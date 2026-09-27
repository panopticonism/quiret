// Client-side offline helpers: caching book files for offline use and mirroring
// reading progress to localStorage so a plane trip doesn't lose your place.

const FILE_CACHE = "quiret-files-v1";
const API_CACHE = "quiret-api-v1";

const hasCaches = () => typeof caches !== "undefined";

const fileKey = (id) => `/api/books/${id}/file`;

// Download a book (and its metadata/cover/chapters) into the cache for offline use.
export async function downloadForOffline(book) {
  if (!hasCaches()) throw new Error("Offline storage unavailable");
  const fileCache = await caches.open(FILE_CACHE);

  const res = await fetch(fileKey(book.id));
  if (!res.ok) throw new Error("Download failed");
  await fileCache.put(fileKey(book.id), res);

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
