/// <reference lib="webworker" />

/**
 * ExamLab service worker.
 *
 * Cambios vs. v2:
 *  - **No** se cachean respuestas de navegación (HTML). El HTML referencia
 *    chunks con hash en su nombre; cachear HTML stale hace que tras un deploy
 *    el navegador pida chunks viejos que ya no existen y termine en 503.
 *  - El `.catch()` de los handlers de assets ya **no** fabrica un
 *    `Response("", { status: 503 })`. Eso confundía al chunk-loader de Vite
 *    (que veía un 503 sintético en lugar del error de red real). Ahora se
 *    deja propagar el rechazo del fetch — el cliente lo detecta y dispara
 *    una recarga (ver __root.tsx → window 'error' listener).
 *  - Cache name v3 invalida las versiones anteriores en `activate`.
 */

const CACHE_NAME = "examlab-v4";
// Solo cacheamos assets inmutables (los que llevan hash en el nombre).
// El HTML siempre se sirve desde la red — si la red falla, mostramos un
// fallback offline mínimo construido al vuelo, no uno cacheado.

self.addEventListener("install", (event) => {
  // No precacheamos nada: el HTML debe ser fresco siempre, y los chunks con
  // hash se irán cacheando bajo demanda al primer fetch exitoso.
  event.waitUntil(caches.open(CACHE_NAME));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  if (url.hostname.includes("supabase")) return;
  // CheerpJ CDN sirve JARs gigantes con range requests; el SW rompe el caché de
  // rango con ERR_CACHE_OPERATION_NOT_SUPPORTED. Dejar pasar a la red directo.
  if (url.hostname.includes("leaningtech.com")) return;

  // Navegación: SIEMPRE red. Sin cache. Si la red falla mostramos un
  // fallback offline mínimo. NO reusamos HTML cacheado entre deploys porque
  // referenciaría chunks viejos.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(
            "<!doctype html><meta charset=utf-8><title>ExamLab</title><body style='font-family:system-ui;padding:2rem;text-align:center'><h1>Sin conexión</h1><p>Reintenta cuando tengas internet.</p></body>",
            { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
          ),
      ),
    );
    return;
  }

  // Assets estáticos con hash inmutable (JS/CSS/images/fonts) → cache-first
  // con caída a red. Si la red rechaza el fetch (no hay 4xx/5xx, sino
  // network error), DEJAMOS que el rechazo se propague: el chunk-loader de
  // Vite lo verá como un `ChunkLoadError` real y nuestro window 'error'
  // listener (en __root.tsx) recargará la página una vez para tomar el
  // HTML/chunks nuevos.
  if (url.pathname.match(/\.(js|css|png|jpg|jpeg|svg|woff2?|ico|webp)$/)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          }),
        // sin .catch — propagar el error de red real
      ),
    );
    return;
  }

  // Google Fonts → cache-first con caída a red, idem propagación.
  if (url.hostname.includes("fonts.googleapis.com") || url.hostname.includes("fonts.gstatic.com")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          }),
      ),
    );
    return;
  }
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") {
    self.skipWaiting();
    return;
  }

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
