/**
 * Vista del estudiante — Calificaciones por cortes.
 *
 * REGLA DE NEGOCIO INMUTABLE (ver EXAMLAB-CONTEXT.md):
 *   Curso → Σ(Cortes × peso)
 *   Corte → Σ([Talleres, Exámenes, Proyectos, Asistencia] × peso)
 *
 * Los pesos globales del curso (`exam_weight`, `workshop_weight`, etc.) son
 * defaults para sembrar cortes nuevos pero NO se usan en el cálculo aquí.
 * La fuente de verdad es `grade_cuts` + sus sub-pesos.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { formatDateOnly } from "@/shared/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RowAction } from "@/components/ui/row-action";
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
  ClipboardList,
  FileText,
  Hammer,
  TrendingUp,
  CheckCircle2,
  XCircle,
  Scale,
  MessageSquareText,
  FolderKanban,
  CalendarCheck,
} from "lucide-react";
import { computeWeightedGrade, countsAsPresent } from "@/modules/grading/grade";
import { computeAttemptGrade, type RetryMode } from "@/modules/exams/exam-attempts";
import { StatusBadge } from "@/components/ui/status-badge";
import { ErrorState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { friendlyError } from "@/shared/lib/db-errors";

// grade_cuts/projects no siempre están en types.ts auto-generados.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/student/grades")({ component: StudentGrades });

type Course = {
  id: string;
  name: string;
  period: string | null;
  grade_scale_min: number;
  grade_scale_max: number;
  passing_grade: number;
};

type Cut = {
  id: string;
  name: string;
  position: number;
  start_date: string | null;
  end_date: string | null;
  weight: number;
  workshop_weight: number;
  exam_weight: number;
  project_weight: number;
  attendance_weight: number;
};

type ItemRow = {
  id: string;
  title: string;
  kind: "exam" | "workshop" | "project" | "attendance";
  cut_id: string | null;
  grade: number | null; // ya normalizado a la escala del curso
  rawGrade: number | null;
  rawMax: number;
  status: string;
  weight?: number; // peso relativo (solo para exámenes por ahora)
  reviewExamId?: string | null;
  reviewWorkshopId?: string | null;
};

type CutBreakdown = {
  cut: Cut;
  items: ItemRow[];
  grade: number | null;
};

function StudentGrades() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  const [cutsBreakdown, setCutsBreakdown] = useState<CutBreakdown[]>([]);
  const [unassigned, setUnassigned] = useState<ItemRow[]>([]);
  const [loading, setLoading] = useState(false);
  // Si la query principal de notas falla (RLS, red caída, schema cache),
  // poblamos `loadError` para mostrar `<ErrorState>` en vez de una vista
  // vacía sin contexto. El user puede pulsar "Reintentar".
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumpear este contador re-dispara el effect manualmente (sin agregarlo
  // a las deps externas que tienen su propia semántica).
  const [retryNonce, setRetryNonce] = useState(0);

  // Carga cursos matriculados
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      const { data: enr } = await supabase
        .from("course_enrollments")
        .select("course_id")
        .eq("user_id", user.id);
      if (cancelled) return;
      const ids = (enr ?? []).map((e: { course_id: string }) => e.course_id);
      if (!ids.length) {
        setCourses([]);
        return;
      }
      const { data } = await supabase
        .from("courses")
        .select("id, name, period, grade_scale_min, grade_scale_max, passing_grade")
        .in("id", ids)
        .is("deleted_at", null)
        .order("period", { ascending: false, nullsFirst: false })
        .order("name");
      if (cancelled) return;
      const cs = (data ?? []) as Course[];
      setCourses(cs);
      if (cs[0]) setCourseId(cs[0].id);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Carga datos de cortes/items para el curso seleccionado
  useEffect(() => {
    if (!user || !courseId) return;
    const course = courses.find((c) => c.id === courseId);
    if (!course) return;

    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [
          { data: cutsData },
          { data: exams },
          { data: workshops },
          { data: projects },
          { data: sessions },
        ] = await Promise.all([
          db
            .from("grade_cuts")
            .select(
              "id, name, position, start_date, end_date, weight, workshop_weight, exam_weight, project_weight, attendance_weight",
            )
            .eq("course_id", courseId)
            .order("position"),
          // Excluir draft del cálculo de notas: un examen/taller/proyecto
          // en borrador todavía no debería pesar en la nota del estudiante.
          // Closed sí cuenta — fue una actividad real que se cerró
          // manualmente. La proyección de proyectos requiere filtrar el
          // join después (project_courses no tiene status), ver flatProjects.
          (supabase as any)
            .from("exams")
            .select("id, title, parent_exam_id, cut_id, weight, retry_mode, status")
            .eq("course_id", courseId)
            .neq("status", "draft")
            .is("deleted_at", null),
          // Talleres via workshop_courses (M:N) para incluir los talleres
          // COMPARTIDOS a este curso como SECUNDARIO y usar el cut_id/weight
          // POR CURSO (no el global legacy de workshops). Un taller que se
          // comparte a 2 cursos vive solo en workshop_courses para el curso
          // secundario; cargarlo por workshops.course_id (ancla legacy) lo
          // dejaba invisible aquí. El filtro de draft se aplica abajo sobre
          // el join (workshop_courses no tiene status). Espejo de flatProjects.
          db
            .from("workshop_courses")
            .select("cut_id, weight, workshop:workshops(id, title, max_score, is_external, status, deleted_at, group_mode)")
            .eq("course_id", courseId),
          // Proyectos via project_courses para incluir secundarios y usar
          // cut_id/weight por curso. El filtro de draft se aplica abajo
          // sobre el join (project_courses no tiene status).
          db
            .from("project_courses")
            .select("cut_id, weight, project:projects(id, title, max_score, is_external, status, deleted_at, group_mode)")
            .eq("course_id", courseId),
          db
            .from("attendance_sessions")
            .select("id, session_date, cut_id")
            .eq("course_id", courseId)
            .is("deleted_at", null),
        ]);

        const cuts = (cutsData ?? []) as Cut[];
        const examIds = (exams ?? []).map((e: { id: string }) => e.id);
        // Flatten workshop_courses rows → per-course cut_id/weight override
        // (espejo de flatProjects). Excluimos drafts y los talleres en
        // papelera. Así un taller compartido aparece con su cut_id/weight de
        // ESTE curso, y la nota correcta se ve en ambos cursos.
        const flatWorkshops = (workshops ?? [])
          .filter(
            (wc: any) =>
              wc.workshop &&
              !wc.workshop.deleted_at &&
              (wc.workshop.status ?? "published") !== "draft",
          )
          .map((wc: any) => ({
            ...wc.workshop,
            cut_id: wc.cut_id ?? null,
            weight: wc.weight ?? 1,
          }));
        const wsIds = flatWorkshops.map((w: { id: string }) => w.id);
        // Entregas de grupo para TODOS los talleres — NO gatear por group_mode:
        // fetchGroupSubs cortocircuita si el alumno no está en ningún grupo del
        // item, así un miembro que no es el "último editor" ve SU nota grupal
        // aunque group_mode haya cambiado o sea NULL (legacy). Los grupos son
        // OPCIONALES (modo mixto): un alumno sin grupo cae a su entrega individual.
        const groupWsIds = wsIds;
        // Flatten project_courses rows → per-course cut_id/weight override.
        // Excluimos drafts: si el proyecto está en borrador no debe pesar
        // todavía en la nota del estudiante.
        const flatProjects = (projects ?? [])
          .filter(
            (pc: any) =>
              !pc.project?.deleted_at && (pc.project?.status ?? "published") !== "draft",
          )
          .map((pc: any) => ({
            ...(pc.project ?? pc),
            cut_id: pc.cut_id ?? null,
            weight: pc.weight ?? 1,
          }));
        const prjIds = flatProjects.map((p: { id: string }) => p.id);
        const groupPrjIds = prjIds;
        const sessIds = ((sessions ?? []) as { id: string }[]).map((s) => s.id);

        const [
          { data: examSubs },
          { data: wsSubsIndiv },
          { data: prjSubsIndiv },
          { data: attRecords },
        ] = await Promise.all([
            examIds.length
              ? supabase
                  .from("submissions")
                  .select("exam_id, ai_grade, final_override_grade, status, created_at")
                  .in("exam_id", examIds)
                  .eq("user_id", user.id)
              : Promise.resolve({ data: [] as any[] }),
            wsIds.length
              ? supabase
                  .from("workshop_submissions")
                  .select("workshop_id, ai_grade, final_grade, status")
                  .in("workshop_id", wsIds)
                  .eq("user_id", user.id)
              : Promise.resolve({ data: [] as any[] }),
            prjIds.length
              ? db
                  .from("project_submissions")
                  .select("project_id, ai_grade, final_grade, status")
                  .in("project_id", prjIds)
                  .eq("user_id", user.id)
              : Promise.resolve({ data: [] as any[] }),
            sessIds.length
              ? supabase
                  .from("attendance_records")
                  .select("session_id, status")
                  .in("session_id", sessIds)
                  .eq("user_id", user.id)
              : Promise.resolve({ data: [] as any[] }),
          ]);

        // Trabajo en grupo: la entrega grupal tiene user_id = solo el "último
        // editor", así que la query por user_id de arriba NO trae la nota para los
        // demás miembros → su taller/proyecto grupal contaba como 0 en la nota final.
        // Traemos las entregas por group_id de los grupos a los que pertenece el
        // alumno y las fusionamos (la grupal PRECEDE a cualquier individual del
        // mismo item, espejo del acta). Solo corre si hay items en modo grupo.
        const fetchGroupSubs = async (
          groupItemIds: string[],
          groupsTable: string,
          membersTable: string,
          subsTable: string,
          fkCol: string,
        ): Promise<any[]> => {
          if (!groupItemIds.length) return [];
          const { data: groups } = await (db as any)
            .from(groupsTable)
            .select("id")
            .in(fkCol, groupItemIds);
          const gIds = ((groups ?? []) as Array<{ id: string }>).map((g) => g.id);
          if (!gIds.length) return [];
          const { data: mem } = await (db as any)
            .from(membersTable)
            .select("group_id")
            .in("group_id", gIds)
            .eq("user_id", user.id);
          const myGIds = ((mem ?? []) as Array<{ group_id: string }>).map((m) => m.group_id);
          if (!myGIds.length) return [];
          const { data: gsubs } = await (db as any)
            .from(subsTable)
            .select(`${fkCol}, group_id, ai_grade, final_grade, status`)
            .in("group_id", myGIds);
          return (gsubs ?? []) as any[];
        };
        const [wsGroupSubs, prjGroupSubs] = await Promise.all([
          fetchGroupSubs(groupWsIds, "workshop_groups", "workshop_group_members", "workshop_submissions", "workshop_id"),
          fetchGroupSubs(groupPrjIds, "project_groups", "project_group_members", "project_submissions", "project_id"),
        ]);
        const wsSubs = [
          ...wsGroupSubs,
          ...((wsSubsIndiv ?? []) as any[]).filter(
            (s) => !wsGroupSubs.some((g) => g.workshop_id === s.workshop_id),
          ),
        ];
        const prjSubs = [
          ...prjGroupSubs,
          ...((prjSubsIndiv ?? []) as any[]).filter(
            (s) => !prjGroupSubs.some((g) => g.project_id === s.project_id),
          ),
        ];

        // Helper: escala una calificación raw (0..max) a la escala del curso.
        const toScale = (raw: number, max: number) => {
          const pct = max > 0 ? raw / max : 0;
          return course.grade_scale_min + pct * (course.grade_scale_max - course.grade_scale_min);
        };
        // Helper: normaliza un puntaje raw de escala 0..fromMax a 0..toMax,
        // redondeado a 2 decimales. Usado para presentar la columna
        // "Puntaje" SIEMPRE en la escala del curso (#19) sin tocar la nota
        // final (que usa `toScale`/`it.grade`). Para items ya en la escala
        // del curso (fromMax === toMax) devuelve el mismo valor.
        const rescaleScore = (raw: number, fromMax: number, toMax: number) => {
          if (fromMax <= 0) return 0;
          if (fromMax === toMax) return Math.round(raw * 100) / 100;
          return Math.round((raw / fromMax) * toMax * 100) / 100;
        };

        // Construye filas para cada item del curso (ya escaladas).
        const rows: ItemRow[] = [];

        // Exámenes (solo originales, no makeups)
        const originalExams = (exams ?? []).filter((e: any) => !e.parent_exam_id);
        for (const e of originalExams as any[]) {
          const mode = (e.retry_mode as RetryMode) ?? "last";
          let attempts = (examSubs ?? []).filter((s: any) => s.exam_id === e.id);
          let usedFromMakeup = false;
          if (!attempts.length) {
            const makeupIds = (exams ?? [])
              .filter((x: any) => x.parent_exam_id === e.id)
              .map((x: any) => x.id);
            attempts = (examSubs ?? []).filter((s: any) => makeupIds.includes(s.exam_id));
            usedFromMakeup = attempts.length > 0;
          }
          const raw = computeAttemptGrade(attempts as any, mode);
          // Para "review" link: el intento más reciente finalizado
          const sortedFinished = [...attempts]
            .filter((s: any) => s.status === "completado" || s.status === "sospechoso")
            .sort(
              (a: any, b: any) =>
                new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
            );
          const latest = sortedFinished[0];
          rows.push({
            id: e.id,
            title: e.title,
            kind: "exam",
            cut_id: e.cut_id ?? null,
            rawGrade: raw,
            rawMax: course.grade_scale_max,
            grade: raw != null ? toScale(raw, course.grade_scale_max) : null,
            status: latest?.status ?? (attempts.length ? "en_progreso" : "sin_entrega"),
            weight: Number(e.weight ?? 1),
            reviewExamId: latest ? (usedFromMakeup ? latest.exam_id : e.id) : null,
          });
        }

        // Talleres — para is_external la nota ya está en la escala del
        // curso (la ingresa el docente en ExternalGradesEditor con cap =
        // course.grade_scale_max). Para AI/datos viejos, w.max_score puede
        // ser 0..100 (legacy) — se reescala internamente con `internalMax`
        // SOLO para calcular `grade` (no cambia la nota). La columna
        // "Puntaje" SIEMPRE se presenta en la escala del curso (#19): el
        // tope mostrado es grade_scale_max y el valor el puntaje normalizado.
        for (const w of flatWorkshops as any[]) {
          const sub = (wsSubs ?? []).find((s: any) => s.workshop_id === w.id);
          const raw = sub ? (sub.final_grade ?? sub.ai_grade) : null;
          const internalMax = w.is_external ? course.grade_scale_max : (w.max_score ?? 100);
          rows.push({
            id: w.id,
            title: w.title,
            kind: "workshop",
            cut_id: w.cut_id ?? null,
            // Puntaje en escala del curso: normaliza raw (0..internalMax) a
            // 0..grade_scale_max. Para items ya en escala del curso
            // (internalMax === grade_scale_max) es no-op.
            rawGrade: raw != null ? rescaleScore(raw, internalMax, course.grade_scale_max) : null,
            rawMax: course.grade_scale_max,
            grade: raw != null ? toScale(raw, internalMax) : null,
            status: sub?.status ?? "pendiente",
            weight: Number(w.weight ?? 1),
            reviewWorkshopId: sub ? w.id : null,
          });
        }

        // Proyectos — misma regla: external = ya en escala del curso;
        // Puntaje normalizado a la escala del curso (#19).
        for (const p of flatProjects as any[]) {
          const sub = (prjSubs ?? []).find((s: any) => s.project_id === p.id);
          const raw = sub ? (sub.final_grade ?? sub.ai_grade) : null;
          const internalMax = p.is_external ? course.grade_scale_max : (p.max_score ?? 100);
          rows.push({
            id: p.id,
            title: p.title,
            kind: "project",
            cut_id: p.cut_id ?? null,
            rawGrade: raw != null ? rescaleScore(raw, internalMax, course.grade_scale_max) : null,
            rawMax: course.grade_scale_max,
            grade: raw != null ? toScale(raw, internalMax) : null,
            status: sub?.status ?? "pendiente",
            weight: Number(p.weight ?? 1),
          });
        }

        // Asistencia: agrupa por corte usando el FK explícito
        // attendance_sessions.cut_id (migración 20260509020000). Antes
        // se inferiía por rango de fechas. Cuenta sesiones del corte y
        // cuántas registró el estudiante como "presente".
        const allSessions = (sessions ?? []) as {
          id: string;
          session_date: string;
          cut_id?: string | null;
        }[];
        const allRecords = (attRecords ?? []) as { session_id: string; status: string }[];
        const recordsBySession = new Map(allRecords.map((r) => [r.session_id, r.status]));

        // Construye el desglose por corte usando el modelo nuevo:
        // cada item aporta su weight (% del total) y la asistencia del
        // corte aporta cut.attendance_weight (también % del total).
        const breakdown: CutBreakdown[] = cuts.map((cut) => {
          const cutItems = rows.filter((r) => r.cut_id === cut.id);

          // Asistencia del corte: filtra sesiones por fecha, calcula %
          // presente y escala. Se modela como un ItemRow más con peso =
          // cut.attendance_weight para entrar al weighted avg uniforme.
          //
          // Renderizamos SIEMPRE la fila de asistencia cuando el bucket
          // attendance_weight > 0, aunque no haya sesiones registradas o
          // el corte no tenga fechas. Así el estudiante ve "0/0 sesiones"
          // o "sin sesiones registradas" en lugar de que la asistencia
          // simplemente desaparezca y dé la sensación de que su nota
          // final ignora ese componente.
          let attItem: ItemRow | null = null;
          const attWeight = Number(cut.attendance_weight ?? 0);
          if (attWeight > 0) {
            // Filtro por cut_id explícito (migración 20260509020000):
            // el docente asigna el corte al crear la sesión.
            const sessionsInCut = allSessions.filter((s) => s.cut_id === cut.id);
            if (sessionsInCut.length > 0) {
              const present = sessionsInCut.filter((s) =>
                countsAsPresent(recordsBySession.get(s.id)),
              ).length;
              const pct = present / sessionsInCut.length;
              const attendanceAvg =
                course.grade_scale_min + pct * (course.grade_scale_max - course.grade_scale_min);
              attItem = {
                id: `attendance-${cut.id}`,
                title: i18n.t("studentGrades.attendanceTitle", { present, total: sessionsInCut.length }),
                kind: "attendance",
                cut_id: cut.id,
                rawGrade: present,
                rawMax: sessionsInCut.length,
                grade: attendanceAvg,
                status: "calculado",
                weight: attWeight,
              };
            } else {
              // Bucket de asistencia con peso > 0 pero sin sesiones
              // asignadas a este corte: grade=null. OJO: computeWeightedGrade
              // NO ignora los null — los cuenta como 0 con su peso completo.
              // Por eso el memo de finalGrade SALTA explícitamente este item
              // (kind attendance + grade null), espejando al gradebook docente.
              attItem = {
                id: `attendance-${cut.id}`,
                title: i18n.t("studentGrades.attendanceNoSessions"),
                kind: "attendance",
                cut_id: cut.id,
                rawGrade: null,
                rawMax: 0,
                grade: null,
                status: "pendiente",
                weight: attWeight,
              };
            }
          }

          const allCutItems = attItem ? [...cutItems, attItem] : cutItems;
          // Card de resumen del corte: usamos AVG de items GRADED ONLY
          // (skip nulls), no `computeWeightedGrade` que cuenta null=0.
          // Razón UX: el card es un overview "cómo voy en lo que YA me
          // calificaron" en escala 1-5 del curso. Si el estudiante tiene
          // perfecto en lo entregado, el card muestra 5 — no 3.33
          // penalizado por items pendientes. Match con el grid del
          // docente (que en práctica solo lo penaliza si EL DOCENTE no
          // calificó algo). La NOTA FINAL global sigue usando null=0
          // (más abajo via `computeWeightedGrade`) porque ahí sí refleja
          // "lo que tienes hoy si nada más se entrega".
          const graded = allCutItems
            .filter((i) => i.grade != null && (i.weight ?? 1) > 0)
            .map((i) => ({ score: i.grade as number, weight: i.weight ?? 1 }));
          const grade =
            graded.length === 0
              ? null
              : Number(
                  (
                    graded.reduce((a, i) => a + i.score * i.weight, 0) /
                    graded.reduce((a, i) => a + i.weight, 0)
                  ).toFixed(2),
                );

          return {
            cut,
            items: allCutItems,
            grade,
          };
        });

        if (cancelled) return;
        // Items sin corte asignado (informativo)
        setUnassigned(rows.filter((r) => !r.cut_id));
        setCutsBreakdown(breakdown);
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            friendlyError(
              e,
              t("studentGrades.loadErrorFallback", {
                defaultValue: "No pudimos cargar tus notas en este momento.",
              }),
            ),
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, courseId, courses, retryNonce]);

  const course = courses.find((c) => c.id === courseId);

  // La nota final ahora es el weighted avg de TODOS los items del curso
  // (de todos los cortes) + asistencias por corte. Cada item ya tiene su
  // weight expresado en % del total, así que pasamos todos directos al
  // helper. Esto evita doble re-escala / pérdida de precisión que tendría
  // promediar primero por corte y luego entre cortes.
  const finalGrade = useMemo(() => {
    const items: { score: number | null; weight: number }[] = [];
    for (const cb of cutsBreakdown) {
      for (const it of cb.items) {
        // Asistencia de un corte SIN sesiones asignadas (grade=null) NO es "nota
        // perdida": el gradebook docente la OMITE (gradebook.tsx:1012) y el
        // certificado se emite con ese consolidado. computeWeightedGrade NO ignora
        // los null — los cuenta como 0 con su peso completo — así que incluirla
        // deflactaría la nota del estudiante vs su certificado (rompe la paridad
        // docente↔estudiante↔certificado). Los demás null (examen/taller/proyecto)
        // SÍ cuentan como 0 (nota perdida), igual que el docente → no se saltan.
        if (it.kind === "attendance" && it.grade == null) continue;
        items.push({ score: it.grade, weight: it.weight ?? 1 });
      }
    }
    // Items SIN corte asignado (config gap): el gradebook docente los incluye
    // en la nota final (finalItems = todos los allItems) y el certificado se
    // emite con ESE número. Si acá los excluyéramos, el estudiante vería una
    // nota final distinta a la de su certificado/gradebook. Los sumamos al
    // weighted avg con su peso para mantener la paridad docente↔estudiante.
    for (const it of unassigned) {
      items.push({ score: it.grade, weight: it.weight ?? 1 });
    }
    return computeWeightedGrade(items);
  }, [cutsBreakdown, unassigned]);

  const passes = course && finalGrade != null ? finalGrade >= course.passing_grade : null;
  const fmt = (n: number | null) => (n == null ? "—" : n.toFixed(2));

  // Si la query de notas del curso seleccionado falló, no queremos
  // mostrar la tabla vacía como si estuviera "sin datos" — eso confunde
  // al alumno (¿no tengo notas? ¿la app está rota?). Renderizamos un
  // ErrorState con botón "Reintentar" que bumpea `retryNonce` para
  // re-disparar el effect.
  if (loadError && courseId) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<ClipboardList className="h-6 w-6" />}
          title={t("studentGrades.title")}
          subtitle={t("studentGrades.subtitle")}
        />
        <ErrorState
          message={t("studentGrades.loadError")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ClipboardList className="h-6 w-6" />}
        title={t("studentGrades.title")}
        subtitle={t("studentGrades.subtitle")}
        actions={
          courses.length > 0 ? (
            <Select value={courseId} onValueChange={setCourseId}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder={t("common.course")} />
              </SelectTrigger>
              <SelectContent>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {c.period ? ` · ${c.period}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null
        }
      />

      {courses.length === 0 ? (
        <Card>
          <CardContent className="p-4 sm:p-10 text-center text-muted-foreground text-sm">
            <ClipboardList className="h-10 w-10 mx-auto text-muted-foreground/60 mb-2" />
            {t("studentGrades.notEnrolled")}
          </CardContent>
        </Card>
      ) : !course ? null : (
        <>
          {/* Tarjetas resumen: una por corte + final */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {cutsBreakdown.map((cb) => (
              <Card key={cb.cut.id}>
                <CardContent className="p-4 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground uppercase tracking-wide">
                      {cb.cut.name}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {cb.cut.weight}%
                    </Badge>
                  </div>
                  <div className="text-2xl font-semibold tabular-nums">{fmt(cb.grade)}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {t("studentGrades.gradedCount", {
                      graded: cb.items.filter((i) => i.grade != null).length,
                      total: cb.items.length,
                    })}
                  </div>
                </CardContent>
              </Card>
            ))}
            <Card
              className={
                passes === true
                  ? "border-success/40 bg-success/5"
                  : passes === false
                    ? "border-destructive/40 bg-destructive/5"
                    : ""
              }
            >
              <CardContent className="p-4 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    {t("studentGrades.finalGradeLabel")}
                  </span>
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="text-2xl font-semibold tabular-nums">{fmt(finalGrade)}</div>
                {passes === true && (
                  <div className="flex items-center gap-1 text-xs text-success">
                    <CheckCircle2 className="h-3 w-3" /> {t("studentGrades.statusPassing")}
                  </div>
                )}
                {passes === false && (
                  <div className="flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="h-3 w-3" /> {t("studentGrades.statusFailing")}
                  </div>
                )}
                {passes == null && (
                  <div className="text-xs text-muted-foreground">{t("studentGrades.statusNoGrades")}</div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Escala del curso */}
          <div className="flex flex-wrap items-center gap-4 rounded-md border p-3 bg-muted/30 text-sm">
            <div className="flex items-center gap-1.5">
              <Scale className="h-4 w-4 text-primary" />
              <span className="font-medium">{t("studentGrades.scaleLabel")}</span>
              <span className="tabular-nums">
                {course.grade_scale_min} – {course.grade_scale_max}
              </span>
            </div>
            <div className="text-muted-foreground">
              {t("studentGrades.passingLabel")} <span className="font-medium tabular-nums">{course.passing_grade}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {t("studentGrades.scaleExplanation")}
            </div>
          </div>

          {/* Detalle por corte */}
          {loading ? (
            <Card>
              <CardContent className="p-4">
                <TableSkeleton rows={3} cols={4} />
              </CardContent>
            </Card>
          ) : cutsBreakdown.length === 0 ? (
            <Card>
              <CardContent className="p-4 sm:p-10 text-center text-sm text-muted-foreground">
                {t("studentGrades.noCuts")}
              </CardContent>
            </Card>
          ) : (
            cutsBreakdown.map((cb) => (
              <Card key={cb.cut.id}>
                <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 space-y-0">
                  <div>
                    <CardTitle className="text-base">{cb.cut.name}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      {t("studentGrades.cutWeight", { weight: cb.cut.weight })}{" "}
                      <span className="font-medium tabular-nums">{fmt(cb.grade)}</span>
                    </p>
                  </div>
                  {cb.cut.start_date && cb.cut.end_date && (
                    <Badge variant="outline" className="text-[10px]">
                      {formatDateOnly(cb.cut.start_date)} → {formatDateOnly(cb.cut.end_date)}
                    </Badge>
                  )}
                </CardHeader>
                <CardContent className="p-3 space-y-3">
                  {cb.items.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      {t("studentGrades.noCutActivities")}
                    </p>
                  ) : (
                    (["workshop", "exam", "project", "attendance"] as const).map((kind) => {
                      const items = cb.items.filter((i) => i.kind === kind);
                      if (items.length === 0) return null;
                      // Subtotal = nota ponderada SOLO de los items de este
                      // tipo dentro del corte. Útil para que el alumno
                      // entienda "cuánto va aportando talleres" antes de
                      // ver la nota global del corte.
                      const subtotal = computeWeightedGrade(
                        items.map((i) => ({ score: i.grade, weight: i.weight ?? 1 })),
                      );
                      const bucketWeight = items.reduce((s, i) => s + (i.weight ?? 0), 0);
                      const graded = items.filter((i) => i.grade != null).length;
                      return (
                        <KindGroup
                          key={kind}
                          kind={kind}
                          items={items}
                          subtotal={subtotal}
                          bucketWeight={bucketWeight}
                          gradedCount={graded}
                          totalCount={items.length}
                          fmt={fmt}
                          gradeScaleMin={course.grade_scale_min}
                          gradeScaleMax={course.grade_scale_max}
                        />
                      );
                    })
                  )}
                </CardContent>
              </Card>
            ))
          )}

          {/* Items sin corte asignado */}
          {unassigned.length > 0 && (
            <Card className="border-dashed">
              <CardHeader>
                <CardTitle className="text-base">{t("studentGrades.noAssignedCut")}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {t("studentGrades.unassignedHint")}
                </p>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("studentGrades.colActivity")}</TableHead>
                      <TableHead>{t("studentGrades.colType")}</TableHead>
                      <TableHead className="text-right">{t("studentGrades.colScore")}</TableHead>
                      <TableHead className="text-right">
                        {t("studentGrades.colGrade")} ({course.grade_scale_min}–{course.grade_scale_max})
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {unassigned.map((it) => (
                      <TableRow key={`${it.kind}-${it.id}`}>
                        <TableCell>{it.title}</TableCell>
                        <TableCell>
                          <KindBadge kind={it.kind} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {it.rawGrade != null ? `${it.rawGrade} / ${it.rawMax}` : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(it.grade)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <p className="text-xs text-muted-foreground">
            {t("studentGrades.footerNote")}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Sub-sección por tipo dentro del detalle de un corte. Renderiza el
 * encabezado del bucket (Talleres / Exámenes / etc) con el subtotal
 * y peso, seguido de una mini-tabla con cada item.
 *
 * Diseño consciente: subtotal y peso son por tipo dentro del corte —
 * NO la nota acumulada del corte (que vive en el header de la card).
 * Sirve para que el alumno entienda "cuánto va aportando cada bucket".
 */
function KindGroup({
  kind,
  items,
  subtotal,
  bucketWeight,
  gradedCount,
  totalCount,
  fmt,
  gradeScaleMin,
  gradeScaleMax,
}: {
  kind: ItemRow["kind"];
  items: ItemRow[];
  subtotal: number | null;
  bucketWeight: number;
  gradedCount: number;
  totalCount: number;
  fmt: (n: number | null) => string;
  gradeScaleMin: number;
  gradeScaleMax: number;
}) {
  const label =
    kind === "workshop"
      ? i18n.t("studentGrades.kindWorkshops")
      : kind === "exam"
        ? i18n.t("studentGrades.kindExams")
        : kind === "project"
          ? i18n.t("studentGrades.kindProjects")
          : i18n.t("studentGrades.kindAttendance");
  return (
    <div className="rounded-md border overflow-x-auto overflow-y-hidden">
      <div className="flex items-center justify-between gap-2 bg-muted/40 px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <KindBadge kind={kind} />
          <span className="text-sm font-medium">{label}</span>
          <span className="text-[11px] text-muted-foreground">
            {i18n.t("studentGrades.gradedCount", { graded: gradedCount, total: totalCount })}
          </span>
        </div>
        <div className="text-xs text-muted-foreground inline-flex items-center gap-2 tabular-nums">
          <span>{i18n.t("studentGrades.bucketWeight", { weight: bucketWeight.toFixed(1) })}</span>
          <span>·</span>
          <span>
            {i18n.t("studentGrades.subtotal")}{" "}
            <span className="font-semibold text-foreground tabular-nums">{fmt(subtotal)}</span>
          </span>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{i18n.t("studentGrades.colActivity")}</TableHead>
            <TableHead className="text-right w-32">{i18n.t("common.weight")}</TableHead>
            <TableHead className="text-right">{i18n.t("studentGrades.colScore")}</TableHead>
            <TableHead className="text-right">
              {i18n.t("studentGrades.colGrade")} ({gradeScaleMin}–{gradeScaleMax})
            </TableHead>
            <TableHead className="hidden md:table-cell">{i18n.t("common.status")}</TableHead>
            <TableHead className="text-right w-[1%]">{i18n.t("studentGrades.colDetail")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => (
            <TableRow key={`${it.kind}-${it.id}`}>
              <TableCell className="font-medium">{it.title}</TableCell>
              <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                {it.weight != null ? `${Number(it.weight).toFixed(1)}%` : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {it.rawGrade != null ? `${it.rawGrade} / ${it.rawMax}` : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">{fmt(it.grade)}</TableCell>
              <TableCell className="hidden md:table-cell">
                <StatusBadge status={it.status} />
              </TableCell>
              <TableCell className="text-right">
                {it.kind === "exam" && it.reviewExamId ? (
                  <RowAction asChild label={i18n.t("common.seeDetail")} icon={MessageSquareText}>
                    <Link to="/app/student/review/$examId" params={{ examId: it.reviewExamId }} />
                  </RowAction>
                ) : it.kind === "workshop" && it.reviewWorkshopId ? (
                  <RowAction asChild label={i18n.t("common.seeDetail")} icon={MessageSquareText}>
                    <Link
                      to="/app/student/workshop/$workshopId"
                      params={{ workshopId: it.reviewWorkshopId }}
                    />
                  </RowAction>
                ) : (
                  <span className="text-muted-foreground text-xs">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function KindBadge({ kind }: { kind: ItemRow["kind"] }) {
  switch (kind) {
    case "exam":
      return (
        <Badge variant="outline" className="text-[10px]">
          <FileText className="h-3 w-3 mr-1" />
          {i18n.t("studentGrades.kindBadgeExam")}
        </Badge>
      );
    case "workshop":
      return (
        <Badge variant="outline" className="text-[10px]">
          <Hammer className="h-3 w-3 mr-1" />
          {i18n.t("studentGrades.kindBadgeWorkshop")}
        </Badge>
      );
    case "project":
      return (
        <Badge variant="outline" className="text-[10px]">
          <FolderKanban className="h-3 w-3 mr-1" />
          {i18n.t("studentGrades.kindBadgeProject")}
        </Badge>
      );
    case "attendance":
      return (
        <Badge variant="outline" className="text-[10px]">
          <CalendarCheck className="h-3 w-3 mr-1" />
          {i18n.t("studentGrades.kindBadgeAttendance")}
        </Badge>
      );
  }
}
