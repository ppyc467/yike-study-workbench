const VERSION = "yike-v12-3";
const ASSETS = `${VERSION}-assets`;
const USER_CACHE = "yike-offline-user";
const PAGE_PREFIX = "yike-pages-";
const shellAssets = ["/offline.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/favicon.svg"];
let userQueue = Promise.resolve();
let userGeneration = 0;
let preparation;

function queueUserOperation(operation) {
  const generation = ++userGeneration;
  preparation?.abort();
  userQueue = userQueue.catch(() => {}).then(() => operation(generation));
  return userQueue;
}

async function clearUser() {
  await Promise.all((await caches.keys()).filter(key => key.startsWith(PAGE_PREFIX) || key === USER_CACHE).map(key => caches.delete(key)));
}

function isAsset(url) {
  return url.origin === self.location.origin && !url.pathname.startsWith("/api/") &&
    !/signin-with-chatgpt|signout-with-chatgpt|callback/.test(url.pathname) &&
    (shellAssets.includes(url.pathname) || /\.(?:m?js|css|png|svg|woff2?|ttf|otf|ico)$/.test(url.pathname));
}

self.addEventListener("install", event => {
  event.waitUntil(caches.open(ASSETS).then(cache => cache.addAll(shellAssets)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  // Keep the preceding page's assets until its replacement is completely available offline.
  event.waitUntil(self.clients.claim());
});

async function currentPageCache() {
  const metadata = await caches.open(USER_CACHE);
  const user = await metadata.match("/offline-user");
  return user ? caches.open(`${PAGE_PREFIX}${await user.text()}`) : null;
}

self.addEventListener("message", event => {
  if (event.data?.type === "CLEAR_USER") event.waitUntil(queueUserOperation(clearUser));
  if (event.data?.type !== "PREPARE_USER" || typeof event.data.userKey !== "string") return;
  event.waitUntil(queueUserOperation(async generation => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(event.data.userKey));
    if (generation !== userGeneration) return;
    const controller = new AbortController();
    preparation = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const user = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const pageName = `${PAGE_PREFIX}${user}`;
      await Promise.all((await caches.keys()).filter(key => key.startsWith(PAGE_PREFIX) && key !== pageName).map(key => caches.delete(key)));
      await (await caches.open(USER_CACHE)).put("/offline-user", new Response(user));
      const pages = await caches.open(pageName);
      const page = await fetch("/", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (generation !== userGeneration) return;
      const cache = await caches.open(ASSETS);
      const supplied = Array.isArray(event.data.assets) ? event.data.assets.filter(value => typeof value === "string") : [];
      let built = [];
      try {
        const manifest = await fetch("/offline-assets.json", { cache: "no-store", signal: controller.signal });
        if (manifest.ok) {
          const data = await manifest.json();
          if (Array.isArray(data.assets)) built = data.assets.filter(value => typeof value === "string");
        }
      } catch { /* Older builds can still supply their loaded dependencies. */ }
      const urls = [...new Set([...built, ...supplied, ...shellAssets])].map(value => {
        try { return new URL(value, self.location.origin); } catch { return null; }
      }).filter(url => url && isAsset(url));
      const prepared = await Promise.allSettled(urls.map(async url => {
        const response = await fetch(url.href, { signal: controller.signal });
        if (!response.ok) throw new Error("Offline asset unavailable");
        await cache.put(url.href, response);
      }));
      if (generation === userGeneration && page.ok && prepared.every(result => result.status === "fulfilled")) {
        await pages.put("/", page);
        await Promise.all((await caches.keys()).filter(key => key.includes("-assets") && key !== ASSETS).map(key => caches.delete(key)));
      }
    } finally {
      clearTimeout(timeout);
      if (preparation === controller) preparation = undefined;
    }
  }).catch(() => {}));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname === "/signout-with-chatgpt") {
    const cleared = queueUserOperation(clearUser);
    event.waitUntil(cleared);
    event.respondWith(cleared.then(() => fetch(request)));
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname === "/mcp" || /signin-with-chatgpt|callback/.test(url.pathname)) return;
  if (request.mode === "navigate" && url.pathname === "/") {
    const generation = userGeneration;
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const copy = response.clone();
        event.waitUntil(userQueue.catch(() => {}).then(async () => {
          if (generation !== userGeneration) return;
          const pages = await currentPageCache();
          if (response.ok && pages && generation === userGeneration) await pages.put("/", copy);
        }));
        return response;
      } catch {
        await userQueue.catch(() => {});
        const pages = await currentPageCache();
        return (pages && await pages.match("/")) || await caches.match("/offline.html");
      }
    })());
  } else if (isAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSETS);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});
