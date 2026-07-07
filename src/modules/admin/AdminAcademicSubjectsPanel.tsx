/**
 * Panel CRUD de Asignaturas (Admin).
 *
 * La asignatura es la materia abstracta del plan ("Programación II").
 * Un curso es una INSTANCIA (grupo X, periodo Y). Asociar cursos a
 * asignaturas permite reportes consolidados — "todos los cursos de
 * Programación II históricamente" en N grupos / periodos.
 *
 * Filtro por programa habilita gestión rápida cuando hay muchas
 * asignaturas (típico: 30-60 por programa).
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { ErrorState, TableEmpty } from "@/components/ui/empty-state";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { SearchInput } from "@/components/ui/search-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { BookOpen, Plus, Pencil, Trash2, BookOpenCheck, FilePlus2, Copy } from "lucide-react";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { logEvent } from "@/shared/lib/audit";
import { useNavigate } from "@tanstack/react-router";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface EvalWeights {
  exam_weight?: number;
  workshop_weight?: number;
  project_weight?: number;
  attendance_weight?: number;
  grade_scale_min?: number;
  grade_scale_max?: number;
}

interface Subject {
  id: string;
  name: string;
  code: string | null;
  program_id: string | null;
  semestre: number | null;
  credits: number | null;
  description: string | null;
  active: boolean;
  // Campos de definición (lo que se dicta) — todos opcionales.
  objetivos: string | null;
  contenidos: string | null;
  sistema_evaluacion: EvalWeights | null;
  bibliografia: string | null;
  intensidad_horaria: number | null;
  course_count?: number;
}

interface Program {
  id: string;
  name: string;
}

interface Draft {
  id: string | null;
  name: string;
  code: string;
  program_id: string | null;
  semestre: number | null;
  credits: number | null;
  description: string;
  active: boolean;
  objetivos: string;
  contenidos: string;
  bibliografia: string;
  intensidad_horaria: number | null;
  // Pesos default de evaluación. Suma esperada = 100. Si suma 0 →
  // no se persiste (sistema_evaluacion queda NULL en DB y el curso
  // hereda los defaults del sistema).
  exam_weight: number;
  workshop_weight: number;
  project_weight: number;
  attendance_weight: number;
  // Escala de calificación de la asignatura. Los cursos creados desde ella
  // la heredan (sobrescribible). null = no definida → el curso usa el default
  // de la institución.
  grade_scale_min: number | null;
  grade_scale_max: number | null;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  code: "",
  program_id: null,
  semestre: null,
  credits: null,
  description: "",
  active: true,
  objetivos: "",
  contenidos: "",
  bibliografia: "",
  intensidad_horaria: null,
  exam_weight: 0,
  workshop_weight: 0,
  project_weight: 0,
  attendance_weight: 0,
  grade_scale_min: null,
  grade_scale_max: null,
};

export function AdminAcademicSubjectsPanel() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Subject[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [programFilter, setProgramFilter] = useState<string>("all");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  // Guard "cambios sin guardar" para el dialog crear/editar asignatura (el
  // sílabo es mucha data: objetivos, contenidos, bibliografía, pesos…). El
  // form ya es UN objeto (`draft`), así que se pasa directo al hook.
  const dirty = useDirtyDialog(open, draft);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const [subRes, progRes, courseCountRes] = await Promise.all([
      db
        .from("academic_subjects")
        .select(
          "id, name, code, program_id, semestre, credits, description, active, objetivos, contenidos, sistema_evaluacion, bibliografia, intensidad_horaria",
        )
        .order("name"),
      db.from("academic_programs").select("id, name").order("name"),
      // Count de cursos por subject_id. Lo agregamos al lado para
      // mostrar 'Cursos: N' en la fila (tracking integral por
      // programa/asignatura que pidió el admin).
      db.from("courses").select("subject_id"),
    ]);
    if (subRes.error) {
      setLoadError(friendlyError(subRes.error, t("hc_modulesAdminAdminAcademicSubjectsPanel.loadErrorFallback")));
      setLoading(false);
      return;
    }
    const countBySubject = new Map<string, number>();
    for (const c of (courseCountRes.data ?? []) as Array<{ subject_id: string | null }>) {
      if (c.subject_id) {
        countBySubject.set(c.subject_id, (countBySubject.get(c.subject_id) ?? 0) + 1);
      }
    }
    const subjects: Subject[] = ((subRes.data ?? []) as Subject[]).map((s) => ({
      ...s,
      course_count: countBySubject.get(s.id) ?? 0,
    }));
    setRows(subjects);
    setPrograms((progRes.data ?? []) as Program[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  const programNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of programs) m.set(p.id, p.name);
    return m;
  }, [programs]);

  const filtered = useMemo(() => {
    let result = rows;
    if (programFilter !== "all") {
      result = result.filter((r) => r.program_id === programFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.code?.toLowerCase().includes(q) ?? false),
      );
    }
    return result;
  }, [rows, search, programFilter]);

  const openNew = () => {
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const openEdit = (r: Subject) => {
    const ev = r.sistema_evaluacion ?? {};
    setDraft({
      id: r.id,
      name: r.name,
      code: r.code ?? "",
      program_id: r.program_id,
      semestre: r.semestre,
      credits: r.credits,
      description: r.description ?? "",
      active: r.active,
      objetivos: r.objetivos ?? "",
      contenidos: r.contenidos ?? "",
      bibliografia: r.bibliografia ?? "",
      intensidad_horaria: r.intensidad_horaria,
      exam_weight: Number(ev.exam_weight ?? 0),
      workshop_weight: Number(ev.workshop_weight ?? 0),
      project_weight: Number(ev.project_weight ?? 0),
      attendance_weight: Number(ev.attendance_weight ?? 0),
      grade_scale_min: ev.grade_scale_min != null ? Number(ev.grade_scale_min) : null,
      grade_scale_max: ev.grade_scale_max != null ? Number(ev.grade_scale_max) : null,
    });
    setOpen(true);
  };

  /** Duplicar: pre-llena el form de creación con TODO el sílabo de la
   *  asignatura origen (objetivos, contenidos, bibliografía, intensidad y
   *  pesos de evaluación). Es el caso de mayor valor: reusar un programa
   *  analítico completo para una variante (ej. la misma materia en otra
   *  carrera/jornada) ajustando solo lo que cambie. id=null + nombre sufijado
   *  para no chocar con un índice único; NO se copian los cursos instanciados
   *  (course_count) — esos se crean aparte desde /app/admin/courses. */
  const duplicate = (r: Subject) => {
    const ev = r.sistema_evaluacion ?? {};
    setDraft({
      id: null,
      name: `${r.name} (copia)`,
      code: r.code ?? "",
      program_id: r.program_id,
      semestre: r.semestre,
      credits: r.credits,
      description: r.description ?? "",
      active: r.active,
      objetivos: r.objetivos ?? "",
      contenidos: r.contenidos ?? "",
      bibliografia: r.bibliografia ?? "",
      intensidad_horaria: r.intensidad_horaria,
      exam_weight: Number(ev.exam_weight ?? 0),
      workshop_weight: Number(ev.workshop_weight ?? 0),
      project_weight: Number(ev.project_weight ?? 0),
      attendance_weight: Number(ev.attendance_weight ?? 0),
      grade_scale_min: ev.grade_scale_min != null ? Number(ev.grade_scale_min) : null,
      grade_scale_max: ev.grade_scale_max != null ? Number(ev.grade_scale_max) : null,
    });
    setOpen(true);
  };

  const save = async () => {
    if (!user) return;
    const name = draft.name.trim();
    if (!name) {
      toast.error(i18n.t("academic.subjects.toastNameRequired"));
      return;
    }
    // Pesos de evaluación: si el admin no completó ninguno (suma 0),
    // dejamos sistema_evaluacion en NULL — el curso instanciado usa
    // los defaults del sistema. Si completó algo, validamos la suma.
    const evalSum =
      draft.exam_weight + draft.workshop_weight + draft.project_weight + draft.attendance_weight;
    if (evalSum > 0 && Math.abs(evalSum - 100) > 0.01) {
      toast.error(i18n.t("academic.subjects.toastEvalWeightsMustSum100", { sum: evalSum }));
      return;
    }
    // Escala: si se definió, validar min < max.
    const hasScale = draft.grade_scale_min != null && draft.grade_scale_max != null;
    if (hasScale && Number(draft.grade_scale_min) >= Number(draft.grade_scale_max)) {
      toast.error(
        i18n.t("academic.subjects.toastScaleInvalid", {
          defaultValue: "La nota mínima de la escala debe ser menor que la máxima.",
        }),
      );
      return;
    }
    setSaving(true);
    const payload = {
      name,
      code: draft.code.trim() || null,
      program_id: draft.program_id,
      semestre: draft.semestre,
      credits: draft.credits,
      description: draft.description.trim() || null,
      active: draft.active,
      objetivos: draft.objetivos.trim() || null,
      contenidos: draft.contenidos.trim() || null,
      bibliografia: draft.bibliografia.trim() || null,
      intensidad_horaria: draft.intensidad_horaria,
      // sistema_evaluacion guarda pesos (si suman 100) y/o la escala. Se
      // persiste si HAY pesos O escala; null solo si no hay nada.
      sistema_evaluacion: (() => {
        const ev: Record<string, number> = {};
        if (evalSum > 0) {
          ev.exam_weight = draft.exam_weight;
          ev.workshop_weight = draft.workshop_weight;
          ev.project_weight = draft.project_weight;
          ev.attendance_weight = draft.attendance_weight;
        }
        if (hasScale) {
          ev.grade_scale_min = Number(draft.grade_scale_min);
          ev.grade_scale_max = Number(draft.grade_scale_max);
        }
        return Object.keys(ev).length > 0 ? ev : null;
      })(),
      updated_by: user.id,
    };
    const { error } = draft.id
      ? await db.from("academic_subjects").update(payload).eq("id", draft.id)
      : await db.from("academic_subjects").insert(payload);
    setSaving(false);
    if (error) {
      toast.error(friendlyError(error, t("hc_modulesAdminAdminAcademicSubjectsPanel.saveErrorFallback")));
      return;
    }
    void logEvent({
      action: draft.id ? "subject.updated" : "subject.created",
      category: "academic",
      severity: "info",
      entityType: "academic_subject",
      entityId: draft.id ?? undefined,
      entityName: name,
      metadata: {
        code: payload.code,
        program_id: payload.program_id,
        semestre: payload.semestre,
        credits: payload.credits,
      },
    });
    toast.success(draft.id ? i18n.t("academic.subjects.toastUpdated") : i18n.t("academic.subjects.toastCreated"));
    setOpen(false);
    void load();
  };

  const remove = async (r: Subject) => {
    const hasCourses = (r.course_count ?? 0) > 0;
    const ok = await confirm({
      title: i18n.t("academic.subjects.confirmDeleteTitle", { name: r.name }),
      description: hasCourses
        ? i18n.t("academic.subjects.confirmDeleteDescWithCourses", { count: r.course_count })
        : i18n.t("academic.subjects.confirmDeleteDesc"),
      confirmLabel: i18n.t("academic.subjects.confirmDeleteLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("academic_subjects").delete().eq("id", r.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    void logEvent({
      action: "subject.deleted",
      category: "academic",
      severity: "warning",
      entityType: "academic_subject",
      entityId: r.id,
      entityName: r.name,
      metadata: { course_count: r.course_count ?? 0 },
    });
    toast.success(i18n.t("academic.subjects.toastDeleted"));
    void load();
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 flex-wrap">
        <CardTitle className="text-base flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-cyan-500" />
          {t("academic.subjects.title")}
        </CardTitle>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t("academic.subjects.new")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {t("academic.subjects.description")}
        </p>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("academic.subjects.searchPlaceholder")}
            />
          </div>
          <Select value={programFilter} onValueChange={setProgramFilter}>
            <SelectTrigger className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("academic.subjects.filterAllPrograms")}</SelectItem>
              {programs.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> {t("academic.subjects.loading")}
          </div>
        ) : loadError ? (
          <ErrorState
            message={t("academic.subjects.loadError")}
            hint={loadError}
            onRetry={() => setRetryNonce((n) => n + 1)}
          />
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <Table fixed resizable>
              <TableHeader>
                <TableRow>
                  <TableHead className="max-w-[260px]">{t("academic.subjects.colName")}</TableHead>
                  <TableHead className="hidden sm:table-cell w-24">{t("academic.subjects.colCode")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("academic.subjects.colProgram")}</TableHead>
                  <TableHead className="hidden sm:table-cell w-20 text-center">{t("academic.subjects.colGrade")}</TableHead>
                  <TableHead className="hidden sm:table-cell w-20 text-center">{t("academic.subjects.colCredits")}</TableHead>
                  <TableHead className="w-20 text-center">{t("academic.subjects.colCourses")}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableEmpty
                    colSpan={7}
                    text={t("academic.subjects.empty")}
                    hint={t("academic.subjects.emptyHint")}
                  />
                ) : (
                  filtered.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        <div className="truncate" title={r.name}>
                          {r.name}
                          {!r.active && (
                            <Badge variant="outline" className="ml-2 text-[10px]">
                              {t("academic.subjects.inactiveBadge")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                        {r.code ?? "—"}
                      </TableCell>
                      <TableCell
                        className="hidden md:table-cell text-sm text-muted-foreground"
                        truncate
                        title={r.program_id ? (programNameById.get(r.program_id) ?? undefined) : undefined}
                      >
                        {r.program_id ? (programNameById.get(r.program_id) ?? "—") : "—"}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-center tabular-nums">
                        {r.semestre ?? "—"}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-center tabular-nums">
                        {r.credits ?? "—"}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {r.course_count ?? 0}
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActionsMenu
                          actions={[
                            { label: t("academic.subjects.actionEdit"), icon: Pencil, onClick: () => openEdit(r) },
                            { label: t("common.duplicate"), icon: Copy, onClick: () => duplicate(r) },
                            {
                              label: t("academic.subjects.actionCreateCourse"),
                              icon: FilePlus2,
                              onClick: () =>
                                void navigate({
                                  to: "/app/admin/courses",
                                  search: { fromSubject: r.id } as never,
                                }),
                              separatorBefore: true,
                            },
                            (r.course_count ?? 0) > 0 && {
                              label: t("academic.subjects.actionViewCourses", { count: r.course_count }),
                              icon: BookOpenCheck,
                              onClick: () =>
                                void navigate({
                                  to: "/app/admin/courses",
                                  search: { subjectFilter: r.id } as never,
                                }),
                            },
                            {
                              label: t("academic.subjects.actionDelete"),
                              icon: Trash2,
                              tone: "destructive",
                              separatorBefore: true,
                              onClick: () => void remove(r),
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={dirty.guardOpenChange(setOpen)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft.id ? t("academic.subjects.editTitle") : t("academic.subjects.createTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-3">
              <div className="space-y-1">
                <Label required>{t("academic.subjects.labelName")}</Label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={t("hc_modulesAdminAdminAcademicSubjectsPanel.placeholderName")}
                />
              </div>
              <div className="space-y-1">
                <Label>{t("academic.subjects.labelCode")}</Label>
                <Input
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  placeholder="PRGII"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t("academic.subjects.labelProgram")}</Label>
              <Select
                value={draft.program_id ?? "__none__"}
                onValueChange={(v) =>
                  setDraft({ ...draft, program_id: v === "__none__" ? null : v })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("academic.subjects.placeholderNoProgram")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t("academic.subjects.placeholderNoProgram")}</SelectItem>
                  {programs.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t("academic.subjects.labelGrade")}</Label>
                <Input
                  type="number"
                  min={1}
                  max={12}
                  value={draft.semestre ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      semestre: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="1–12"
                />
              </div>
              <div className="space-y-1">
                <Label>{t("academic.subjects.labelCredits")}</Label>
                <Input
                  type="number"
                  min={0}
                  max={20}
                  value={draft.credits ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      credits: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="0–20"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t("academic.subjects.labelDescription")}</Label>
              <Textarea
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder={t("hc_modulesAdminAdminAcademicSubjectsPanel.placeholderDescription")}
                rows={2}
              />
            </div>

            {/* ── Definición de qué se dicta (template del curso) ─────────────
                Estos campos no se autocompletan en el curso instanciado al pie
                de la letra; sirven como referencia institucional + para que
                los informes (acuerdo pedagógico, acta) puedan citarlos. */}
            <div className="rounded-md border p-3 space-y-3 bg-muted/30">
              <p className="text-sm font-medium">{t("academic.subjects.labelPlanTitle")}</p>
              <div className="space-y-1">
                <Label className="text-xs">{t("academic.subjects.labelObjetivos")}</Label>
                <Textarea
                  value={draft.objetivos}
                  onChange={(e) => setDraft({ ...draft, objetivos: e.target.value })}
                  placeholder={t("hc_modulesAdminAdminAcademicSubjectsPanel.placeholderObjetivos")}
                  rows={3}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("academic.subjects.labelContenidos")}</Label>
                <Textarea
                  value={draft.contenidos}
                  onChange={(e) => setDraft({ ...draft, contenidos: e.target.value })}
                  placeholder={t("hc_modulesAdminAdminAcademicSubjectsPanel.placeholderContenidos")}
                  rows={4}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("academic.subjects.labelBibliografia")}</Label>
                <Textarea
                  value={draft.bibliografia}
                  onChange={(e) => setDraft({ ...draft, bibliografia: e.target.value })}
                  placeholder={t("hc_modulesAdminAdminAcademicSubjectsPanel.placeholderBibliografia")}
                  rows={2}
                />
              </div>
              <div>
                <Label className="text-xs">{t("academic.subjects.labelIntensidad")}</Label>
                <Input
                  type="number"
                  min={0}
                  max={60}
                  value={draft.intensidad_horaria ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      intensidad_horaria:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder={t("hc_modulesAdminAdminAcademicSubjectsPanel.placeholderIntensidad")}
                  className="w-32"
                />
              </div>
            </div>

            {/* ── Sistema de evaluación sugerido (% por tipo) ─────────────
                Pesos default que el curso instanciado puede heredar para
                ahorrar configuración. Si se dejan en 0 (default), el curso
                usa los defaults del sistema. */}
            <div className="rounded-md border p-3 space-y-3 bg-muted/30">
              <p className="text-sm font-medium">
                {t("academic.subjects.labelEvalTitle")}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  {t("academic.subjects.labelEvalNote")}
                </span>
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <Label className="text-xs">{t("academic.subjects.labelExamWeight")}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.exam_weight}
                    onChange={(e) =>
                      setDraft({ ...draft, exam_weight: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs">{t("academic.subjects.labelWorkshopWeight")}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.workshop_weight}
                    onChange={(e) =>
                      setDraft({ ...draft, workshop_weight: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs">{t("academic.subjects.labelProjectWeight")}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.project_weight}
                    onChange={(e) =>
                      setDraft({ ...draft, project_weight: Number(e.target.value) || 0 })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs">{t("academic.subjects.labelAttendanceWeight")}</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={draft.attendance_weight}
                    onChange={(e) =>
                      setDraft({ ...draft, attendance_weight: Number(e.target.value) || 0 })
                    }
                  />
                </div>
              </div>

              {/* Escala de calificación de la asignatura. Los cursos creados
                  desde ella la heredan (sobrescribible). Vacío = el curso usa
                  el default de la institución. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <Label className="text-xs">
                    {t("academic.subjects.labelScaleMin", { defaultValue: "Nota mínima (escala)" })}
                  </Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={draft.grade_scale_min ?? ""}
                    placeholder={t("academic.subjects.scalePlaceholderMin", { defaultValue: "Default institución" })}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        grade_scale_min: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs">
                    {t("academic.subjects.labelScaleMax", { defaultValue: "Nota máxima (escala)" })}
                  </Label>
                  <Input
                    type="number"
                    step="0.1"
                    value={draft.grade_scale_max ?? ""}
                    placeholder={t("academic.subjects.scalePlaceholderMax", { defaultValue: "Ej. 5" })}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        grade_scale_max: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("academic.subjects.scaleHint", {
                  defaultValue:
                    "Los cursos creados desde esta asignatura heredan esta escala (puedes cambiarla por curso). Si la dejas vacía, el curso usa el default de la institución.",
                })}
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {t("academic.subjects.evalSumLabel")}{" "}
                <strong>
                  {draft.exam_weight +
                    draft.workshop_weight +
                    draft.project_weight +
                    draft.attendance_weight}
                </strong>
                {" "}/ 100
              </p>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Switch
                checked={draft.active}
                onCheckedChange={(v) => setDraft({ ...draft, active: v })}
              />
              <Label className="text-sm">{t("academic.subjects.labelActive")}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              {t("academic.subjects.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? t("academic.subjects.saving") : draft.id ? t("academic.subjects.saveChanges") : t("academic.subjects.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
