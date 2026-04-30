/**
 * CutsEditor — Inline editor for evaluation cuts (cortes evaluativos) of a course.
 *
 * Each cut has its own date range, weight (relative to the course final grade),
 * and four sub-weights (exams, workshops, attendance, projects) that must sum 100
 * within the cut. The DB triggers `enforce_cut_weights_max_100` already prevent
 * the global cut weight from exceeding 100; sub-weight validation is UI-only.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/DatePicker";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";

// grade_cuts has new sub-weight columns introduced via a migration that may
// not be reflected in src/integrations/supabase/types.ts yet — use a loose cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Cut = {
  id: string;
  course_id: string;
  name: string;
  position: number;
  start_date: string | null;
  end_date: string | null;
  weight: number;
  exam_weight: number;
  workshop_weight: number;
  attendance_weight: number;
  project_weight: number;
};

export function CutsEditor({ courseId }: { courseId: string }) {
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await db
      .from("grade_cuts")
      .select("*")
      .eq("course_id", courseId)
      .order("position");
    setCuts((data ?? []) as Cut[]);
    setLoading(false);
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalWeight = useMemo(
    () => cuts.reduce((acc, c) => acc + Number(c.weight || 0), 0),
    [cuts],
  );

  const addCut = async () => {
    const { data, error } = await db
      .from("grade_cuts")
      .insert({
        course_id: courseId,
        name: `Corte ${cuts.length + 1}`,
        position: cuts.length,
        weight: 0,
        exam_weight: 40,
        workshop_weight: 30,
        attendance_weight: 10,
        project_weight: 20,
      })
      .select()
      .single();
    if (error) return toast.error(error.message);
    setCuts((prev) => [...prev, data as Cut]);
    setExpanded((prev) => new Set(prev).add(data.id));
  };

  const updateCut = async (id: string, patch: Partial<Cut>) => {
    setCuts((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    const { error } = await db.from("grade_cuts").update(patch).eq("id", id);
    if (error) toast.error(error.message);
  };

  const removeCut = async (id: string) => {
    if (!window.confirm("¿Eliminar este corte? Se borrarán también sus items.")) return;
    const { error } = await db.from("grade_cuts").delete().eq("id", id);
    if (error) return toast.error(error.message);
    setCuts((prev) => prev.filter((c) => c.id !== id));
  };

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Cortes evaluativos</p>
          <p className="text-xs text-muted-foreground">
            Cada corte tiene fechas, peso global y pesos por componente (deben sumar 100% dentro del corte).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant={totalWeight === 100 || cuts.length === 0 ? "secondary" : "destructive"}
            className="text-xs"
          >
            Total cortes: {totalWeight}%
          </Badge>
          <Button size="sm" type="button" onClick={addCut}>
            <Plus className="mr-1 h-3 w-3" />
            Agregar corte
          </Button>
        </div>
      </div>

      {loading && <p className="text-xs text-muted-foreground">Cargando...</p>}
      {!loading && cuts.length === 0 && (
        <p className="text-xs text-muted-foreground italic">Sin cortes configurados.</p>
      )}

      <div className="space-y-2">
        {cuts.map((cut) => {
          const subSum =
            Number(cut.exam_weight || 0) +
            Number(cut.workshop_weight || 0) +
            Number(cut.attendance_weight || 0) +
            Number(cut.project_weight || 0);
          const isOpen = expanded.has(cut.id);
          return (
            <div key={cut.id} className="rounded border bg-muted/30 p-2 space-y-2">
              <div className="grid items-center gap-2 md:grid-cols-[auto_2fr_1fr_1fr_1fr_auto]">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => toggle(cut.id)}
                  className="h-8 w-8 p-0"
                >
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
                <Input
                  value={cut.name}
                  onChange={(e) => updateCut(cut.id, { name: e.target.value })}
                  placeholder="Nombre del corte"
                />
                <DatePicker
                  value={cut.start_date ?? ""}
                  onChange={(v) => updateCut(cut.id, { start_date: v || null })}
                  placeholder="Inicio"
                />
                <DatePicker
                  value={cut.end_date ?? ""}
                  onChange={(v) => updateCut(cut.id, { end_date: v || null })}
                  placeholder="Fin"
                />
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={cut.weight || ""}
                  onChange={(e) =>
                    updateCut(cut.id, {
                      weight: e.target.value === "" ? 0 : Number(e.target.value),
                    })
                  }
                  placeholder="Peso %"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeCut(cut.id)}
                  title="Eliminar corte"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {isOpen && (
                <div className="space-y-2 rounded bg-background p-2">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div>
                      <Label className="text-xs">Exámenes %</Label>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={cut.exam_weight || ""}
                        onChange={(e) =>
                          updateCut(cut.id, {
                            exam_weight: e.target.value === "" ? 0 : Number(e.target.value),
                          })
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Talleres %</Label>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={cut.workshop_weight || ""}
                        onChange={(e) =>
                          updateCut(cut.id, {
                            workshop_weight: e.target.value === "" ? 0 : Number(e.target.value),
                          })
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Asistencia %</Label>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={cut.attendance_weight || ""}
                        onChange={(e) =>
                          updateCut(cut.id, {
                            attendance_weight: e.target.value === "" ? 0 : Number(e.target.value),
                          })
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Proyecto %</Label>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={cut.project_weight || ""}
                        onChange={(e) =>
                          updateCut(cut.id, {
                            project_weight: e.target.value === "" ? 0 : Number(e.target.value),
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-end">
                    <Badge
                      variant={subSum === 100 ? "secondary" : "destructive"}
                      className="text-xs"
                    >
                      Sub-pesos: {subSum}%
                    </Badge>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
