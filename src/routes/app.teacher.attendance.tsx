import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { softDelete } from "@/modules/trash/soft-delete";
import { useAuth } from "@/hooks/use-auth";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import { isStaffRole } from "@/shared/lib/roles";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { HelpHint } from "@/components/ui/help-hint";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { friendlyError } from "@/shared/lib/db-errors";
import { ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CalendarCheck } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  Plus,
  CheckCircle2,
  X,
  Eraser,
  QrCode,
  Trash2,
  Settings2,
  Presentation as PresentationIcon,
  Scissors,
  MoreVertical,
  Check,
  ChevronsUpDown,
  CalendarPlus,
  PlayCircle,
  Zap,
  Palette,
  Copy,
} from "lucide-react";
import { toCSV } from "@/shared/lib/csv";
import { formatDateShort, formatSessionLabel, todayLocalISO } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { useTranslation, Trans } from "react-i18next";
import i18n from "@/i18n";
import { ImportExportMenu } from "@/shared/components/ImportExportMenu";
import { DatePicker } from "@/components/ui/date-picker";
import {
  AttendanceCheckInProjector,
  type CheckInState,
} from "@/modules/attendance/AttendanceCheckInProjector";
import {
  ATTENDANCE_CHECK_IN_DEFAULT_MINUTES,
  ATTENDANCE_CODE_ROTATION_DEFAULT,
} from "@/modules/attendance/attendance-code";
import { GenerateSessionsDialog } from "@/modules/contents/GenerateSessionsDialog";
import { buildNewSessionPayload } from "@/modules/sessions/create-session";
import { LaunchPollDialog } from "@/modules/polls/LaunchPollDialog";
import { SessionWhiteboardDialog } from "@/modules/whiteboard/SessionWhiteboardDialog";
import { DuplicateOptionsDialog } from "@/shared/components/DuplicateOptionsDialog";
// Helpers PUROS de CSV de sesiones — extraídos para testear sin montar
// el componente (ver src/modules/sessions/csv.test.ts). El template, el
// builder de filas y el parser viven ahí; acá solo los componemos con
// los efectos de DB / contexto React.
import {
  SESSIONS_TEMPLATE,
  SESSIONS_CSV_COLUMNS,
  parseHHMMToMinutes,
  addMinutesToHHMM,
  buildSessionsRows,
  parseSessionsCsv,
} from "@/modules/sessions/csv.ts";

const ATTENDANCE_TEMPLATE = `email,session_date,status,note
estudiante1@uni.edu,2025-08-01,presente,
estudiante2@uni.edu,2025-08-01,ausente,Justificó por correo
estudiante1@uni.edu,2025-08-03,presente,`;

export const Route = createFileRoute("/app/teacher/attendance")({ component: TeacherAttendance });

type Course = { id: string; name: string; period: string | null };
type Session = {
  id: string;
  course_id: string;
  session_date: string;
  title: string | null;
  created_by: string;
  check_in_open?: boolean;
  /** FK al corte al que pertenece la sesión. Lo elige el docente al
   * crear la sesión. Cuando es null, la sesión no aporta a la nota
   * de asistencia de ningún corte (ya no se infiere por fecha). */
  cut_id?: string | null;
  /** FK al GeneratedContent asignado a la sesión. Define qué material
   *  ve el estudiante en el tablero del curso para esta fecha. */
  content_id?: string | null;
  /** Índice de clase (1-indexed) cuando el contenido es curso_completo
   *  con varios CLASE_N. Para material_individual queda null. */
  content_class_index?: number | null;
  /** Enlace libre a la grabación (Meet, Teams, Zoom, Loom…). Se abre en
   *  nueva pestaña — no se intenta embed porque esos servicios bloquean
   *  iframes externos. */
  recording_url?: string | null;
  /** Enlace libre a las notas de reunión / minuta (Google Docs, Notion,
   *  etc.). Google Calendar lo trae automáticamente como attachment; el
   *  docente también lo puede pegar a mano. Se abre en nueva pestaña. */
  notes_url?: string | null;
  /** Referencia opcional a un video de la biblioteca con la grabación.
   *  Cuando está poblado, la UI lo embebe en el detalle de la sesión. */
  recording_video_id?: string | null;
  /** Hora de inicio de la clase (HH:MM:SS, Postgres TIME). NULL si no se
   *  registró. El CSV export la recorta a HH:MM. */
  start_time?: string | null;
  /** Duración en minutos. NULL si no se registró. */
  duration_minutes?: number | null;
  /** Link a la sala virtual (Meet/Zoom/Teams). Apertura en nueva pestaña. */
  meeting_url?: string | null;
};
/** Contenido generado disponible para asignar a una sesión. Solo
 *  status='done' y solo del docente actual (RLS lo asegura igual,
 *  pero filtramos para no traer ruido). */
type AvailableContent = {
  id: string;
  /** Nombre humano único — lo que muestra el selector. */
  display_name: string;
  /** Tema original del prompt (subtítulo para distinguir contenidos
   *  con el mismo nombre o reusar como buscable). */
  topic: string;
  mode: "curso_completo" | "material_individual";
  course_id: string | null;
  classes: number[]; // CLASE_N detectados; vacío para material_individual
};
type Cut = {
  id: string;
  name: string;
  position: number;
  start_date: string | null;
  end_date: string | null;
};
type Student = { id: string; full_name: string; institutional_email: string };
type Record_ = {
  id: string;
  session_id: string;
  user_id: string;
  status: string;
  note: string | null;
};

const STATUS_OPTIONS = [
  {
    value: "presente",
    short: i18n.t("teacherAttendance.statusPresentShort"),
    label: i18n.t("teacherAttendance.statusPresent"),
    icon: CheckCircle2,
    color: "text-success",
  },
  {
    value: "ausente",
    short: i18n.t("teacherAttendance.statusAbsentShort"),
    label: i18n.t("teacherAttendance.statusAbsent"),
    icon: X,
    color: "text-destructive",
  },
];

function TeacherAttendance() {
  const { user, roles, loading: authLoading } = useAuth();
  const confirm = useConfirm();
  const { t } = useTranslation();
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [cuts, setCuts] = useState<Cut[]>([]);
  // Contenidos generados disponibles para asignar (filtrados al curso
  // actual cuando aplica). Se carga junto con sessions/students en
  // loadCourse — no añade un round-trip extra perceptible.
  const [availableContents, setAvailableContents] = useState<AvailableContent[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [studentSearch, setStudentSearch] = useState("");
  const [records, setRecords] = useState<Record_[]>([]);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newDate, setNewDate] = useState(todayLocalISO());
  // Hora local (HH:MM 24h). El docente edita start y end; al guardar
  // calculamos `duration_minutes = end - start`. Es más natural que
  // pedir "duración" — el docente piensa en términos de "9:00-10:30",
  // no "90 minutos". La edge function de calendar sigue consumiendo
  // duration_minutes para crear el evento Google.
  const [newStartTime, setNewStartTime] = useState("09:00");
  const [newEndTime, setNewEndTime] = useState("10:30");
  const [newTitle, setNewTitle] = useState("");
  // Corte explícito al que pertenece la sesión nueva. "" = sin corte
  // (la sesión queda visible pero no aporta a la nota de asistencia).
  const [newCutId, setNewCutId] = useState<string>("");
  // Grabación de la clase. `newRecordingUrl` = enlace libre (Meet/Teams/
  // Zoom/Loom/...); `newRecordingVideoId` = referencia a la biblioteca.
  // Independientes — uno, ambos o ninguno pueden estar poblados.
  const [newRecordingUrl, setNewRecordingUrl] = useState("");
  const [newRecordingVideoId, setNewRecordingVideoId] = useState<string>("");
  // Notas de reunión / minuta de la clase. Análogo a newRecordingUrl —
  // enlace libre (Google Docs/Notion/…). Google Calendar lo trae como
  // attachment al vincular; también editable a mano.
  const [newNotesUrl, setNewNotesUrl] = useState("");
  // Guard "cambios sin guardar" para el dialog de nueva sesión. Agrupa los
  // campos editables del form en un memo (el hook compara por JSON.stringify
  // y captura el snapshot al abrir el dialog).
  const newSessionFormMemo = useMemo(
    () => ({
      newDate,
      newStartTime,
      newEndTime,
      newTitle,
      newCutId,
      newRecordingUrl,
      newRecordingVideoId,
      newNotesUrl,
    }),
    [
      newDate,
      newStartTime,
      newEndTime,
      newTitle,
      newCutId,
      newRecordingUrl,
      newRecordingVideoId,
      newNotesUrl,
    ],
  );
  const newSessionDirty = useDirtyDialog(newSessionOpen, newSessionFormMemo);
  // Lista de videos disponibles para asociar a la sesión (biblioteca
  // filtrada al curso actual + globales sin course_id). Cargada lazy
  // cuando se abre el dialog.
  const [sessionVideos, setSessionVideos] = useState<
    Array<{ id: string; title: string; provider: string }>
  >([]);
  // Estado del dialog de edición de grabación para sesiones existentes
  // (se declara aquí arriba porque `useEffect(loadSessionVideos)` debajo
  // depende de `recordingEditSession`).
  const [recordingEditSession, setRecordingEditSession] = useState<Session | null>(null);
  const [recordingEditUrl, setRecordingEditUrl] = useState("");
  const [recordingEditVideoId, setRecordingEditVideoId] = useState<string>("");
  // Notas de reunión / minuta para sesiones existentes (mismo dialog que
  // la grabación de fila). Análogo a recordingEditUrl.
  const [notesEditUrl, setNotesEditUrl] = useState("");

  // Check-in self-service: configuración + estado del proyector activo
  const [checkInConfigSession, setCheckInConfigSession] = useState<Session | null>(null);
  // Sesión seleccionada para lanzar una encuesta in-class. Cuando es
  // != null se abre `LaunchPollDialog` con el attendance_session_id
  // pre-rellenado. La encuesta queda en `polls` con el FK seteado y
  // aparece destacada para los alumnos en /app/student/polls como
  // "🎯 Sesión presencial".
  const [pollLaunchSession, setPollLaunchSession] = useState<Session | null>(null);
  // Sesión seleccionada para abrir su pizarra. Distinto del whiteboard
  // standalone — esta queda ligada 1:1 al attendance_session via la
  // columna `whiteboard_scene JSONB` (mig 20260603060000). Reabrir
  // recupera el contenido. Solo el docente de la sesión la edita.
  const [whiteboardSession, setWhiteboardSession] = useState<Session | null>(null);
  // Sesión seleccionada para DUPLICAR. Abre un dialog con opciones de qué
  // info interna copiar (contenido asignado, pizarra, snippets de código).
  const [duplicateSessionFor, setDuplicateSessionFor] = useState<Session | null>(null);
  /** Abre el dialog "Programar sesiones del curso". Se usa SIN contenido
   *  pre-asociado — el dialog calcula N sesiones a partir de fecha
   *  inicio + días de la semana, las crea con `course_id = courseId` y
   *  titulo genérico "Sesión N". El docente puede asignar contenido
   *  después desde el selector buscable del propio tablero. */
  const [generateSessionsOpen, setGenerateSessionsOpen] = useState(false);
  const [checkInDuration, setCheckInDuration] = useState<number>(
    ATTENDANCE_CHECK_IN_DEFAULT_MINUTES,
  );
  const [checkInRotation, setCheckInRotation] = useState<number>(ATTENDANCE_CODE_ROTATION_DEFAULT);
  const [startingCheckIn, setStartingCheckIn] = useState(false);
  const [projector, setProjector] = useState<CheckInState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  // SA accede a pantallas Docente para soporte / diagnóstico — sin SA
  // en el set, recibía "Necesitas rol Docente" silencioso al entrar.
  const isTeacher = isStaffRole(roles);

  // Load courses
  useEffect(() => {
    supabase
      .from("courses")
      .select("id, name, period")
      // Ocultar cursos en papelera del Select de curso del tablero.
      .is("deleted_at", null)
      .order("name")
      .then(({ data, error }) => {
        if (error) {
          setLoadError(friendlyError(error, t("teacherAttendance.loadCoursesErrorHint")));
          return;
        }
        setLoadError(null);
        setCourses((data ?? []) as Course[]);
        if (data?.[0]) setCourseId(data[0].id);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  // Load data for selected course
  const loadCourse = useCallback(async () => {
    if (!courseId) return;

    const [{ data: sess }, { data: enr }, { data: cs }, { data: gens }] = await Promise.all([
      supabase
        .from("attendance_sessions")
        .select("*")
        .eq("course_id", courseId)
        // Ocultar sesiones en papelera del tablero del docente.
        .is("deleted_at", null)
        .order("session_date"),
      supabase.from("course_enrollments").select("user_id").eq("course_id", courseId),
      // grade_cuts no está en types.ts auto-generado todavía
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .from("grade_cuts")
        .select("id, name, position, start_date, end_date")
        .eq("course_id", courseId)
        .order("position"),
      // generated_contents disponibles: status='done' del docente.
      // Filtramos a contenidos que sean del propio curso O sin curso
      // asociado (material reutilizable). RLS ya restringe al teacher_id.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .from("generated_contents")
        .select("id, display_name, topic, mode, course_id, files")
        .eq("status", "done")
        // No ofrecer contenidos en papelera para asignar a sesiones.
        .is("deleted_at", null)
        .or(`course_id.eq.${courseId},course_id.is.null`),
    ]);
    setSessions((sess ?? []) as Session[]);
    setCuts((cs ?? []) as Cut[]);
    // Aplana files[] → classes[] para no recalcular en cada Select.
    setAvailableContents(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((gens ?? []) as any[]).map((g) => {
        const files = (g.files ?? []) as Array<{ name: string }>;
        const set = new Set<number>();
        for (const f of files) {
          const m = f.name.match(/(?:CLASE|CLASS|SESION|SESSION)[_\s-]*(\d+)/i);
          if (m) set.add(Number(m[1]));
        }
        return {
          id: g.id,
          // Fallback al topic para filas pre-migración display_name.
          display_name: (g.display_name as string | null) ?? g.topic,
          topic: g.topic,
          mode: g.mode,
          course_id: g.course_id,
          classes: Array.from(set).sort((a, b) => a - b),
        };
      }),
    );

    const userIds = (enr ?? []).map((e: any) => e.user_id);
    if (userIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", userIds)
        .order("full_name");
      setStudents((profs ?? []) as Student[]);
    } else {
      setStudents([]);
    }

    // Load all records for this course's sessions
    const sessionIds = (sess ?? []).map((s: any) => s.id);
    if (sessionIds.length) {
      const { data: recs } = await supabase
        .from("attendance_records")
        .select("*")
        .in("session_id", sessionIds);
      setRecords((recs ?? []) as Record_[]);
    } else {
      setRecords([]);
    }
  }, [courseId]);

  useEffect(() => {
    loadCourse();
  }, [loadCourse]);

  // Carga lazy de los videos disponibles para asociar a sesión. Se llama
  // cuando se abre el dialog de nueva sesión o el de editar grabación.
  // Filtra a (videos del curso actual) ∪ (globales sin course_id).
  const loadSessionVideos = useCallback(async () => {
    if (!courseId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from("videos")
      .select("id, title, provider, course_id")
      .eq("is_archived", false)
      .or(`course_id.eq.${courseId},course_id.is.null`)
      .order("title");
    setSessionVideos((data ?? []) as Array<{ id: string; title: string; provider: string }>);
  }, [courseId]);

  useEffect(() => {
    if (newSessionOpen || recordingEditSession) {
      void loadSessionVideos();
    }
  }, [newSessionOpen, recordingEditSession, loadSessionVideos]);

  // Create session
  const createSession = async () => {
    if (!courseId || !user || !newDate) {
      toast.error(
        i18n.t("toast.routes_app_teacher_attendance.dateRequired", {
          defaultValue: "Fecha requerida",
        }),
      );
      return;
    }
    // Validación de horas: ambos opcionales, pero si vienen los dos
    // deben ser consistentes (end > start). Sin esto el docente podría
    // guardar "9:00 → 8:00" con duración negativa.
    const startMin = newStartTime ? parseHHMMToMinutes(newStartTime) : null;
    const endMin = newEndTime ? parseHHMMToMinutes(newEndTime) : null;
    if (startMin != null && endMin != null && endMin <= startMin) {
      toast.error(
        i18n.t("toast.routes_app_teacher_attendance.endTimeAfterStart", {
          defaultValue: "La hora de fin debe ser posterior a la de inicio.",
        }),
      );
      return;
    }
    // Derivamos duration desde end-start cuando ambos están. Si solo hay
    // start, default 90 min (clase universitaria típica). Si no hay
    // start_time, duration queda null para no inventar datos.
    const duration =
      startMin != null && endMin != null && endMin > startMin
        ? endMin - startMin
        : newStartTime
          ? 90
          : null;
    // cut_id va sólo si el docente eligió uno. Sin corte la sesión es
    // visible pero no entra en el cálculo de la nota de asistencia.
    // start_time se persiste como TIME ("HH:MM:00") sin zona horaria (lo
    // normaliza buildNewSessionPayload). Bogotá se aplica al construir el ISO
    // datetime en la edge function de calendar — la columna DB es agnóstica de TZ.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("attendance_sessions").insert(
      buildNewSessionPayload({
        course_id: courseId,
        session_date: newDate,
        created_by: user.id,
        title: newTitle || null,
        start_time: newStartTime || null,
        duration_minutes: duration,
        cut_id: newCutId || null,
        recording_url: newRecordingUrl.trim() || null,
        recording_video_id: newRecordingVideoId || null,
        notes_url: newNotesUrl.trim() || null,
      }),
    );
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("toast.routes_app_teacher_attendance.sessionCreated", {
        defaultValue: "Sesión creada correctamente",
      }),
    );
    setNewSessionOpen(false);
    setNewTitle("");
    setNewCutId("");
    setNewRecordingUrl("");
    setNewRecordingVideoId("");
    setNewNotesUrl("");
    loadCourse();
  };

  /** Duplicar una sesión. Crea una sesión NUEVA en la misma fecha (el docente
   *  reubica la fecha después con el engranaje) copiando metadata estructural
   *  (título + "(copia)", corte, hora, duración, sala). El docente elige qué
   *  información INTERNA se copia:
   *   - copyContent: el material asignado (content_id + content_class_index).
   *   - copyWhiteboard: el lienzo de la pizarra (whiteboard_scene) y si está
   *     compartida con los estudiantes (whiteboard_shared).
   *   - copySnippets: los snippets de código preparados (session_code_snippets),
   *     SIN su caché de última ejecución (la copia nace sin correr).
   *  NUNCA se copian: asistencia registrada, grabación/notas, ni el estado de
   *  check-in — son propios de la sesión que ya ocurrió. */
  const duplicateSession = async (
    s: Session,
    opts: { copyContent: boolean; copyWhiteboard: boolean; copySnippets: boolean },
  ) => {
    if (!user || !courseId) return;
    try {
      // El whiteboard_scene/shared NO está en el type Session (se cargan con
      // select("*"), pero los leemos puntualmente para no depender del payload).
      let whiteboardScene: unknown = null;
      let whiteboardShared = false;
      if (opts.copyWhiteboard) {
        const { data: wb } = await (supabase as any)
          .from("attendance_sessions")
          .select("whiteboard_scene, whiteboard_shared")
          .eq("id", s.id)
          .maybeSingle();
        whiteboardScene = wb?.whiteboard_scene ?? null;
        whiteboardShared = wb?.whiteboard_shared ?? false;
      }
      const payload: Record<string, unknown> = {
        course_id: courseId,
        session_date: s.session_date,
        title: `${s.title ?? t("teacherAttendance.defaultSessionTitle")} ${t("teacherAttendance.copySuffix")}`,
        created_by: user.id,
        cut_id: s.cut_id ?? null,
        start_time: s.start_time ?? null,
        duration_minutes: s.duration_minutes ?? null,
        meeting_url: s.meeting_url ?? null,
      };
      if (opts.copyContent) {
        payload.content_id = s.content_id ?? null;
        payload.content_class_index = s.content_class_index ?? null;
      }
      if (opts.copyWhiteboard) {
        payload.whiteboard_scene = whiteboardScene;
        payload.whiteboard_shared = whiteboardShared;
      }
      const { data: created, error } = await (supabase as any)
        .from("attendance_sessions")
        .insert(payload)
        .select("id")
        .single();
      if (error || !created) {
        toast.error(friendlyError(error, t("teacherAttendance.duplicateFailed")));
        return;
      }
      // Snippets: clonamos title/language/source_code/position. NO copiamos
      // last_stdout/last_stderr/last_exit_code/last_executed_at (caché de
      // ejecución del original — la copia arranca sin correr).
      if (opts.copySnippets) {
        const { data: snips } = await (supabase as any)
          .from("session_code_snippets")
          .select("id, position, title, language, source_code")
          .eq("session_id", s.id)
          .order("position");
        if (snips && snips.length > 0) {
          const rows = (snips as Array<Record<string, unknown>>).map((sn) => ({
            session_id: created.id,
            position: sn.position,
            title: sn.title,
            language: sn.language,
            source_code: sn.source_code,
          }));
          const { data: newSnips, error: snErr } = await (supabase as any)
            .from("session_code_snippets")
            .insert(rows)
            .select("id, position");
          if (snErr) {
            // No abortamos: la sesión ya se creó; avisamos que faltaron snippets.
            toast.warning(
              friendlyError(snErr, t("teacherAttendance.duplicateSnippetsFailed")),
            );
          } else if (newSnips) {
            // Copiar también session_snippet_files: son la FUENTE DE VERDAD del
            // contenido multi-archivo (source_code es solo un fallback legacy
            // sincronizado con el 1er archivo). Sin esto, la copia pierde los
            // archivos secundarios y el filename real (cae a "Main.java").
            const oldIds = (snips as Array<{ id: string }>).map((sn) => sn.id);
            const { data: files } = await (supabase as any)
              .from("session_snippet_files")
              .select("snippet_id, filename, content, position")
              .in("snippet_id", oldIds);
            if (files && files.length > 0) {
              const posByOldId = new Map(
                (snips as Array<{ id: string; position: number }>).map((sn) => [sn.id, sn.position]),
              );
              const newIdByPos = new Map(
                (newSnips as Array<{ id: string; position: number }>).map((sn) => [sn.position, sn.id]),
              );
              const fileRows = (
                files as Array<{ snippet_id: string; filename: string; content: string; position: number }>
              )
                .map((f) => {
                  const pos = posByOldId.get(f.snippet_id);
                  const newId = pos != null ? newIdByPos.get(pos) : undefined;
                  return newId
                    ? { snippet_id: newId, filename: f.filename, content: f.content, position: f.position }
                    : null;
                })
                .filter(Boolean);
              if (fileRows.length > 0) {
                const { error: fErr } = await (supabase as any)
                  .from("session_snippet_files")
                  .insert(fileRows);
                if (fErr) {
                  toast.warning(
                    friendlyError(fErr, t("teacherAttendance.duplicateSnippetsFailed")),
                  );
                }
              }
            }
          }
        }
      }
      toast.success(t("teacherAttendance.sessionDuplicated"));
      loadCourse();
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  // Persiste recording_url / recording_video_id en sesiones existentes
  // desde la columna "Grabación" de la tabla. Se llama desde el handler
  // del Dialog "Editar grabación" — uno solo en la página. El state
  // mismo se declara arriba (junto a sessionVideos) porque el effect
  // `loadSessionVideos` depende de él.
  const openRecordingEdit = (s: Session) => {
    setRecordingEditSession(s);
    setRecordingEditUrl(s.recording_url ?? "");
    setRecordingEditVideoId(s.recording_video_id ?? "");
    setNotesEditUrl(s.notes_url ?? "");
  };

  const saveRecordingEdit = async () => {
    if (!recordingEditSession) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("attendance_sessions")
      .update({
        recording_url: recordingEditUrl.trim() || null,
        recording_video_id: recordingEditVideoId || null,
        notes_url: notesEditUrl.trim() || null,
      })
      .eq("id", recordingEditSession.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setSessions((prev) =>
      prev.map((s) =>
        s.id === recordingEditSession.id
          ? {
              ...s,
              recording_url: recordingEditUrl.trim() || null,
              recording_video_id: recordingEditVideoId || null,
              notes_url: notesEditUrl.trim() || null,
            }
          : s,
      ),
    );
    setRecordingEditSession(null);
    toast.success(
      i18n.t("toast.routes_app_teacher_attendance.recordingUpdated", {
        defaultValue: "Grabación actualizada",
      }),
    );
  };

  // Reasignar el corte de una sesión existente (la fecha NO cambia).
  // Útil cuando se crea un corte nuevo y se quieren mover sesiones
  // huérfanas, o cuando el docente cambia de criterio.
  const updateSessionCut = async (sessionId: string, cutId: string | null) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("attendance_sessions")
      .update({ cut_id: cutId })
      .eq("id", sessionId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, cut_id: cutId } : s)));
  };

  /**
   * Actualiza la asignación de contenido de UNA sesión. El value que
   * recibe el Select se codifica como `"<contentId>:<classIndex>"`
   * (classIndex puede ser "0" para material_individual completo) o
   * `"__none"` para limpiar. Lo decodificamos aquí y persistimos los
   * dos campos en attendance_sessions.
   */
  const updateSessionContent = async (sessionId: string, raw: string) => {
    let content_id: string | null = null;
    let content_class_index: number | null = null;
    if (raw !== "__none") {
      const [cid, idx] = raw.split(":");
      content_id = cid;
      const n = Number(idx);
      content_class_index = Number.isFinite(n) && n > 0 ? n : null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("attendance_sessions")
      .update({ content_id, content_class_index })
      .eq("id", sessionId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, content_id, content_class_index } : s)),
    );
  };

  // Toggle attendance ("none" = eliminar registro para esa celda)
  const setAttendance = async (sessionId: string, userId: string, status: string) => {
    const existing = records.find((r) => r.session_id === sessionId && r.user_id === userId);
    if (status === "none") {
      if (!existing) return;
      const { error } = await supabase.from("attendance_records").delete().eq("id", existing.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      setRecords((prev) => prev.filter((r) => r.id !== existing.id));
      return;
    }
    if (existing) {
      const { error } = await supabase
        .from("attendance_records")
        .update({ status })
        .eq("id", existing.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      setRecords((prev) => prev.map((r) => (r.id === existing.id ? { ...r, status } : r)));
    } else {
      const { data, error } = await supabase
        .from("attendance_records")
        .insert({
          session_id: sessionId,
          user_id: userId,
          status,
        })
        .select()
        .single();
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      if (data) setRecords((prev) => [...prev, data as Record_]);
    }
  };

  // Get status for a cell
  const getStatus = (sessionId: string, userId: string): string => {
    return records.find((r) => r.session_id === sessionId && r.user_id === userId)?.status ?? "";
  };

  // Marcar todos presentes en la sesión (sobrescribe ausentes / vacíos)
  const markAllPresent = async (sessionId: string) => {
    if (!students.length) return;
    for (const s of students) {
      const existing = records.find((r) => r.session_id === sessionId && r.user_id === s.id);
      if (existing) {
        await supabase
          .from("attendance_records")
          .update({ status: "presente" })
          .eq("id", existing.id);
      } else {
        await supabase.from("attendance_records").insert({
          session_id: sessionId,
          user_id: s.id,
          status: "presente",
        });
      }
    }
    toast.success(
      i18n.t("toast.routes_app_teacher_attendance.allMarkedPresent", {
        defaultValue: "Todos los estudiantes marcados como presentes",
      }),
    );
    loadCourse();
  };

  // Quitar todo registro de asistencia de la sesión
  const clearSessionAttendance = async (sessionId: string) => {
    const ok = await confirm({
      title: t("attendance.resetTitle"),
      description: t("attendance.resetBody"),
      confirmLabel: t("common.confirm"),
      tone: "warning",
    });
    if (!ok) return;
    const { error } = await supabase
      .from("attendance_records")
      .delete()
      .eq("session_id", sessionId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("toast.routes_app_teacher_attendance.sessionAttendanceReset", {
        defaultValue: "Asistencia de la sesión reiniciada",
      }),
    );
    loadCourse();
  };

  // Build CSV de exportación de asistencia (matriz)
  const buildAttendanceCsv = (): string => {
    if (!sessions.length || !students.length) return "";
    const csvRows = students.map((s) => {
      const row: any = { nombre: s.full_name, email: s.institutional_email };
      sessions.forEach((sess) => {
        const label = sess.title ? `${sess.session_date} - ${sess.title}` : sess.session_date;
        row[label] = getStatus(sess.id, s.id) || "—";
      });
      const total = sessions.length;
      const present = sessions.filter((sess) => getStatus(sess.id, s.id) === "presente").length;
      row["% Asistencia"] = total > 0 ? `${Math.round((present / total) * 100)}%` : "—";
      return row;
    });
    return toCSV(csvRows);
  };

  // Build CSV de exportación de sesiones/clases. Composición fina sobre
  // `buildSessionsRows` (puro, testeado) + `toCSV` (puro, testeado).
  const buildSessionsCsv = (): string => {
    if (!sessions.length) return "";
    const cutNameById = new Map(cuts.map((c) => [c.id, c.name]));
    return toCSV(buildSessionsRows(sessions, cutNameById), [...SESSIONS_CSV_COLUMNS]);
  };

  // Importar sesiones desde CSV. Parseo PURO en `parseSessionsCsv` (ver
  // src/modules/sessions/csv.ts) — acá solo añadimos el contexto
  // (course_id, created_by) y disparamos el insert + reload.
  const importSessions = async (rows: Record<string, string>[]) => {
    if (!courseId || !user) throw new Error(t("teacherAttendance.selectCourse"));
    const cutByName = new Map(cuts.map((c) => [c.name.trim().toLowerCase(), c.id]));
    const { rows: parsed, unmatchedCuts } = parseSessionsCsv(rows, cutByName);
    if (!parsed.length) throw new Error(t("teacherAttendance.noValidRows"));
    const payload = parsed.map((p) => ({
      course_id: courseId,
      created_by: user.id,
      session_date: p.session_date,
      title: p.title,
      cut_id: p.cut_id,
      start_time: p.start_time,
      duration_minutes: p.duration_minutes,
      meeting_url: p.meeting_url,
      recording_url: p.recording_url,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("attendance_sessions").insert(payload);
    if (error) throw new Error(friendlyError(error));
    await loadCourse();
    const suffix =
      unmatchedCuts > 0
        ? t("teacherAttendance.importSessionsUnmatchedSuffix", { count: unmatchedCuts })
        : "";
    return t("teacherAttendance.importSessionsResult", { count: payload.length }) + suffix;
  };

  // Importar registros de asistencia desde CSV
  const importAttendance = async (rows: Record<string, string>[]) => {
    if (!courseId) throw new Error(t("teacherAttendance.selectCourse"));
    const sessionByDate = new Map(sessions.map((s) => [s.session_date, s.id]));
    const studentByEmail = new Map(
      students.map((s) => [s.institutional_email.toLowerCase(), s.id]),
    );

    let inserted = 0,
      updated = 0,
      skipped = 0;
    for (const r of rows) {
      const email = (r.email || "").toLowerCase().trim();
      const date = (r.session_date || "").trim();
      const status = (r.status || "").toLowerCase().trim();
      const note = r.note || null;
      const sid = sessionByDate.get(date);
      const uid = studentByEmail.get(email);
      if (!sid || !uid || !["presente", "ausente"].includes(status)) {
        skipped++;
        continue;
      }
      const existing = records.find((rec) => rec.session_id === sid && rec.user_id === uid);
      if (existing) {
        const { error } = await supabase
          .from("attendance_records")
          .update({ status, note })
          .eq("id", existing.id);
        if (!error) updated++;
        else skipped++;
      } else {
        const { error } = await supabase
          .from("attendance_records")
          .insert({ session_id: sid, user_id: uid, status, note });
        if (!error) inserted++;
        else skipped++;
      }
    }
    await loadCourse();
    return t("teacherAttendance.importAttendanceResult", { inserted, updated, skipped });
  };

  // ── Check-in self-service ──────────────────────────────────────────
  // Total de matriculados — el proyector lo necesita para mostrar X/Y
  const totalEnrolled = students.length;

  const openCheckInConfig = (sess: Session) => {
    setCheckInDuration(ATTENDANCE_CHECK_IN_DEFAULT_MINUTES);
    setCheckInRotation(ATTENDANCE_CODE_ROTATION_DEFAULT);
    setCheckInConfigSession(sess);
  };

  const startCheckIn = async () => {
    if (!checkInConfigSession) return;
    setStartingCheckIn(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("teacher_open_attendance_check_in", {
        p_session_id: checkInConfigSession.id,
        p_duration_minutes: checkInDuration,
        p_rotation_seconds: checkInRotation,
      });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      // RPC retorna { ok, seed, rotation_seconds, opened_at, closes_at } o { ok:false, error }
      const result = data as {
        ok: boolean;
        error?: string;
        seed?: string;
        rotation_seconds?: number;
        closes_at?: string;
      };
      if (!result?.ok || !result.seed || !result.closes_at || !result.rotation_seconds) {
        toast.error(result?.error ?? t("teacherAttendance.checkInStartFailed"));
        return;
      }
      setProjector({
        sessionId: checkInConfigSession.id,
        seed: result.seed,
        rotationSeconds: result.rotation_seconds,
        closesAt: result.closes_at,
        totalEnrolled,
        sessionLabel: formatSessionLabel(
          checkInConfigSession.session_date,
          checkInConfigSession.title,
        ),
      });
      void logEvent({
        action: "attendance.checkin_opened",
        category: "attendance",
        actorRole: roles[0],
        entityType: "attendance_session",
        entityId: checkInConfigSession.id,
        courseId: checkInConfigSession.course_id,
        metadata: { duration_minutes: checkInDuration, rotation_seconds: checkInRotation },
      });

      // NO notificamos desde el cliente: el trigger de DB
      // `trg_notify_attendance_check_in_open` (AFTER UPDATE OF check_in_open,
      // WHEN false→true) ya inserta la notificación `kind='attendance'` +
      // correo + push a TODOS los matriculados, y cubre CUALQUIER vía de
      // apertura (UI, RPC directa, SQL) de forma idempotente. La llamada
      // cliente adicional duplicaba notif/correo/push por cada alumno
      // (2× por apertura — p.ej. 186 correos en un curso de 93).
      setCheckInConfigSession(null);
      // Refresca listado para reflejar check_in_open=true
      loadCourse();
    } finally {
      setStartingCheckIn(false);
    }
  };

  /** Reabre el proyector de una sesión que ya está abierta (refresh / otra pestaña). */
  const reopenProjector = async (sess: Session) => {
    const { data, error } = await supabase
      .from("attendance_check_in_state" as never)
      .select("seed, rotation_seconds, closes_at")
      .eq("session_id", sess.id)
      .maybeSingle();
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    // Sesión inconsistente: check_in_open=true pero no hay state. Limpiar
    // y permitir al docente iniciar uno nuevo.
    if (!data) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).rpc("teacher_close_attendance_check_in", {
        p_session_id: sess.id,
      });
      toast.info(
        i18n.t("toast.routes_app_teacher_attendance.previousCheckInExpired", {
          defaultValue: "El check-in anterior expiró. Inicia uno nuevo.",
        }),
      );
      loadCourse();
      openCheckInConfig(sess);
      return;
    }
    const row = data as { seed: string; rotation_seconds: number; closes_at: string };
    // State expirado en DB pero check_in_open=true: limpiar y abrir uno
    // nuevo en vez de reabrir un proyector que se cerrará en el primer tick.
    if (new Date(row.closes_at).getTime() <= Date.now()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).rpc("teacher_close_attendance_check_in", {
        p_session_id: sess.id,
      });
      toast.info(
        i18n.t("toast.routes_app_teacher_attendance.previousCheckInExpired", {
          defaultValue: "El check-in anterior expiró. Inicia uno nuevo.",
        }),
      );
      loadCourse();
      openCheckInConfig(sess);
      return;
    }
    setProjector({
      sessionId: sess.id,
      seed: row.seed,
      rotationSeconds: row.rotation_seconds,
      closesAt: row.closes_at,
      totalEnrolled,
      sessionLabel: formatSessionLabel(sess.session_date, sess.title),
    });
  };

  /** Llamado por el proyector cuando se cierra (manual o por expiración). */
  const closeProjector = async () => {
    const closedSessionId = projector?.sessionId;
    if (closedSessionId) {
      void logEvent({
        action: "attendance.checkin_closed",
        category: "attendance",
        actorRole: roles[0],
        entityType: "attendance_session",
        entityId: closedSessionId,
        courseId: courseId || undefined,
      });
    }
    setProjector(null);
    loadCourse();
    if (!closedSessionId) return;
    // Ofrecer marcar pendientes como ausentes
    const ok = await confirm({
      title: t("attendance.markAbsentsTitle"),
      description: t("attendance.markAbsentsBody"),
      confirmLabel: t("attendance.markAbsentsConfirm"),
      tone: "warning",
    });
    if (!ok) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("teacher_mark_pending_absent", {
      p_session_id: closedSessionId,
    });
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    const result = data as { ok: boolean; marked_absent?: number; error?: string };
    if (result?.ok) {
      void logEvent({
        action: "attendance.pending_marked_absent",
        category: "attendance",
        actorRole: roles[0],
        severity: "warning",
        entityType: "attendance_session",
        entityId: closedSessionId,
        courseId: courseId || undefined,
        metadata: { marked_absent: result.marked_absent ?? 0 },
      });
      toast.success(
        i18n.t("toast.routes_app_teacher_attendance.studentsMarkedAbsent", {
          defaultValue: "{{count}} estudiante(s) marcado(s) como ausentes",
          count: result.marked_absent ?? 0,
        }),
      );
      loadCourse();
    } else {
      toast.error(result?.error ?? t("teacherAttendance.markPendingFailed"));
    }
  };

  // Delete session
  const deleteSession = async (id: string) => {
    const sess = sessions.find((s) => s.id === id);
    const recordsForSession = records.filter((r) => r.session_id === id).length;
    const dateLabel = sess
      ? formatSessionLabel(sess.session_date, sess.title)
      : t("teacherAttendance.thisSession");
    const ok = await confirm({
      title: t("attendance.deleteSessionTitle"),
      description: t("attendance.deleteSessionBody", {
        session: dateLabel,
        count: recordsForSession,
      }),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await softDelete("attendance_sessions", id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(t("attendance.sessionDeleted"));
    loadCourse();
  };

  // Agrupa las sesiones por corte usando el FK explícito
  // attendance_sessions.cut_id. Antes la pertenencia se infería por
  // rango de fechas (cut.start_date <= session_date <= cut.end_date),
  // pero ahora el docente la elige al crear la sesión y la puede
  // cambiar desde el selector "Corte" en el header de cada columna.
  // Las sesiones sin cut_id (legacy o intencionales) caen al grupo
  // "Sin corte" y no aportan a la nota de asistencia.
  type CutGroup = { cut: Cut | null; sessions: Session[] };
  const cutGroups: CutGroup[] = (() => {
    if (sessions.length === 0) return [];
    const groups: CutGroup[] = cuts.map((c) => ({ cut: c, sessions: [] }));
    const orphan: CutGroup = { cut: null, sessions: [] };
    for (const sess of sessions) {
      const target = sess.cut_id ? groups.find((g) => g.cut?.id === sess.cut_id) : null;
      if (target) {
        target.sessions.push(sess);
      } else {
        orphan.sessions.push(sess);
      }
    }
    const nonEmpty = groups.filter((g) => g.sessions.length > 0);
    if (orphan.sessions.length > 0) nonEmpty.push(orphan);
    return nonEmpty;
  })();
  // Marca el id de la primera sesión de cada grupo (excepto el primer
  // grupo en absoluto) para pintar un divisor visual entre cortes.
  const cutBoundaryIds = new Set(
    cutGroups
      .slice(1)
      .map((g) => g.sessions[0]?.id)
      .filter(Boolean) as string[],
  );

  // Filtra estudiantes para el render. La lista completa (`students`)
  // se preserva para los totales del header y el cálculo de check-in.
  const filteredStudents = useMemo(() => {
    if (!studentSearch.trim()) return students;
    const q = studentSearch.toLowerCase();
    return students.filter((s) => {
      const name = s.full_name.toLowerCase();
      const email = s.institutional_email.toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [students, studentSearch]);

  if (authLoading) return null;
  if (!isTeacher)
    return <p className="text-muted-foreground">{t("teacherAttendance.needsTeacherRole")}</p>;

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<CalendarCheck className="h-6 w-6" />}
          title={t("teacherAttendance.pageTitle")}
        />
        <ErrorState
          message={t("teacherAttendance.loadCoursesError")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<CalendarCheck className="h-6 w-6" />}
        title={t("teacherAttendance.pageTitle")}
        subtitle={t("teacherAttendance.subtitle", {
          sessions: sessions.length,
          students: students.length,
        })}
        actions={
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
            <Select value={courseId} onValueChange={setCourseId}>
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue placeholder={t("teacherAttendance.coursePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {c.period ? ` (${c.period})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ImportExportMenu
              label={t("teacherAttendance.classesLabel")}
              resourceName={t("teacherAttendance.classesResourceName")}
              templateCsv={SESSIONS_TEMPLATE}
              onImport={importSessions}
              onExport={buildSessionsCsv}
              disabled={!courseId}
            />
            <ImportExportMenu
              label={t("teacherAttendance.attendanceLabel")}
              resourceName={t("teacherAttendance.attendanceResourceName")}
              templateCsv={ATTENDANCE_TEMPLATE}
              onImport={importAttendance}
              onExport={buildAttendanceCsv}
              disabled={!courseId}
            />
            <Button
              size="sm"
              onClick={() => setNewSessionOpen(true)}
              data-tour-id="create-session"
            >
              <Plus className="h-4 w-4 mr-1" />
              {t("teacherAttendance.newSession")}
            </Button>
            {/* Programar varias sesiones a partir de fecha inicio + días
              de la semana. Mismo dialog que vive en el módulo de
              Contenidos, pero acá lo abrimos SIN contenido pre-asociado
              — el docente puede después asignar contenido a cada sesión
              desde el selector buscable del propio tablero. */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setGenerateSessionsOpen(true)}
              disabled={!courseId}
              title={t("teacherAttendance.scheduleSessionsTitle")}
            >
              <CalendarPlus className="h-4 w-4 mr-1" />
              {t("teacherAttendance.scheduleSessions")}
            </Button>
          </div>
        }
      />

      {/* Legend (above the grid) */}
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="p-3 flex flex-wrap items-center gap-4 text-xs">
          <span className="font-medium text-muted-foreground">
            {t("teacherAttendance.legend")}
          </span>
          {STATUS_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            return (
              <div key={opt.value} className="flex items-center gap-1.5">
                <span
                  className={`inline-flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold ${opt.color}`}
                >
                  {opt.short}
                </span>
                <span className="text-muted-foreground">
                  <Icon className={`inline h-3 w-3 mr-1 ${opt.color}`} />
                  {opt.short} = {opt.label}
                </span>
              </div>
            );
          })}
          <span className="text-muted-foreground">{t("teacherAttendance.legendNoRecord")}</span>
        </CardContent>
      </Card>

      {/* Búsqueda por estudiante — útil cuando un curso tiene 30-40 alumnos
          y el docente busca uno específico para revisar asistencia. */}
      {courseId && (
        <SearchInput
          value={studentSearch}
          onChange={setStudentSearch}
          placeholder={t("teacherAttendance.searchStudentPlaceholder")}
        />
      )}

      {/* Attendance grid */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              {cutGroups.length > 0 && (
                <TableRow>
                  <TableHead className="sticky left-0 z-10 bg-card" />
                  {cutGroups.map((g, idx) => (
                    <TableHead
                      key={g.cut?.id ?? `orphan-${idx}`}
                      colSpan={g.sessions.length}
                      className={`text-center text-xs font-semibold uppercase tracking-wide py-1.5 bg-muted/40 border-b ${
                        idx > 0 ? "border-l-2 border-l-primary/40" : ""
                      }`}
                    >
                      <span className={g.cut ? "" : "text-muted-foreground italic"}>
                        {g.cut ? g.cut.name : t("teacherAttendance.noCut")}
                      </span>
                      <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                        {t("teacherAttendance.sessionCount", { count: g.sessions.length })}
                      </span>
                    </TableHead>
                  ))}
                  <TableHead />
                </TableRow>
              )}
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-card min-w-36 sm:min-w-48">
                  {t("teacherAttendance.studentColumn")}
                </TableHead>
                {sessions.map((sess) => {
                  // Labels compactos para el resumen de "corte · contenido"
                  // que aparece debajo del header — evita reservar 2
                  // selects en cada columna del grid (antes ~6 filas de
                  // alto; ahora ~4). La edición vive en el Popover.
                  const cutLabel = sess.cut_id
                    ? (cuts.find((c) => c.id === sess.cut_id)?.name ?? t("teacherAttendance.cutFallback"))
                    : null;
                  const contentLabel = (() => {
                    if (!sess.content_id) return null;
                    const c = availableContents.find((x) => x.id === sess.content_id);
                    if (!c) return t("teacherAttendance.contentFallback");
                    return sess.content_class_index && sess.content_class_index > 0
                      ? `${c.topic} · ${t("teacherAttendance.classN", { n: sess.content_class_index })}`
                      : c.topic;
                  })();
                  return (
                    <TableHead
                      key={sess.id}
                      className={`text-center min-w-[6.5rem] align-bottom p-2 ${
                        cutBoundaryIds.has(sess.id) ? "border-l-2 border-l-primary/40" : ""
                      }`}
                    >
                      <div className="flex flex-col items-stretch gap-1.5">
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            type="button"
                            variant={sess.check_in_open ? "default" : "outline"}
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() =>
                              sess.check_in_open ? reopenProjector(sess) : openCheckInConfig(sess)
                            }
                            title={
                              sess.check_in_open
                                ? t("teacherAttendance.checkInActiveOpenProjector")
                                : t("teacherAttendance.startCheckInQr")
                            }
                          >
                            <QrCode className="h-4 w-4" aria-hidden />
                          </Button>
                          {/* Configurar sesión: corte + contenido — popover
                              porque son Selects que necesitan espacio. */}
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-8 w-8 shrink-0"
                                title={t("teacherAttendance.configureCutContentTitle")}
                              >
                                <Settings2 className="h-4 w-4 text-muted-foreground" aria-hidden />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-72 p-3 space-y-3" align="end">
                              <div className="text-xs font-medium">
                                {t("teacherAttendance.sessionLabel")}{" "}
                                <span className="tabular-nums text-muted-foreground">
                                  {formatDateShort(sess.session_date + "T12:00:00")}
                                </span>
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-[11px] flex items-center gap-1">
                                  <Scissors className="h-3 w-3" />
                                  {t("teacherAttendance.cutLabel")}
                                </Label>
                                <Select
                                  value={sess.cut_id ?? "__none"}
                                  onValueChange={(v) =>
                                    updateSessionCut(sess.id, v === "__none" ? null : v)
                                  }
                                >
                                  <SelectTrigger className="h-8 text-xs">
                                    <SelectValue placeholder={t("teacherAttendance.noCut")} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="__none">
                                      {t("teacherAttendance.noCut")}
                                    </SelectItem>
                                    {cuts.map((c) => (
                                      <SelectItem key={c.id} value={c.id}>
                                        {c.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-[11px] flex items-center gap-1">
                                  <PresentationIcon className="h-3 w-3" />
                                  {t("teacherAttendance.contentLabel")}
                                </Label>
                                <ContentPicker
                                  value={
                                    sess.content_id
                                      ? `${sess.content_id}:${sess.content_class_index ?? 0}`
                                      : "__none"
                                  }
                                  contents={availableContents}
                                  onChange={(v) => updateSessionContent(sess.id, v)}
                                />
                              </div>
                            </PopoverContent>
                          </Popover>
                          {/* Menú "Más acciones" — antes había 3 botones inline
                              (marcar todos / reiniciar / eliminar) que hacían
                              el header de cada columna muy ancho. Las acciones
                              menos frecuentes ahora viven en este DropdownMenu;
                              QR y Settings se quedan inline porque son los más
                              usados. */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-8 w-8 shrink-0"
                                title={t("teacherAttendance.moreActionsTitle")}
                              >
                                <MoreVertical className="h-4 w-4" aria-hidden />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                              <DropdownMenuItem onSelect={() => markAllPresent(sess.id)}>
                                <CheckCircle2 className="h-4 w-4 mr-2 text-success" />
                                {t("teacherAttendance.markAllPresent")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => clearSessionAttendance(sess.id)}>
                                <Eraser className="h-4 w-4 mr-2 text-muted-foreground" />
                                {t("teacherAttendance.resetAttendance")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => openRecordingEdit(sess)}>
                                <PlayCircle className="h-4 w-4 mr-2 text-primary" />
                                {sess.recording_url || sess.recording_video_id || sess.notes_url
                                  ? t("attendance.editRecordingNotes", {
                                      defaultValue: "Editar grabación / notas",
                                    })
                                  : t("attendance.addRecordingNotes", {
                                      defaultValue: "Agregar grabación / notas",
                                    })}
                              </DropdownMenuItem>
                              {/* Lanzar encuesta en vivo durante esta
                                  sesión. El attendance_session_id queda
                                  ligado a la encuesta (FK en `polls`),
                                  permite mostrar la encuesta al alumno
                                  con un badge "Sesión presencial" y a
                                  futuro destacarla cuando esté dentro
                                  de la clase. */}
                              <DropdownMenuItem onSelect={() => setPollLaunchSession(sess)}>
                                <Zap className="h-4 w-4 mr-2 text-sky-500" />
                                {t("teacherAttendance.launchPoll")}
                              </DropdownMenuItem>
                              {/* Pizarra de la sesión — abre el editor
                                  Excalidraw embebido. Persiste en
                                  attendance_sessions.whiteboard_scene
                                  (1:1 con la sesión). El docente reabre
                                  y su contenido reaparece. */}
                              <DropdownMenuItem onSelect={() => setWhiteboardSession(sess)}>
                                <Palette className="h-4 w-4 mr-2 text-violet-500" />
                                {t("teacherAttendance.whiteboard")}
                              </DropdownMenuItem>
                              {/* Duplicar la sesión: crea una copia (misma fecha,
                                  el docente la reubica) con opción de copiar el
                                  contenido asignado, la pizarra y los snippets. */}
                              <DropdownMenuItem onSelect={() => setDuplicateSessionFor(sess)}>
                                <Copy className="h-4 w-4 mr-2 text-muted-foreground" />
                                {t("teacherAttendance.duplicateSession")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() => deleteSession(sess.id)}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                {t("teacherAttendance.deleteSession")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        {sess.check_in_open && (
                          <Badge variant="default" className="text-[9px] py-0 px-1 self-center">
                            {t("teacherAttendance.checkInActive")}
                          </Badge>
                        )}
                        <div className="flex flex-col items-center gap-0.5 border-t border-border/70 pt-1.5">
                          <span className="text-[10px] font-medium leading-tight tabular-nums">
                            {formatDateShort(sess.session_date + "T12:00:00")}
                          </span>
                          {sess.title && (
                            <span
                              className="text-[9px] text-muted-foreground truncate max-w-[5.5rem]"
                              title={sess.title ?? undefined}
                            >
                              {sess.title}
                            </span>
                          )}
                          {/* Resumen compacto del corte y contenido —
                              indicador read-only; click en el Settings
                              de arriba para editar. */}
                          <div className="flex flex-wrap items-center justify-center gap-0.5 pt-0.5">
                            {cutLabel ? (
                              <Badge
                                variant="outline"
                                className="text-[9px] py-0 px-1 max-w-[5.5rem] truncate font-normal"
                                title={t("teacherAttendance.cutTooltip", { cut: cutLabel })}
                              >
                                <Scissors className="h-2.5 w-2.5 mr-0.5 shrink-0" />
                                {cutLabel}
                              </Badge>
                            ) : (
                              <span className="text-[9px] text-muted-foreground/50">
                                {t("teacherAttendance.noCutShort")}
                              </span>
                            )}
                            {contentLabel && (
                              <Badge
                                variant="outline"
                                className="text-[9px] py-0 px-1 max-w-[5.5rem] truncate font-normal"
                                title={t("teacherAttendance.contentTooltip", {
                                  content: contentLabel,
                                })}
                              >
                                <PresentationIcon className="h-2.5 w-2.5 mr-0.5 shrink-0" />
                                {contentLabel}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </TableHead>
                  );
                })}
                <TableHead className="text-center min-w-16">
                  {t("teacherAttendance.percentColumn")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredStudents.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={sessions.length + 2}
                    className="text-center text-muted-foreground py-8"
                  >
                    {studentSearch.trim() && students.length > 0
                      ? t("teacherAttendance.noMatches")
                      : t("teacherAttendance.noStudentsEnrolled")}
                  </TableCell>
                </TableRow>
              )}
              {filteredStudents.map((s) => {
                const total = sessions.length;
                const present = sessions.filter((sess) => {
                  const st = getStatus(sess.id, s.id);
                  return st === "presente";
                }).length;
                const pct = total > 0 ? Math.round((present / total) * 100) : 0;
                return (
                  <TableRow key={s.id}>
                    <TableCell className="sticky left-0 z-10 bg-card">
                      <div className="text-sm font-medium truncate">{s.full_name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {s.institutional_email}
                      </div>
                    </TableCell>
                    {sessions.map((sess) => {
                      const status = getStatus(sess.id, s.id);
                      return (
                        <TableCell
                          key={sess.id}
                          className={`text-center p-1 ${
                            cutBoundaryIds.has(sess.id) ? "border-l-2 border-l-primary/40" : ""
                          }`}
                        >
                          <Select
                            value={status || "none"}
                            onValueChange={(v) => setAttendance(sess.id, s.id, v)}
                          >
                            <SelectTrigger
                              className={`h-8 w-12 mx-auto text-xs font-bold px-1.5 [&>svg]:h-3 [&>svg]:w-3 ${status === "presente" ? "text-success border-success/40" : status === "ausente" ? "text-destructive border-destructive/40" : ""}`}
                            >
                              <SelectValue placeholder="—" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">
                                <span className="text-muted-foreground text-xs">—</span>
                              </SelectItem>
                              {STATUS_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  <span className={`text-xs font-bold ${opt.color}`}>
                                    {opt.short}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-center">
                      <Badge
                        variant={pct >= 80 ? "default" : pct >= 60 ? "secondary" : "destructive"}
                        className="text-[10px]"
                      >
                        {pct}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* New session dialog */}
      <Dialog open={newSessionOpen} onOpenChange={newSessionDirty.guardOpenChange(setNewSessionOpen)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm" data-tour-id="dialog-session">
          <DialogHeader>
            <DialogTitle>{t("teacherAttendance.newSessionDialogTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div data-tour-id="session-field-date">
              <Label required>{t("teacherAttendance.dateLabel")}</Label>
              <DatePicker value={newDate} onChange={setNewDate} />
            </div>
            {/* Hora inicio + fin — el docente piensa en "9:00-10:30",
                no "90 min". Al guardar derivamos duration = end - start
                para alimentar la sincronización a Google Calendar (que
                consume duration_minutes). Mobile-first: 1 col en xs
                (inputs time se ven completos sin truncar), 2 en sm+. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-tour-id="session-field-time">
              <div>
                <Label>
                  {t("teacherAttendance.startTimeLabel")}{" "}
                  <HelpHint>{t("help.startTimeTimezoneHint")}</HelpHint>
                </Label>
                <Input
                  type="time"
                  value={newStartTime}
                  onChange={(e) => setNewStartTime(e.target.value)}
                />
              </div>
              <div>
                <Label>{t("teacherAttendance.endTimeLabel")}</Label>
                <Input
                  type="time"
                  value={newEndTime}
                  onChange={(e) => setNewEndTime(e.target.value)}
                />
              </div>
            </div>
            <div data-tour-id="session-field-title">
              <Label>{t("teacherAttendance.titleOptionalLabel")}</Label>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder={t("teacherAttendance.titlePlaceholder")}
              />
            </div>
            <div data-tour-id="session-field-cut">
              <Label>
                {t("teacherAttendance.cutLabel")}{" "}
                <HelpHint>{t("help.cutSelectionHelp")}</HelpHint>
              </Label>
              <Select
                value={newCutId || "__none"}
                onValueChange={(v) => setNewCutId(v === "__none" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("teacherAttendance.noCut")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">{t("teacherAttendance.noCut")}</SelectItem>
                  {cuts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {cuts.length === 0 && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t("teacherAttendance.noCutsDefined")}
                </p>
              )}
            </div>
            <div className="border-t pt-3 space-y-2">
              <Label>
                {t("teacherAttendance.recordingOptionalLabel")}{" "}
                <HelpHint>{t("help.recordingOptionsHelp")}</HelpHint>
              </Label>
              <Input
                value={newRecordingUrl}
                onChange={(e) => setNewRecordingUrl(e.target.value)}
                placeholder={t("teacherAttendance.recordingUrlPlaceholder")}
              />
              <Select
                value={newRecordingVideoId || "__none"}
                onValueChange={(v) => setNewRecordingVideoId(v === "__none" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("teacherAttendance.libraryVideoPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">
                    {t("teacherAttendance.noLibraryVideo")}
                  </SelectItem>
                  {sessionVideos.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="border-t pt-3 space-y-2">
              <Label>
                {t("attendance.notesUrlLabel", {
                  defaultValue: "Enlace de notas / minuta (opcional)",
                })}{" "}
                <HelpHint>
                  {t("attendance.notesUrlHelp", {
                    defaultValue:
                      "Enlace a las notas de reunión o minuta (Google Docs, Notion…). Al vincular con Google Calendar se trae automáticamente. Se abre en una pestaña nueva.",
                  })}
                </HelpHint>
              </Label>
              <Input
                value={newNotesUrl}
                onChange={(e) => setNewNotesUrl(e.target.value)}
                placeholder={t("teacherAttendance.notesUrlPlaceholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewSessionOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={createSession}>{t("teacherAttendance.create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog de edición de grabación para sesiones existentes */}
      <Dialog
        open={!!recordingEditSession}
        onOpenChange={(o) => !o && setRecordingEditSession(null)}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t("attendance.editRecordingNotesTitle", {
                defaultValue: "Editar grabación / notas",
              })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>{t("teacherAttendance.externalLinkLabel")}</Label>
              <Input
                value={recordingEditUrl}
                onChange={(e) => setRecordingEditUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>
            <div>
              <Label>{t("teacherAttendance.libraryVideoLabel")}</Label>
              <Select
                value={recordingEditVideoId || "__none"}
                onValueChange={(v) => setRecordingEditVideoId(v === "__none" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("teacherAttendance.noLibraryVideo")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">
                    {t("teacherAttendance.noLibraryVideo")}
                  </SelectItem>
                  {sessionVideos.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("teacherAttendance.uploadVideoHint")}
              </p>
            </div>
            <div className="border-t pt-3">
              <Label>
                {t("attendance.notesUrlLabel", {
                  defaultValue: "Enlace de notas / minuta (opcional)",
                })}{" "}
                <HelpHint>
                  {t("attendance.notesUrlHelp", {
                    defaultValue:
                      "Enlace a las notas de reunión o minuta (Google Docs, Notion…). Al vincular con Google Calendar se trae automáticamente. Se abre en una pestaña nueva.",
                  })}
                </HelpHint>
              </Label>
              <Input
                value={notesEditUrl}
                onChange={(e) => setNotesEditUrl(e.target.value)}
                placeholder={t("teacherAttendance.notesUrlPlaceholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecordingEditSession(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={saveRecordingEdit}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Check-in config dialog */}
      <Dialog
        open={!!checkInConfigSession}
        onOpenChange={(o) => !o && setCheckInConfigSession(null)}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("teacherAttendance.startCheckInQr")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("teacherAttendance.checkInConfigDescription")}
            </p>
            <div>
              <Label>
                {t("teacherAttendance.windowDurationLabel")}{" "}
                <HelpHint>{t("help.checkinDurationHelp")}</HelpHint>
              </Label>
              <Input
                type="number"
                min={1}
                max={240}
                value={checkInDuration || ""}
                onChange={(e) =>
                  setCheckInDuration(
                    e.target.value === "" ? 0 : Math.max(1, Math.min(240, Number(e.target.value))),
                  )
                }
              />
            </div>
            <div>
              <Label>
                {t("teacherAttendance.codeRotationLabel")}{" "}
                <HelpHint>{t("help.checkinRotationHelp")}</HelpHint>
              </Label>
              <Input
                type="number"
                min={15}
                max={600}
                value={checkInRotation || ""}
                onChange={(e) =>
                  setCheckInRotation(
                    e.target.value === "" ? 0 : Math.max(15, Math.min(600, Number(e.target.value))),
                  )
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCheckInConfigSession(null)}
              disabled={startingCheckIn}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={startCheckIn} disabled={startingCheckIn}>
              {startingCheckIn ? (
                <Spinner size="md" className="mr-1" />
              ) : (
                <QrCode className="h-4 w-4 mr-1" />
              )}
              {t("teacherAttendance.start")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Programar sesiones del curso — mismo dialog que el módulo de
          Contenidos, pero abierto SIN contenido (content=null). El
          docente elige N sesiones, fecha de inicio y días de la semana. */}
      <GenerateSessionsDialog
        open={generateSessionsOpen}
        content={null}
        courseId={courseId}
        onClose={() => setGenerateSessionsOpen(false)}
        onCreated={() => {
          setGenerateSessionsOpen(false);
          void loadCourse();
        }}
      />

      {/* Projector overlay */}
      {projector && <AttendanceCheckInProjector state={projector} onClose={closeProjector} />}

      {/* Encuesta en vivo durante una sesión. courseId viene del state
          del componente (la pantalla siempre opera sobre un curso
          seleccionado); attendanceSessionId del session seleccionado
          desde el dropdown. La encuesta queda ligada a la sesión para
          que el alumno la vea destacada en /app/student/polls. */}
      <LaunchPollDialog
        open={Boolean(pollLaunchSession)}
        onOpenChange={(open) => !open && setPollLaunchSession(null)}
        courseId={courseId}
        attendanceSessionId={pollLaunchSession?.id ?? null}
        sessionLabel={
          pollLaunchSession
            ? `${pollLaunchSession.title ?? t("teacherAttendance.defaultSessionTitle")} · ${formatDateShort(pollLaunchSession.session_date)}`
            : undefined
        }
        onCreated={() => setPollLaunchSession(null)}
      />
      {/* Pizarra de la sesión — Excalidraw embebido en Dialog full-height.
          Persiste 1:1 con attendance_sessions.whiteboard_scene. */}
      <SessionWhiteboardDialog
        sessionId={whiteboardSession?.id ?? null}
        sessionLabel={
          whiteboardSession
            ? `${whiteboardSession.title ?? t("teacherAttendance.defaultSessionTitle")} · ${formatDateShort(whiteboardSession.session_date)}`
            : undefined
        }
        onOpenChange={(open) => !open && setWhiteboardSession(null)}
      />
      {/* Duplicar sesión — elige qué info interna copiar. La copia nace en la
          misma fecha (el docente la reubica) sin asistencia ni grabación. */}
      <DuplicateOptionsDialog
        open={duplicateSessionFor !== null}
        onOpenChange={(open) => !open && setDuplicateSessionFor(null)}
        title={t("teacherAttendance.duplicateSession")}
        description={
          <Trans
            i18nKey="teacherAttendance.duplicateDialogDescription"
            components={{ strong: <strong /> }}
          />
        }
        options={[
          {
            param: "copyContent",
            label: t("teacherAttendance.duplicateCopyContent"),
            hint: t("teacherAttendance.duplicateCopyContentHint"),
          },
          {
            param: "copyWhiteboard",
            label: t("teacherAttendance.duplicateCopyWhiteboard"),
            hint: t("teacherAttendance.duplicateCopyWhiteboardHint"),
          },
          {
            param: "copySnippets",
            label: t("teacherAttendance.duplicateCopySnippets"),
            hint: t("teacherAttendance.duplicateCopySnippetsHint"),
          },
        ]}
        onConfirm={async (flags) => {
          if (duplicateSessionFor)
            await duplicateSession(duplicateSessionFor, {
              copyContent: flags.copyContent !== false,
              copyWhiteboard: flags.copyWhiteboard !== false,
              copySnippets: flags.copySnippets !== false,
            });
        }}
      />
    </div>
  );
}

/**
 * Selector buscable de contenidos generados para asignar a una sesión.
 * Antes era un `<Select>` plano que listaba `topic` — cuando dos
 * contenidos compartían tema, eran indistinguibles. Ahora muestra
 * `display_name` como label principal + `topic` como subtítulo gris, y
 * permite filtrar por cualquiera de los dos via `CommandInput`.
 *
 * Value codificado igual que antes: `<contentId>:<classIndex>` (o
 * `__none` para "sin contenido"). Mantener el formato evita tocar la
 * lógica de `updateSessionContent`.
 */
interface ContentPickerProps {
  value: string;
  contents: AvailableContent[];
  onChange: (value: string) => void;
}

function ContentPicker({ value, contents, onChange }: ContentPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // Construimos la lista plana de opciones — material_individual usa
  // ":0", curso_completo se expande a una opción por clase.
  type Option = {
    value: string;
    /** Lo que se muestra en negrita en la opción y como label cuando
     *  está seleccionada. */
    primary: string;
    /** Subtítulo gris con el topic + sufijo de clase si aplica. */
    secondary: string;
    /** Texto agregado para la búsqueda — incluye topic, display_name
     *  y "clase N" para que cualquier criterio matchee. */
    searchKey: string;
  };
  const options: Option[] = [];
  for (const c of contents) {
    if (c.classes.length > 0) {
      for (const n of c.classes) {
        const classLabel = t("teacherAttendance.classN", { n });
        options.push({
          value: `${c.id}:${n}`,
          primary: `${c.display_name} · ${classLabel}`,
          secondary: c.topic,
          searchKey: `${c.display_name} ${c.topic} ${classLabel}`,
        });
      }
    } else {
      options.push({
        value: `${c.id}:0`,
        primary: c.display_name,
        secondary: c.topic,
        searchKey: `${c.display_name} ${c.topic}`,
      });
    }
  }

  const selected = options.find((o) => o.value === value);
  const triggerLabel =
    value === "__none" || !selected ? t("teacherAttendance.noContent") : selected.primary;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 text-xs w-full justify-between font-normal"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50 ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[var(--radix-popover-trigger-width)] min-w-[260px]"
        align="start"
      >
        <Command
          filter={(item, search) => {
            // cmdk pasa el `value` del CommandItem como `item`. Usamos
            // option.searchKey como ese value para soportar búsqueda por
            // display_name, topic o número de clase.
            return item.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput
            placeholder={t("teacherAttendance.contentPickerSearchPlaceholder")}
            className="h-8 text-xs"
          />
          <CommandList>
            <CommandEmpty>{t("teacherAttendance.noResults")}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="sin contenido __none"
                onSelect={() => {
                  onChange("__none");
                  setOpen(false);
                }}
              >
                <Check
                  className={cn(
                    "mr-2 h-3.5 w-3.5",
                    value === "__none" ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="text-muted-foreground italic">
                  {t("teacherAttendance.noContent")}
                </span>
              </CommandItem>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.searchKey}
                  onSelect={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-3.5 w-3.5 shrink-0",
                      value === o.value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{o.primary}</div>
                    {o.secondary && o.secondary !== o.primary && (
                      <div className="text-[10px] text-muted-foreground truncate">
                        {o.secondary}
                      </div>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
