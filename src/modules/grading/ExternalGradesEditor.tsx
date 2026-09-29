import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DecimalInput } from "@/components/ui/decimal-input";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, ClipboardList, Save, Search, UsersRound, X } from "lucide-react";
import { RowAction } from "@/components/ui/row-action";
import { Spinner } from "@/components/ui/spinner";
import { HelpHint } from "@/components/ui/help-hint";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";

/**
 * Editor de notas para actividades externas (parciales/talleres
 * presenciales que ya pasaron y solo se registran). Lista a los
 * estudiantes matriculados en el curso y permite ingresar la nota
 * de cada uno; al guardar persiste en submissions.final_override_grade
 * o workshop_submissions.final_grade según el `kind`. El cálculo de
 * cortes ya promedia esas tablas, así que la nota entra automático
 * en el corte sin tocar la lógica de pesos.
 *
 * No hace cambios optimistas en la grilla — espera la confirmación
 * del backend para reflejar el id de la submission recién creada,
 * porque sin ese id futuras ediciones harían INSERT duplicado.
 */

export type ExternalKind = "exam" | "workshop" | "project";

interface Props {
  kind: ExternalKind;
  /** id del exam o workshop (depende de kind) */
  refId: string;
  /** id del curso al que pertenece — sirve para listar matriculados */
  courseId: string;
  /**
   * Tope de nota. Se IGNORA y se reemplaza por `course.grade_scale_max`
   * leído internamente: las notas externas siempre se ingresan en la
   * escala del curso (0..grade_scale_max), no en max_score del item,
   * porque el docente está transcribiendo manualmente la nota final
   * que ya tenía en su libreta. Mantener max_score=100 acá producía
   * que un "5" se interpretara como 5/100=0.25 al consolidar el corte.
   * Se mantiene la prop por compat con llamadas existentes.
   */
  maxScore?: number;
}

interface Row {
  userId: string;
  fullName: string;
  email: string;
  grade: number | null;
  feedback: string;
  submissionId: string | null;
  hasGrade: boolean;
  /** Snapshot al cargar la fila — usado para detectar cambios sin guardar
   *  y omitir saves redundantes en `Guardar todo`. */
  originalGrade: number | null;
  originalFeedback: string;
  /** Solo talleres/proyectos con grupos: la exposición se califica por grupo. */
  grupoId: string | null;
  grupoNombre: string | null;
}

export function ExternalGradesEditor({ kind, refId, courseId }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [maxScore, setMaxScore] = useState<number>(5);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Fija el tope = grade_scale_max del curso. Las notas externas se
      // guardan en submissions.final_override_grade / *_submissions.final_grade
      // y al consolidar el corte se escalan asumiendo esa escala.
      const coursePromise = supabase
        .from("courses")
        .select("grade_scale_max")
        .eq("id", courseId)
        .maybeSingle();
      const enrPromise = supabase
        .from("course_enrollments")
        .select("user_id")
        .eq("course_id", courseId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any;
      const subsPromise =
        kind === "exam"
          ? db
              .from("submissions")
              .select("id, user_id, final_override_grade, teacher_feedback")
              .eq("exam_id", refId)
          : kind === "workshop"
            ? db
                .from("workshop_submissions")
                .select("id, user_id, final_grade, teacher_feedback")
                .eq("workshop_id", refId)
            : db
                .from("project_submissions")
                .select("id, user_id, final_grade, teacher_feedback")
                .eq("project_id", refId);
      const [{ data: course }, { data: enr, error: enrErr }, { data: subs, error: subsErr }] =
        await Promise.all([coursePromise, enrPromise, subsPromise]);
      if (enrErr) throw enrErr;
      if (subsErr) throw subsErr;
      const courseMax = Number((course as { grade_scale_max?: number } | null)?.grade_scale_max);
      setMaxScore(Number.isFinite(courseMax) && courseMax > 0 ? courseMax : 5);
      const userIds = (enr ?? []).map((e: any) => e.user_id);
      if (userIds.length === 0) {
        setRows([]);
        return;
      }
      const { data: profs, error: pErr } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", userIds);
      if (pErr) throw pErr;

      // Grupos (talleres y proyectos): una actividad externa por grupos —la
      // exposición— se califica una vez por grupo; el editor la replica.
      const grupoDe = new Map<string, { id: string; name: string }>();
      if (kind !== "exam") {
        const gt = kind === "workshop" ? "workshop_groups" : "project_groups";
        const mt = kind === "workshop" ? "workshop_group_members" : "project_group_members";
        const fk = kind === "workshop" ? "workshop_id" : "project_id";
        const { data: gs } = await db.from(gt).select("id, name").eq(fk, refId);
        const grupos = (gs ?? []) as Array<{ id: string; name: string }>;
        if (grupos.length) {
          const { data: ms } = await db
            .from(mt)
            .select("group_id, user_id")
            .in("group_id", grupos.map((g) => g.id));
          const porId = new Map(grupos.map((g) => [g.id, g]));
          for (const m of (ms ?? []) as Array<{ group_id: string; user_id: string }>) {
            const g = porId.get(m.group_id);
            if (g) grupoDe.set(m.user_id, g);
          }
        }
      }

      const subByUser = new Map<string, any>();
      for (const s of (subs ?? []) as any[]) subByUser.set(s.user_id, s);

      const newRows: Row[] = ((profs ?? []) as any[]).map((p) => {
        const sub = subByUser.get(p.id);
        const rawGrade = kind === "exam" ? sub?.final_override_grade : sub?.final_grade;
        const grade = rawGrade != null ? Number(rawGrade) : null;
        const feedback = sub?.teacher_feedback ?? "";
        return {
          userId: p.id,
          fullName: p.full_name ?? "—",
          email: p.institutional_email ?? "",
          grade,
          feedback,
          submissionId: sub?.id ?? null,
          hasGrade: grade != null,
          originalGrade: grade,
          originalFeedback: feedback,
          grupoId: grupoDe.get(p.id)?.id ?? null,
          grupoNombre: grupoDe.get(p.id)?.name ?? null,
        };
      });
      // Con grupos, los integrantes quedan juntos (los sin grupo, al final).
      newRows.sort(
        (a, b) =>
          (a.grupoNombre ?? "￿").localeCompare(b.grupoNombre ?? "￿", "es", {
            numeric: true,
          }) || a.fullName.localeCompare(b.fullName),
      );
      setRows(newRows);
    } catch (e) {
      toast.error(
        i18n.t("toast.modules_grading_ExternalGradesEditor.loadStudentsFailed", {
          defaultValue: "No se pudieron cargar los estudiantes: {{error}}",
          error: friendlyError(e),
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [kind, refId, courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateRow = (userId: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.userId === userId ? { ...r, ...patch } : r)));
  };

  /** Copia nota y observación a los demás integrantes (quedan sin guardar). */
  const aplicarAlGrupo = (row: Row) => {
    if (!row.grupoId) return;
    setRows((prev) =>
      prev.map((r) =>
        r.grupoId === row.grupoId ? { ...r, grade: row.grade, feedback: row.feedback } : r,
      ),
    );
  };

  const validateGrade = (
    n: number | null,
  ): { ok: true; value: number | null } | { ok: false; msg: string } => {
    if (n == null) return { ok: true, value: null };
    if (Number.isNaN(n)) return { ok: false, msg: i18n.t("externalGrades.errorNoteInvalid") };
    if (n < 0) return { ok: false, msg: i18n.t("externalGrades.errorNoteNegative") };
    if (n > maxScore) return { ok: false, msg: i18n.t("externalGrades.errorNoteMax", { max: maxScore }) };
    return { ok: true, value: n };
  };

  /**
   * Persiste una sola fila. Si no hay submission previa, inserta una
   * nueva con campos mínimos (started_at = submitted_at = now). Si ya
   * existe, hace UPDATE para no romper datos previos (intentos del
   * estudiante u otros campos).
   */
  const saveRow = async (row: Row): Promise<boolean> => {
    const v = validateGrade(row.grade);
    if (!v.ok) {
      toast.error(i18n.t("externalGrades.toastSaveFailed", { name: row.fullName, error: v.msg }));
      return false;
    }
    const now = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any;
    if (kind === "exam") {
      if (row.submissionId) {
        const { error } = await db
          .from("submissions")
          .update({
            final_override_grade: v.value,
            teacher_feedback: row.feedback || null,
            status: "completado",
            submitted_at: now,
          })
          .eq("id", row.submissionId);
        if (error) {
          toast.error(i18n.t("externalGrades.toastSaveFailed", { name: row.fullName, error: friendlyError(error) }));
          return false;
        }
      } else {
        const { data, error } = await db
          .from("submissions")
          .insert({
            exam_id: refId,
            user_id: row.userId,
            final_override_grade: v.value,
            teacher_feedback: row.feedback || null,
            started_at: now,
            submitted_at: now,
            status: "completado",
            answers: {},
          })
          .select("id")
          .single();
        if (error) {
          toast.error(i18n.t("externalGrades.toastSaveFailed", { name: row.fullName, error: friendlyError(error) }));
          return false;
        }
        if (data?.id) updateRow(row.userId, { submissionId: data.id });
      }
    } else if (kind === "workshop") {
      if (row.submissionId) {
        const { error } = await db
          .from("workshop_submissions")
          .update({
            final_grade: v.value,
            teacher_feedback: row.feedback || null,
            status: "calificado",
            submitted_at: now,
          })
          .eq("id", row.submissionId);
        if (error) {
          toast.error(i18n.t("externalGrades.toastSaveFailed", { name: row.fullName, error: friendlyError(error) }));
          return false;
        }
      } else {
        const { data, error } = await db
          .from("workshop_submissions")
          .insert({
            workshop_id: refId,
            user_id: row.userId,
            final_grade: v.value,
            teacher_feedback: row.feedback || null,
            submitted_at: now,
            status: "calificado",
          })
          .select("id")
          .single();
        if (error) {
          toast.error(i18n.t("externalGrades.toastSaveFailed", { name: row.fullName, error: friendlyError(error) }));
          return false;
        }
        if (data?.id) updateRow(row.userId, { submissionId: data.id });
      }
    } else {
      // project
      if (row.submissionId) {
        const { error } = await db
          .from("project_submissions")
          .update({
            final_grade: v.value,
            teacher_feedback: row.feedback || null,
            status: "calificado",
            submitted_at: now,
          })
          .eq("id", row.submissionId);
        if (error) {
          toast.error(i18n.t("externalGrades.toastSaveFailed", { name: row.fullName, error: friendlyError(error) }));
          return false;
        }
      } else {
        const { data, error } = await db
          .from("project_submissions")
          .insert({
            project_id: refId,
            user_id: row.userId,
            final_grade: v.value,
            teacher_feedback: row.feedback || null,
            submitted_at: now,
            status: "calificado",
          })
          .select("id")
          .single();
        if (error) {
          toast.error(i18n.t("externalGrades.toastSaveFailed", { name: row.fullName, error: friendlyError(error) }));
          return false;
        }
        if (data?.id) updateRow(row.userId, { submissionId: data.id });
      }
    }
    updateRow(row.userId, { hasGrade: v.value != null });
    return true;
  };

  const handleSaveOne = async (row: Row) => {
    setSavingId(row.userId);
    try {
      const ok = await saveRow(row);
      if (ok) {
        // Snapshot post-save: la fila ya no es dirty hasta el siguiente edit.
        updateRow(row.userId, {
          originalGrade: row.grade,
          originalFeedback: row.feedback,
        });
        toast.success(i18n.t("externalGrades.toastSaved", { name: row.fullName }));
      }
    } finally {
      setSavingId(null);
    }
  };

  /** Filas con cambios sin guardar. La comparación es estricta sobre
   *  `grade` (null vs número) y feedback (trim para evitar marcar dirty
   *  por espacios en blanco accidentales). Usado para el botón de
   *  guardado masivo y el badge contador. */
  const dirtyRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.grade !== r.originalGrade ||
          (r.feedback ?? "").trim() !== (r.originalFeedback ?? "").trim(),
      ),
    [rows],
  );

  const handleSaveAll = async () => {
    setBulkSaving(true);
    let okCount = 0;
    let failCount = 0;
    try {
      for (const row of dirtyRows) {
        // Saltamos filas que igual quedaron vacías (sin nota ni feedback).
        if (row.grade == null && !row.feedback.trim()) continue;
        const ok = await saveRow(row);
        if (ok) {
          okCount += 1;
          // Marcar como "no dirty" actualizando los originales en memoria.
          updateRow(row.userId, {
            originalGrade: row.grade,
            originalFeedback: row.feedback,
          });
        } else {
          failCount += 1;
        }
      }
      if (okCount > 0) {
        const savedPart = i18n.t("externalGrades.toastBulkSaved", { count: okCount });
        const failPart = failCount > 0 ? i18n.t("externalGrades.toastBulkFailed", { count: failCount }) : "";
        toast.success(savedPart + failPart);
      } else if (failCount === 0) {
        toast.info(i18n.t("externalGrades.toastNoChanges"));
      }
    } finally {
      setBulkSaving(false);
    }
  };

  const summary = useMemo(() => {
    const total = rows.length;
    const graded = rows.filter((r) => r.hasGrade).length;
    return { total, graded };
  }, [rows]);

  // Filtra por nombre o correo (case-insensitive). Usado solo para
  // búsqueda visual; el `Guardar todo` sigue iterando `rows` completos.
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.fullName.toLowerCase().includes(q) || (r.email ?? "").toLowerCase().includes(q),
    );
  }, [rows, search]);

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-primary" />
            {t("externalGrades.title")}
            <HelpHint>{t("externalGrades.helpHint", { max: maxScore })}</HelpHint>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-2xs">
              {t("externalGrades.gradedBadge", { graded: summary.graded, total: summary.total })}
            </Badge>
            <Button
              size="sm"
              onClick={handleSaveAll}
              disabled={bulkSaving || loading || dirtyRows.length === 0}
              className="h-8 text-xs"
              title={
                dirtyRows.length === 0
                  ? t("externalGrades.saveAllTitleNone")
                  : t("externalGrades.saveAllTitlePending", { count: dirtyRows.length })
              }
            >
              {bulkSaving ? (
                <Spinner size="sm" className="mr-1.5" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              {dirtyRows.length > 0
                ? t("externalGrades.saveAllButtonCount", { count: dirtyRows.length })
                : t("externalGrades.saveAllButton")}
            </Button>
          </div>
        </div>
        {rows.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("externalGrades.searchPlaceholder")}
                className="h-8 pl-8 pr-8 text-xs"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label={t("externalGrades.clearSearch")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {search && (
              <span className="text-2xs text-muted-foreground tabular-nums">
                {t("externalGrades.filterCount", { filtered: filteredRows.length, total: rows.length })}
              </span>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        {!loading && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4 text-center">
            {t("externalGrades.empty")}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-40">{t("externalGrades.colStudent")}</TableHead>
                <TableHead className="w-32">{t("externalGrades.colScore")}</TableHead>
                <TableHead className="min-w-48 hidden sm:table-cell">{t("externalGrades.colObservation")}</TableHead>
                <TableHead className="w-28 text-right">{t("externalGrades.colAction")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && <TableSkeleton rows={5} cols={4} />}
              {!loading && filteredRows.length === 0 && search && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-6">
                    {t("externalGrades.noMatch", { q: search })}
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                filteredRows.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell className="max-w-40">
                      <div className="font-medium truncate" title={row.fullName}>
                        {row.fullName}
                      </div>
                      <div
                        className="text-xs text-muted-foreground truncate"
                        title={row.email}
                      >
                        {row.email}
                      </div>
                      {row.grupoNombre && (
                        <Badge variant="secondary" className="text-3xs mt-0.5 max-w-full truncate">
                          {row.grupoNombre}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <DecimalInput
                        min={0}
                        max={maxScore}
                        value={row.grade}
                        onChange={(v) => updateRow(row.userId, { grade: v })}
                        placeholder="—"
                        className="h-8 text-sm"
                      />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Textarea
                        rows={2}
                        value={row.feedback}
                        onChange={(e) => updateRow(row.userId, { feedback: e.target.value })}
                        placeholder={t("externalGrades.feedbackPlaceholder")}
                        className="min-h-[44px] text-xs resize-y"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                      {row.grupoId && (
                        <RowAction
                          label={t("externalGrades.applyToGroup", { group: row.grupoNombre })}
                          icon={UsersRound}
                          onClick={() => aplicarAlGrupo(row)}
                          disabled={bulkSaving}
                        />
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSaveOne(row)}
                        disabled={savingId === row.userId || bulkSaving}
                        className="h-8 text-xs"
                      >
                        {savingId === row.userId ? (
                          <Spinner size="sm" className="mr-1" />
                        ) : row.hasGrade ? (
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-emerald-600" />
                        ) : (
                          <Save className="h-3.5 w-3.5 mr-1" />
                        )}
                        {t("externalGrades.saveButton")}
                      </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
