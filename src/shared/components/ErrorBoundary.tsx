import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logEvent } from "@/shared/lib/audit";
import i18n from "@/i18n";

/**
 * ErrorBoundary — captura excepciones en el árbol de React que NO
 * llegan al `defaultErrorComponent` de TanStack Router (errores en
 * shared layouts, providers, components fuera de rutas, etc.).
 *
 * Sin esto, una excepción que escape de los componentes provoca que
 * React desmonte todo el subtree y el usuario ve la pantalla en
 * blanco — peor experiencia posible. Con esto, al menos vemos un
 * mensaje claro y un botón para recargar.
 *
 * Importante: solo atrapa errores de RENDER. Errores async (fetch,
 * promesas no manejadas) NO los captura — esos van por el flujo de
 * toast normal o el chunk-error reload del __root.tsx.
 */

interface Props {
  children: ReactNode;
  /** Fallback custom. Si no se pasa, usamos el default centrado. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Detecta errores de chunk-load (deploy nuevo borró el chunk con hash
 * que el HTML viejo todavía referenciaba). Coincide con la lista del
 * handler de `window.addEventListener('error')` en __root.tsx —
 * mantenerlas sincronizadas si cambia una.
 */
function isChunkLoadError(err: Error): boolean {
  const msg = err.message ?? "";
  const name = err.name ?? "";
  return (
    name === "ChunkLoadError" ||
    msg.includes("ChunkLoadError") ||
    msg.includes("Loading chunk") ||
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed")
  );
}

/**
 * Recarga la página UNA sola vez por sesión cuando detectamos un
 * chunk-error. Sin la flag `examlab:reloaded` en sessionStorage, un
 * chunk roto en el HTML nuevo (poco probable pero posible) entraría
 * en bucle de recarga infinito. La flag se limpia al `load` exitoso
 * desde __root.tsx.
 */
function reloadOnceForStaleChunk(): void {
  try {
    if (sessionStorage.getItem("examlab:reloaded") === "1") return;
    sessionStorage.setItem("examlab:reloaded", "1");
  } catch {
    /* sessionStorage bloqueado en safari incognito — recarga igual */
  }
  window.location.reload();
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Chunk-load fail durante un render (lazy route que apunta a un
    // chunk borrado por el deploy): NO mostrar la UI de fallback.
    // Recargamos UNA vez — el HTML nuevo trae los chunks correctos.
    // El listener global de __root.tsx también capta esto, pero
    // SOLO si el error escapa al runtime; cuando React lo atrapa en
    // su ErrorBoundary (este), `window.error` nunca dispara → hay
    // que detectarlo acá también para cerrar el loop.
    if (isChunkLoadError(error)) {
      reloadOnceForStaleChunk();
      return;
    }
    // Logueo a console para que en prod quede registro mínimo en
    // las DevTools del usuario; si tienes Sentry/LogRocket aquí es
    // donde reportarías. Mantengo el warn en lugar de console.error
    // porque ya React lo loguea como error en su propio canal.
    console.warn("[ErrorBoundary] caught", error, info.componentStack);
    // Audit log: el render boundary atrapó un error de UI. Truncamos el
    // stack para no inflar audit_logs (typical stacks son cientos de
    // líneas; los primeros 2KB suelen ser suficientes para diagnóstico).
    void logEvent({
      action: "app.render_error",
      category: "system",
      severity: "error",
      entityName: error.name || "Error",
      metadata: {
        message: (error.message ?? "").slice(0, 500),
        stack: (error.stack ?? "").slice(0, 2000),
        component_stack: (info.componentStack ?? "").slice(0, 2000),
        url: typeof window !== "undefined" ? window.location.pathname : null,
      },
    });
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      // Para chunk-errors no mostramos UI — `componentDidCatch` ya
      // disparó el reload. Mientras se procesa, renderizamos un
      // placeholder mínimo para evitar el flash del fallback rojo.
      if (isChunkLoadError(error)) {
        return (
          <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
            {i18n.t("hc_sharedComponentsErrorBoundary.updating")}
          </div>
        );
      }
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return <DefaultFallback error={error} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultFallback({ error, onReset }: { error: Error; onReset: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center space-y-4">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-8 w-8 text-destructive" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">{t("hc_sharedComponentsErrorBoundary.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("hc_sharedComponentsErrorBoundary.description")}
          </p>
        </div>
        {import.meta.env.DEV && error.message && (
          <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-left font-mono text-xs text-destructive">
            {error.message}
          </pre>
        )}
        <div className="flex items-center justify-center gap-3">
          <Button onClick={onReset}>{t("hc_sharedComponentsErrorBoundary.retry")}</Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            {t("hc_sharedComponentsErrorBoundary.reloadPage")}
          </Button>
        </div>
      </div>
    </div>
  );
}
