import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmProvider } from "@/shared/components/ConfirmDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/shared/components/ErrorBoundary";
import { TenantThemeProvider } from "@/modules/tenants/TenantThemeProvider";
import { GlobalErrorLogger } from "@/shared/components/GlobalErrorLogger";
import { IosInstallBanner } from "@/modules/pwa/IosInstallBanner";

import "@/i18n";
import appCss from "../styles.css?url";

function NotFoundComponent() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">{t("common.notFound")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("common.notFoundBody")}</p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t("common.goHome")}
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ExamLab" },
      {
        name: "description",
        content:
          "ExamLab es una plataforma web para gestión y ejecución de exámenes online con IA y proctoring.",
      },
      { name: "author", content: "ExamLab" },
      { property: "og:title", content: "ExamLab" },
      {
        property: "og:description",
        content: "Diseña, asigna y califica exámenes con IA y proctoring integrado.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "ExamLab" },
      {
        name: "twitter:description",
        content: "Plataforma académica con IA, proctoring y gestión completa de exámenes.",
      },
      { name: "theme-color", content: "#6366f1" },
      { name: "description", content: "Online exam management and execution platform." },
      { property: "og:description", content: "Online exam management and execution platform." },
      { name: "twitter:description", content: "Online exam management and execution platform." },
      {
        property: "og:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/46f6c31a-cc9f-43d8-98c5-90caf08ac519/id-preview-d54ebc1f--9f16eaeb-e983-4536-9a73-1461f295b2d3.lovable.app-1777090431857.png",
      },
      {
        name: "twitter:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/46f6c31a-cc9f-43d8-98c5-90caf08ac519/id-preview-d54ebc1f--9f16eaeb-e983-4536-9a73-1461f295b2d3.lovable.app-1777090431857.png",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.json" },
      // Android/Chrome: PNG primero (favicon de pestaña + add-to-home-screen).
      // SVG queda como fallback para browsers que prefieren vectorial.
      { rel: "icon", type: "image/png", href: "/icons/icon-192.png" },
      { rel: "icon", type: "image/svg+xml", href: "/icons/icon-192.svg" },
      // iOS PWA: apple-touch-icon DEBE ser PNG (Safari ignora SVG aquí).
      { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: el <script> pre-paint de abajo le agrega
    // la clase `.dark` al <html> ANTES de que React hidrate. Sin esto, el
    // <html> del DOM (con `class="dark"`) no coincide con el que React
    // renderizó en el server (sin clase) → React error #418, intermitente
    // (solo dispara para usuarios con tema oscuro guardado). Patrón estándar
    // de los theme scripts (next-themes, etc.): silenciar el warning de
    // hidratación SOLO en el elemento que el script muta.
    <html lang="es" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {/* Theme pre-paint: aplica la clase `.dark` desde localStorage
            ANTES de que el contenido pinte, para que el fondo no
            parpadee de claro→oscuro en usuarios con tema oscuro. Va como
            primer hijo del body (corre durante el parse, antes de
            `{children}`). El árbol React de useTheme arranca en "light"
            determinista (ver use-theme.ts) y se sincroniza post-mount;
            esta clase solo evita el flash visual del fondo. Mantener el
            nombre de la key en sync con use-theme.ts (`examlab-theme`). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('examlab-theme');if(t==='dark')document.documentElement.classList.add('dark');}catch(e){}})();`,
          }}
        />
        {children}
        <Scripts />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                // ── Detect Lovable preview / iframe contexts ────────────────
                // El service worker NO debe correr dentro del iframe de la
                // vista previa de Lovable: cachea HTML/chunks viejos, intercepta
                // llamadas a Supabase Functions (causando timeouts tipo
                // "NetworkMonitor: Timeout") y rompe la hidratación SSR.
                // En esos contextos: desinstalamos cualquier SW previo y
                // limpiamos todas las cachés.
                var isInIframe = false;
                try { isInIframe = window.self !== window.top; } catch (e) { isInIframe = true; }
                var host = window.location.hostname || '';
                var isPreviewHost =
                  host.indexOf('id-preview--') !== -1 ||
                  host.indexOf('lovableproject.com') !== -1 ||
                  host.indexOf('lovable.app') !== -1; // incluye published; ver nota abajo

                // En published (lovable.app) sí queremos SW, pero solo si NO
                // estamos embebidos en un iframe. Reajustamos:
                var disableSW = isInIframe || host.indexOf('id-preview--') !== -1 ||
                  host.indexOf('lovableproject.com') !== -1;

                if ('serviceWorker' in navigator && disableSW) {
                  // Desinstala SW legacy (que pueden estar interceptando fetch
                  // y devolviendo respuestas viejas/rotas) y limpia caches.
                  try {
                    navigator.serviceWorker.getRegistrations().then(function (regs) {
                      regs.forEach(function (r) { try { r.unregister(); } catch (e) {} });
                    });
                  } catch (e) {}
                  try {
                    if (window.caches && caches.keys) {
                      caches.keys().then(function (names) {
                        names.forEach(function (n) { try { caches.delete(n); } catch (e) {} });
                      });
                    }
                  } catch (e) {}
                }

                if ('serviceWorker' in navigator && !disableSW) {
                  var refreshing = false;
                  navigator.serviceWorker.addEventListener('controllerchange', function () {
                    if (refreshing) return;
                    refreshing = true;
                    if (window.__hadController) window.location.reload();
                  });

                  window.addEventListener('load', function () {
                    window.__hadController = !!navigator.serviceWorker.controller;
                    navigator.serviceWorker
                      .register('/sw.js')
                      .then(function (reg) {
                        if (reg.waiting) reg.waiting.postMessage('skipWaiting');
                        reg.addEventListener('updatefound', function () {
                          var sw = reg.installing;
                          if (!sw) return;
                          sw.addEventListener('statechange', function () {
                            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
                              sw.postMessage('skipWaiting');
                            }
                          });
                        });
                        document.addEventListener('visibilitychange', function () {
                          if (document.visibilityState === 'visible') {
                            // reg.update() re-fetcha /sw.js de la red (se sirve con
                            // Cache-Control: no-cache). En conexiones intermitentes —móvil
                            // que bloquea/desbloquea, red escolar tras Cloudflare— ese fetch
                            // falla y update() RECHAZA con "Script .../sw.js load failed".
                            // El try/catch NO atrapa el rechazo async; hay que encadenar
                            // .catch o queda como unhandledrejection (benigno: el SW vigente
                            // sigue activo, pero ensucia el monitoreo). Si el navegador se
                            // reporta offline, ni intentamos el fetch.
                            if (navigator.onLine === false) return;
                            try {
                              var up = reg.update();
                              if (up && typeof up.catch === 'function') up.catch(function () {});
                            } catch (e) {}
                          }
                        });
                      })
                      .catch(function () {});
                  });
                }

                // ── Chunk-load failure recovery ──────────────────────────────
                // Si un dynamic import falla (deploy nuevo borró el chunk con
                // hash que el HTML viejo todavía referencia), recargamos UNA
                // vez. Marcador en sessionStorage para evitar bucles.
                function reloadOnce() {
                  try {
                    if (sessionStorage.getItem('examlab:reloaded') === '1') return;
                    sessionStorage.setItem('examlab:reloaded', '1');
                  } catch (e) {}
                  window.location.reload();
                }
                function isChunkError(msg) {
                  if (!msg) return false;
                  msg = String(msg);
                  return (
                    msg.indexOf('ChunkLoadError') !== -1 ||
                    msg.indexOf('Loading chunk') !== -1 ||
                    msg.indexOf('Failed to fetch dynamically imported module') !== -1 ||
                    msg.indexOf('Importing a module script failed') !== -1
                  );
                }
                window.addEventListener('error', function (ev) {
                  if (isChunkError(ev.message) || (ev.error && isChunkError(ev.error.message))) {
                    reloadOnce();
                  }
                });
                window.addEventListener('unhandledrejection', function (ev) {
                  var reason = ev.reason;
                  var msg = reason && (reason.message || reason.toString());
                  if (isChunkError(msg)) reloadOnce();
                });
                // Si la navegación cargó OK, limpiamos la marca de recarga.
                window.addEventListener('load', function () {
                  try { sessionStorage.removeItem('examlab:reloaded'); } catch (e) {}
                });
              })();
            `,
          }}
        />
      </body>
    </html>
  );
}

function RootComponent() {
  // delayDuration en 200ms para que tooltips de RowAction aparezcan
  // rápido al pasar el mouse — el default de 700ms se siente lento
  // en grids donde el usuario hace hover rápidamente entre filas.
  //
  // ErrorBoundary envuelve el árbol entero como red final: si algún
  // componente fuera de las rutas (provider, layout compartido) lanza
  // en render, el usuario ve un mensaje claro en vez de pantalla
  // en blanco. Errores DENTRO de rutas siguen siendo capturados por
  // el defaultErrorComponent de TanStack Router (router.tsx).
  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={200}>
        <ConfirmProvider>
          <GlobalErrorLogger />
          <TenantThemeProvider>
            <Outlet />
          </TenantThemeProvider>
          {/* Banner iOS para instalar la PWA — fuera del Outlet para que
              persista al navegar entre rutas. No-op en otros browsers /
              ya instalado / descartado por el usuario. */}
          <IosInstallBanner />
          <Toaster richColors position="top-right" expand visibleToasts={6} />
        </ConfirmProvider>
      </TooltipProvider>
    </ErrorBoundary>
  );
}
