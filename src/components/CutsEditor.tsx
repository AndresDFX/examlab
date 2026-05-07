/**
 * CutsEditor — Editor de cortes evaluativos del curso.
 *
 * Modelo de pesos (post-migración 20260507130000):
 *   - cut.weight = % de la nota final que aporta el corte (cortes suman 100).
 *   - Cada item (exam, workshop, project) tiene weight = % de la nota final.
 *     Se editan en sus propias pantallas, no acá.
 *   - cut.attendance_weight = % de la nota final para asistencia del corte.
 *   - cut.workshop_weight / exam_weight / project_weight = "buckets" por tipo
 *     dentro del corte. Cada bucket es el cap acumulado de los items de ese
 *     tipo. Suma de 4 buckets (workshop + exam + project + attendance) debe
 *     igualar cut.weight.
 *   - Validación soft: si los items asignados no llenan el bucket exacto,
 *     se muestra warning pero el cálculo sigue funcionando con
 *     computeWeightedGrade (items con score=null cuentan como 0).
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
  // Buckets por tipo dentro del corte. Suman cut.weight junto con
  // attendance_weight. Caps de los items en sus respectivos forms.
  exam_weight: number;
  workshop_weight: number;
  project_weight: number;
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
        // Buckets por tipo — el docente los configura al expandir el corte.
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
          // Buckets configurados por el docente
          const wsBucket = Number(cut.workshop_weight || 0);
          const exBucket = Number(cut.exam_weight || 0);
          const pjBucket = Number(cut.project_weight || 0);
          const attBucket = Number(cut.attendance_weight || 0);
          const bucketsSum = wsBucket + exBucket + pjBucket + attBucket;
          // Items realmente asignados por tipo
          const wsAssigned = cutItems
            .filter((i) => i.kind === "workshop")
            .reduce((a, b) => a + Number(b.weight || 0), 0);
          const exAssigned = cutItems
            .filter((i) => i.kind === "exam")
            .reduce((a, b) => a + Number(b.weight || 0), 0);
          const pjAssigned = cutItems
            .filter((i) => i.kind === "project")
            .reduce((a, b) => a + Number(b.weight || 0), 0);
          const expected = Number(cut.weight || 0);
          const matches = Math.abs(bucketsSum - expected) < 0.01;
          const overAllocated = bucketsSum > expected + 0.01;
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
                  <p className="text-[11px] text-muted-foreground">
                    Define cuánto vale cada tipo de actividad dentro de este corte. La suma de los 4
                    buckets debe igualar el peso del corte ({expected || 0}%). Cada item individual
                    (taller/examen/proyecto) compite por su bucket — al crearlo, el max permitido
                    será el remanente del bucket.
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <BucketInput
                      label="Talleres"
                      icon={Hammer}
                      value={wsBucket}
                      assigned={wsAssigned}
                      max={expected}
                      onChange={(v) => updateCut(cut.id, { workshop_weight: v })}
                    />
                    <BucketInput
                      label="Exámenes"
                      icon={FileText}
                      value={exBucket}
                      assigned={exAssigned}
                      max={expected}
                      onChange={(v) => updateCut(cut.id, { exam_weight: v })}
                    />
                    <BucketInput
                      label="Proyectos"
                      icon={FolderKanban}
                      value={pjBucket}
                      assigned={pjAssigned}
                      max={expected}
                      onChange={(v) => updateCut(cut.id, { project_weight: v })}
                    />
                    <BucketInput
                      label="Asistencia"
                      icon={null}
                      value={attBucket}
                      assigned={attBucket}
                      max={expected}
                      onChange={(v) => updateCut(cut.id, { attendance_weight: v })}
                      hideAssigned
                    />
                  </div>

                  <div className="flex items-center justify-end">
                    <Badge
                      variant={
                        matches ? "secondary" : overAllocated ? "destructive" : "outline"
                      }
                      className="text-xs whitespace-nowrap"
                      title="Suma de los 4 buckets vs peso del corte"
                    >
                      Buckets: {bucketsSum.toFixed(1)} / {expected || 0}
                      {!matches && expected > 0 && (
                        <span className="ml-1">
                          ({overAllocated ? "exceso" : "faltan"}{" "}
                          {Math.abs(expected - bucketsSum).toFixed(1)})
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

/**
 * Input de un bucket. Muestra el peso configurado y, si hay items
 * asignados de ese tipo, cuánto del bucket ya está consumido.
 */
function BucketInput({
  label,
  icon: Icon,
  value,
  assigned,
  max,
  onChange,
  hideAssigned = false,
}: {
  label: string;
  icon: typeof FileText | null;
  value: number;
  assigned: number;
  max: number;
  onChange: (v: number) => void;
  hideAssigned?: boolean;
}) {
  const over = !hideAssigned && assigned > value + 0.01;
  return (
    <div>
      <Label className="text-xs flex items-center gap-1">
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
        {label}
      </Label>
      <Input
        type="number"
        min={0}
        max={max || undefined}
        step="0.1"
        value={value || ""}
        onChange={(e) => {
          const raw = e.target.value === "" ? 0 : Number(e.target.value);
          onChange(max > 0 ? Math.min(raw, max) : raw);
        }}
        className="mt-1"
      />
      {!hideAssigned && (
        <p
          className={`text-[10px] mt-1 tabular-nums ${
            over ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          Asignado: {assigned.toFixed(1)} / {value.toFixed(1)}
          {over && <span className="ml-1">(exceso)</span>}
        </p>
      )}
    </div>
  );
}
