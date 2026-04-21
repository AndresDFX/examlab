/// <reference lib="webworker" />

const CACHE_NAME = "examlab-v2";
const STATIC_ASSETS = ["/", "/auth"];

// Install: cache shell
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))),
      ),
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for static
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and Supabase API calls
  if (request.method !== "GET") return;
  if (url.hostname.includes("supabase")) return;

  // For navigation requests, try network first, fall back to cache
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful navigation responses
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match("/").then(
            (r) =>
              r ||
              new Response("Offline — ExamLab", {
                status: 503,
                headers: { "Content-Type": "text/html" },
              }),
          ),
        ),
    );
    return;
  }

  // For static assets (JS, CSS, images, fonts), cache-first with network fallback
  if (url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|woff2?|ico|webp)$/)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request)
            .then((response) => {
              if (response.ok) {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
              }
              return response;
            })
            .catch(() => new Response("", { status: 503 })),
      ),
    );
    return;
  }

  // For Google Fonts, cache-first
  if (url.hostname.includes("fonts.googleapis.com") || url.hostname.includes("fonts.gstatic.com")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request)
            .then((response) => {
              if (response.ok) {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
              }
              return response;
            })
            .catch(() => new Response("", { status: 503 })),
      ),
    );
    return;
  }
});

// Listen for messages from the app
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") {
    self.skipWaiting();
    return;
  }

  // The app forwards Supabase Realtime notifications here when the window is
  // hidden so we can show an OS-level toast. Shape:
  //   { type: "examlab:notify", title, body, link }
  if (event.data && event.data.type === "examlab:notify") {
    const { title, body, link } = event.data;
    if (self.registration && self.registration.showNotification) {
      self.registration.showNotification(title || "ExamLab", {
        body: body || "",
        icon: "/icons/icon-192.svg",
        badge: "/icons/icon-192.svg",
        data: { link: link || "/app" },
        tag: "examlab",
      });
    }
  }
});

// Web Push (server-side subscription flow is out of scope for Phase 3; this
// handler is provided so future push endpoints work without redeploying SW).
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "ExamLab", body: event.data.text() };
  }
  const { title = "ExamLab", body = "", link = "/app" } = payload;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.svg",
      badge: "/icons/icon-192.svg",
      data: { link },
      tag: "examlab",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.link) || "/app";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      const existing = clients.find((c) => c.url.includes(url));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    }),
  );
});
