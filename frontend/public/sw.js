// Quiret service worker — offline support.
//
// - App shell (HTML/JS/CSS/assets) is cached on first online load so the app
//   opens with no network.
// - Library/metadata/cover/chapter API GETs use stale-while-revalidate.
// - Book files are only served from cache when the user has explicitly
//   downloaded them (see lib/offline.js); range requests are satisfied from the
//   cached full response so audio seeking works offline. Non-downloaded files
//   pass through to the network.

const SHELL_CACHE = "quiret-shell-v2";
const API_CACHE = "quiret-api-v1";
const FILE_CACHE = "quiret-files-v1";
const CURRENT = new Set([SHELL_CACHE, API_CACHE, FILE_CACHE]);

// Precache the full app shell on install so lazily-imported chunks (e.g.
// foliate-js format modules) are available offline even if never opened online.
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch("/precache-manifest.json", { cache: "no-store" });
        if (res.ok) {
          const urls = await res.json();
          const cache = await caches.open(SHELL_CACHE);
          await Promise.allSettled(urls.map((u) => cache.add(u).catch(() => {})));
        }
      } catch {
        // Best-effort: runtime caching still covers assets fetched while online.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("quiret-") && !CURRENT.has(n))
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never touch writes (progress, uploads, ...)

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(handleNavigate(req));
    return;
  }

  if (/^\/api\/books\/[^/]+\/file$/.test(url.pathname)) {
    event.respondWith(handleFile(req, url));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(staleWhileRevalidate(req, API_CACHE));
    return;
  }

  // Same-origin static assets (JS/CSS/fonts/icons/worker).
  event.respondWith(cacheFirst(req, SHELL_CACHE));
});

async function handleNavigate(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put("/index.html", res.clone());
    return res;
  } catch {
    return (await cache.match("/index.html")) || Response.error();
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === "basic") cache.put(req, res.clone());
    return res;
  } catch {
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fetching = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await fetching) || Response.error();
}

const MIME = {
  mp3: "audio/mpeg",
  m4b: "audio/mp4",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  epub: "application/epub+zip",
  pdf: "application/pdf",
  fb2: "application/x-fictionbook+xml",
  cbz: "application/vnd.comicbook+zip",
};

async function offlineContentType(id) {
  try {
    const apiCache = await caches.open(API_CACHE);
    const metaRes = await apiCache.match("/api/books/" + id);
    if (metaRes) {
      const meta = await metaRes.json();
      return MIME[meta.fileType] || "application/octet-stream";
    }
  } catch {}
  return "application/octet-stream";
}

async function opfsFile(id) {
  try {
    if (!(self.navigator && navigator.storage && navigator.storage.getDirectory))
      return null;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("books").catch(() => null);
    if (!dir) return null;
    const fh = await dir.getFileHandle(id).catch(() => null);
    return fh ? await fh.getFile() : null;
  } catch {
    return null;
  }
}

function parseRange(rangeHeader, total) {
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader || "");
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
  if (Number.isNaN(start)) start = 0;
  if (Number.isNaN(end) || end > total - 1) end = total - 1;
  return { start, end };
}

async function handleFile(req, url) {
  const id = (/^\/api\/books\/([^/]+)\/file$/.exec(url.pathname) || [])[1];
  const range = req.headers.get("range");

  // Prefer OPFS (streams large media from disk without buffering).
  const file = id ? await opfsFile(id) : null;
  if (file) {
    const type = await offlineContentType(id);
    const total = file.size;
    if (!range) {
      return new Response(file, {
        headers: {
          "Content-Type": type,
          "Content-Length": String(total),
          "Accept-Ranges": "bytes",
        },
      });
    }
    const { start, end } = parseRange(range, total);
    if (start > end || start >= total) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      statusText: "Partial Content",
      headers: {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
      },
    });
  }

  // Cache API fallback (small files / browsers without writable OPFS).
  const cache = await caches.open(FILE_CACHE);
  const cached = await cache.match(url.pathname);
  if (!cached) return fetch(req); // not downloaded — online passthrough
  if (!range) return cached.clone();
  return buildRange(cached, range);
}

async function buildRange(response, rangeHeader) {
  const buf = await response.clone().arrayBuffer();
  const total = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader || "");
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
  if (Number.isNaN(start)) start = 0;
  if (Number.isNaN(end) || end > total - 1) end = total - 1;
  if (start > end || start >= total) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${total}` },
    });
  }
  const body = buf.slice(start, end + 1);
  const headers = new Headers();
  const ct = response.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
  headers.set("Content-Length", String(body.byteLength));
  headers.set("Accept-Ranges", "bytes");
  return new Response(body, {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}
