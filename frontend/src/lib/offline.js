// Client-side offline helpers: caching book files for offline use and mirroring
// reading progress to localStorage so a plane trip doesn't lose your place.

const FILE_CACHE = "quiret-files-v1";
const API_CACHE = "quiret-api-v1";

const hasCaches = () => typeof caches !== "undefined";

const fileKey = (id) => `/api/books/${id}/file`;

const fmtMB = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

// Download a book (and its metadata/cover/chapters) into the cache for offline
// use. Streams the file to storage (so large audiobooks don't buffer in memory)
// and reports progress via onProgress(fraction 0..1).
export async function downloadForOffline(book, onProgress) {
  if (!hasCaches()) {
    throw new Error("Offline storage isn't available in this browser.");
  }

  // Pre-flight: make sure the file plausibly fits, so we fail clearly instead of
  // spinning forever / crashing the tab on a device that's low on space.
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
      // estimate() unsupported/failed — proceed and rely on the quota error below.
    }
  }

  const fileCache = await caches.open(FILE_CACHE);
  const res = await fetch(fileKey(book.id));
  if (!res.ok || !res.body) throw new Error("Download failed");

  const total = Number(res.headers.get("Content-Length")) || book.fileSize || 0;
  const contentType = res.headers.get("Content-Type") || "application/octet-stream";
  let loaded = 0;
  const reader = res.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      loaded += value.byteLength;
      if (onProgress && total) onProgress(Math.min(loaded / total, 1));
      controller.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });

  try {
    await fileCache.put(
      fileKey(book.id),
      new Response(stream, {
        headers: { "Content-Type": contentType, "Content-Length": String(total) },
      }),
    );
  } catch (e) {
    await fileCache.delete(fileKey(book.id)).catch(() => {});
    if (e && (e.name === "QuotaExceededError" || /quota/i.test(e.message || ""))) {
      throw new Error("Ran out of offline storage while downloading.");
    }
    throw e;
  }

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

export async function removeDownload(bookId) {
  if (!hasCaches()) return;
  const fileCache = await caches.open(FILE_CACHE);
  await fileCache.delete(fileKey(bookId));
}

// Set of book ids currently available offline.
export async function downloadedIds() {
  const ids = new Set();
  if (!hasCaches()) return ids;
  const cache = await caches.open(FILE_CACHE);
  for (const req of await cache.keys()) {
    const m = /\/api\/books\/([^/]+)\/file$/.exec(new URL(req.url).pathname);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// --- Progress mirror -------------------------------------------------------
// Every progress save is also written locally with a timestamp, so it survives
// an offline session even if the server PUT couldn't go through.

const progressKey = (id) => `quiret:progress:${id}`;

export function saveLocalProgress(bookId, progressStr) {
  try {
    localStorage.setItem(
      progressKey(bookId),
      JSON.stringify({ progress: progressStr, at: Date.now() }),
    );
  } catch {}
}

export function getLocalProgress(bookId) {
  try {
    const v = JSON.parse(localStorage.getItem(progressKey(bookId)));
    return v && v.progress ? v : null;
  } catch {
    return null;
  }
}

// The progress string to actually use for a book: prefer the local mirror when
// offline, or when it's newer than what the server last recorded.
export function effectiveProgress(book) {
  const local = getLocalProgress(book?.id);
  if (!local) return book?.readingProgress || "";
  const serverAt = book?.progressUpdatedAt ? Date.parse(book.progressUpdatedAt) : 0;
  if (typeof navigator !== "undefined" && !navigator.onLine) return local.progress;
  return local.at > serverAt ? local.progress : book?.readingProgress || "";
}

// Push any locally-newer progress up to the server (best-effort, online only).
export async function flushLocalProgress(books) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
  for (const book of books) {
    const local = getLocalProgress(book.id);
    if (!local) continue;
    const serverAt = book.progressUpdatedAt ? Date.parse(book.progressUpdatedAt) : 0;
    if (local.at <= serverAt) continue;
    try {
      await fetch(`/api/books/${book.id}/progress`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ progress: local.progress }),
      });
    } catch {}
  }
}
