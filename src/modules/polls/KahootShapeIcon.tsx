/**
 * KahootShapeIcon — renderiza una de las 4 formas de Kahoot (triángulo /
 * rombo / círculo / cuadrado) como ícono relleno. Compartido por la vista
 * host y la del jugador para mantener la identidad visual consistente.
 */
import { Triangle, Diamond, Circle, Square } from "lucide-react";

const MAP: Record<string, typeof Triangle> = {
  triangle: Triangle,
  diamond: Diamond,
  circle: Circle,
  square: Square,
};

export function KahootShapeIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = MAP[icon] ?? Square;
  return <Icon className={className} fill="currentColor" strokeWidth={1.5} />;
}
