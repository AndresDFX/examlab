import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";

/**
 * RowAction — botón de acción para grids/listas/tablas. Es ícono-solo
 * (sin texto) con tooltip y aria-label, lo que mantiene el grid
 * compacto pero accesible. Para acciones page-level / dialog footers
 * SE SIGUE USANDO el Button normal con texto + ícono — RowAction es
 * solo para los lugares donde la acción se repite por fila.
 *
 * Variantes:
 *  - default: ghost button (sutil, no compite con el contenido)
 *  - tone="destructive": pinta rojo en hover, para borrar
 *
 * Estados:
 *  - loading: muestra spinner en lugar del ícono y desactiva
 *  - disabled
 *
 * Como Link: pasar `asChild` y meter el <Link> dentro de children.
 * Mantenemos el <Tooltip> envolviendo afuera para que el hover
 * funcione tanto si es <button> como si es <a>.
 */

interface RowActionProps {
  /** Texto del tooltip + aria-label. */
  label: string;
  /** Componente lucide-react del ícono (no la instancia, el componente). */
  icon: ComponentType<{ className?: string }>;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  variant?: "ghost" | "outline";
  tone?: "default" | "destructive";
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  /** Si se pasa, el botón delega el render a children (típicamente <Link>). */
  asChild?: boolean;
  children?: ReactNode;
  type?: "button" | "submit";
}

export const RowAction = forwardRef<HTMLButtonElement, RowActionProps>(function RowAction(
  {
    label,
    icon: Icon,
    onClick,
    variant = "ghost",
    tone = "default",
    disabled,
    loading,
    className,
    asChild,
    children,
    type = "button",
  },
  ref,
) {
  // El glifo del ícono va siempre adentro del `<Button>`. Cuando se
  // usa con `asChild` (típicamente envolviendo un <Link>), tenemos
  // que inyectarlo como hijo del Link — si no, el Link queda vacío
  // y no se ve nada. Clonamos y pisamos los children del Link.
  const glyph = loading ? (
    <Spinner size="md" />
  ) : (
    <Icon className="h-4 w-4" />
  );
  let buttonChildren: ReactNode = glyph;
  if (asChild && isValidElement(children)) {
    buttonChildren = cloneElement(children as ReactElement<{ children?: ReactNode }>, {
      children: glyph,
    });
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          type={type}
          size="icon"
          variant={variant}
          aria-label={label}
          onClick={onClick}
          disabled={disabled || loading}
          asChild={asChild}
          className={cn(
            "h-8 w-8",
            tone === "destructive" &&
              "text-destructive hover:bg-destructive/10 hover:text-destructive",
            className,
          )}
        >
          {buttonChildren}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
});
