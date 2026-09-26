/**
 * El corte de una actividad y cuánto vale de la nota final.
 *
 * Lo pintan las TRES listas del estudiante (exámenes, talleres, proyectos), y
 * por eso vive acá y no dentro de una de ellas: tres copias de la misma
 * etiqueta divergen, y el modo de falla es que el mismo taller se lea distinto
 * según desde qué pantalla lo mire el alumno.
 *
 * La decisión de SI se muestra no es de este componente: la toma
 * `resolverCorteYPeso`, que falla cerrado cuando no puede atribuir el
 * porcentaje. Acá solo se pinta lo que ya se resolvió.
 *
 * El texto dice **«de la nota final»** completo a propósito: el peso es
 * porcentaje de la nota final del curso, no del corte. Un «10%» a secas se lee
 * como «10% del corte» —otro número— y manda al estudiante a una cuenta
 * equivocada justo antes de un parcial.
 */
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { formatPercent } from "@/shared/lib/format";
import type { CorteYPeso } from "@/modules/grading/corte-y-peso";

export function CortePesoBadges({
  valor,
  className,
}: {
  valor: CorteYPeso | null;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!valor) return null;
  return (
    // `flex-nowrap` + `min-w-0`: en una tarjeta angosta el nombre del corte
    // trunca en vez de empujar el porcentaje a una segunda línea y descuadrar
    // el alto de la tarjeta respecto de las de al lado.
    <div className={`flex flex-nowrap items-center gap-1 min-w-0 ${className ?? ""}`}>
      {/* El que TRUNCA es el nombre del corte, y el que no se achica es el
          porcentaje: es el patrón de `BadgeOverflow` —texto que trunca,
          adornos en `shrink-0`—. Al revés, un corte con nombre largo se queda
          con todo el ancho y empuja el porcentaje fuera de la tarjeta. */}
      <Badge
        variant="outline"
        className="text-3xs font-normal min-w-0 flex-1 truncate"
        title={t("cortePeso.cutHint")}
      >
        {valor.corte}
      </Badge>
      <Badge
        variant="secondary"
        className="text-3xs font-normal shrink-0 tabular-nums"
        title={t("cortePeso.weightOfFinalHint")}
      >
        {t("cortePeso.weightOfFinal", { pct: formatPercent(valor.porcentaje) })}
      </Badge>
    </div>
  );
}
