/**
 * Teacher grading configuration per course.
 *
 * - Final project vs. coursework split (must sum to 100 to save).
 * - Cuts with name, start/end dates, weight (sum across cuts should be 100).
 * - Items per cut (exam | workshop | project) with weight (sum must be 100).
 *
 * DB triggers prevent a single insert/update from exceeding 100; the UI also
 * surfaces the running sums so the teacher sees the constraint live.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, Plus, Trash2, Save, CheckCircle2, AlertTriangle, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useConfirm } from "@/components/ConfirmDialog";
import { DatePicker } from "@/components/ui/date-picker";

// The grade_* tables are introduced in migration 20260423000000 and are not
// yet reflected in src/integrations/supabase/types.ts. Cast through a loose
// client so queries don't need @ts-expect-error at every call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/teacher/grading/$courseId")({
  component: GradingConfigPage,
});

interface Cut {
  id: string;
  course_id: string;
  name: string;
  position: number;
  start_date: string | null;
  end_date: string | null;
  weight: number;
}

interface CutItem {
  id: string;
  cut_id: string;
  item_type: "exam" | "workshop" | "project";
  exam_id: string | null;
  workshop_id: string | null;
  project_title: string | null;
  weight: number;
}

interface Config {
  final_project_weight: number;
  coursework_weight: number;
}

type ExamRef = { id: string; title: string };
type WorkshopRef = { id: string; title: string };

function GradingConfigPage() {
  const { courseId } = Route.useParams();
  const { t } = useTranslation();
  const confirm = useConfirm();

  const [courseName, setCourseName] = useState("");
  const [config, setConfig] = useState<Config>({ final_project_weight: 0, coursework_weight: 100 });
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [itemsByCut, setItemsByCut] = useState<Record<string, CutItem[]>>({});
  const [exams, setExams] = useState<ExamRef[]>([]);
  const [workshops, setWorkshops] = useState<WorkshopRef[]>([]);
  const [savingConfig, setSavingConfig] = useState(false);

  const loadAll = useCallback(async () => {
    const [courseRes, cfgRes, cutsRes, examsRes, workshopsRes] = await Promise.all([
      supabase.from("courses").select("name").eq("id", courseId).single(),
      db.from("course_grading_config").select("*").eq("course_id", courseId).maybeSingle(),
      db.from("grade_cuts").select("*").eq("course_id", courseId).order("position"),
      supabase.from("exams").select("id, title").eq("course_id", courseId),
      supabase.from("workshops").select("id, title").eq("course_id", courseId),
    ]);
    if (courseRes.data) setCourseName(courseRes.data.name);
    if (cfgRes.data) {
      setConfig({
        final_project_weight: Number(cfgRes.data.final_project_weight),
        coursework_weight: Number(cfgRes.data.coursework_weight),
      });
    }
    const cutList = (cutsRes.data ?? []) as Cut[];
    setCuts(cutList);
    setExams((examsRes.data ?? []) as ExamRef[]);
    setWorkshops((workshopsRes.data ?? []) as WorkshopRef[]);

    if (cutList.length) {
      const { data: items } = await db
        .from("grade_cut_items")
        .select("*")
        .in(
          "cut_id",
          cutList.map((c: Cut) => c.id),
        );
      const grouped: Record<string, CutItem[]> = {};
      for (const it of (items ?? []) as unknown as CutItem[]) {
        (grouped[it.cut_id] ??= []).push(it);
      }
      setItemsByCut(grouped);
    } else {
      setItemsByCut({});
    }
  }, [courseId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const cutsWeightSum = useMemo(
    () => cuts.reduce((acc, c) => acc + Number(c.weight || 0), 0),
    [cuts],
  );
  const configSum = config.final_project_weight + config.coursework_weight;
  const configValid = Math.abs(configSum - 100) < 0.01;

  const saveConfig = async () => {
    if (!configValid) {
      toast.error(t("grading.weightsMustSumTo100"));
      return;
    }
    setSavingConfig(true);
    const { error } = await db.from("course_grading_config").upsert({
      course_id: courseId,
      final_project_weight: config.final_project_weight,
      coursework_weight: config.coursework_weight,
    });
    setSavingConfig(false);
    if (error) return toast.error(error.message);
    toast.success(t("grading.savedToast"));
  };

  const addCut = async () => {
    const { data, error } = await db
      .from("grade_cuts")
      .insert({
        course_id: courseId,
        name: `Corte ${cuts.length + 1}`,
        position: cuts.length,
        weight: 0,
      })
      .select()
      .single();
    if (error) return toast.error(error.message);
    setCuts((prev) => [...prev, data as Cut]);
  };

  const updateCut = async (id: string, patch: Partial<Cut>) => {
    setCuts((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    const { error } = await db.from("grade_cuts").update(patch).eq("id", id);
    if (error) toast.error(error.message);
  };

  const removeCut = async (cut: Cut) => {
    const ok = await confirm({
      title: `Eliminar ${cut.name}`,
      description:
        "Se eliminarán también todos sus items. Esta acción no se puede deshacer.",
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("grade_cuts").delete().eq("id", cut.id);
    if (error) return toast.error(error.message);
    setCuts((prev) => prev.filter((c) => c.id !== cut.id));
    const copy = { ...itemsByCut };
    delete copy[cut.id];
    setItemsByCut(copy);
  };

  const addItem = async (cutId: string, itemType: CutItem["item_type"]) => {
    const { data, error } = await db
      .from("grade_cut_items")
      .insert({
        cut_id: cutId,
        item_type: itemType,
        weight: 0,
        project_title: itemType === "project" ? "Proyecto" : null,
      })
      .select()
      .single();
    if (error) return toast.error(error.message);
    setItemsByCut((prev) => ({
      ...prev,
      [cutId]: [...(prev[cutId] ?? []), data as CutItem],
    }));
  };

  const updateItem = async (item: CutItem, patch: Partial<CutItem>) => {
    const next = { ...item, ...patch } as CutItem;
    setItemsByCut((prev) => ({
      ...prev,
      [item.cut_id]: (prev[item.cut_id] ?? []).map((it) => (it.id === item.id ? next : it)),
    }));
    const { error } = await db.from("grade_cut_items").update(patch).eq("id", item.id);
    if (error) toast.error(error.message);
  };

  const removeItem = async (item: CutItem) => {
    const ok = await confirm({
      title: "Eliminar item del corte",
      description: "Se eliminará este item del corte. La acción no se puede deshacer.",
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("grade_cut_items").delete().eq("id", item.id);
    if (error) return toast.error(error.message);
    setItemsByCut((prev) => ({
      ...prev,
      [item.cut_id]: (prev[item.cut_id] ?? []).filter((it) => it.id !== item.id),
    }));
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Link to="/app/teacher/courses">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("common.back")}
          </Button>
        </Link>
        <div>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">
            {t("grading.configTitle")}
          </h1>
          <p className="text-muted-foreground text-sm">{courseName}</p>
        </div>
      </div>

      {/* Banner de deprecación: la nueva configuración vive en el diálogo de curso. */}
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
        <Info className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
        <div className="space-y-1">
          <p className="font-medium">Vista en transición</p>
          <p className="text-muted-foreground">
            Esta pantalla quedará obsoleta. La configuración oficial de cortes evaluativos vive
            ahora en el diálogo de creación/edición de curso. La nueva jerarquía de calificación
            es: <strong>Curso → Cortes → [Talleres, Exámenes, Proyectos, Asistencia]</strong>.
            Los cambios realizados aquí ya no afectan el cálculo final del estudiante.
          </p>
        </div>
      </div>

      {/* Final project vs. coursework */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("grading.configTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("grading.finalProjectWeight")}</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={config.final_project_weight || ""}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    final_project_weight: e.target.value === "" ? 0 : Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("grading.courseworkWeight")}</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={config.coursework_weight || ""}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    coursework_weight: e.target.value === "" ? 0 : Number(e.target.value),
                  }))
                }
              />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <Badge variant={configValid ? "secondary" : "destructive"}>
              {configValid ? (
                <CheckCircle2 className="mr-1 h-3 w-3" />
              ) : (
                <AlertTriangle className="mr-1 h-3 w-3" />
              )}
              {t("grading.currentSum", { sum: configSum })}
            </Badge>
            <Button onClick={saveConfig} disabled={savingConfig || !configValid}>
              <Save className="mr-1 h-4 w-4" />
              {t("common.save")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Cuts */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">{t("grading.cuts")}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={Math.abs(cutsWeightSum - 100) < 0.01 ? "secondary" : "outline"}>
              {t("grading.currentSum", { sum: cutsWeightSum })}
            </Badge>
            <Button size="sm" onClick={addCut}>
              <Plus className="mr-1 h-4 w-4" />
              {t("grading.addCut")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {cuts.length === 0 && (
            <p className="text-muted-foreground text-sm">{t("common.empty")}</p>
          )}
          {cuts.map((cut) => {
            const items = itemsByCut[cut.id] ?? [];
            const itemSum = items.reduce((a, b) => a + Number(b.weight || 0), 0);
            return (
              <div key={cut.id} className="space-y-3 rounded-md border p-3">
                <div className="grid gap-2 md:grid-cols-[2fr_1fr_1fr_1fr_auto]">
                  <Input
                    value={cut.name}
                    onChange={(e) => updateCut(cut.id, { name: e.target.value })}
                    placeholder={t("grading.cutName")}
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
                    placeholder="%"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeCut(cut)}
                    title={t("common.delete")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div className="bg-muted/40 space-y-2 rounded p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {t("grading.items")} · {t("grading.currentSum", { sum: itemSum })}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" onClick={() => addItem(cut.id, "exam")}>
                        <Plus className="mr-1 h-3 w-3" />
                        {t("grading.exam")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => addItem(cut.id, "workshop")}
                      >
                        <Plus className="mr-1 h-3 w-3" />
                        {t("grading.workshop")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => addItem(cut.id, "project")}
                      >
                        <Plus className="mr-1 h-3 w-3" />
                        {t("grading.project")}
                      </Button>
                    </div>
                  </div>

                  {items.map((it) => (
                    <div
                      key={it.id}
                      className="grid items-center gap-2 md:grid-cols-[120px_1fr_100px_auto]"
                    >
                      <Badge variant="outline" className="justify-center capitalize">
                        {t(`grading.${it.item_type}`)}
                      </Badge>
                      {it.item_type === "exam" && (
                        <Select
                          value={it.exam_id ?? ""}
                          onValueChange={(v) => updateItem(it, { exam_id: v })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t("grading.exam")} />
                          </SelectTrigger>
                          <SelectContent>
                            {exams.map((e) => (
                              <SelectItem key={e.id} value={e.id}>
                                {e.title}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {it.item_type === "workshop" && (
                        <Select
                          value={it.workshop_id ?? ""}
                          onValueChange={(v) => updateItem(it, { workshop_id: v })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t("grading.workshop")} />
                          </SelectTrigger>
                          <SelectContent>
                            {workshops.map((w) => (
                              <SelectItem key={w.id} value={w.id}>
                                {w.title}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {it.item_type === "project" && (
                        <Input
                          value={it.project_title ?? ""}
                          onChange={(e) => updateItem(it, { project_title: e.target.value })}
                          placeholder={t("grading.projectTitle")}
                        />
                      )}
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={it.weight || ""}
                        onChange={(e) =>
                          updateItem(it, {
                            weight: e.target.value === "" ? 0 : Number(e.target.value),
                          })
                        }
                        placeholder="%"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeItem(it)}
                        title={t("common.delete")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
