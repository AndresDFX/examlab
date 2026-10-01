import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import { HelpHint } from "@/components/ui/help-hint";
import { friendlyError } from "@/shared/lib/db-errors";
import { matchesQuery } from "@/modules/search/search-text";
import { borradorInicialDeGrupo, resumenDeGrupo, seccionesPorGrupo } from "./nota-de-grupo";
import { escribirNotaExterna, type TipoDeActividadExterna } from "./notas-externas";
import { useCalificarGrupo } from "./use-calificar-grupo";
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
 * Con grupos (talleres y proyectos), los integrantes van juntos debajo de una
 * fila del grupo que lo califica ENTERO con una sola nota (ver
 * nota-de-grupo.ts): cada integrante sigue teniendo su propia fila, así que se
 * puede ajustar a uno solo después.
 *
 * No hace cambios optimistas en la grilla — espera la confirmación
 * del backend para reflejar el id de la submission recién creada,
 * porque sin ese id futuras ediciones harían INSERT duplicado.
 */

export type ExternalKind = TipoDeActividadExterna;

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

type BorradorDeGrupo = { grade: number | null; feedback: string };

export function ExternalGradesEditor({ kind, refId, courseId }: Props) {
  const { t } = useTranslation();
  const { calificar, guardando: guardandoGrupo } = useCalificarGrupo(kind, refId);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [maxScore, setMaxScore] = useState<number>(5);
  /** Nota y observación que se están escribiendo en la fila de cada grupo. */
  const [borradorGrupo, setBorradorGrupo] = useState<Record<string, BorradorDeGrupo>>({});

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any;
      // Talleres y proyectos son M:N: además del curso ancla, los de su tabla
      // de unión. Es la misma lista que usa el editor de grupos, así que un
      // grupo con integrantes de otro curso se puede calificar completo.
      const unionPromise =
        kind === "workshop"
          ? db.from("workshop_courses").select("course_id").eq("workshop_id", refId)
          : kind === "project"
            ? db.from("project_courses").select("course_id").eq("project_id", refId)
            : Promise.resolve({ data: [] });
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
      const [{ data: course }, { data: union }, { data: subs, error: subsErr }] =
        await Promise.all([coursePromise, unionPromise, subsPromise]);
      if (subsErr) throw subsErr;
      // Un curso de la unión que está en la papelera no aporta estudiantes.
      const otros = Array.from(
        new Set(((union ?? []) as { course_id: string }[]).map((r) => r.course_id)),
      ).filter((id) => id !== courseId);
      let vigentes: string[] = [];
      if (otros.length > 0) {
        const { data: cs } = await supabase
          .from("courses")
          .select("id")
          .in("id", otros)
          .is("deleted_at", null);
        vigentes = ((cs ?? []) as { id: string }[]).map((c) => c.id);
      }
      const courseIds = [courseId, ...vigentes];
      const { data: enr, error: enrErr } = await supabase
        .from("course_enrollments")
        .select("user_id")
        .in("course_id", courseIds);
      if (enrErr) throw enrErr;
      const courseMax = Number((course as { grade_scale_max?: number } | null)?.grade_scale_max);
      setMaxScore(Number.isFinite(courseMax) && courseMax > 0 ? courseMax : 5);
      const userIds = Array.from(new Set((enr ?? []).map((e: any) => e.user_id as string)));
      if (userIds.length === 0) {
        setRows([]);
        setBorradorGrupo({});
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
      setBorradorGrupo(
        Object.fromEntries(
          seccionesPorGrupo(newRows).grupos.map((s) => [s.grupoId, borradorInicialDeGrupo(s.filas)]),
        ),
      );
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
   * Persiste una sola fila y devuelve el motivo si no pudo (o `null`). La
   * escritura es la de `notas-externas.ts`, la misma que usa la ventana de
   * grupos: UPDATE si ya tiene fila, INSERT si no.
   *
   * No avisa por sí sola: quien la llama decide cómo mostrar el error.
   */
  const escribirFila = async (row: Row): Promise<string | null> => {
    const v = validateGrade(row.grade);
    if (!v.ok) return v.msg;
    const r = await escribirNotaExterna(kind, refId, {
      userId: row.userId,
      submissionId: row.submissionId,
      grade: v.value,
      feedback: row.feedback,
    });
    if (!r.ok) return r.error;
    if (!row.submissionId && r.submissionId) updateRow(row.userId, { submissionId: r.submissionId });
    updateRow(row.userId, { hasGrade: v.value != null });
    return null;
  };

  const saveRow = async (row: Row): Promise<boolean> => {
    const error = await escribirFila(row);
    if (error) {
      toast.error(i18n.t("externalGrades.toastSaveFailed", { name: row.fullName, error }));
      return false;
    }
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

  // ── Calificar al grupo ────────────────────────────────────────────────
  /** Integrantes COMPLETOS de cada grupo: la búsqueda filtra lo que se ve,
   *  nunca a quién se le escribe la nota del grupo. */
  const secciones = useMemo(() => seccionesPorGrupo(rows), [rows]);
  const integrantesDe = useMemo(
    () => new Map(secciones.grupos.map((s) => [s.grupoId, s.filas])),
    [secciones],
  );
  const hayGrupos = secciones.grupos.length > 0;

  const editarBorrador = (grupoId: string, patch: Partial<BorradorDeGrupo>) => {
    setBorradorGrupo((prev) => ({
      ...prev,
      [grupoId]: { ...(prev[grupoId] ?? { grade: null, feedback: "" }), ...patch },
    }));
  };

  /**
   * Escribe la misma nota en cada integrante (ver `useCalificarGrupo`, que
   * pregunta antes si alguno ya tenía OTRA nota).
   */
  const calificarGrupo = async (grupoId: string, nombre: string): Promise<boolean> => {
    return calificar({
      grupoId,
      nombre,
      integrantes: integrantesDe.get(grupoId) ?? [],
      borrador: borradorGrupo[grupoId] ?? { grade: null, feedback: "" },
      maximo: maxScore,
      onGuardada: (userId, nota) =>
        updateRow(userId, {
          grade: nota.grade,
          feedback: nota.feedback,
          originalGrade: nota.grade,
          originalFeedback: nota.feedback,
          hasGrade: true,
          ...(nota.submissionId ? { submissionId: nota.submissionId } : {}),
        }),
    });
  };

  /**
   * Grupos con una nota escrita en su fila que todavía no se guardó. Cuentan
   * para «Guardar todos»: es el botón principal, y si no los incluyera, quien
   * escribe la nota de cada grupo y lo aprieta se iría creyendo que guardó.
   */
  const gruposPendientes = useMemo(
    () =>
      secciones.grupos.filter((sec) => {
        const b = borradorGrupo[sec.grupoId];
        if (!b || b.grade == null) return false;
        const guardado = borradorInicialDeGrupo(sec.filas);
        return b.grade !== guardado.grade || b.feedback.trim() !== guardado.feedback;
      }),
    [secciones, borradorGrupo],
  );
  const pendientes = dirtyRows.length + gruposPendientes.length;

  const handleSaveAll = async () => {
    setBulkSaving(true);
    let okCount = 0;
    let failCount = 0;
    let gruposGuardados = 0;
    /** Integrantes que su grupo acaba de guardar: su fila ya no se toca. */
    const yaGuardados = new Set<string>();
    try {
      // Primero las notas de grupo (cada una pregunta si va a pisar otra nota).
      for (const sec of gruposPendientes) {
        if (await calificarGrupo(sec.grupoId, sec.nombre)) {
          gruposGuardados += 1;
          for (const f of sec.filas) yaGuardados.add(f.userId);
        }
      }
      for (const row of dirtyRows) {
        if (yaGuardados.has(row.userId)) continue;
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
      } else if (failCount === 0 && gruposGuardados === 0 && gruposPendientes.length === 0) {
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

  // Filtra por nombre, correo o grupo (por palabras y sin tildes). Usado solo
  // para búsqueda visual; «Guardar todo» y la nota del grupo siguen operando
  // sobre `rows` completos.
  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    return rows.filter((r) =>
      matchesQuery(`${r.fullName} ${r.email} ${r.grupoNombre ?? ""}`, search),
    );
  }, [rows, search]);

  const seccionesVisibles = useMemo(() => seccionesPorGrupo(filteredRows), [filteredRows]);
  const ocupado = bulkSaving || guardandoGrupo != null;

  const renderFila = (row: Row, enGrupo: boolean) => (
    <TableRow key={row.userId}>
      <TableCell className="max-w-40">
        {/* La sangría va adentro: la celda trae `md:p-2`, que pisa un `pl-*`. */}
        <div className={enGrupo ? "pl-5 min-w-0" : "min-w-0"}>
          <div className="font-medium truncate" title={row.fullName}>
            {row.fullName}
          </div>
          <div className="text-xs text-muted-foreground truncate" title={row.email}>
            {row.email}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <DecimalInput
          min={0}
          max={maxScore}
          value={row.grade}
          onChange={(v) => updateRow(row.userId, { grade: v })}
          placeholder="—"
          className="h-8 text-sm min-w-16"
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
        <Button
          size="sm"
          variant="outline"
          onClick={() => handleSaveOne(row)}
          disabled={savingId === row.userId || ocupado}
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
      </TableCell>
    </TableRow>
  );

  const renderGrupo = (grupoId: string, nombre: string) => {
    const integrantes = integrantesDe.get(grupoId) ?? [];
    const r = resumenDeGrupo(integrantes);
    const b = borradorGrupo[grupoId] ?? { grade: null, feedback: "" };
    return (
      <TableRow key={`grupo-${grupoId}`} className="bg-muted/40 hover:bg-muted/40">
        <TableCell className="max-w-40">
          <div className="flex items-center gap-1.5 min-w-0">
            <UsersRound className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden />
            <span className="font-medium truncate" title={nombre}>
              {nombre}
            </span>
          </div>
          <div className="text-2xs text-muted-foreground">
            {t("externalGrades.groupStatus", { graded: r.conNota, count: r.total })}
            {r.distintas && ` · ${t("externalGrades.groupDistinct")}`}
          </div>
        </TableCell>
        <TableCell>
          <DecimalInput
            min={0}
            max={maxScore}
            value={b.grade}
            onChange={(v) => editarBorrador(grupoId, { grade: v })}
            placeholder="—"
            className="h-8 text-sm min-w-16"
            aria-label={t("externalGrades.groupGradeAria", { group: nombre })}
          />
        </TableCell>
        <TableCell className="hidden sm:table-cell">
          <Textarea
            rows={2}
            value={b.feedback}
            onChange={(e) => editarBorrador(grupoId, { feedback: e.target.value })}
            placeholder={t("externalGrades.groupFeedbackPlaceholder")}
            className="min-h-[44px] text-xs resize-y"
          />
        </TableCell>
        <TableCell className="text-right">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void calificarGrupo(grupoId, nombre)}
            disabled={ocupado || savingId != null || b.grade == null}
            className="h-8 text-xs"
            title={t("externalGrades.gradeGroupTitle", { count: integrantes.length, group: nombre })}
          >
            {guardandoGrupo === grupoId ? (
              <Spinner size="sm" className="sm:mr-1" />
            ) : (
              <UsersRound className="h-3.5 w-3.5 sm:mr-1" />
            )}
            {/* En el teléfono, solo el ícono: con el texto, la columna de la
                nota se angosta tanto que «4,5» se ve «4». */}
            <span className="sr-only sm:not-sr-only">{t("externalGrades.gradeGroup")}</span>
          </Button>
        </TableCell>
      </TableRow>
    );
  };

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
              disabled={ocupado || loading || pendientes === 0}
              className="h-8 text-xs"
              title={
                pendientes === 0
                  ? t("externalGrades.saveAllTitleNone")
                  : t("externalGrades.saveAllTitlePending", { count: pendientes })
              }
            >
              {bulkSaving ? (
                <Spinner size="sm" className="mr-1.5" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              {pendientes > 0
                ? t("externalGrades.saveAllButtonCount", { count: pendientes })
                : t("externalGrades.saveAllButton")}
            </Button>
          </div>
        </div>
        {hayGrupos && (
          <p className="text-xs text-muted-foreground">{t("externalGrades.groupsHint")}</p>
        )}
        {rows.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={
                  hayGrupos
                    ? t("externalGrades.searchPlaceholderGroups")
                    : t("externalGrades.searchPlaceholder")
                }
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
              {!loading && !hayGrupos && filteredRows.map((row) => renderFila(row, false))}
              {!loading &&
                hayGrupos &&
                seccionesVisibles.grupos.map((s) => (
                  <Fragment key={s.grupoId}>
                    {renderGrupo(s.grupoId, s.nombre)}
                    {s.filas.map((row) => renderFila(row, true))}
                  </Fragment>
                ))}
              {!loading && hayGrupos && seccionesVisibles.sinGrupo.length > 0 && (
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableCell colSpan={4} className="text-xs font-medium text-muted-foreground">
                    {t("externalGrades.noGroupSection", { count: secciones.sinGrupo.length })}
                  </TableCell>
                </TableRow>
              )}
              {!loading && hayGrupos && seccionesVisibles.sinGrupo.map((row) => renderFila(row, false))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
