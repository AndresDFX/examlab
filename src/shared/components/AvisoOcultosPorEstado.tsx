import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Lo que el filtro de ESTADO deja afuera en las listas del estudiante (exámenes, talleres y
 * proyectos). Sin el aviso, entrar después del plazo mostraba una lista vacía sin explicación.
 *
 * Genérico a propósito: nombrar cada actividad oculta llegaba a cuatro renglones de títulos, y
 * no nombra estados porque oculta lo que el estudiante haya desmarcado, no solo vencidos y
 * cerrados. Va con el color de la institución para que no se lea como parte de la lista.
 */
export function AvisoOcultosPorEstado({
  mensaje,
  etiquetaMostrar,
  onMostrar,
}: Readonly<{ mensaje: string; etiquetaMostrar: string; onMostrar: () => void }>) {
  return (
    <div className="col-span-full flex flex-wrap items-center gap-2 rounded-md border border-primary/40 bg-primary/10 p-3 text-sm">
      <Filter className="h-4 w-4 shrink-0 text-primary" />
      <span className="flex-1 min-w-0 font-medium">{mensaje}</span>
      <Button variant="outline" size="sm" onClick={onMostrar}>
        {etiquetaMostrar}
      </Button>
    </div>
  );
}
