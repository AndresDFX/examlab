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
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { formatDateOnly, todayLocalISO } from "@/shared/lib/format";
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
import { computeWeightedGrade } from "@/modules/grading/grade";
import { resumirCortes, type ResumenDeCorte } from "@/modules/grading/estado-de-cortes";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import {
  actividadesConNota,
  notaDelEstudianteEnCurso,
  type DetalleDeItem,
} from "@/modules/grading/nota-del-curso";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
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
  status?: string | null;
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
  /** Peso en ESTE curso (% de la nota final); 0 si no cae en un corte. */
  weight?: number;
  reviewExamId?: string | null;
  reviewWorkshopId?: string | null;
  /** Si entra en la nota (nota-relativa.ts). */
  cuenta?: boolean;
  /** Por qué no cuenta todavía, o por qué cuenta 0. null si tiene nota. */
  motivo?: string | null;
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
  /** Cortes desplegados a mano; sin entrada, abierto solo el actual. */
  const [abiertos, setAbiertos] = useState<Record<string, boolean>>({});
  const [unassigned, setUnassigned] = useState<ItemRow[]>([]);
  const [finalGrade, setFinalGrade] = useState<number | null>(null);
  // La nota todavía puede cambiar: hay algo por darse o por calificar.
  const [parcial, setParcial] = useState(false);
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
        .select("id, name, period, grade_scale_min, grade_scale_max, passing_grade, status")
        .in("id", ids)
        .is("deleted_at", null)
        .order("period", { ascending: false, nullsFirst: false })
        .order("name");
      if (cancelled) return;
      // `as unknown as`: types.ts generado aún no incluye `courses.status`.
      const cs = (data ?? []) as unknown as Course[];
      setCourses(cs);
      if (cs[0]) setCourseId(cs[0].id);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Carga los datos del curso seleccionado y arma la nota con el MISMO cálculo
  // que el libro del docente y el boletín (nota-del-curso.ts): la nota es
  // RELATIVA a lo que ya se dio. Antes esta pantalla tenía su propia copia —con
  // un 1 % por defecto para los pesos vacíos y la tarjeta de cada corte
  // promediando solo lo calificado— y el estudiante veía otro número que su
  // docente.
  useEffect(() => {
    if (!user || !courseId) return;
    const course = courses.find((c) => c.id === courseId);
    if (!course) return;

    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const PRJ_COLS =
          "id, title, course_id, cut_id, weight, due_date, max_score, is_external, status, deleted_at";
        const [
          { data: cutsData },
          { data: exams },
          { data: wcRows },
          { data: wsAncla },
          { data: pcRows },
          { data: prjAncla },
          { data: sessions },
          senalesRes,
        ] = await Promise.all([
          db
            .from("grade_cuts")
            .select(
              "id, name, position, start_date, end_date, weight, workshop_weight, exam_weight, project_weight, attendance_weight",
            )
            .eq("course_id", courseId)
            .order("position"),
          // Sin borradores ni papelera. `*` y no la lista: las columnas de
          // recuperación (migs 20262650000000 / 20262660000000) pueden llegar
          // después que el frontend, y pedirlas por nombre haría fallar todo.
          (supabase as any)
            .from("exams")
            .select("*")
            .eq("course_id", courseId)
            .neq("status", "draft")
            .is("deleted_at", null),
          // Talleres: por la fila de unión (incluye los COMPARTIDOS a este curso)
          // y los anclados al curso — un taller sin fila de unión seguía siendo
          // del curso y quedaba afuera de la nota. La RLS le devuelve al
          // estudiante solo los que tiene asignados.
          db
            .from("workshop_courses")
            .select("workshop_id, cut_id, weight, workshop:workshops(*)")
            .eq("course_id", courseId),
          db.from("workshops").select("*").eq("course_id", courseId).is("deleted_at", null),
          db
            .from("project_courses")
            .select(`project_id, cut_id, weight, project:projects(${PRJ_COLS})`)
            .eq("course_id", courseId),
          db.from("projects").select(PRJ_COLS).eq("course_id", courseId).is("deleted_at", null),
          db
            .from("attendance_sessions")
            .select("id, session_date, cut_id")
            .eq("course_id", courseId)
            .is("deleted_at", null),
          // Lo que el estudiante no puede saber solo (la RLS no le deja ver lo
          // ajeno): qué sesiones se dieron y qué actividades ya tienen notas.
          db.rpc("senales_nota_relativa", { _course_id: courseId }),
        ]);

        const cuts = (cutsData ?? []) as Cut[];
        const vigente = (x: any) =>
          !!x && !x.deleted_at && (x.status ?? "published") !== "draft";
        const talleres: any[] = [
          ...new Map(
            [...((wcRows ?? []) as any[]).map((r) => r.workshop), ...((wsAncla ?? []) as any[])]
              .filter(vigente)
              .map((w) => [w.id, w]),
          ).values(),
        ];
        const proyectos: any[] = [
          ...new Map(
            [...((pcRows ?? []) as any[]).map((r) => r.project), ...((prjAncla ?? []) as any[])]
              .filter(vigente)
              .map((p) => [p.id, p]),
          ).values(),
        ];
        const examenes = (exams ?? []) as any[];
        const examIds = examenes.map((e) => e.id);
        const wsIds = talleres.map((w) => w.id);
        const prjIds = proyectos.map((p) => p.id);
        const allSessions = (sessions ?? []) as {
          id: string;
          session_date: string;
          cut_id?: string | null;
        }[];
        const sessIds = allSessions.map((s) => s.id);

        const vacio = Promise.resolve({ data: [] as any[], error: null });
        const [
          { data: examSubs },
          { data: wsSubsIndiv },
          { data: prjSubsIndiv },
          { data: attRecords },
          asigExRes,
          asigWsRes,
          asigPrjRes,
        ] = await Promise.all([
          examIds.length
            ? supabase
                .from("submissions")
                .select("exam_id, ai_grade, final_override_grade, status, created_at")
                .in("exam_id", examIds)
                .eq("user_id", user.id)
            : vacio,
          wsIds.length
            ? supabase
                .from("workshop_submissions")
                .select("workshop_id, ai_grade, final_grade, status")
                .in("workshop_id", wsIds)
                .eq("user_id", user.id)
            : vacio,
          prjIds.length
            ? db
                .from("project_submissions")
                .select("project_id, ai_grade, final_grade, status")
                .in("project_id", prjIds)
                .eq("user_id", user.id)
            : vacio,
          sessIds.length
            ? supabase
                .from("attendance_records")
                .select("session_id, status")
                .in("session_id", sessIds)
                .eq("user_id", user.id)
            : vacio,
          // Lo asignado a ESTE estudiante. Para un alumno común la RLS ya filtra
          // por asignación; un usuario multi-rol (docente matriculado en su
          // curso) ve todo, y sin esto le contaría actividades que no tiene.
          examIds.length
            ? db
                .from("exam_assignments")
                .select("exam_id")
                .in("exam_id", examIds)
                .eq("user_id", user.id)
            : vacio,
          wsIds.length
            ? db
                .from("workshop_assignments")
                .select("workshop_id")
                .in("workshop_id", wsIds)
                .eq("user_id", user.id)
            : vacio,
          prjIds.length
            ? db
                .from("project_assignments")
                .select("project_id")
                .in("project_id", prjIds)
                .eq("user_id", user.id)
            : vacio,
        ]);

        // Trabajo en grupo: la entrega grupal tiene user_id = solo el "último
        // editor", así que la query por user_id de arriba NO trae la nota para los
        // demás miembros. Traemos las entregas por group_id de los grupos a los
        // que pertenece el alumno y las fusionamos (la grupal PRECEDE a cualquier
        // individual del mismo item, espejo del libro del docente y del acta).
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
          fetchGroupSubs(wsIds, "workshop_groups", "workshop_group_members", "workshop_submissions", "workshop_id"),
          fetchGroupSubs(prjIds, "project_groups", "project_group_members", "project_submissions", "project_id"),
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
        const propiosIntentos = (examSubs ?? []) as any[];
        const estadoPorSesion = new Map(
          ((attRecords ?? []) as { session_id: string; status: string }[]).map((r) => [
            r.session_id,
            r.status,
          ]),
        );

        // Señales del servidor. Si la función todavía no existe (el frontend
        // puede desplegarse antes que la migración), se aproximan con lo propio:
        // una sesión cuenta si ya pasó o si el estudiante tiene marca.
        const senales = senalesRes?.error ? null : (senalesRes?.data as any);
        const hoy = todayLocalISO();
        const sesionesDadasSet: Set<string> = senales
          ? new Set<string>(senales.sesiones_dadas ?? [])
          : new Set(
              allSessions
                .filter((s) => s.session_date <= hoy || estadoPorSesion.has(s.id))
                .map((s) => s.id),
            );
        const conNota = senales
          ? {
              examenes: new Set<string>(senales.examenes_con_nota ?? []),
              talleres: new Set<string>(senales.talleres_con_nota ?? []),
              proyectos: new Set<string>(senales.proyectos_con_nota ?? []),
            }
          : actividadesConNota({
              intentos: propiosIntentos,
              entregasTaller: wsSubs,
              talleres,
              entregasProyecto: prjSubs,
            });

        const escala = { min: Number(course.grade_scale_min), max: Number(course.grade_scale_max) };
        const unionTalleres = new Map(
          ((wcRows ?? []) as any[]).map((r) => [r.workshop_id ?? r.workshop?.id, r]),
        );
        const unionProyectos = new Map(
          ((pcRows ?? []) as any[]).map((r) => [r.project_id ?? r.project?.id, r]),
        );
        const nota = notaDelEstudianteEnCurso(
          {
            courseId,
            escala,
            cursoFinalizado: course.status === "finalizado",
            cortes: cuts,
            examenes,
            talleres,
            unionTalleres,
            proyectos,
            unionProyectos,
            sesiones: allSessions,
            sesionesDadas: sesionesDadasSet,
            conNota,
          },
          {
            intentos: propiosIntentos,
            entregaTaller: (wid) => wsSubs.find((s: any) => s.workshop_id === wid),
            entregaProyecto: (pid) => prjSubs.find((s: any) => s.project_id === pid),
            estadoAsistencia: (sid) => estadoPorSesion.get(sid),
            // Si no se pudieron leer, NO se asume «nada asignado» (ningún 0
            // contaría y la nota subiría en silencio): todo asignado, como antes.
            asignaciones:
              asigExRes.error || asigWsRes.error || asigPrjRes.error
                ? undefined
                : {
                    examenes: new Set(((asigExRes.data ?? []) as any[]).map((r) => r.exam_id)),
                    talleres: new Set(((asigWsRes.data ?? []) as any[]).map((r) => r.workshop_id)),
                    proyectos: new Set(((asigPrjRes.data ?? []) as any[]).map((r) => r.project_id)),
                  },
          },
          Date.now(),
        );

        // «Puntaje» = la nota expresada sobre el tope de la escala (0..max).
        const aPuntaje = (score: number | null) => {
          if (score == null) return null;
          const rango = escala.max - escala.min;
          const v = rango > 0 ? ((score - escala.min) / rango) * escala.max : score;
          return Math.round(v * 100) / 100;
        };
        const motivoDe = (i: DetalleDeItem): string | null => {
          if (i.score != null) return null;
          // Sin corte no suma (lo dice la tarjeta «Sin corte asignado»); con
          // peso 0 tampoco mueve la nota, y decir «cuenta 0» confunde.
          if (i.cutId == null) return null;
          if (i.weight <= 0) return t("notaRelativa.motivoPesoCero");
          if (i.cuenta) return t("notaRelativa.motivoCuentaCero");
          if (!i.seDio) return t("notaRelativa.motivoAbierta");
          return i.entrego
            ? t("notaRelativa.motivoPorCalificar")
            : t("notaRelativa.motivoNoAsignada");
        };
        const examPorId = new Map(examenes.map((e) => [e.id, e]));
        const tallerPorId = new Map(talleres.map((w) => [w.id, w]));
        const proyectoPorId = new Map(proyectos.map((p) => [p.id, p]));

        const rows: ItemRow[] = nota.items.map((i) => {
          const base = {
            id: i.id,
            cut_id: i.cutId,
            grade: i.score,
            rawGrade: aPuntaje(i.score),
            rawMax: escala.max,
            weight: i.weight,
            cuenta: i.cuenta,
            motivo: motivoDe(i),
          };
          if (i.tipo === "examen") {
            // Estado y enlace: los intentos del examen de donde salió la nota.
            const fuente = i.idFuente ?? i.id;
            const intentos = propiosIntentos.filter((s) => s.exam_id === fuente);
            const terminado = [...intentos]
              .filter((s) => s.status === "completado" || s.status === "sospechoso")
              .sort(
                (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
              )[0];
            return {
              ...base,
              title: examPorId.get(i.id)?.title ?? "—",
              kind: "exam" as const,
              status: terminado?.status ?? (intentos.length ? "en_progreso" : "sin_entrega"),
              reviewExamId: terminado ? fuente : null,
            };
          }
          if (i.tipo === "taller") {
            const fuente = i.idFuente ?? i.id;
            const sub = wsSubs.find((s: any) => s.workshop_id === fuente);
            return {
              ...base,
              title: tallerPorId.get(i.id)?.title ?? "—",
              kind: "workshop" as const,
              status: sub?.status ?? "pendiente",
              reviewWorkshopId: sub ? fuente : null,
            };
          }
          const sub = prjSubs.find((s: any) => s.project_id === i.id);
          return {
            ...base,
            title: proyectoPorId.get(i.id)?.title ?? "—",
            kind: "project" as const,
            status: sub?.status ?? "pendiente",
          };
        });

        const breakdown: CutBreakdown[] = cuts.map((cut) => {
          const cutItems = rows.filter((r) => r.cut_id === cut.id);
          // La asistencia se muestra SIEMPRE que el corte le da peso, aunque no
          // haya sesiones: si desapareciera, parecería que la nota la ignora.
          let attItem: ItemRow | null = null;
          const attWeight = Number(cut.attendance_weight ?? 0);
          if (attWeight > 0) {
            const asis = nota.asistencia.get(cut.id);
            const programadas = allSessions.filter((s) => s.cut_id === cut.id).length;
            if (asis && asis.dadas > 0) {
              attItem = {
                id: `attendance-${cut.id}`,
                title: t("studentGrades.attendanceTitle", {
                  present: asis.presentes,
                  total: asis.dadas,
                }),
                kind: "attendance",
                cut_id: cut.id,
                rawGrade: asis.presentes,
                rawMax: asis.dadas,
                grade: asis.nota,
                status: "calculado",
                weight: attWeight,
                cuenta: true,
                motivo:
                  asis.dadas < programadas
                    ? t("notaRelativa.asistenciaDeLasDadas", { count: programadas })
                    : null,
              };
            } else {
              attItem = {
                id: `attendance-${cut.id}`,
                title:
                  programadas > 0
                    ? t("notaRelativa.asistenciaSinSesionesDadas")
                    : t("studentGrades.attendanceNoSessions"),
                kind: "attendance",
                cut_id: cut.id,
                rawGrade: null,
                rawMax: 0,
                grade: null,
                status: "pendiente",
                weight: attWeight,
                cuenta: false,
                motivo: null,
              };
            }
          }
          return {
            cut,
            items: attItem ? [...cutItems, attItem] : cutItems,
            grade: nota.cutGrades.find((g) => g.cutId === cut.id)?.grade ?? null,
          };
        });

        if (cancelled) return;
        // Sin corte asignado: informativo, NO suma a la nota final.
        setUnassigned(rows.filter((r) => !r.cut_id));
        setCutsBreakdown(breakdown);
        setFinalGrade(nota.finalGrade);
        setParcial(nota.parcial);
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

  const passes = course && finalGrade != null ? finalGrade >= course.passing_grade : null;
  const fmt = (n: number | null) => (n == null ? "—" : n.toFixed(2));
  /** En qué va cada corte, desde las notas y no desde las fechas. */
  const resumenes = resumirCortes(
    cutsBreakdown.map((cb) => cb.items.map((i) => ({ kind: i.kind, grade: i.grade }))),
  );
  /** Verde si aprueba, rojo si no: lo primero que el estudiante busca. */
  const colorDeNota = (n: number | null) =>
    n == null || !course ? "" : n >= course.passing_grade ? "text-success" : "text-destructive";

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
              {/* w-full en móvil (el selector es el control principal de la
                  pantalla y a 375px un ancho fijo deja el tap target corto);
                  ancho fijo desde sm. Mismo patrón que Asistencia. */}
              <SelectTrigger className="w-full sm:w-64">
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
          <CardContent className="p-0">
            <EmptyState icon={ClipboardList} text={t("studentGrades.notEnrolled")} />
          </CardContent>
        </Card>
      ) : !course ? null : (
        <>
          {/* Tarjetas resumen: una por corte + final */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {cutsBreakdown.map((cb, idx) => {
              const r = resumenes[idx];
              const asistencia = cb.items.find((i) => i.kind === "attendance");
              return (
                <Card
                  key={cb.cut.id}
                  className={r.estado === "actual" ? "border-primary/60 ring-1 ring-primary/40" : ""}
                >
                  <CardContent className="p-4 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground uppercase tracking-wide truncate">
                        {cb.cut.name}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        {r.estado === "actual" && (
                          <Badge className="text-3xs">{t("estadoCortes.actual")}</Badge>
                        )}
                        <Badge variant="outline" className="text-3xs">
                          {cb.cut.weight}%
                        </Badge>
                      </div>
                    </div>
                    {r.conNotas ? (
                      <>
                        <div className={`text-2xl font-semibold tabular-nums ${colorDeNota(cb.grade)}`}>
                          {fmt(cb.grade)}
                        </div>
                        <div className="text-2xs text-muted-foreground">
                          {t("studentGrades.gradedCount", {
                            graded: cb.items.filter((i) => i.grade != null).length,
                            total: cb.items.length,
                          })}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="text-2xl font-semibold text-muted-foreground">—</div>
                        <div className="text-2xs text-muted-foreground">
                          {t("estadoCortes.sinNotas")}
                          {asistencia?.grade != null &&
                            ` · ${t("estadoCortes.soloAsistencia", { nota: fmt(asistencia.grade) })}`}
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })}
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
                {parcial && finalGrade != null && (
                  <div className="text-2xs text-muted-foreground">
                    {t("notaRelativa.notaParcial")} · {t("notaRelativa.soloLoQueSeDio")}
                  </div>
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
              {/* `TableSkeleton` pinta filas (<tr>): van dentro de una tabla, no
                  sueltas en un <div> (React avisaba de HTML inválido). */}
              <CardContent className="p-4">
                <Table>
                  <TableBody>
                    <TableSkeleton rows={3} cols={4} />
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : cutsBreakdown.length === 0 ? (
            <Card>
              <CardContent className="p-4 sm:p-10 text-center text-sm text-muted-foreground">
                {t("studentGrades.noCuts")}
              </CardContent>
            </Card>
          ) : (
            cutsBreakdown.map((cb, idx) => {
              const r = resumenes[idx];
              // Abierto por defecto SOLO el corte actual: los demás se despliegan
              // a pedido, así la pantalla arranca mostrando lo que importa ahora.
              const abierto = abiertos[cb.cut.id] ?? r.estado === "actual";
              return (
              <Collapsible
                key={cb.cut.id}
                open={abierto}
                onOpenChange={(v) => setAbiertos((prev) => ({ ...prev, [cb.cut.id]: v }))}
              >
              <Card className={r.estado === "actual" ? "border-primary/60" : ""}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="w-full text-left rounded-t-lg hover:bg-accent/40 transition-colors"
                    aria-label={t("estadoCortes.toggleAria", { cut: cb.cut.name })}
                  >
                    <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 space-y-0">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <ChevronDown
                            className={`h-4 w-4 shrink-0 transition-transform ${abierto ? "" : "-rotate-90"}`}
                            aria-hidden
                          />
                          <CardTitle className="text-base truncate">{cb.cut.name}</CardTitle>
                          <EstadoDeCorteBadge estado={r.estado} />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t("studentGrades.cutWeight", { weight: cb.cut.weight })}{" "}
                          {r.conNotas ? (
                            <span className={`font-semibold tabular-nums ${colorDeNota(cb.grade)}`}>
                              {fmt(cb.grade)}
                            </span>
                          ) : (
                            <span className="font-medium">{t("estadoCortes.sinNotas")}</span>
                          )}
                        </p>
                        <SintesisDeCorte resumen={r} />
                      </div>
                      {cb.cut.start_date && cb.cut.end_date && (
                        <Badge variant="outline" className="text-3xs shrink-0">
                          {formatDateOnly(cb.cut.start_date)} → {formatDateOnly(cb.cut.end_date)}
                        </Badge>
                      )}
                    </CardHeader>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
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
                      // Con la MISMA regla que la nota del corte: lo que todavía no
                      // cuenta (abierto, por calificar) tampoco entra acá.
                      const subtotal = computeWeightedGrade(
                        items
                          .filter((i) => i.cuenta)
                          .map((i) => ({ score: i.grade, weight: i.weight ?? 0 })),
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
                </CollapsibleContent>
              </Card>
              </Collapsible>
              );
            })
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
      {/* flex-wrap: a 390 px las dos mitades no caben en una línea, y sin
          envolver cada texto se partía palabra por palabra. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-muted/40 px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <KindBadge kind={kind} />
          <span className="text-sm font-medium">{label}</span>
          <span className="text-2xs text-muted-foreground whitespace-nowrap">
            {i18n.t("studentGrades.gradedCount", { graded: gradedCount, total: totalCount })}
          </span>
        </div>
        <div className="text-xs text-muted-foreground inline-flex items-center gap-2 tabular-nums whitespace-nowrap">
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
            {/* Peso por item: se oculta bajo `sm` porque el peso del bucket ya
                está en el encabezado del grupo y en móvil lo decisivo es
                Puntaje/Nota. El TableCell usa el MISMO breakpoint. */}
            <TableHead className="hidden sm:table-cell text-right w-32">
              {i18n.t("common.weight")}
            </TableHead>
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
              <TableCell className="font-medium">
                {it.title}
                {it.motivo && (
                  <div className="text-2xs font-normal text-muted-foreground">{it.motivo}</div>
                )}
              </TableCell>
              <TableCell className="hidden sm:table-cell text-right text-xs tabular-nums text-muted-foreground">
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
        <Badge variant="outline" className="text-3xs">
          <FileText className="h-3 w-3 mr-1" />
          {i18n.t("studentGrades.kindBadgeExam")}
        </Badge>
      );
    case "workshop":
      return (
        <Badge variant="outline" className="text-3xs">
          <Hammer className="h-3 w-3 mr-1" />
          {i18n.t("studentGrades.kindBadgeWorkshop")}
        </Badge>
      );
    case "project":
      return (
        <Badge variant="outline" className="text-3xs">
          <FolderKanban className="h-3 w-3 mr-1" />
          {i18n.t("studentGrades.kindBadgeProject")}
        </Badge>
      );
    case "attendance":
      return (
        <Badge variant="outline" className="text-3xs">
          <CalendarCheck className="h-3 w-3 mr-1" />
          {i18n.t("studentGrades.kindBadgeAttendance")}
        </Badge>
      );
  }
}

/** El estado del corte en una palabra, con el color que lo distingue. */
function EstadoDeCorteBadge({ estado }: { estado: ResumenDeCorte["estado"] }) {
  const { t } = useTranslation();
  if (estado === "actual") return <Badge className="text-3xs shrink-0">{t("estadoCortes.actual")}</Badge>;
  if (estado === "con_notas")
    return (
      <Badge variant="secondary" className="text-3xs shrink-0">
        {t("estadoCortes.conNotas")}
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-3xs shrink-0 text-muted-foreground">
      {t("estadoCortes.sinNotas")}
    </Badge>
  );
}

/** Qué hay en el corte: «Exámenes 2/3 · Talleres 1/1 · Asistencia 1/1» (con nota / total). */
function SintesisDeCorte({ resumen }: { resumen: ResumenDeCorte }) {
  const { t } = useTranslation();
  if (resumen.porTipo.length === 0) return null;
  return (
    <p className="text-2xs text-muted-foreground truncate">
      {resumen.porTipo
        .map((x) =>
          t("estadoCortes.tipoConteo", {
            label: t(`estadoCortes.tipo_${x.kind}`),
            conNota: x.conNota,
            total: x.total,
          }),
        )
        .join(" · ")}
    </p>
  );
}
