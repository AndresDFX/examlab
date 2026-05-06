import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * SectionLoader y PageLoader — placeholders reutilizables para
 * estados "Cargando…". Antes cada ruta tenía su propio
 *   <div className="flex items-center gap-2 text-muted-foreground p-6">
 *     <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
 *   </div>
 * con paddings y tamaños levemente distintos. Centralizar acá fija
 * el padding, el tono y el spinner.
 *
 * SectionLoader: para una sección dentro de una página (Card, tab,
 * dialog content). Usa un spinner mediano y padding moderado.
 *
 * PageLoader: para toda la página, centrado vertical y horizontal,
 * con spinner grande. Lo usan rutas que cargan datos críticos
 * antes de poder renderizar nada (review de examen, take de examen).
 */

interface LoaderProps {
  text?: string;
  className?: string;
}

export function SectionLoader({ text = "Cargando…", className }: Readonly<LoaderProps>) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-sm text-muted-foreground p-6",
        className,
      )}
    >
      <Spinner size="md" />
      <span>{text}</span>
    </div>
  );
}

export function PageLoader({ text = "Cargando…", className }: Readonly<LoaderProps>) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 min-h-[40vh] text-muted-foreground",
        className,
      )}
    >
      <Spinner size="lg" />
      <span className="text-sm">{text}</span>
    </div>
  );
}
