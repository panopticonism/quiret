// Client-side offline helpers: caching book files for offline use and mirroring
// reading progress to localStorage so a plane trip doesn't lose your place.

const FILE_CACHE = "quiret-files-v1";
const API_CACHE = "quiret-api-v1";

const hasCaches = () => typeof caches !== "undefined";

const fileKey = (id) => `/api/books/${id}/file`;

const fmtMB = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

// Large audiobooks (hundreds of MB) can't go through the Cache API without
// buffering the whole file in memory and crashing the tab, so we prefer the
// Origin Private File System, which streams straight to disk. The Cache API is
// kept as a fallback for browsers without a writable OPFS.

async function opfsWritable() {
  if (!(navigator.storage && navigator.storage.getDirectory)) return false;
  try {
    const root = await navigator.storage.getDirectory();
    const probe = await root.getFileHandle(".q_probe", { create: true });
    const ok = typeof probe.createWritable === "function";
    await root.removeEntry(".q_probe").catch(() => {});
    return ok;
  } catch {
    return false;
  }
}

async function opfsBooksDir(create = false) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("books", { create });
}

async function cacheExtras(book) {
  if (!hasCaches()) return;
  const apiCache = await caches.open(API_CACHE);
  const extras = [`/api/books/${book.id}`, `/api/books/${book.id}/chapters`];
  if (book.coverPath) extras.push(`/api/books/${book.id}/cover`);
  await Promise.all(
    extras.map(async (p) => {
      try {
        const r = await fetch(p);
        if (r.ok) await apiCache.put(p, r.clone());
      } catch {}
    }),
  );
}

// Download a book (and its metadata/cover/chapters) for offline use. Streams the
// file to disk (OPFS, or the Cache API as fallback) and reports progress via
// onProgress(fraction 0..1).
export async function downloadForOffline(book, onProgress) {
  // Pre-flight: fail clearly if it plainly won't fit, rather than crashing.
  if (book.fileSize && navigator.storage?.estimate) {
    try {
      const { quota = 0, usage = 0 } = await navigator.storage.estimate();
      const free = quota - usage;
      if (free && book.fileSize > free - 10 * 1024 * 1024) {
        throw new Error(
          `Not enough offline storage — needs ${fmtMB(book.fileSize)}, only ${fmtMB(Math.max(free, 0))} free.`,
        );
      }
    } catch (e) {
      if (e.message?.startsWith("Not enough")) throw e;
    }
  }

  const res = await fetch(fileKey(book.id));
  if (!res.ok || !res.body) throw new Error("Download failed");
  const total = Number(res.headers.get("Content-Length")) || book.fileSize || 0;

  let loaded = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      if (onProgress && total) onProgress(Math.min(loaded / total, 1));
      controller.enqueue(chunk);
    },
  });

  const quotaError = (e) =>
    e && (e.name === "QuotaExceededError" || /quota/i.test(e.message || ""));

  if (await opfsWritable()) {
    const dir = await opfsBooksDir(true);
    const fh = await dir.getFileHandle(book.id, { create: true });
    const writable = await fh.createWritable();
    try {
      await res.body.pipeThrough(counter).pipeTo(writable);
    } catch (e) {
      try {
        await dir.removeEntry(book.id);
      } catch {}
      throw quotaError(e)
        ? new Error("Ran out of offline storage while downloading.")
        : e;
    }
  } else if (hasCaches()) {
    const fileCache = await caches.open(FILE_CACHE);
    try {
      await fileCache.put(
        fileKey(book.id),
        new Response(res.body.pipeThrough(counter), {
          headers: { "Content-Length": String(total) },
        }),
      );
    } catch (e) {
      await fileCache.delete(fileKey(book.id)).catch(() => {});
      throw quotaError(e)
        ? new Error("Ran out of offline storage while downloading.")
        : e;
    }
  } else {
    throw new Error("Offline storage isn't available in this browser.");
  }

  await cacheExtras(book);
}

export async function removeDownload(bookId) {
  try {
    if (navigator.storage?.getDirectory) {
      const dir = await opfsBooksDir(false).catch(() => null);
      if (dir) await dir.removeEntry(bookId).catch(() => {});
    }
  } catch {}
  if (hasCaches()) {
    const fileCache = await caches.open(FILE_CACHE);
    await fileCache.delete(fileKey(bookId)).catch(() => {});
  }
}

// Set of book ids currently available offline (from OPFS and/or the cache).
export async function downloadedIds() {
  const ids = new Set();
  try {
    if (navigator.storage?.getDirectory) {
      const dir = await opfsBooksDir(false).catch(() => null);
      if (dir) {
        for await (const name of dir.keys()) ids.add(name);
      }
    }
  } catch {}
  if (hasCaches()) {
    const cache = await caches.open(FILE_CACHE);
    for (const req of await cache.keys()) {
      const m = /\/api\/books\/([^/]+)\/file$/.exec(new URL(req.url).pathname);
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}

// --- Progress mirror -------------------------------------------------------
// Every progress save is mirrored locally so an offline session survives even
// if the server PUT can't go through, and the entry records whether the server
// has acknowledged that exact value.
//
// Sync state is tracked explicitly rather than by comparing timestamps: the
// browser's clock and the server's are independent, and weighing one against
// the other meant a device running a few days fast pinned its own stale
// position in place and then flushed it back up over newer progress from
// another device.

const progressKey = (id) => `quiret:progress:${id}`;

export function saveLocalProgress(bookId, progressStr) {
  if (!bookId || !progressStr) return;
  try {
    localStorage.setItem(
      progressKey(bookId),
      JSON.stringify({ progress: progressStr, at: Date.now(), pending: true }),
    );
  } catch {}
}

export function getLocalProgress(bookId) {
  if (!bookId) return null;
  try {
    const v = JSON.parse(localStorage.getItem(progressKey(bookId)));
    return v && typeof v.progress === "string" && v.progress ? v : null;
  } catch {
    return null;
  }
}

// Record that the server stored exactly `progressStr`. A later local save may
// already have superseded this value, so the entry is only cleared while it
// still matches.
export function markLocalProgressSynced(bookId, progressStr) {
  const local = getLocalProgress(bookId);
  if (!local || local.progress !== progressStr) return;
  try {
    localStorage.setItem(
      progressKey(bookId),
      JSON.stringify({ ...local, pending: false }),
    );
  } catch {}
}

// The progress string to actually use for a book. A pending mirror entry is this
// device's own unsent position and wins; once the server has it, the server is
// authoritative, because another device may have moved further along.
//
// `pending` is the flag rather than its opposite so that an entry written by an
// older build - which had no sync bookkeeping at all - reads as already sent.
// Those entries were pushed on every save, and treating them as unsent would
// replay stale positions over whatever the server now holds.
export function effectiveProgress(book) {
  const local = getLocalProgress(book?.id);
  const server = book?.readingProgress || "";
  if (!local) return server;
  // Unsent work on this device is the one thing that outranks the server.
  if (local.pending) return local.progress;
  // Otherwise the server is authoritative - including when it says there is no
  // progress. Falling back to the mirror here resurrected records that had been
  // cleared server-side, putting those items back on the Continue shelf.
  return server;
}

// Mirror entries the server hasn't acknowledged yet, as {id, progress}.
// Entries from an older build carry no `pending` flag and are left alone.
export function pendingLocalProgress(books) {
  const out = [];
  for (const book of books || []) {
    const local = getLocalProgress(book?.id);
    if (!local || !local.pending) continue;
    if (local.progress === (book?.readingProgress || "")) continue;
    out.push({ id: book.id, progress: local.progress });
  }
  return out;
}

// Push a progress string to the server and record that it landed. Callers mirror
// locally first, so a failed push simply leaves the mirror holding unsent work -
// re-mirroring here would stamp this value over a newer local save.
// `keepalive` lets the request outlive the page on teardown.
export async function pushProgress(bookId, progressStr) {
  try {
    const res = await fetch(`/api/books/${bookId}/progress`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ progress: progressStr }),
      keepalive: true,
    });
    if (!res.ok) return false;
    markLocalProgressSynced(bookId, progressStr);
    return true;
  } catch {
    return false;
  }
}

// Push any unsent progress up to the server (best-effort, online only).
export async function flushLocalProgress(books) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  for (const { id, progress } of pendingLocalProgress(books)) {
    await pushProgress(id, progress);
  }
}
