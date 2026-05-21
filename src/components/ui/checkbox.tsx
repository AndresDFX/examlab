import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";

import { cn } from "@/shared/lib/utils";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      // Tamaño bloqueado con min/max + box-border: defensa contra
      // user-agent styles del <button> (iOS Safari añadía min-height
      // implícita para "tap target", inflando el checkbox a ~30px de
      // alto en celdas con align-middle y mucho espacio vertical).
      // appearance-none + leading-none limpian styling nativo restante.
      "inline-flex items-center justify-center appearance-none leading-none box-border",
      "peer h-4 w-4 min-h-4 min-w-4 max-h-4 max-w-4 shrink-0 grow-0 p-0",
      "rounded-sm border border-primary shadow",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn("flex items-center justify-center text-current")}>
      <Check className="h-3 w-3" strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
