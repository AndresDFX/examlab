import { createRouter, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { routeTree } from "./routeTree.gen";
import { recargarLaApp } from "@/shared/lib/recarga-propia";
/**
 * Misma detección que ErrorBoundary + __root.tsx. Si cualquier ruta lazy
 * intenta cargar un chunk que el deploy nuevo ya invalidó, recargamos
 * UNA vez (la flag `examlab:reloaded` en sessionStorage evita el loop).
 */
function isChunkLoadError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: string; name?: string };
  const msg = String(e.message ?? "");
  return (
    e.name === "ChunkLoadError" ||
    msg.includes("ChunkLoadError") ||
    msg.includes("Loading chunk") ||
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    // WebKit, cuando un chunk que ya no existe llega como index.html (Cloudflare
    // en modo SPA responde 200 text/html): ver public/sw.js.
    msg.includes("is not a valid JavaScript MIME type")
  );
}

// Sin red, recargar deja la página en blanco o colgada: se espera a la red.
let esperandoRed = false;
function reloadOnceForStaleChunk(): void {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    if (!esperandoRed) {
      esperandoRed = true;
      window.addEventListener(
        "online",
        () => {
          esperandoRed = false;
          reloadOnceForStaleChunk();
        },
        { once: true },
      );
    }
    return;
  }
  try {
    // Una recarga automática cada 60 s como mucho (misma regla que el script
    // de __root.tsx): la marca ya no se borra al cargar, así que una falla
    // persistente no se vuelve un bucle.
    const previa = Number(sessionStorage.getItem("examlab:reloaded")) || 0;
    if (Date.now() - previa < 60_000) return;
    sessionStorage.setItem("examlab:reloaded", String(Date.now()));
  } catch {
    /* sessionStorage bloqueado — recargar igual */
  }
  // La pide la plataforma, no el usuario: un examen no se la cobra.
  recargarLaApp();
}

/**
 * Componente que TanStack Router renderiza cuando una ruta lanza
 * (loader, beforeLoad, render). Antes estaba en inglés y con SVG
 * inline; lo migramos a español + design system para que se vea
 * coherente con el resto de la app.
 *
 * Chunk-load failures (deploy reciente borró el JS de la ruta) NO
 * deberían mostrar este fallback: recargamos automáticamente para que
 * el navegador tome los chunks nuevos. Sin esto el usuario veía la
 * pantalla roja "Algo salió mal" después de cada deploy mientras tenía
 * pestañas abiertas.
 *
 * En dev mostramos el mensaje del error; en prod lo escondemos para
 * no exponer detalles técnicos al usuario final.
 */
function DefaultErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const chunkError = isChunkLoadError(error);

  // useEffect porque queremos disparar el reload DESPUÉS de que React
  // termine de renderizar (no en plena reconciliación). El reload solo
  // ocurre una vez por sesión gracias a la flag de sessionStorage.
  useEffect(() => {
    if (chunkError) reloadOnceForStaleChunk();
  }, [chunkError]);

  if (chunkError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>
          {typeof navigator !== "undefined" && navigator.onLine === false
            ? t("hc_router.offline")
            : t("hc_router.updating")}
        </p>
        {/* Si la guarda ya recargó hace menos de un minuto, la recarga automática
            no vuelve a ocurrir: sin este botón la pantalla quedaba sin salida. */}
        <Button size="sm" onClick={() => recargarLaApp()}>
          {t("arranque.reintentar")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center space-y-4">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-8 w-8 text-destructive" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">{t("hc_router.errorTitle")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("hc_router.errorDescription")}
          </p>
        </div>
        {import.meta.env.DEV && error.message && (
          <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-left font-mono text-xs text-destructive">
            {error.message}
          </pre>
        )}
        <div className="flex items-center justify-center gap-3">
          <Button
            onClick={() => {
              router.invalidate();
              reset();
            }}
          >
            {t("hc_router.retry")}
          </Button>
          <Button variant="outline" asChild>
            <a href="/">{t("hc_router.goHome")}</a>
          </Button>
        </div>
      </div>
    </div>
  );
}

export const getRouter = () => {
  // Tenant context para el SuperAdmin "Ver como X" vive en
  // localStorage (`examlab_tenant_override`). La URL queda `/app/...`
  // sin prefix — el intento de poner el slug en la URL (`/t/<slug>/...`)
  // falló en Lovable porque TanStack Start hace SSR y emite 307
  // canonical-redirect cuando el rewrite es asimétrico entre server
  // (no hay `window`, no captura slug) y client. Ver historial git
  // en src/modules/tenants/url.ts para detalles.

  const router = createRouter({
    routeTree,
    context: {},
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultErrorComponent,
  });

  return router;
};
