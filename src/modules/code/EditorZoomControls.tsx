/**
 * Los tres botones del zoom de un editor: menos, más y restablecer.
 *
 * ── Por qué es un componente ──────────────────────────────────────────
 * El control va en CUATRO editores: la hoja/pregunta de SQL, el compilador de
 * examen y taller, y los de Java y Python con interfaz gráfica. Son ~30 líneas
 * de JSX idénticas, y la regla de UI de CLAUDE.md pide el componente en vez de
 * la cuarta copia. El diseño es el que ya se había afinado en la hoja de SQL.
 *
 * ── SOLO CLICS: ni atajos de teclado ni Ctrl+rueda ────────────────────
 * Y no es una omisión. La toma de examen intercepta Ctrl+± y Ctrl+rueda a
 * propósito, para que el zoom del NAVEGADOR no saque de pantalla completa y
 * dispare una advertencia de proctoring. Un atajo funcionaría en la pizarra y en
 * el examen no haría nada —o haría otra cosa—, que es peor que no tenerlo.
 *
 * ── El porcentaje ocupa un ancho FIJO ─────────────────────────────────
 * Con ancho automático, pasar de 100 % a 125 % corre los botones y el clic
 * siguiente cae en otro. Se oculta en pantallas chicas, donde el espacio de la
 * barra es el recurso escaso.
 *
 * Usa `RowAction` y no `<Button size="icon">` porque ese ya trae el tooltip y el
 * `aria-label` que un botón icon-only necesita para teclado y lector de
 * pantalla.
 */
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RowAction } from "@/components/ui/row-action";

export interface EditorZoomControlsProps {
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  atMin: boolean;
  atMax: boolean;
  /** Porcentaje actual, para el indicador entre los botones. */
  pct: number;
}

export function EditorZoomControls({
  zoomIn,
  zoomOut,
  reset,
  atMin,
  atMax,
  pct,
}: Readonly<EditorZoomControlsProps>) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1">
      <RowAction
        label={t("bdSql.zoomOut")}
        icon={ZoomOut}
        variant="outline"
        onClick={zoomOut}
        disabled={atMin}
      />
      <span className="hidden w-10 text-center text-2xs tabular-nums text-muted-foreground sm:inline">
        {pct}%
      </span>
      <RowAction
        label={t("bdSql.zoomIn")}
        icon={ZoomIn}
        variant="outline"
        onClick={zoomIn}
        disabled={atMax}
      />
      <RowAction
        label={t("bdSql.zoomReset")}
        icon={RotateCcw}
        variant="outline"
        onClick={reset}
        disabled={atMin}
      />
    </div>
  );
}
