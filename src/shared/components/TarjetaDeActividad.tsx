/**
 * Tarjeta de una actividad en las listas del ESTUDIANTE (exámenes, talleres, proyectos): el contenido
 * arriba y las ACCIONES —entregar, ver el detalle, eliminar mi entrega y los avisos de por qué no se
 * puede— siempre al pie.
 *
 * La grilla estira cada tarjeta al alto de su fila. Con las acciones en el flujo normal, la tarjeta con
 * menos texto dejaba su botón a media altura, desalineado con el de la tarjeta de al lado.
 *
 * Son tres piezas y no una con una prop `acciones` para que cada lista solo ENVUELVA lo que ya tenía, sin
 * mover bloques: `CuerpoDeTarjeta` conserva el `space-y-3` de antes (un enlace con forma de botón sigue
 * con su ancho natural; dentro de una columna flexible se estiraría a todo el ancho).
 */
import { forwardRef, type ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/shared/lib/utils";

export const TarjetaDeActividad = forwardRef<
  HTMLDivElement,
  { children: ReactNode; className?: string }
>(({ children, className }, ref) => (
  <Card ref={ref} className={cn("flex flex-col", className)}>
    <CardContent className="p-5 flex flex-1 flex-col gap-3">{children}</CardContent>
  </Card>
));
TarjetaDeActividad.displayName = "TarjetaDeActividad";

export function CuerpoDeTarjeta({ children }: { children: ReactNode }) {
  return <div className="space-y-3">{children}</div>;
}

/** `empty:hidden`: una actividad sin ninguna acción (cerrada, sin entrega) no deja un hueco al pie. */
export function AccionesDeTarjeta({ children }: { children: ReactNode }) {
  return <div className="mt-auto space-y-3 empty:hidden">{children}</div>;
}
