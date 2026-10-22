/**
 * El indicador visible de una «condición por estudiante» (tope de nota, plazo
 * propio y/o entrega individual) en una actividad.
 *
 * - `CondicionPopover`: una insignia compacta (ícono `UserPen`) que abre un
 *   panel con el detalle. Se usa en la celda del libro de notas, en el diálogo de
 *   calificación y en el encabezado de la tarjeta del estudiante. Popover y no
 *   tooltip, porque en una pantalla táctil el hover no dispara (igual que
 *   `HelpHint`).
 * - `CondicionDetalle`: el mismo detalle como bloque, para el «Ver más» de la
 *   tarjeta del estudiante.
 *
 * `persona` cambia el tratamiento: `"estudiante"` habla en segunda persona
 * («Tienes plazo…»), `"docente"` lo dice neutro («Plazo propio…»).
 *
 * El ícono `UserPen` es el del concepto «condición por estudiante» en toda la app
 * (botón del docente + estos indicadores): no se usa para otra cosa.
 */
import { UserPen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatDateTime, formatNumber } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";
import { plazoPropioVigente, type CondicionEstudiante } from "./condiciones-estudiante";

type Persona = "estudiante" | "docente";

const nota2 = (n: number) => formatNumber(n, { maximumFractionDigits: 2 });

/** Las líneas activas de una condición, ya traducidas, para listarlas. */
function lineasDeCondicion(
  c: CondicionEstudiante,
  t: (k: string, o?: Record<string, unknown>) => string,
  persona: Persona,
  ahora: number,
): string[] {
  const est = persona === "estudiante";
  const lineas: string[] = [];
  if (c.plazoPropio != null) {
    const fecha = formatDateTime(c.plazoPropio);
    const vigente = plazoPropioVigente(c.plazoPropio, ahora);
    if (vigente) {
      lineas.push(t(est ? "condicionEstudiante.plazoEst" : "condicionEstudiante.plazo", { fecha }));
    } else {
      lineas.push(
        t(est ? "condicionEstudiante.plazoVencidoEst" : "condicionEstudiante.plazoVencido", { fecha }),
      );
    }
  }
  if (c.notaMaxima != null) {
    lineas.push(
      t(est ? "condicionEstudiante.topeEst" : "condicionEstudiante.tope", { nota: nota2(c.notaMaxima) }),
    );
  }
  if (c.entregaIndividual) {
    lineas.push(t(est ? "condicionEstudiante.individualEst" : "condicionEstudiante.individual"));
  }
  return lineas;
}

interface ContenidoProps {
  condicion: CondicionEstudiante;
  persona?: Persona;
  ahora?: number;
  /** Nota del trabajo en la ESCALA DEL CURSO, antes del tope. */
  notaTrabajo?: number | null;
  /** Nota en la ESCALA DEL CURSO después del tope. */
  notaConCondicion?: number | null;
}

/** El cuerpo del detalle: líneas + motivo (+ nota con la condición, si se pasa). */
function Contenido({ condicion, persona = "docente", ahora, notaTrabajo, notaConCondicion }: ContenidoProps) {
  const { t } = useTranslation();
  const lineas = lineasDeCondicion(condicion, t, persona, ahora ?? Date.now());
  // Solo tiene sentido mostrar «antes → después» cuando el tope cambió algo.
  const muestraNota =
    condicion.notaMaxima != null &&
    notaTrabajo != null &&
    notaConCondicion != null &&
    notaConCondicion < notaTrabajo;
  return (
    <div className="space-y-1.5">
      <ul className="space-y-1">
        {lineas.map((l, i) => (
          <li key={i} className="text-xs leading-snug">
            {l}
          </li>
        ))}
      </ul>
      {muestraNota && (
        <p className="text-xs font-medium">
          {t("condicionEstudiante.notaConCondicion", {
            trabajo: nota2(notaTrabajo),
            final: nota2(notaConCondicion),
          })}
        </p>
      )}
      {condicion.motivo && (
        <p className="text-2xs text-muted-foreground">
          {t("condicionEstudiante.motivo", { motivo: condicion.motivo })}
        </p>
      )}
    </div>
  );
}

/** Insignia compacta (ícono `UserPen`) que abre el detalle de la condición. */
export function CondicionPopover({
  className,
  mostrarEtiqueta = true,
  ...props
}: ContenidoProps & { className?: string; mostrarEtiqueta?: boolean }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label={t("condicionEstudiante.badge")}
          className={cn("inline-flex shrink-0 align-middle", className)}
        >
          <Badge
            variant="outline"
            className="cursor-help gap-1 border-primary/40 text-primary"
          >
            <UserPen className="h-3 w-3" />
            {mostrarEtiqueta && t("condicionEstudiante.badge")}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-xs p-3">
        <p className="mb-1 text-xs font-semibold">
          {props.persona === "estudiante"
            ? t("condicionEstudiante.tituloEstudiante")
            : t("condicionEstudiante.tituloDocente")}
        </p>
        <Contenido {...props} />
      </PopoverContent>
    </Popover>
  );
}

/** El detalle como bloque (para el «Ver más» de la tarjeta del estudiante). */
export function CondicionDetalle(props: ContenidoProps) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-primary">
        <UserPen className="h-3.5 w-3.5" />
        {props.persona === "estudiante"
          ? t("condicionEstudiante.tituloEstudiante")
          : t("condicionEstudiante.tituloDocente")}
      </div>
      <Contenido {...props} />
    </div>
  );
}
