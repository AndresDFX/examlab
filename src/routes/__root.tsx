import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmProvider } from "@/components/ConfirmDialog";

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
      { property: "og:title", content: "ExamLab — Plataforma de Exámenes Online" },
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
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.json" },
      { rel: "icon", type: "image/svg+xml", href: "/icons/icon-192.svg" },
      { rel: "apple-touch-icon", href: "/icons/icon-192.svg" },
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
    <html lang="es">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                // ── Service Worker registration + auto-update ────────────────
                // Si hay una versión nueva del SW publicada (deploy reciente),
                // queremos tomarla sin pedirle al usuario un hard-refresh:
                //  1) registramos /sw.js
                //  2) en cada visibilitychange revisamos si hay update
                //  3) cuando un nuevo SW toma control (controllerchange), si no
                //     es la primera instalación, recargamos una sola vez para
                //     que el HTML pida los chunks nuevos.
                if ('serviceWorker' in navigator) {
                  var refreshing = false;
                  navigator.serviceWorker.addEventListener('controllerchange', function () {
                    if (refreshing) return;
                    refreshing = true;
                    // Solo recarga si ya había un controller (no primer install).
                    if (window.__hadController) window.location.reload();
                  });

                  window.addEventListener('load', function () {
                    window.__hadController = !!navigator.serviceWorker.controller;
                    navigator.serviceWorker
                      .register('/sw.js')
                      .then(function (reg) {
                        // Pide al SW nuevo (waiting) que tome control inmediatamente.
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
                            try { reg.update(); } catch (e) {}
                          }
                        });
                      })
                      .catch(function () {});
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
  return (
    <ConfirmProvider>
      <Outlet />
      <Toaster richColors position="top-right" />
    </ConfirmProvider>
  );
}
