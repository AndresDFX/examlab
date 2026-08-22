import { type ReactNode } from "react";
import { BackLink } from "@/components/ui/back-button";
import { cn } from "@/shared/lib/utils";

/**
 * PageHeader — header consistente para páginas de detalle/edición.
 *
 * Antes cada ruta improvisaba su propia estructura (algunas con
 * "Volver" al lado del título compitiendo visualmente, otras con
 * espaciados levemente distintos). Centralizar acá fija el patrón:
 *
 *   [← Volver]                          ← breadcrumb pequeño arriba
 *   Título grande                       ← título dominante
 *   subtítulo muted                     ← contexto/metadata
 *                              [actions] ← slot opcional a la derecha
 *
 * El "Volver" va arriba en su propia fila como link tipo breadcrumb,
 * en vez de Button al lado del título — así el título es lo primero
 * que el usuario lee, no compite con el botón de navegación. Lo pinta
 * `BackLink` (`components/ui/back-button.tsx`), que es la única fuente del
 * ícono de volver en toda la app: acá NO se elige un ícono.
 *
 * Props:
 *  - back: ruta hacia atrás (TanStack Router) o función onClick
 *  - backLabel: texto del enlace (default "Volver")
 *  - title: requerido — el h1 de la página
 *  - subtitle: opcional — descripción/metadata bajo el título
 *  - actions: slot opcional para CTAs alineadas a la derecha
 *    (ej. "Guardar cambios", "Nuevo")
 *  - icon: ícono opcional al lado del título (ej. Monitor, FileText)
 */

interface PageHeaderProps {
  /** Ruta de destino del breadcrumb. Si se omite, se asume back stack. */
  backTo?: string;
  backParams?: Record<string, string>;
  /** Alternativa a backTo: handler custom (history.back, navigate, etc.). */
  onBack?: () => void;
  backLabel?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function PageHeader({
  backTo,
  backParams,
  onBack,
  backLabel,
  title,
  subtitle,
  actions,
  icon,
  className,
}: Readonly<PageHeaderProps>) {
  return (
    <div className={cn("space-y-3", className)}>
      {backTo ? (
        <BackLink to={backTo} params={backParams} label={backLabel} />
      ) : onBack ? (
        <BackLink onClick={onBack} label={backLabel} />
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 min-w-0">
            {icon ? <span className="shrink-0 text-primary">{icon}</span> : null}
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight truncate">{title}</h1>
          </div>
          {subtitle ? (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full sm:max-w-none sm:shrink-0 sm:flex-nowrap">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}
