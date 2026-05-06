import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DecimalInput } from "@/components/ui/decimal-input";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, ClipboardList, Save } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

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

export type ExternalKind = "exam" | "workshop";

interface Props {
  kind: ExternalKind;
  /** id del exam o workshop (depende de kind) */
  refId: string;
  /** id del curso al que pertenece — sirve para listar matriculados */
  courseId: string;
  /** Tope de nota (course.grade_scale_max para exam, workshop.max_score para workshop) */
  maxScore: number;
}

interface Row {
  userId: string;
  fullName: string;
  email: string;
  grade: number | null;
  feedback: string;
  submissionId: string | null;
  hasGrade: boolean;
}

export function ExternalGradesEditor({ kind, refId, courseId, maxScore }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const enrPromise = supabase
        .from("course_enrollments")
        .select("user_id")
        .eq("course_id", courseId);
      const subsPromise =
        kind === "exam"
          ? supabase
              .from("submissions")
              .select("id, user_id, final_override_grade")
              .eq("exam_id", refId)
          : supabase
              .from("workshop_submissions")
              .select("id, user_id, final_grade, teacher_feedback")
              .eq("workshop_id", refId);
      const [{ data: enr, error: enrErr }, { data: subs, error: subsErr }] = await Promise.all([
        enrPromise,
        subsPromise,
      ]);
      if (enrErr) throw enrErr;
      if (subsErr) throw subsErr;
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

      const subByUser = new Map<string, any>();
      for (const s of (subs ?? []) as any[]) subByUser.set(s.user_id, s);

      const newRows: Row[] = ((profs ?? []) as any[]).map((p) => {
        const sub = subByUser.get(p.id);
        const rawGrade =
          kind === "exam" ? sub?.final_override_grade : sub?.final_grade;
        const grade = rawGrade != null ? Number(rawGrade) : null;
        return {
          userId: p.id,
          fullName: p.full_name ?? "—",
          email: p.institutional_email ?? "",
          grade,
          feedback: sub?.teacher_feedback ?? "",
          submissionId: sub?.id ?? null,
          hasGrade: grade != null,
        };
      });
      newRows.sort((a, b) => a.fullName.localeCompare(b.fullName));
      setRows(newRows);
    } catch (e) {
      toast.error(`No se pudieron cargar los estudiantes: ${e instanceof Error ? e.message : e}`);
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
    if (Number.isNaN(n)) return { ok: false, msg: "Nota inválida" };
    if (n < 0) return { ok: false, msg: "La nota no puede ser negativa" };
    if (n > maxScore) return { ok: false, msg: `La nota no puede superar ${maxScore}` };
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
      toast.error(`${row.fullName}: ${v.msg}`);
      return false;
    }
    const now = new Date().toISOString();
    if (kind === "exam") {
      if (row.submissionId) {
        const { error } = await supabase
          .from("submissions")
          .update({
            final_override_grade: v.value,
            status: "completado",
            submitted_at: now,
          })
          .eq("id", row.submissionId);
        if (error) {
          toast.error(`${row.fullName}: ${error.message}`);
          return false;
        }
      } else {
        const { data, error } = await supabase
          .from("submissions")
          .insert({
            exam_id: refId,
            user_id: row.userId,
            final_override_grade: v.value,
            started_at: now,
            submitted_at: now,
            status: "completado",
            answers: {},
          })
          .select("id")
          .single();
        if (error) {
          toast.error(`${row.fullName}: ${error.message}`);
          return false;
        }
        if (data?.id) updateRow(row.userId, { submissionId: data.id });
      }
    } else {
      // workshop
      if (row.submissionId) {
        const { error } = await supabase
          .from("workshop_submissions")
          .update({
            final_grade: v.value,
            teacher_feedback: row.feedback || null,
            status: "calificado",
            submitted_at: now,
          })
          .eq("id", row.submissionId);
        if (error) {
          toast.error(`${row.fullName}: ${error.message}`);
          return false;
        }
      } else {
        const { data, error } = await supabase
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
          toast.error(`${row.fullName}: ${error.message}`);
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
      if (ok) toast.success(`Nota guardada: ${row.fullName}`);
    } finally {
      setSavingId(null);
    }
  };

  const handleSaveAll = async () => {
    setBulkSaving(true);
    let okCount = 0;
    try {
      for (const row of rows) {
        // Saltamos filas vacías para no crear submissions sin nota.
        if (row.grade == null && !row.feedback.trim()) continue;
        const ok = await saveRow(row);
        if (ok) okCount += 1;
      }
      if (okCount > 0) toast.success(`${okCount} nota${okCount === 1 ? "" : "s"} guardada${okCount === 1 ? "" : "s"}`);
    } finally {
      setBulkSaving(false);
    }
  };

  const summary = useMemo(() => {
    const total = rows.length;
    const graded = rows.filter((r) => r.hasGrade).length;
    return { total, graded };
  }, [rows]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-primary" />
            Notas externas
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[11px]">
              {summary.graded}/{summary.total} con nota
            </Badge>
            <Button
              size="sm"
              onClick={handleSaveAll}
              disabled={bulkSaving || loading || rows.length === 0}
              className="h-8 text-xs"
            >
              {bulkSaving ? (
                <Spinner size="sm" className="mr-1.5" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1.5" />
              )}
              Guardar todo
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Esta actividad ya ocurrió fuera de la plataforma. Ingresa la nota de cada
          estudiante (0–{maxScore}) para que cuente en el cálculo del corte.{" "}
          <span className="font-medium">
            Usa coma para decimales (ej. 4,5).
          </span>
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {!loading && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4 text-center">
            No hay estudiantes matriculados en este curso aún.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Estudiante</TableHead>
                <TableHead className="w-32">Nota</TableHead>
                {kind === "workshop" && <TableHead>Retroalimentación</TableHead>}
                <TableHead className="w-28 text-right">Acción</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && <TableSkeleton rows={5} cols={kind === "workshop" ? 4 : 3} />}
              {!loading &&
                rows.map((row) => (
                <TableRow key={row.userId}>
                  <TableCell>
                    <div className="font-medium">{row.fullName}</div>
                    <div className="text-xs text-muted-foreground">{row.email}</div>
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
                  {kind === "workshop" && (
                    <TableCell>
                      <Textarea
                        rows={1}
                        value={row.feedback}
                        onChange={(e) => updateRow(row.userId, { feedback: e.target.value })}
                        placeholder="Comentario opcional"
                        className="min-h-[32px] text-xs"
                      />
                    </TableCell>
                  )}
                  <TableCell className="text-right">
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
                      Guardar
                    </Button>
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
