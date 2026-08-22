/**
 * Afordancia de "volver" — la ÚNICA fuente del ícono y del ancho de hit.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────
 * "Volver" estaba escrito a mano en cada pantalla y las copias divergieron en
 * las tres dimensiones que el usuario percibe:
 *
 *   · el ÍCONO: unas usaban `ArrowLeft`, otras `ChevronLeft`. Son dos gestos
 *     distintos — la flecha dice "salir de acá", el chevron dice "el anterior
 *     de una serie" (mes previo, diapositiva previa, pregunta previa). Usar
 *     chevron para volver enseña que el control es de paginación y el usuario
 *     no lo busca cuando quiere salir.
 *   · el TAMAÑO: `h-3.5` en el encabezado, `h-4` en el resto.
 *   · la SEPARACIÓN: `mr-1` en el ícono en algunos, `gap-1` en el contenedor
 *     en otros.
 *
 * Además, dos textos traducidos traían la flecha COMO CARÁCTER (`"← Volver al
 * inicio"`), así que el enlace mostraba dos flechas: la del ícono y la del
 * texto. Es el modo de falla que justifica centralizar: mientras la flecha
 * viva en el string, cada traducción nueva puede volver a meterla.
 *
 * ── Dos formas, un solo ícono ─────────────────────────────────────────────
 * `BackLink` (miga de pan, `text-xs` apagado) y `BackButton` (botón fantasma)
 * se ven distinto A PROPÓSITO: la miga va ARRIBA del título de una página de
 * detalle y no debe competir con él; el botón va dentro del contenido, donde
 * tiene que leerse como algo pulsable. Lo que NO puede diferir es el ícono, y
 * por eso los dos lo toman de `BACK_ICON`.
 *
 * NO usar ninguna de las dos para "anterior de una serie": eso es
 * `ChevronLeft` y no es volver.
 */
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";

/** El ícono de volver. Se exporta para que un caso raro que no encaje en los
 *  dos componentes siga pintando el MISMO glifo en vez de elegir otro. */
export const BACK_ICON = ArrowLeft;

/** Destino: o una ruta, o un handler. Nunca los dos. */
type BackTarget =
  | { to: string; params?: Record<string, string>; onClick?: never }
  | { onClick: () => void; to?: never; params?: never };

interface BackCommonProps {
  /** Texto visible. Por defecto `common.back` ("Volver" / "Back"). */
  label?: string;
  className?: string;
}

/** Rótulo por defecto, compartido por las dos formas. */
function useBackLabel(label?: string): string {
  const { t } = useTranslation();
  return label ?? t("common.back", { defaultValue: "Volver" });
}

/**
 * Miga de pan de "volver": chica, apagada, para ir ARRIBA del título de una
 * página de detalle. Es la que usa `PageHeader` a través de `backTo`; en una
 * pantalla con `PageHeader` no se agrega otra a mano.
 */
export function BackLink({ label, className, ...target }: BackCommonProps & BackTarget) {
  const resolved = useBackLabel(label);
  const content = (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
      <BACK_ICON className="h-3.5 w-3.5" />
      {resolved}
    </span>
  );
  const shell = cn("inline-flex w-fit", className);

  return target.to ? (
    <Link to={target.to} params={target.params} className={shell} aria-label={resolved}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={target.onClick} className={shell} aria-label={resolved}>
      {content}
    </button>
  );
}

interface BackButtonProps extends BackCommonProps {
  /** Solo el ícono, sin texto. El rótulo pasa a `aria-label` y a `title`, así
   *  que sigue siendo anunciable y con tooltip. El hit queda en 32px, el piso
   *  táctil del proyecto (un `<button>` pelado con un ícono de 16px da ~16px y
   *  es imposible de acertar en un teléfono). */
  iconOnly?: boolean;
}

/**
 * Botón fantasma de "volver", para salir de una vista embebida: el detalle de
 * una entrega, el tablero de un curso, la conversación abierta en móvil.
 */
export function BackButton({
  label,
  className,
  iconOnly = false,
  ...target
}: BackButtonProps & BackTarget) {
  const resolved = useBackLabel(label);
  const icon = <BACK_ICON className="h-4 w-4" />;
  const shared = {
    variant: "ghost" as const,
    size: "sm" as const,
    className: cn(iconOnly ? "h-8 w-8 shrink-0 p-0" : "gap-1.5", className),
    "aria-label": resolved,
    title: iconOnly ? resolved : undefined,
  };

  return target.to ? (
    <Button {...shared} asChild>
      <Link to={target.to} params={target.params}>
        {icon}
        {iconOnly ? null : resolved}
      </Link>
    </Button>
  ) : (
    <Button {...shared} onClick={target.onClick}>
      {icon}
      {iconOnly ? null : resolved}
    </Button>
  );
}
