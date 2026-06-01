import { createRouter, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { routeTree } from "./routeTree.gen";
import { createTenantRewrite, clearLegacyOverrideStorage } from "@/modules/tenants/url";

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
    msg.includes("Importing a module script failed")
  );
}

function reloadOnceForStaleChunk(): void {
  try {
    if (sessionStorage.getItem("examlab:reloaded") === "1") return;
    sessionStorage.setItem("examlab:reloaded", "1");
  } catch {
    /* sessionStorage bloqueado — recargar igual */
  }
  window.location.reload();
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
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Actualizando…
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
          <h1 className="text-2xl font-bold tracking-tight">Algo salió mal</h1>
          <p className="text-sm text-muted-foreground">
            Ocurrió un error inesperado. Por favor intenta de nuevo.
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
            Reintentar
          </Button>
          <Button variant="outline" asChild>
            <a href="/">Ir al inicio</a>
          </Button>
        </div>
      </div>
    </div>
  );
}

export const getRouter = () => {
  // Limpia el localStorage del override viejo (legacy). La fuente de
  // verdad ahora es la URL — ver [`url.ts`](src/modules/tenants/url.ts).
  clearLegacyOverrideStorage();

  // Rewrite dinámico para el prefix `/t/<slug>`. NO usamos `basepath`
  // porque TanStack Start hace `router.update({ basepath:
  // process.env.TSS_ROUTER_BASEPATH })` durante la hidratación del
  // cliente, sobrescribiendo cualquier basepath dinámico que pasemos.
  // El `rewrite` SÍ persiste porque router-core lo guarda en
  // `options.rewrite` y lo re-incluye en cada `update`.
  //
  // - INPUT del rewrite: strippea `/t/<slug>` de URLs entrantes → el
  //   router matchea contra `/app/...`.
  // - OUTPUT del rewrite: agrega `/t/<slug>` a URLs salientes → los
  //   Links/navigate generan hrefs con prefix.
  const router = createRouter({
    routeTree,
    context: {},
    rewrite: createTenantRewrite(),
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultErrorComponent,
  });

  return router;
};
