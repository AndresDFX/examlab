import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/shared/lib/utils";

// Size variants use responsive heights: slightly taller on mobile for
// easier tapping, compact on desktop. The global `@media (pointer: coarse)`
// rule in styles.css guarantees a 44×44 hit area on touch devices regardless.
// `touch-manipulation` disables the 300ms double-tap-to-zoom delay on iOS.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors touch-manipulation select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 md:h-9 px-4 py-2",
        sm: "h-9 md:h-8 rounded-md px-3 text-xs",
        lg: "h-11 md:h-10 rounded-md px-6 md:px-8",
        icon: "h-10 w-10 md:h-9 md:w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

/**
 * Si `onClick` devuelve una Promise, deshabilitamos el botón mientras
 * esa Promise está pendiente para prevenir double-clicks que disparen
 * el mismo request dos veces. Para handlers síncronos no hay cambio.
 *
 * Salimos del wrapping en modo `asChild` porque ahí el handler se le
 * pasa al hijo (un Link, etc.) y el contrato no es "ejecutar este
 * onClick" sino "delegarlo".
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, onClick, disabled, ...props }, ref) => {
    const [pending, setPending] = React.useState(false);
    const wrappedClick = React.useCallback(
      (e: React.MouseEvent<HTMLButtonElement>) => {
        if (!onClick) return;
        const result = onClick(e) as unknown;
        const isThenable =
          !!result && typeof (result as { then?: unknown }).then === "function";
        if (!isThenable) return;
        setPending(true);
        Promise.resolve(result as Promise<unknown>).finally(() => setPending(false));
      },
      [onClick],
    );
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || (!asChild && pending)}
        onClick={asChild ? onClick : wrappedClick}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
