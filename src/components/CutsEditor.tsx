/**
 * CutsEditor — Editor de cortes evaluativos del curso.
 *
 * Modelo de pesos (post-migración 20260507100000):
 *   - cut.weight = % de la nota final que aporta el corte (cortes suman 100).
 *   - Items (exams, workshops, projects) tienen weight = % de la nota final.
 *     Se editan en sus propias pantallas, no acá.
 *   - cut.attendance_weight = % de la nota final para la asistencia del corte.
 *   - Validación soft: la suma de (items en el corte + attendance_weight)
 *     debería ser igual a cut.weight para que el reparto sea exacto. Si no
 *     coincide, computeWeightedGrade reescala los pesos automáticamente al
 *     calcular la nota — así nada se rompe pero el docente lo ve en el badge.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, FileText, Hammer, FolderKanban } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { RowAction } from "@/components/ui/row-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/ui/date-picker";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useConfirm } from "@/components/ConfirmDialog";

// grade_cuts y los items aún no están todos en types.ts auto-generados.
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
  attendance_weight: number;
  // Buckets legacy — los queremos en el tipo para no romper el SELECT *,
  // pero no se usan en el render ni el cálculo.
  exam_weight?: number;
  workshop_weight?: number;
  project_weight?: number;
};

type CutItem = {
  id: string;
  kind: "exam" | "workshop" | "project";
  title: string;
  weight: number;
  cut_id: string | null;
};

const ITEM_ICON: Record<CutItem["kind"], typeof FileText> = {
  exam: FileText,
  workshop: Hammer,
  project: FolderKanban,
};
const ITEM_LABEL: Record<CutItem["kind"], string> = {
  exam: "Examen",
  workshop: "Taller",
  project: "Proyecto",
};

export function CutsEditor({ courseId }: Readonly<{ courseId: string }>) {
  const confirm = useConfirm();
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [items, setItems] = useState<CutItem[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [cutsRes, examsRes, workshopsRes, projectsRes] = await Promise.all([
      db.from("grade_cuts").select("*").eq("course_id", courseId).order("position"),
      db
        .from("exams")
        .select("id, title, weight, cut_id, parent_exam_id")
        .eq("course_id", courseId),
      db.from("workshops").select("id, title, weight, cut_id").eq("course_id", courseId),
      db.from("projects").select("id, title, weight, cut_id").eq("course_id", courseId),
    ]);
    setCuts((cutsRes.data ?? []) as Cut[]);
    const merged: CutItem[] = [];
    for (const e of (examsRes.data ?? []) as any[]) {
      // Excluye supletorios (parent_exam_id != null) — no son items propios.
      if (e.parent_exam_id) continue;
      merged.push({
        id: e.id,
        kind: "exam",
        title: e.title,
        weight: Number(e.weight ?? 1),
        cut_id: e.cut_id ?? null,
      });
    }
    for (const w of (workshopsRes.data ?? []) as any[]) {
      merged.push({
        id: w.id,
        kind: "workshop",
        title: w.title,
        weight: Number(w.weight ?? 1),
        cut_id: w.cut_id ?? null,
      });
    }
    for (const p of (projectsRes.data ?? []) as any[]) {
      merged.push({
        id: p.id,
        kind: "project",
        title: p.title,
        weight: Number(p.weight ?? 1),
        cut_id: p.cut_id ?? null,
      });
    }
    setItems(merged);
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
        attendance_weight: 0,
        // Legacy: cero, no se usan en el cálculo nuevo.
        exam_weight: 0,
        workshop_weight: 0,
        project_weight: 0,
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
    const ok = await confirm({
      title: "Eliminar corte",
      description:
        "Se eliminará el corte y los items que lo tenían asignado quedarán sin corte. Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
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
        <div className="space-y-1">
          <p className="text-sm font-medium">Cortes evaluativos</p>
          <p className="text-xs text-muted-foreground max-w-xl">
            Cada corte vale un porcentaje de la nota final del curso (la suma de todos los
            cortes debe ser 100%). Cada examen, taller y proyecto se asigna a un corte y
            tiene un <span className="font-medium text-foreground">peso directo en %</span>{" "}
            de la nota final. La suma de items + asistencia dentro de un corte debe igualar
            el peso del corte.
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
        {cuts.length > 0 && (
          <div className="hidden md:grid items-center gap-2 px-2 md:grid-cols-[auto_2fr_1fr_1fr_1fr_auto] text-[11px] text-muted-foreground">
            <div />
            <div>Nombre del corte</div>
            <div>Fecha inicio</div>
            <div>Fecha fin</div>
            <div>% de la nota final</div>
            <div />
          </div>
        )}
        {cuts.map((cut) => {
          const isOpen = expanded.has(cut.id);
          const cutItems = items.filter((i) => i.cut_id === cut.id);
          const itemsSum = cutItems.reduce((a, b) => a + Number(b.weight || 0), 0);
          const attWeight = Number(cut.attendance_weight || 0);
          const allocated = itemsSum + attWeight;
          const expected = Number(cut.weight || 0);
          const matches = Math.abs(allocated - expected) < 0.01;
          const overAllocated = allocated > expected + 0.01;
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
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </Button>
                <Input
                  value={cut.name}
                  onChange={(e) => updateCut(cut.id, { name: e.target.value })}
                  placeholder="Nombre del corte"
                />
                <DatePicker
                  value={cut.start_date ?? ""}
                  onChange={(v) => updateCut(cut.id, { start_date: v || null })}
                />
                <DatePicker
                  value={cut.end_date ?? ""}
                  onChange={(v) => updateCut(cut.id, { end_date: v || null })}
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
                <RowAction
                  label="Eliminar corte"
                  icon={Trash2}
                  tone="destructive"
                  onClick={() => removeCut(cut.id)}
                />
              </div>

              {isOpen && (
                <div className="space-y-3 rounded bg-background p-3">
                  <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-start">
                    <div>
                      <Label className="text-xs">Asistencia (% de la nota final)</Label>
                      <Input
                        type="number"
                        min={0}
                        max={expected}
                        step="0.1"
                        value={cut.attendance_weight || ""}
                        onChange={(e) => {
                          const raw = e.target.value === "" ? 0 : Number(e.target.value);
                          const capped = expected > 0 ? Math.min(raw, expected) : raw;
                          updateCut(cut.id, { attendance_weight: capped });
                        }}
                        className="w-32 mt-1"
                      />
                      <p className="text-[11px] text-muted-foreground mt-1">
                        Cuánto vale la asistencia de este corte sobre la nota final del curso.
                        Máximo {expected || 0} (lo que vale el corte). Si dejas 0, las
                        sesiones del rango del corte no afectan la nota.
                      </p>
                    </div>
                    <Badge
                      variant={
                        matches ? "secondary" : overAllocated ? "destructive" : "outline"
                      }
                      className="text-xs whitespace-nowrap"
                      title="Suma de pesos asignados al corte (items + asistencia) versus el peso del corte"
                    >
                      Asignado: {allocated.toFixed(1)} / {expected || 0}
                      {!matches && expected > 0 && (
                        <span className="ml-1">
                          ({overAllocated ? "exceso" : "faltan"}{" "}
                          {Math.abs(expected - allocated).toFixed(1)})
                        </span>
                      )}
                    </Badge>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-xs font-medium">Items asignados a este corte</p>
                    {cutItems.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground italic">
                        No hay items asignados. Edita un examen, taller o proyecto y
                        selecciona este corte para que aparezca acá.
                      </p>
                    ) : (
                      <ul className="text-xs space-y-1">
                        {cutItems.map((it) => {
                          const Icon = ITEM_ICON[it.kind];
                          return (
                            <li
                              key={`${it.kind}-${it.id}`}
                              className="flex items-center justify-between gap-2 rounded border bg-muted/40 px-2 py-1"
                            >
                              <span className="flex items-center gap-1.5 min-w-0">
                                <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                <span className="text-[11px] text-muted-foreground shrink-0">
                                  {ITEM_LABEL[it.kind]}:
                                </span>
                                <span className="truncate">{it.title}</span>
                              </span>
                              <span className="font-mono tabular-nums shrink-0">
                                {it.weight.toFixed(1)}%
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
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
