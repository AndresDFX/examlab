/**
 * LoadingOverlay — overlay full-screen con spinner + mensaje.
 *
 * Para operaciones LARGAS donde el usuario necesita feedback que diga
 * "esto está pasando, NO toques nada". Casos típicos:
 *   - Bulk import / export (45s+ con throttle).
 *   - Generación con IA inline (10-30s).
 *   - Backup / restore.
 *
 * Diferencia con `<Spinner>` inline:
 *   - Bloquea TODA la pantalla (z-50 + backdrop) — el user no puede
 *     clickear nada accidentalmente y romper la operación.
 *   - Mensaje opcional grande + subtexto explicativo.
 *   - `progress` opcional (0-1) para mostrar una barra cuando el proceso
 *     es N-of-M cuantificable. Para operaciones sin progreso conocido
 *     (un fetch grande), omitirla y queda solo el spinner indeterminado.
 *
 * Uso típico:
 * ```tsx
 * {importing && (
 *   <LoadingOverlay
 *     title="Importando usuarios…"
 *     subtitle={`Procesando ${current} de ${total}. Puede tomar 1-2 min.`}
 *     progress={current / total}
 *   />
 * )}
 * ```
 */
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/shared/lib/utils";

interface LoadingOverlayProps {
  /** Título principal — describe la acción en curso. */
  title: string;
  /** Subtítulo opcional — contexto ("Procesando N de M", tiempo estimado, etc.). */
  subtitle?: string;
  /** Progreso 0..1. Si no se pasa, el spinner es indeterminado. */
  progress?: number;
  /** Variante visual. `solid` = backdrop opaco (bloquea visualmente);
   *  `blur` = blur sutil sobre el fondo. Default `solid`. */
  variant?: "solid" | "blur";
}

export function LoadingOverlay({ title, subtitle, progress, variant = "solid" }: LoadingOverlayProps) {
  const pct = typeof progress === "number" ? Math.max(0, Math.min(1, progress)) : null;
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center p-4",
        variant === "solid"
          ? "bg-background/80 backdrop-blur-sm"
          : "bg-background/40 backdrop-blur",
      )}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex flex-col items-center gap-3 rounded-lg border bg-card px-6 py-5 shadow-lg max-w-[calc(100vw-2rem)] sm:max-w-md">
        <Spinner size="xl" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">{title}</p>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {pct !== null && (
          <div className="w-full space-y-1">
            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${Math.round(pct * 100)}%` }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground text-right tabular-nums">
              {Math.round(pct * 100)}%
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
