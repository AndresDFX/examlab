import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/shared/lib/utils";

export interface PasswordInputProps
  extends Omit<React.ComponentProps<typeof Input>, "type"> {
  /** Clases para el wrapper `relative` externo (ej. `flex-1`, `mt-1`). */
  wrapperClassName?: string;
  /** aria-label del botón cuando la contraseña está OCULTA (acción: mostrar). */
  revealLabel?: string;
  /** aria-label del botón cuando la contraseña está VISIBLE (acción: ocultar). */
  hideLabel?: string;
}

/**
 * Input de contraseña con botón "ojo" integrado para mostrar/ocultar.
 *
 * Reemplaza el patrón duplicado `<div relative><Input type={show?…}/> +
 * <button ojo></div>` que estaba copiado en ~7 pantallas. Maneja su propio
 * estado de visibilidad: el caller solo usa value/onChange/placeholder/etc.
 * como en cualquier Input. Cualquier campo de contraseña nuevo DEBE usar
 * este componente para que siempre tenga el ojo (ver CLAUDE.md).
 *
 * Los aria-label del botón son props (`revealLabel`/`hideLabel`) con default
 * en español; en flujos i18n pasar `t("auth.showPassword")` / `hidePassword`.
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  (
    {
      className,
      wrapperClassName,
      revealLabel = "Mostrar contraseña",
      hideLabel = "Ocultar contraseña",
      ...props
    },
    ref,
  ) => {
    const [show, setShow] = React.useState(false);
    return (
      <div className={cn("relative", wrapperClassName)}>
        <Input
          ref={ref}
          type={show ? "text" : "password"}
          className={cn("pr-9", className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? hideLabel : revealLabel}
          // tabIndex -1: el toggle no entra en el orden de tabulación del
          // form — se opera con click; así Tab salta del input al siguiente
          // campo, no al ojo.
          tabIndex={-1}
          className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
