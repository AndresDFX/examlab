/**
 * Filtro por fecha EXACTA o por rango, para las barras de filtros.
 *
 * Es un botón que abre dos selectores de fecha —«Desde» y «Hasta»—, con el
 * mismo aspecto que `MultiSelectFilter`, que es el vecino con el que comparte
 * la fila.
 *
 * ── Por qué no hay un modo «exacta» ───────────────────────────────────
 *
 * Una fecha exacta es el rango con los dos extremos iguales, y para eso está el
 * botón **«Un solo día»**: pone los dos campos en el mismo valor de un clic. Un
 * selector «exacta / rango» sería un control más que decidir ANTES de poder
 * filtrar, para algo que el rango ya expresa.
 *
 * ── Por qué el resumen dice el rango y no «Fechas» ────────────────────
 *
 * El botón cerrado muestra «1–5 oct» o «desde 1 oct». Es la misma razón por la
 * que `MultiSelectFilter` lleva `entidadPlural`: con cuatro filtros en la fila,
 * uno que dice siempre lo mismo obliga a abrirlo para saber qué tiene puesto.
 *
 * La decisión de QUÉ fila entra la toma `enRangoDeFechas`; acá solo se elige el
 * rango.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarRange, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DatePicker } from "@/components/ui/date-picker";
import { formatDateShort } from "@/shared/lib/format";
import { normalizarRango, rangoVacio, type RangoFechas } from "@/shared/lib/rango-de-fechas";

/** «1–5 oct», «desde 1 oct», «hasta 5 oct», o el día suelto si son iguales. */
export function resumirRango(
  r: RangoFechas,
  textos: { desde: (f: string) => string; hasta: (f: string) => string; vacio: string },
): string {
  if (rangoVacio(r)) return textos.vacio;
  const { desde, hasta } = normalizarRango(r);
  // `formatDateShort` ancla a mediodía local, así que un `yyyy-MM-dd` no
  // retrocede un día por UTC — el bug que ya documenta `formatDateOnly`.
  const f = (d: string) => formatDateShort(`${d}T12:00:00`);
  if (desde && hasta) return desde === hasta ? f(desde) : `${f(desde)} – ${f(hasta)}`;
  if (desde) return textos.desde(f(desde));
  return textos.hasta(f(hasta as string));
}

export function DateRangeFilter({
  rango,
  onChange,
  label,
  triggerClassName,
}: {
  rango: RangoFechas;
  onChange: (r: RangoFechas) => void;
  /** Qué fecha se está filtrando ("Entrega", "Sesión"…). Sale en el encabezado
   *  del panel: sin eso, con dos grids distintos el usuario no sabe si filtra
   *  por inicio o por cierre. */
  label?: string;
  triggerClassName?: string;
}) {
  const { t } = useTranslation();
  const [abierto, setAbierto] = useState(false);
  const activo = !rangoVacio(rango);
  const resumen = resumirRango(rango, {
    vacio: t("filtroFechas.todas"),
    desde: (f) => t("filtroFechas.desdeResumen", { fecha: f }),
    hasta: (f) => t("filtroFechas.hastaResumen", { fecha: f }),
  });

  return (
    <Popover open={abierto} onOpenChange={setAbierto}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          // `justify-start` + truncado: el resumen puede ser largo («1 oct –
          // 30 nov») y sin esto empuja al resto de la fila de filtros.
          className={`justify-start font-normal ${activo ? "" : "text-muted-foreground"} ${
            triggerClassName ?? "w-full sm:w-52"
          }`}
        >
          <CalendarRange className="h-4 w-4 mr-2 shrink-0" />
          <span className="truncate">{resumen}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] space-y-3" align="start">
        {label && <p className="text-xs font-medium">{label}</p>}
        <div className="space-y-2">
          <div>
            <Label className="text-xs">{t("filtroFechas.desde")}</Label>
            <DatePicker
              value={rango.desde ?? ""}
              onChange={(v) => onChange({ ...rango, desde: v || null })}
            />
          </div>
          <div>
            <Label className="text-xs">{t("filtroFechas.hasta")}</Label>
            <DatePicker
              value={rango.hasta ?? ""}
              onChange={(v) => onChange({ ...rango, hasta: v || null })}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Una fecha EXACTA sin un modo aparte: copia el extremo que ya
              eligió al otro. */}
          <Button
            variant="secondary"
            size="sm"
            disabled={!rango.desde && !rango.hasta}
            onClick={() => {
              const d = rango.desde ?? rango.hasta;
              onChange({ desde: d, hasta: d });
            }}
          >
            {t("filtroFechas.unSoloDia")}
          </Button>
          {activo && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange({ desde: null, hasta: null })}
            >
              <X className="h-4 w-4 mr-1" />
              {t("filtroFechas.limpiar")}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
