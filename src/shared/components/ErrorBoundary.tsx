import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

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

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logueo a console para que en prod quede registro mínimo en
    // las DevTools del usuario; si tienes Sentry/LogRocket aquí es
    // donde reportarías. Mantengo el warn en lugar de console.error
    // porque ya React lo loguea como error en su propio canal.
    console.warn("[ErrorBoundary] caught", error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return <DefaultFallback error={error} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

function DefaultFallback({ error, onReset }: { error: Error; onReset: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center space-y-4">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-8 w-8 text-destructive" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Algo salió mal</h1>
          <p className="text-sm text-muted-foreground">
            La aplicación encontró un error inesperado. Recargar la página suele resolverlo.
          </p>
        </div>
        {import.meta.env.DEV && error.message && (
          <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-left font-mono text-xs text-destructive">
            {error.message}
          </pre>
        )}
        <div className="flex items-center justify-center gap-3">
          <Button onClick={onReset}>Reintentar</Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Recargar página
          </Button>
        </div>
      </div>
    </div>
  );
}
