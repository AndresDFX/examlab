/**
 * AssignSelector — UI única para "asignar personas a X" (estudiantes a un
 * curso, docentes a un curso, estudiantes a un proyecto, estudiantes a un
 * examen, etc.).
 *
 * Antes cada flujo había evolucionado por su lado: el de estudiantes-curso
 * tenía búsqueda y bulk actions, el de docentes-curso era minimal, el de
 * proyectos tenía chips por curso pero sin búsqueda, el de exámenes vivía
 * en una Card sin búsqueda. Este componente unifica:
 *  - Caja de búsqueda con icono.
 *  - Header con contador (selected / total · filtrados) y botones
 *    "Seleccionar/Deseleccionar [todos|filtrados]".
 *  - Lista scrolleable con checkbox + nombre + email + badge.
 *
 * El consumidor pasa `headerExtras` para agregar UI específica (p.ej. los
 * chips de filtro por curso del flujo de proyectos) sin romper el patrón.
 */
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Search, CheckSquare, XSquare, Loader2 } from "lucide-react";

export type AssignSelectorItem = {
  id: string;
  full_name: string | null;
  institutional_email: string | null;
};

interface Props {
  items: AssignSelectorItem[];
  selectedIds: Set<string>;
  onToggle: (id: string, checked: boolean) => void;
  /** El parent decide qué hacer con los IDs visibles (filtrados o no). */
  onSelectAll: (visibleIds: string[]) => void;
  onDeselectAll: (visibleIds: string[]) => void;
  /** Texto del badge en filas seleccionadas. Default: "Asignado". */
  selectedLabel?: string;
  /** Mostrado cuando items está vacío o el filtro no devuelve nada. */
  emptyText?: string;
  searchPlaceholder?: string;
  /** Se pinta arriba del search; útil para chips o helpers. */
  headerExtras?: React.ReactNode;
  loading?: boolean;
  errorText?: string | null;
  /** Texto sustantivo para los contadores ("matriculados", "asignados", …). */
  countNoun?: string;
}

export function AssignSelector({
  items,
  selectedIds,
  onToggle,
  onSelectAll,
  onDeselectAll,
  selectedLabel = "Asignado",
  emptyText = "Sin resultados",
  searchPlaceholder = "Buscar por nombre o email…",
  headerExtras,
  loading = false,
  errorText = null,
  countNoun = "asignados",
}: Props) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        (i.full_name ?? "").toLowerCase().includes(q) ||
        (i.institutional_email ?? "").toLowerCase().includes(q),
    );
  }, [items, search]);

  const isSearching = search.trim().length > 0;

  return (
    <div className="space-y-3">
      {headerExtras}

      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-9"
        />
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">
          {selectedIds.size} {countNoun} de {items.length}
          {isSearching && ` · ${filtered.length} filtrados`}
        </span>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => onSelectAll(filtered.map((i) => i.id))}
            disabled={loading || filtered.length === 0}
          >
            <CheckSquare className="h-3 w-3" /> Seleccionar{" "}
            {isSearching ? "filtrados" : "todos"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => onDeselectAll(filtered.map((i) => i.id))}
            disabled={loading || filtered.length === 0}
          >
            <XSquare className="h-3 w-3" /> Deseleccionar{" "}
            {isSearching ? "filtrados" : "todos"}
          </Button>
        </div>
      </div>

      <div className="max-h-72 overflow-y-auto space-y-0.5 rounded-md border p-1">
        {loading && (
          <p className="text-sm text-muted-foreground text-center py-4">
            <Loader2 className="inline h-3 w-3 animate-spin mr-1" /> Cargando…
          </p>
        )}
        {!loading && errorText && (
          <p className="text-sm text-destructive text-center py-4">{errorText}</p>
        )}
        {!loading && !errorText && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">{emptyText}</p>
        )}
        {!loading &&
          !errorText &&
          filtered.map((s) => (
            <label
              key={s.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 text-sm cursor-pointer"
            >
              <Checkbox
                checked={selectedIds.has(s.id)}
                onCheckedChange={(v) => onToggle(s.id, !!v)}
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{s.full_name ?? "—"}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {s.institutional_email ?? ""}
                </div>
              </div>
              {selectedIds.has(s.id) && (
                <Badge variant="secondary" className="text-[9px] shrink-0">
                  {selectedLabel}
                </Badge>
              )}
            </label>
          ))}
      </div>
    </div>
  );
}
