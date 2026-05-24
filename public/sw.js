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

// v8: icons PNG para que Android Chrome NO descarte notificaciones (SVG en
// icon/badge causa drop silencioso en Android).
const CACHE_NAME = "examlab-v8";
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
      .then(async () => {
        // Limpieza defensiva: cualquier entrada de leaningtech que
        // haya quedado de una versión anterior del SW (cuando aún se
        // cacheaban los JARs gigantes) reproduce ERR_CACHE_OPERATION_NOT_SUPPORTED
        // al hacer range requests. Si quedó algo, lo borramos del
        // caché vigente.
        try {
          const cache = await caches.open(CACHE_NAME);
          const reqs = await cache.keys();
          await Promise.all(
            reqs
              .filter((r) => {
                try {
                  return new URL(r.url).hostname.includes("leaningtech.com");
                } catch {
                  return false;
                }
              })
              .map((r) => cache.delete(r)),
          );
        } catch (_) {
          /* silent */
        }
      })
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  // El Cache API solo acepta requests con scheme http(s). Extensiones del
  // navegador (chrome-extension://, moz-extension://, etc.) que se cuelgan
  // sobre la página disparan fetch eventos que pasan por el SW; si los
  // intentamos cachear, cache.put rechaza con:
  //   "Failed to execute 'put' on 'Cache': Request scheme 'chrome-extension'
  //    is unsupported"
  // Salir temprano para esos schemes evita el error sin afectar el
  // funcionamiento de la extensión (queda libre de pasar a la red).
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.hostname.includes("supabase")) return;
  // CheerpJ CDN sirve JARs gigantes con range requests; el SW rompe el caché de
  // rango con ERR_CACHE_OPERATION_NOT_SUPPORTED. Dejar pasar a la red directo.
  if (url.hostname.includes("leaningtech.com")) return;

  // Navegación: SIEMPRE red. Sin cache. Si la red falla:
  //  - Reintenta UNA vez después de 600ms (la mayoría de fallos durante
  //    una sesión activa son blips transitorios — DNS, wifi roaming, etc.)
  //  - Solo si el segundo intento también falla, devolvemos el fallback.
  //  - El fallback ahora tiene un botón "Reintentar" que recarga sin que
  //    el alumno tenga que navegar a la URL a mano.
  // NO reusamos HTML cacheado entre deploys porque referenciaría chunks
  // viejos.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        // Hasta 3 intentos con backoff: 0ms, 700ms, 1800ms.
        // Solo mostramos el fallback "Sin conexión" si efectivamente
        // el navegador reporta offline. Si está online pero el fetch
        // sigue fallando, devolvemos una página de "Error temporal"
        // con reintentar — no mentimos diciendo que no hay internet.
        const delays = [0, 700, 1800];
        let lastErr;
        for (const d of delays) {
          if (d) await new Promise((r) => setTimeout(r, d));
          try {
            const res = await fetch(request);
            return res;
          } catch (e) {
            lastErr = e;
          }
        }
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        const title = offline ? "Sin conexión" : "Error temporal";
        const body = offline
          ? "No pudimos cargar la página. Si estás presentando un examen, tus respuestas guardadas hasta ahora siguen seguras: vuelve a intentar cuando tengas internet y podrás reanudar."
          : "No pudimos cargar la página en este momento. Tus respuestas guardadas siguen seguras. Intenta de nuevo en unos segundos.";
        const html = `<!doctype html>
<meta charset="utf-8">
<title>ExamLab — ${title}</title>
<body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:0 auto;text-align:center;color:#1f2937">
  <h1 style="font-size:1.5rem;margin:0 0 .5rem">${title}</h1>
  <p style="color:#6b7280;margin:0 0 1.5rem">${body}</p>
  <button onclick="location.reload()" style="background:#111827;color:#fff;border:0;border-radius:.5rem;padding:.6rem 1.2rem;font-size:.95rem;cursor:pointer">Reintentar</button>
</body>`;
        return new Response(html, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      })(),
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
              // `.catch(() => {})` defensivo: cualquier fallo de cacheo
              // (scheme no soportado, quota excedida, opaque response, etc.)
              // queda silenciado — la respuesta de red ya se devolvió y
              // el siguiente fetch reintentará caching. Romper la
              // promesa propaga un unhandled rejection en el console.
              caches
                .open(CACHE_NAME)
                .then((cache) => cache.put(request, clone))
                .catch(() => {});
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
              caches
                .open(CACHE_NAME)
                .then((cache) => cache.put(request, clone))
                .catch(() => {});
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
    const { title, body, link, id } = event.data;
    if (self.registration && self.registration.showNotification) {
      self.registration.showNotification(title || "ExamLab", {
        body: body || "",
        // ¡IMPORTANTE! Android Chrome NO renderiza notificaciones con icon SVG
        // — las descarta silenciosamente. Debe ser PNG. badge va a la status
        // bar y conviene un PNG monocromo (Android le aplica tinta del tema).
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-72.png",
        data: { link: link || "/app" },
        // Tag único por notificación (o el ID si lo pasaron) — un tag fijo
        // colapsa todas las notifs en una sola y el usuario solo ve la
        // última, no las anteriores.
        tag: id ? `examlab:${id}` : `examlab:${Date.now()}`,
        // Vibración corta para alertar en Android (ignorado en desktop).
        vibrate: [200, 100, 200],
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
  const { title = "ExamLab", body = "", link = "/app", id } = payload;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // Ver comentario en el handler 'message' arriba — PNG, NO SVG, o
      // Android Chrome descarta la notificación sin error.
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      data: { link },
      tag: id ? `examlab:${id}` : `examlab:${Date.now()}`,
      vibrate: [200, 100, 200],
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
