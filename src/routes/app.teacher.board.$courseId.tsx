// ──────────────────────────────────────────────────────────────────────
// Tablero del curso (Docente/Admin) — PÁGINA COMPLETA.
// Antes era un modal (CourseBoardDialog en app.admin.courses.tsx); se
// promovió a página para dar espacio real al cronograma + contenidos.
// Misma vista que el tablero del estudiante (/app/student/courses →
// seleccionar curso) + capacidad inline de asignar contenido a cada
// sesión. Reúne todo lo relevante para el docente: cronograma del curso,
// qué material verá el alumno cada día, qué entregas vencen cerca de
// cada clase.
//
// "Subir contenido" pide DESTINO: material general del curso (visible
// siempre en el tablero del estudiante — RLS via content_course_assignments,
// migración 20260938000000) o una CLASE específica (asigna el contenido a
// esa sesión; si la sesión ya tiene contenido, AGREGA los archivos).
// ──────────────────────────────────────────────────────────────────────
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { softDelete } from "@/modules/trash/soft-delete";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { friendlyError, friendlyUniqueViolation } from "@/shared/lib/db-errors";
import { toCSV } from "@/shared/lib/csv";
import {
  SESSIONS_TEMPLATE,
  SESSIONS_CSV_COLUMNS,
  parseSessionsCsv,
  buildSessionsRows,
  parseHHMMToMinutes,
} from "@/modules/sessions/csv";
import { ImportExportMenu } from "@/shared/components/ImportExportMenu";
import { GenerateSessionsDialog } from "@/modules/contents/GenerateSessionsDialog";
import { CourseScheduleEditor } from "@/modules/schedules/CourseScheduleEditor";
import {
  formatBlockShort,
  compareBlocks,
  trimTime,
  type CourseScheduleBlock,
} from "@/modules/schedules/course-schedule";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SectionLoader } from "@/components/ui/loaders";
import { ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { DateCell } from "@/components/ui/date-cell";
import {
  nextBoardContentName,
  uploadBoardContent,
  appendBoardContentFiles,
  BOARD_ACCEPTED_EXTENSIONS,
  type BoardUploadResult,
} from "@/modules/contents/board-content-upload";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Pencil,
  CheckSquare,
  CalendarRange,
  FileText,
  Hammer,
  FolderKanban,
  Link2,
  Upload,
  Video,
  Layers,
  CalendarPlus,
  CalendarClock,
} from "lucide-react";
import { LinkCalendarEventsDialog } from "@/modules/calendar/LinkCalendarEventsDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { classNumberFromFilename, isTeacherOnlyFile } from "@/modules/contents/contents-extract";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { RowAction } from "@/components/ui/row-action";
import { DatePicker } from "@/components/ui/date-picker";
import { ManageContentCoursesDialog } from "@/modules/contents/ManageContentCoursesDialog";
import { useTranslation } from "react-i18next";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/teacher/board/$courseId")({
  component: CourseBoardPage,
});

interface SessionRow {
  id: string;
  course_id: string;
  session_date: string;
  /** Hora local Bogotá HH:MM:SS (TIME). Null = legacy, la edge function
   *  cae al fallback 09:00 al sincronizar con Google Calendar. */
  start_time: string | null;
  /** Minutos. Null = fallback 90. */
  duration_minutes: number | null;
  title: string | null;
  content_id: string | null;
  content_class_index: number | null;
  /** Subconjunto opcional de paths de archivos del contenido a mostrar en
   *  esta sesión. NULL = todos los del contenido/clase. */
  content_file_paths: string[] | null;
  meeting_url: string | null;
  recording_url: string | null;
  notes_url: string | null;
  /** Corte (grade_cuts) al que el docente asignó la sesión. Sólo se usa
   *  para el round-trip cut_name↔cut_id del import/export CSV; la nota
   *  del corte se sigue derivando por fecha (ver CLAUDE.md). */
  cut_id: string | null;
}

/** Corte de notas del curso (grade_cuts). Sólo id+name — usados para el
 *  mapeo cut_name↔cut_id del import/export de sesiones. */
interface Cut {
  id: string;
  name: string;
}

/** Fila del grid "Contenidos del curso" en el tablero — material subido
 *  desde el propio tablero (o generado) anclado a este curso. */
interface BoardContentItem {
  id: string;
  displayName: string;
  createdAt: string | null;
  isPublished: boolean;
  fileCount: number;
  /** true = el contenido está anclado a ESTE curso (`generated_contents.course_id`).
   *  false = aparece sólo por content_course_assignments (su ancla es OTRO
   *  curso). Determina si "Quitar del curso" borra el contenido (anclado) o
   *  sólo desasocia la fila cca (multi-curso). */
  isAnchored: boolean;
  /** Curso ancla (`generated_contents.course_id`). null = contenido genérico
   *  sin curso. Usado por "Asignar a cursos" para fijar el ancla. */
  anchorCourseId: string | null;
}

interface AvailableContent {
  id: string;
  topic: string;
  /** Nombre humano único del contenido (`display_name`). Es lo que se muestra
   *  en el Select de asociación y en las tarjetas — el `topic` (tema de
   *  generación de IA) ya NO es el label visible. Fallback a `topic` si vacío. */
  displayName: string;
  mode: "curso_completo" | "material_individual";
  classes: number[];
  /** Archivos del contenido (name + path) para elegir un subconjunto a
   *  asignar. Se filtran los de uso docente (solución, guía) en el selector. */
  files: { name: string; path: string }[];
}

/**
 * Selector de asignación de contenido en 3 pasos:
 *   1. Primer Select → ¿qué contenido? (un curso puede tener varios).
 *   2. Segundo Select → ¿qué clase dentro de ese contenido?
 *      Solo para `curso_completo` (con clases). En `material_individual`
 *      se oculta y se asigna con classIndex=null.
 *   3. Popover "Archivos" → subconjunto OPCIONAL de archivos a mostrar.
 *      Se adapta al modo: en curso_completo lista los archivos de la CLASE
 *      elegida; en individual lista todos los del contenido. Por defecto
 *      van TODOS (content_file_paths=null); el docente puede destildar para
 *      asignar solo algunos. Filtra archivos de uso docente (solución/guía).
 * Las opciones de "Sin asignar" se concentran en el 1er select.
 */
function ContentAssignmentSelector({
  contents,
  contentId,
  classIndex,
  filePaths,
  onChange,
  assignedClassesByContent,
}: {
  contents: AvailableContent[];
  contentId: string | null;
  classIndex: number | null;
  /** Subconjunto de paths asignado. null = todos los de la clase/contenido. */
  filePaths: string[] | null;
  onChange: (
    contentId: string | null,
    classIndex: number | null,
    filePaths: string[] | null,
  ) => void;
  /** Map de clases ya asignadas a OTRAS sesiones del mismo curso
   *  (excluye la sesión actual). El selector oculta esas clases para
   *  evitar que el docente asigne dos veces la misma clase. */
  assignedClassesByContent?: Map<string, Set<number>>;
}) {
  const { t } = useTranslation();
  const selected = contents.find((c) => c.id === contentId) ?? null;
  // Filtramos del listado de clases las que ya estan asignadas a otra
  // sesion. La clase actual (classIndex) se preserva — sin esto, el
  // dropdown se vacia cuando ya hay una asignacion valida.
  const blockedForSelected = selected
    ? (assignedClassesByContent?.get(selected.id) ?? new Set<number>())
    : new Set<number>();
  const availableClasses = selected
    ? selected.classes.filter((n) => n === classIndex || !blockedForSelected.has(n))
    : [];
  const hasClasses = selected && availableClasses.length > 0;

  // Archivos ELEGIBLES: TODOS los del contenido (sin los de uso docente),
  // sin acotar por clase. Así el docente puede asignar CUALQUIER archivo del
  // contenido subido a la sesión, no solo los que el "match automático" por
  // clase sugeriría. La clase solo determina el DEFAULT (defaultPaths).
  const eligibleFiles = useMemo(() => {
    if (!selected) return [] as { name: string; path: string }[];
    return selected.files.filter((f) => !isTeacherOnlyFile(f.name));
  }, [selected]);

  // Selección por DEFAULT (cuando filePaths==null): en curso_completo, los
  // archivos de la CLASE elegida; si no, todos. Es solo el punto de partida
  // — el docente puede destildar/marcar cualquier archivo a partir de acá.
  const defaultPaths = useMemo(() => {
    if (!selected) return new Set<string>();
    if (selected.classes.length > 0 && classIndex != null) {
      const byClass = eligibleFiles.filter(
        (f) => classNumberFromFilename(f.name) === classIndex,
      );
      const base = byClass.length > 0 ? byClass : eligibleFiles;
      return new Set(base.map((f) => f.path));
    }
    return new Set(eligibleFiles.map((f) => f.path));
  }, [selected, classIndex, eligibleFiles]);

  // Set efectivo de incluidos: explícito (filePaths) o el default.
  const includedSet = filePaths == null ? defaultPaths : new Set(filePaths);
  const isIncluded = (p: string) => includedSet.has(p);
  const includedCount = eligibleFiles.filter((f) => isIncluded(f.path)).length;
  const allIncluded = includedCount === eligibleFiles.length;

  const setsEqual = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((x) => b.has(x));

  const toggleFile = (path: string) => {
    const current = new Set(includedSet);
    if (current.has(path)) current.delete(path);
    else current.add(path);
    // Si la selección coincide EXACTO con el default → null (estado limpio,
    // el tablero del estudiante aplica el default). Si no, guardamos el
    // array explícito (puede incluir archivos de cualquier clase).
    const next = setsEqual(current, defaultPaths)
      ? null
      : eligibleFiles.filter((f) => current.has(f.path)).map((f) => f.path);
    onChange(contentId, classIndex, next);
  };

  return (
    <div className="flex items-center gap-1.5">
      {/* 1) Contenido */}
      <Select
        value={contentId ?? "__none"}
        onValueChange={(v) => {
          if (v === "__none") {
            onChange(null, null, null);
            return;
          }
          // Al cambiar de contenido, reseteamos clase Y subconjunto de
          // archivos. Si el nuevo contenido tiene clases, escogemos la
          // primera DISPONIBLE (no asignada a otra sesión).
          const next = contents.find((c) => c.id === v);
          if (next && next.classes.length > 0) {
            const taken = assignedClassesByContent?.get(v) ?? new Set<number>();
            const firstFree = next.classes.find((n) => !taken.has(n)) ?? null;
            onChange(v, firstFree, null);
          } else {
            onChange(v, null, null);
          }
        }}
      >
        <SelectTrigger className="w-44 h-8 text-xs">
          <SelectValue placeholder={t("contents.assignNone")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">{t("contents.assignNone")}</SelectItem>
          {contents.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* 2) Clase — solo si el contenido elegido tiene clases. Cambiar de
          clase resetea el subconjunto de archivos. */}
      {hasClasses && (
        <Select
          value={classIndex != null ? String(classIndex) : ""}
          onValueChange={(v) => onChange(contentId, Number(v), null)}
        >
          <SelectTrigger className="w-28 h-8 text-xs">
            <SelectValue placeholder={t("contents.classPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {availableClasses.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {t("contents.classNumber")} {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {/* 3) Archivos — subconjunto opcional. Solo si hay 2+ elegibles
          (con 0/1 no tiene sentido elegir). */}
      {selected && eligibleFiles.length > 1 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1">
              <FileText className="h-3.5 w-3.5" />
              {allIncluded
                ? t("hc_routesAppTeacherBoardCourseId.filesCount", { count: eligibleFiles.length })
                : t("hc_routesAppTeacherBoardCourseId.filesCountPartial", {
                    included: includedCount,
                    total: eligibleFiles.length,
                  })}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-2">
            <div className="text-[11px] text-muted-foreground px-1 pb-1">
              {t("hc_routesAppTeacherBoardCourseId.filesPickerHint")}
            </div>
            <div className="max-h-56 overflow-y-auto space-y-0.5">
              {eligibleFiles.map((f) => (
                <label
                  key={f.path}
                  className="flex items-start gap-2 rounded px-1.5 py-1 hover:bg-muted/50 cursor-pointer"
                >
                  <Checkbox
                    checked={isIncluded(f.path)}
                    onCheckedChange={() => toggleFile(f.path)}
                    className="mt-0.5"
                  />
                  <span className="text-xs break-all">{f.name}</span>
                </label>
              ))}
            </div>
            {includedCount === 0 && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 px-1 pt-1">
                {t("hc_routesAppTeacherBoardCourseId.filesNoneSelected")}
              </p>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

type ScheduledItem = {
  kind: "exam" | "workshop" | "project";
  id: string;
  title: string;
  due: string;
  /** Sesión asociada por el docente (attendance_session_id). null = General. */
  sessionId: string | null;
};

/** Destino de la subida: material general del curso o una sesión (clase). */
type UploadDest = "global" | string;

function CourseBoardPage() {
  const { courseId } = Route.useParams();
  const { t } = useTranslation();
  const { user } = useAuth();
  const activeRole = useActiveRole();
  const confirm = useConfirm();
  const [course, setCourse] = useState<{ id: string; name: string } | null>(null);
  const [courseMissing, setCourseMissing] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  // Cortes del curso (grade_cuts) — para el mapeo cut_name↔cut_id del CSV.
  const [cuts, setCuts] = useState<Cut[]>([]);
  // Horario semanal del curso (course_schedules) — se muestra en el tablero
  // y prefija la creación de sesiones.
  const [schedule, setSchedule] = useState<CourseScheduleBlock[]>([]);
  const [contents, setContents] = useState<AvailableContent[]>([]);
  // Grid "Contenidos del curso": material anclado a este curso (incluye el
  // subido desde el propio tablero con el botón "Subir contenido").
  const [boardContents, setBoardContents] = useState<BoardContentItem[]>([]);
  // content_ids con fila en content_course_assignments para ESTE curso —
  // material "general del curso" visible al estudiante aunque no esté
  // asignado a una sesión (badge del grid).
  const [assignedToCourse, setAssignedToCourse] = useState<Set<string>>(new Set());
  // Todos los cursos visibles para el docente — para "Asignar a cursos"
  // (gestionar la membresía multi-curso del contenido, #16). La RLS de
  // `courses` ya recorta al tenant del docente.
  const [allCourses, setAllCourses] = useState<{ id: string; name: string }[]>([]);
  // Contenido cuyo destino multi-curso se está gestionando (null = cerrado).
  const [manageCoursesFor, setManageCoursesFor] = useState<BoardContentItem | null>(null);
  const [uploadingContent, setUploadingContent] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadDest, setUploadDest] = useState<UploadDest>("global");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Mapa de (content_id → set de class_index ya asignados en este curso).
  // Sirve para que el selector de contenido oculte las clases tomadas
  // y obligar la regla "una clase del contenido = una sesion". El selector
  // preserva internamente la clase de la sesion actual aunque este en el
  // set, asi el dropdown no se "vacia" cuando ya hay asignacion valida.
  const assignedClassesByContent = useMemo(() => {
    const map = new Map<string, Set<number>>();
    for (const s of sessions) {
      if (!s.content_id || s.content_class_index == null) continue;
      let set = map.get(s.content_id);
      if (!set) {
        set = new Set();
        map.set(s.content_id, set);
      }
      set.add(s.content_class_index);
    }
    return map;
  }, [sessions]);
  // Map content_id → sesiones que lo usan (para el badge del grid de
  // contenidos: "Clase <fecha>" / "N clases").
  const sessionsByContent = useMemo(() => {
    const map = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      if (!s.content_id) continue;
      const list = map.get(s.content_id) ?? [];
      list.push(s);
      map.set(s.content_id, list);
    }
    return map;
  }, [sessions]);
  // Borrador para creación + edición inline. Cuando `editingId` es
  // null el form de la card-borrador crea una sesión nueva; cuando es
  // un id, edita esa fila. La fila editada queda con un anillo
  // primary para señalizar el modo edición.
  const [draftDate, setDraftDate] = useState("");
  const [draftStartTime, setDraftStartTime] = useState("09:00");
  const [draftDuration, setDraftDuration] = useState(90);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftMeetingUrl, setDraftMeetingUrl] = useState("");
  const [draftRecordingUrl, setDraftRecordingUrl] = useState("");
  const [draftNotesUrl, setDraftNotesUrl] = useState("");
  // Marca si el docente tocó manualmente hora/duración del form de creación.
  // Mientras sea false, elegir una fecha con horario definido prefija esos
  // campos desde el bloque del curso (no destructivo — nunca pisa lo tipeado).
  const [draftTimeTouched, setDraftTimeTouched] = useState(false);
  // Dialog de vincular/resincronizar Google Calendar (grabaciones/notas).
  const [calendarOpen, setCalendarOpen] = useState(false);
  // Dialogs de horario del curso + generador de sesiones.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  // Bump para forzar recarga del tablero (ej. tras resincronizar calendario).
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Volver: el tablero se abre desde el grid de cursos del rol activo.
  const backTo =
    activeRole === "Admin" || activeRole === "SuperAdmin"
      ? "/app/admin/courses"
      : "/app/teacher/courses";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const { data: c } = await db
        .from("courses")
        .select("id, name")
        .eq("id", courseId)
        .is("deleted_at", null)
        .maybeSingle();
      if (cancelled) return;
      if (!c) {
        setCourseMissing(true);
        setLoading(false);
        return;
      }
      setCourse(c as { id: string; name: string });
      // Asignaciones del contenido a ESTE curso (junction N-N). Se carga
      // PRIMERO porque la query de contenidos las incluye: un contenido
      // anclado a OTRO curso pero asignado a éste vía cca debe aparecer en
      // el selector del tablero (#16 — multi-curso a nivel de tablero).
      const { data: ccaRows } = await db
        .from("content_course_assignments")
        .select("content_id")
        .eq("course_id", courseId);
      if (cancelled) return;
      const ccaIds = Array.from(
        new Set(((ccaRows ?? []) as Array<{ content_id: string }>).map((r) => r.content_id)),
      );

      // Sesiones del curso + contenidos del docente disponibles + items
      // (exams/workshops/projects) calendarizados + cursos visibles (para
      // "Asignar a cursos") — en paralelo.
      const [sesRes, contentsRes, examsRes, wsRes, projRes, coursesRes, cutsRes, schedRes] =
        await Promise.all([
        db
          .from("attendance_sessions")
          .select(
            "id, course_id, session_date, start_time, duration_minutes, title, content_id, content_class_index, content_file_paths, meeting_url, recording_url, notes_url, cut_id",
          )
          .eq("course_id", courseId)
          .is("deleted_at", null)
          .order("session_date", { ascending: true }),
        // status='done' del propio docente; "available" se filtra por
        // RLS al teacher_id. Incluimos contenidos anclados a este curso O
        // sin curso (genéricos reutilizables) O asignados a este curso vía
        // content_course_assignments (multi-curso: el ancla puede ser OTRO
        // curso, pero el material aparece igual en este tablero).
        db
          .from("generated_contents")
          .select("id, topic, mode, course_id, files, display_name, created_at, is_published")
          .eq("status", "done")
          .is("deleted_at", null)
          .or(
            `course_id.eq.${courseId},course_id.is.null${
              ccaIds.length > 0 ? `,id.in.(${ccaIds.join(",")})` : ""
            }`,
          ),
        (supabase as any)
          .from("exams")
          .select("id, title, end_time, attendance_session_id")
          .eq("course_id", courseId)
          .is("deleted_at", null),
        (supabase as any)
          .from("workshops")
          .select("id, title, due_date, attendance_session_id")
          .eq("course_id", courseId)
          .is("deleted_at", null),
        (supabase as any)
          .from("projects")
          .select("id, title, due_date, attendance_session_id")
          .eq("course_id", courseId)
          .is("deleted_at", null),
        // Cursos visibles para el docente (RLS recorta al tenant). Para el
        // dialog "Asignar a cursos" del grid de contenidos.
        db.from("courses").select("id, name").is("deleted_at", null).order("name"),
        // Cortes del curso (grade_cuts no está en types.ts auto-generado).
        db
          .from("grade_cuts")
          .select("id, name, position, start_date, end_date")
          .eq("course_id", courseId)
          .order("position"),
        // Horario semanal del curso (course_schedules).
        db
          .from("course_schedules")
          .select("id, day_of_week, start_time, end_time, aula, modalidad, notes")
          .eq("course_id", courseId)
          .order("day_of_week", { ascending: true })
          .order("start_time", { ascending: true }),
      ]);
      if (cancelled) return;

      setSessions((sesRes.data ?? []) as SessionRow[]);
      setCuts((cutsRes.data ?? []) as Cut[]);
      setSchedule((schedRes.data ?? []) as CourseScheduleBlock[]);
      setAllCourses((coursesRes.data ?? []) as { id: string; name: string }[]);
      const ccaIdSet = new Set(ccaIds);
      // Aplana files[] → classes[] para no recalcular regex en cada Select.
      setContents(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((contentsRes.data ?? []) as any[]).map((g) => {
          const files = (g.files ?? []) as Array<{ name: string; path?: string }>;
          const set = new Set<number>();
          for (const f of files) {
            const m = f.name.match(/(?:CLASE|CLASS|SESION|SESSION)[_\s-]*(\d+)/i);
            if (m) set.add(Number(m[1]));
          }
          return {
            id: g.id,
            topic: g.topic,
            // Label visible = display_name; fallback al topic si vacío (#17).
            displayName: ((g.display_name as string) ?? "").trim() || (g.topic as string),
            mode: g.mode,
            classes: Array.from(set).sort((a, b) => a - b),
            files: files.map((f) => ({ name: f.name, path: f.path ?? f.name })),
          };
        }),
      );
      // Grid "Contenidos del curso": material visible en ESTE curso — anclado
      // a él (course_id) O asignado vía content_course_assignments (multi-curso,
      // #16). Los genéricos sin curso quedan fuera. Incluye los subidos desde el
      // tablero. Orden por fecha desc (lo más nuevo arriba).
      setBoardContents(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((contentsRes.data ?? []) as any[])
          .filter((g) => g.course_id === courseId || ccaIdSet.has(g.id as string))
          .map((g) => ({
            id: g.id as string,
            displayName: ((g.display_name as string) ?? "").trim() || (g.topic as string),
            createdAt: (g.created_at as string) ?? null,
            isPublished: !!g.is_published,
            fileCount: Array.isArray(g.files) ? g.files.length : 0,
            isAnchored: g.course_id === courseId,
            anchorCourseId: (g.course_id as string | null) ?? null,
          }))
          .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
      );
      setAssignedToCourse(
        new Set(
          ((ccaRows ?? []) as Array<{ content_id: string }>).map((r) => r.content_id),
        ),
      );

      const items: ScheduledItem[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const e of (examsRes.data ?? []) as any[]) {
        items.push({
          kind: "exam",
          id: e.id,
          title: e.title,
          due: e.end_time ?? "",
          sessionId: e.attendance_session_id ?? null,
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const w of (wsRes.data ?? []) as any[]) {
        items.push({
          kind: "workshop",
          id: w.id,
          title: w.title,
          due: w.due_date ?? "",
          sessionId: w.attendance_session_id ?? null,
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const p of (projRes.data ?? []) as any[]) {
        items.push({
          kind: "project",
          id: p.id,
          title: p.title,
          due: p.due_date ?? "",
          sessionId: p.attendance_session_id ?? null,
        });
      }
      setScheduled(items);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, reloadNonce]);

  /** Items asociados EXPLÍCITAMENTE por el docente a esta sesión. */
  const itemsForSession = (s: SessionRow): ScheduledItem[] =>
    scheduled.filter((it) => it.sessionId === s.id);

  /** Items del curso SIN sesión asociada (o cuya sesión ya no existe) →
   *  sección "General del curso". */
  const generalScheduled = (() => {
    const ids = new Set(sessions.map((s) => s.id));
    return scheduled.filter((it) => !it.sessionId || !ids.has(it.sessionId));
  })();

  const uploadToasts = (res: BoardUploadResult) => {
    if (res.error) {
      toast.error(
        res.error === "no_valid_files"
          ? t("course.boardUploadPartial", {
              defaultValue: "{{skipped}} descartado(s) por formato/tamaño, {{failed}} fallaron.",
              skipped: res.skipped.length,
              failed: res.failed.length,
            })
          : t("course.boardUploadError", {
              defaultValue: "No se pudo subir el contenido. Reintenta.",
            }),
      );
      return false;
    }
    toast.success(
      t("course.boardUploadOk", {
        defaultValue: "{{name}} subido ({{count}} archivo(s)).",
        name: res.displayName,
        count: res.uploaded,
      }),
    );
    if (res.skipped.length > 0 || res.failed.length > 0) {
      toast.warning(
        t("course.boardUploadPartial", {
          defaultValue: "{{skipped}} descartado(s) por formato/tamaño, {{failed}} fallaron.",
          skipped: res.skipped.length,
          failed: res.failed.length,
        }),
      );
    }
    return true;
  };

  /** Subir contenido desde el tablero según el destino elegido:
   *  - "global": contenido general del curso (visible SIEMPRE para el
   *    estudiante en su tablero — sección "Material del curso").
   *  - sessionId: a esa clase. Sin contenido previo → crea uno y lo asigna;
   *    con contenido → AGREGA los archivos al contenido de la sesión y
   *    extiende `content_file_paths` si la sesión filtra por subconjunto. */
  const handleBoardUpload = async (files: File[], dest: UploadDest) => {
    if (files.length === 0 || !course || !user) return;
    setUploadingContent(true);
    try {
      const session = dest === "global" ? null : sessions.find((s) => s.id === dest);

      if (session?.content_id) {
        // ── Clase con contenido ya asignado → APPEND al contenido existente.
        const res = await appendBoardContentFiles({
          userId: user.id,
          contentId: session.content_id,
          files,
        });
        if (!uploadToasts(res)) return;
        // Extender visibilidad de la sesión para que los archivos NUEVOS
        // aparezcan aunque la sesión filtre por clase o por subconjunto.
        if (session.content_file_paths != null) {
          const merged = Array.from(
            new Set([...session.content_file_paths, ...res.uploadedPaths]),
          );
          await updateAssignment(
            session.id,
            session.content_id,
            session.content_class_index,
            merged,
          );
        } else if (session.content_class_index != null) {
          // La sesión mostraba el DEFAULT por clase — lo materializamos y
          // sumamos los nuevos (que no traen marcador _CLASE_N en el nombre).
          const content = contents.find((c) => c.id === session.content_id);
          const visible = (content?.files ?? []).filter((f) => !isTeacherOnlyFile(f.name));
          const byClass = visible.filter(
            (f) => classNumberFromFilename(f.name) === session.content_class_index,
          );
          const base = (byClass.length > 0 ? byClass : visible).map((f) => f.path);
          const merged = Array.from(new Set([...base, ...res.uploadedPaths]));
          await updateAssignment(
            session.id,
            session.content_id,
            session.content_class_index,
            merged,
          );
        }
        setReloadNonce((n) => n + 1);
        return;
      }

      // ── Global o clase SIN contenido → crear contenido nuevo.
      // Nombre auto: traemos TODOS los display_name del curso (incl. los
      // soft-deleted, sin filtro deleted_at) para que N no choque con el
      // índice único (teacher_id, lower(display_name)).
      const { data: existing } = await db
        .from("generated_contents")
        .select("display_name")
        .eq("teacher_id", user.id)
        .eq("course_id", course.id);
      const names = ((existing ?? []) as { display_name: string }[]).map((r) => r.display_name);
      const displayName = nextBoardContentName(names, course.name);
      const res = await uploadBoardContent({
        userId: user.id,
        courseId: course.id,
        courseName: course.name,
        files,
        displayName,
      });
      if (!uploadToasts(res)) return;
      if (session && res.contentId) {
        // Asignar el contenido recién creado a la clase elegida.
        await updateAssignment(session.id, res.contentId, null, null);
      }
      setReloadNonce((n) => n + 1);
    } finally {
      setUploadingContent(false);
    }
  };

  /** Persiste el cambio de contenido para UNA sesión. Optimista —
   *  actualiza el state local en cuanto la BD responde OK.
   *  `content_file_paths`: subconjunto opcional de archivos a mostrar
   *  (NULL = todos los del contenido/clase). */
  const updateAssignment = async (
    sessionId: string,
    content_id: string | null,
    content_class_index: number | null,
    content_file_paths: string[] | null,
  ) => {
    const { error } = await db
      .from("attendance_sessions")
      .update({ content_id, content_class_index, content_file_paths })
      .eq("id", sessionId);
    if (error) {
      // 23505 = unique_violation. La constraint `attendance_sessions_unique_content_class`
      // se dispara si alguien (o una race condition) intenta asignar la
      // misma (content_id, class_index) a dos sesiones del mismo curso.
      // El selector ya filtra clases tomadas, pero por defensa en
      // profundidad mostramos un mensaje claro en lugar del raw del CLI.
      if (error.code === "23505") {
        toast.error(t("course.classAlreadyAssignedToAnotherSession"));
      } else {
        toast.error(friendlyError(error));
      }
      return;
    }
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId ? { ...s, content_id, content_class_index, content_file_paths } : s,
      ),
    );
  };

  /** Crea una sesión nueva. Inserta en attendance_sessions con
   *  course_id + session_date + title (opcional) + created_by. */
  const createSession = async () => {
    if (!course || !user) return;
    if (!draftDate) {
      toast.error(t("course.boardDateRequired"));
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await db
        .from("attendance_sessions")
        .insert({
          course_id: course.id,
          session_date: draftDate,
          start_time: draftStartTime ? `${draftStartTime}:00` : null,
          duration_minutes: draftDuration > 0 ? draftDuration : 90,
          title: draftTitle.trim() || null,
          meeting_url: draftMeetingUrl.trim() || null,
          recording_url: draftRecordingUrl.trim() || null,
          notes_url: draftNotesUrl.trim() || null,
          created_by: user.id,
        })
        .select(
          "id, course_id, session_date, start_time, duration_minutes, title, content_id, content_class_index, content_file_paths, meeting_url, recording_url, notes_url, cut_id",
        )
        .single();
      if (error || !data) {
        toast.error(friendlyUniqueViolation(error) ?? error?.message ?? "insert failed");
        return;
      }
      setSessions((prev) =>
        [...prev, data as SessionRow].sort((a, b) => a.session_date.localeCompare(b.session_date)),
      );
      setDraftDate("");
      setDraftStartTime("09:00");
      setDraftDuration(90);
      setDraftTitle("");
      setDraftMeetingUrl("");
      setDraftRecordingUrl("");
      setDraftNotesUrl("");
      setDraftTimeTouched(false);
      toast.success(t("course.boardSessionCreated"));
    } finally {
      setSaving(false);
    }
  };

  /** Exporta las sesiones actuales del curso a CSV (mismo formato que el
   *  template + import). Resuelve cut_id→cut_name con la lista de cortes.
   *  El ImportExportMenu lo reusa para CSV y Excel. */
  const buildSessionsCsv = (): string => {
    if (!sessions.length) return "";
    const cutNameById = new Map(cuts.map((c) => [c.id, c.name]));
    return toCSV(buildSessionsRows(sessions, cutNameById), [...SESSIONS_CSV_COLUMNS]);
  };

  /** Importa sesiones desde el CSV (filas ya parseadas por el ImportExportMenu).
   *  Parseo PURO en parseSessionsCsv (resuelve cut_name→cut_id con la lista de
   *  cortes); acá añadimos course_id + created_by e insertamos TODAS las
   *  columnas (mismo mapeo que Asistencia). Lanza mensajes friendly con
   *  N° de fila para CSVs mal formados. */
  const importSessions = async (rows: Record<string, string>[]) => {
    if (!course || !user) throw new Error(t("course.boardImportEmpty"));
    const cutByName = new Map(cuts.map((c) => [c.name.trim().toLowerCase(), c.id]));
    const { rows: parsed, unmatchedCuts } = parseSessionsCsv(rows, cutByName);
    if (!parsed.length) throw new Error(t("course.boardImportNoValid", { skipped: 0 }));
    const payload = parsed.map((p) => ({
      course_id: course.id,
      created_by: user.id,
      session_date: p.session_date,
      title: p.title,
      cut_id: p.cut_id,
      start_time: p.start_time,
      duration_minutes: p.duration_minutes,
      meeting_url: p.meeting_url,
      recording_url: p.recording_url,
    }));
    const { data, error } = await db
      .from("attendance_sessions")
      .insert(payload)
      .select(
        "id, course_id, session_date, start_time, duration_minutes, title, content_id, content_class_index, content_file_paths, meeting_url, recording_url, notes_url, cut_id",
      );
    if (error) throw new Error(error.message);
    setSessions((prev) =>
      [...prev, ...((data ?? []) as SessionRow[])].sort((a, b) =>
        a.session_date.localeCompare(b.session_date),
      ),
    );
    const suffix =
      unmatchedCuts > 0
        ? t("course.boardImportUnmatchedCuts", {
            count: unmatchedCuts,
            defaultValue: " ({{count}} corte(s) del CSV no coincidieron con los del curso)",
          })
        : "";
    return t("course.boardImportDone", { created: payload.length, skipped: 0 }) + suffix;
  };

  /** Recarga sólo el horario del curso — usado al cerrar el editor de
   *  horario (evita el full-reload del tablero). */
  const reloadSchedule = async () => {
    const { data } = await db
      .from("course_schedules")
      .select("id, day_of_week, start_time, end_time, aula, modalidad, notes")
      .eq("course_id", courseId)
      .order("day_of_week", { ascending: true })
      .order("start_time", { ascending: true });
    setSchedule((data ?? []) as CourseScheduleBlock[]);
  };

  /** Bloque de horario que aplica a una fecha ISO ("YYYY-MM-DD"). Ancla a
   *  mediodía local para evitar el bug UTC de getDay() (descontar un día).
   *  Si hay varios bloques ese día, devuelve el de inicio más temprano. */
  const scheduleBlockForDate = (iso: string): CourseScheduleBlock | null => {
    if (!iso) return null;
    const dow = new Date(`${iso}T12:00:00`).getDay();
    const matches = schedule.filter((b) => b.day_of_week === dow);
    if (matches.length === 0) return null;
    return [...matches].sort((a, b) => a.start_time.localeCompare(b.start_time))[0];
  };

  /** Duración en minutos de un bloque (end - start), o null si no computa. */
  const blockDurationMin = (b: CourseScheduleBlock): number | null => {
    const s = parseHHMMToMinutes(b.start_time);
    const e = parseHHMMToMinutes(b.end_time);
    if (s == null || e == null || e <= s) return null;
    return e - s;
  };

  /** Al elegir una fecha en el form de creación, prefija hora + duración
   *  desde el horario del curso SI el docente no las tocó manualmente. */
  const onDraftDatePicked = (v: string) => {
    if (editingId) cancelEdit();
    setDraftDate(v);
    if (!v || draftTimeTouched) return;
    const block = scheduleBlockForDate(v);
    if (!block) return;
    setDraftStartTime(trimTime(block.start_time));
    const dur = blockDurationMin(block);
    if (dur) setDraftDuration(dur);
  };

  /** Activa el modo edición de una sesión. Carga sus valores actuales
   *  en el borrador para que el docente los modifique. */
  const startEdit = (s: SessionRow) => {
    setEditingId(s.id);
    setDraftDate(s.session_date);
    // Postgres devuelve TIME como "HH:MM:SS"; el <input type="time">
    // espera "HH:MM". Cortamos al primer ":" desde el final.
    setDraftStartTime(s.start_time ? s.start_time.slice(0, 5) : "09:00");
    setDraftDuration(s.duration_minutes ?? 90);
    setDraftTitle(s.title ?? "");
    setDraftMeetingUrl(s.meeting_url ?? "");
    setDraftRecordingUrl(s.recording_url ?? "");
    setDraftNotesUrl(s.notes_url ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftDate("");
    setDraftStartTime("09:00");
    setDraftDuration(90);
    setDraftTitle("");
    setDraftMeetingUrl("");
    setDraftRecordingUrl("");
    setDraftNotesUrl("");
    setDraftTimeTouched(false);
  };

  /** Persiste cambios de fecha/hora/título/duración de la sesión en
   *  edición. La hora + duración alimentan la sincronización a
   *  Google Calendar (edge function `calendar`). */
  const saveEdit = async () => {
    if (!editingId || !draftDate) return;
    setSaving(true);
    try {
      const newStartTime = draftStartTime ? `${draftStartTime}:00` : null;
      const newDuration = draftDuration > 0 ? draftDuration : 90;
      const { error } = await db
        .from("attendance_sessions")
        .update({
          session_date: draftDate,
          start_time: newStartTime,
          duration_minutes: newDuration,
          title: draftTitle.trim() || null,
          meeting_url: draftMeetingUrl.trim() || null,
          recording_url: draftRecordingUrl.trim() || null,
          notes_url: draftNotesUrl.trim() || null,
        })
        .eq("id", editingId);
      if (error) {
        toast.error(friendlyUniqueViolation(error) ?? friendlyError(error));
        return;
      }
      setSessions((prev) =>
        prev
          .map((s) =>
            s.id === editingId
              ? {
                  ...s,
                  session_date: draftDate,
                  start_time: newStartTime,
                  duration_minutes: newDuration,
                  title: draftTitle.trim() || null,
                  meeting_url: draftMeetingUrl.trim() || null,
                  recording_url: draftRecordingUrl.trim() || null,
                  notes_url: draftNotesUrl.trim() || null,
                }
              : s,
          )
          .sort((a, b) => a.session_date.localeCompare(b.session_date)),
      );
      cancelEdit();
      toast.success(t("course.boardSessionSaved"));
    } finally {
      setSaving(false);
    }
  };

  /** Elimina una sesión. Cascade en BD también borra los registros
   *  de asistencia (FK con ON DELETE CASCADE). El docente acepta
   *  esto en el confirm dialog. */
  const removeSession = async (s: SessionRow) => {
    const ok = await confirm({
      title: t("course.boardSessionDeleteTitle"),
      description: t("course.boardSessionDeleteBody", {
        date: s.session_date,
        title: s.title || t("contents.assignSessionUntitled"),
      }),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await softDelete("attendance_sessions", s.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setSessions((prev) => prev.filter((x) => x.id !== s.id));
    toast.success(t("course.boardSessionDeleted"));
  };

  /** Quita un contenido del curso desde el tablero. Dos comportamientos según
   *  cómo aparece el contenido en este tablero:
   *   - ANCLADO (`generated_contents.course_id === courseId`): soft-delete del
   *     contenido (→ Papelera). Deja de verse en el tablero del docente Y del
   *     estudiante Y en el módulo de Contenidos — coherente en todos lados.
   *     Reversible: restaurable dentro de 30 días.
   *   - MULTI-CURSO (asignado vía content_course_assignments, su ancla es OTRO
   *     curso): SOLO se borra la fila cca de ESTE curso. El contenido y su curso
   *     ancla quedan intactos — quitarlo de un curso no debe afectar a los
   *     demás cursos que lo comparten. */
  const removeBoardContent = async (c: BoardContentItem) => {
    if (c.isAnchored) {
      const ok = await confirm({
        title: t("course.boardContentRemoveTitle", {
          defaultValue: "¿Quitar este contenido del curso?",
        }),
        description: t("course.boardContentRemoveBody", {
          defaultValue:
            'Se quitará "{{name}}" del curso y dejará de verse en el tablero del estudiante. Queda en la Papelera y puedes restaurarlo dentro de 30 días.',
          name: c.displayName,
        }),
        confirmLabel: t("common.remove", { defaultValue: "Quitar" }),
        tone: "destructive",
      });
      if (!ok) return;
      const { error } = await softDelete("generated_contents", c.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      setBoardContents((prev) => prev.filter((x) => x.id !== c.id));
      toast.success(
        t("course.boardContentRemoved", { defaultValue: "Contenido quitado del curso" }),
      );
      return;
    }
    // Multi-curso: desasociar solo de ESTE curso (no tocar el contenido).
    const ok = await confirm({
      title: t("course.boardContentUnassignTitle", {
        defaultValue: "¿Quitar este contenido de este curso?",
      }),
      description: t("course.boardContentUnassignBody", {
        defaultValue:
          'Se quitará "{{name}}" de este curso. El contenido sigue disponible en su curso original y en los demás cursos donde esté asignado.',
        name: c.displayName,
      }),
      confirmLabel: t("common.remove", { defaultValue: "Quitar" }),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db
      .from("content_course_assignments")
      .delete()
      .eq("content_id", c.id)
      .eq("course_id", courseId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setBoardContents((prev) => prev.filter((x) => x.id !== c.id));
    setAssignedToCourse((prev) => {
      const next = new Set(prev);
      next.delete(c.id);
      return next;
    });
    toast.success(
      t("course.boardContentUnassigned", { defaultValue: "Contenido quitado de este curso" }),
    );
  };

  /** Badge de visibilidad de un contenido del grid: a qué clase(s) está
   *  asignado, o si es material general del curso, o si aún no es visible. */
  const visibilityBadge = (c: BoardContentItem) => {
    const used = sessionsByContent.get(c.id) ?? [];
    if (used.length === 1) {
      return (
        <Badge variant="outline" className="text-[9px] shrink-0">
          {t("course.boardAssignedSession", {
            defaultValue: "Clase {{date}}",
            date: used[0].session_date,
          })}
        </Badge>
      );
    }
    if (used.length > 1) {
      return (
        <Badge variant="outline" className="text-[9px] shrink-0">
          {t("course.boardAssignedSessionCount", {
            defaultValue: "{{count}} clases",
            count: used.length,
          })}
        </Badge>
      );
    }
    if (assignedToCourse.has(c.id) && c.isPublished) {
      return (
        <Badge
          variant="outline"
          className="text-[9px] shrink-0 border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
        >
          {t("course.boardAssignedGeneral", { defaultValue: "General del curso" })}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-[9px] shrink-0 text-muted-foreground">
        {t("course.boardAssignedNone", { defaultValue: "No visible al estudiante" })}
      </Badge>
    );
  };

  if (loading && !course) return <SectionLoader text={t("common.loading", { defaultValue: "Cargando…" })} />;
  if (courseMissing || !course) {
    return (
      <ErrorState
        message={t("course.boardCourseMissing", { defaultValue: "Curso no encontrado" })}
        hint={t("course.boardCourseMissingHint", {
          defaultValue: "El curso no existe o no tienes acceso.",
        })}
      />
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        backTo={backTo}
        icon={<CalendarRange className="h-6 w-6" />}
        title={t("course.boardDialogTitle", { name: course.name })}
        subtitle={t("course.boardSubtitle")}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Import/export unificado de sesiones: plantilla + importar CSV +
                exportar CSV/Excel. Reemplaza los controles manuales previos. */}
            <ImportExportMenu
              label={t("course.boardSessionsData", { defaultValue: "Sesiones" })}
              resourceName={t("course.boardSessionsResource", { defaultValue: "sesiones" })}
              templateCsv={SESSIONS_TEMPLATE}
              onImport={importSessions}
              onExport={buildSessionsCsv}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setGenerateOpen(true)}
              title={t("course.boardGenerateTooltip", {
                defaultValue:
                  "Programa varias sesiones a partir del horario del curso, marcando festivos",
              })}
              className="h-8 text-xs"
            >
              <CalendarPlus className="h-3.5 w-3.5 mr-1" />
              {t("course.boardGenerateSessions", { defaultValue: "Generar sesiones" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCalendarOpen(true)}
              title={t("course.boardCalendarTooltip", {
                defaultValue:
                  "Vincular sesiones con Google Calendar y resincronizar grabaciones",
              })}
              className="h-8 text-xs"
            >
              <CalendarRange className="h-3.5 w-3.5 mr-1" />
              {t("course.boardCalendar", { defaultValue: "Calendario" })}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setUploadDest("global");
                setUploadFiles([]);
                setUploadOpen(true);
              }}
              title={t("course.boardUploadTooltip", {
                defaultValue:
                  "Sube material del curso (PDF, diapositivas, código…) sin ir al módulo de Contenidos",
              })}
              className="h-8 text-xs"
            >
              <FileText className="h-3.5 w-3.5 mr-1" />
              {t("course.boardUploadContent", { defaultValue: "Subir contenido" })}
            </Button>
          </div>
        }
      />

      {/* Horario del curso — bloques semanales de course_schedules. Prefija
          hora/duración al crear una sesión y alimenta "Generar sesiones". */}
      <div className="rounded-md border">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-muted/30">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <CalendarClock className="h-3.5 w-3.5" />
            {t("course.boardScheduleTitle", { defaultValue: "Horario del curso" })}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setScheduleOpen(true)}
          >
            <Pencil className="h-3 w-3 mr-1" />
            {t("course.boardScheduleEdit", { defaultValue: "Editar horario" })}
          </Button>
        </div>
        {schedule.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            {t("course.boardScheduleEmpty", {
              defaultValue:
                "Define el horario del curso para agilizar la creación de sesiones.",
            })}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5 px-3 py-2.5">
            {[...schedule].sort(compareBlocks).map((b, i) => (
              <Badge
                key={b.id ?? `${b.day_of_week}-${b.start_time}-${i}`}
                variant="outline"
                className="text-[11px] gap-1 tabular-nums"
              >
                <CalendarClock className="h-3 w-3" />
                {formatBlockShort(b)}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Form de creación rápida — siempre visible arriba del listado. */}
      <div className="rounded-md border bg-muted/30 p-3 space-y-2">
        <div className="text-xs font-medium text-muted-foreground">
          {t("course.boardNewSession")}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-[11px]">{t("common.date")}</Label>
            <DatePicker
              value={editingId ? "" : draftDate}
              onChange={onDraftDatePicked}
              className="h-8 text-xs w-44"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">{t("course.boardStartTime")}</Label>
            <Input
              type="time"
              value={editingId ? "" : draftStartTime}
              onChange={(e) => {
                if (editingId) cancelEdit();
                setDraftTimeTouched(true);
                setDraftStartTime(e.target.value);
              }}
              className="h-8 text-xs w-36"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px]">{t("course.boardDuration")}</Label>
            <Input
              type="number"
              min={15}
              max={480}
              step={5}
              value={editingId ? "" : draftDuration}
              onChange={(e) => {
                if (editingId) cancelEdit();
                setDraftTimeTouched(true);
                setDraftDuration(Number(e.target.value) || 90);
              }}
              className="h-8 text-xs w-24"
            />
          </div>
          <div className="space-y-1 w-full sm:flex-1 sm:min-w-[160px] md:min-w-48">
            <Label className="text-[11px]">{t("common.title")}</Label>
            <Input
              value={editingId ? "" : draftTitle}
              onChange={(e) => {
                if (editingId) cancelEdit();
                setDraftTitle(e.target.value);
              }}
              placeholder={t("course.boardSessionTitlePlaceholder")}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1 w-full sm:flex-1 sm:min-w-[160px] md:min-w-48">
            <Label className="text-[11px]">{t("course.boardMeetingUrl")}</Label>
            <Input
              type="url"
              value={editingId ? "" : draftMeetingUrl}
              onChange={(e) => {
                if (editingId) cancelEdit();
                setDraftMeetingUrl(e.target.value);
              }}
              placeholder="https://meet.google.com/…"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1 w-full sm:flex-1 sm:min-w-[160px] md:min-w-48">
            <Label className="text-[11px]">
              {t("course.boardRecordingUrl", { defaultValue: "Enlace de grabación (opcional)" })}
            </Label>
            <Input
              type="url"
              value={editingId ? "" : draftRecordingUrl}
              onChange={(e) => {
                if (editingId) cancelEdit();
                setDraftRecordingUrl(e.target.value);
              }}
              placeholder={t("hc_routesAppTeacherBoardCourseId.recordingUrlPlaceholder")}
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1 w-full sm:flex-1 sm:min-w-[160px] md:min-w-48">
            <Label className="text-[11px]">
              {t("course.boardNotesUrl", {
                defaultValue: "Enlace de notas / minuta (opcional)",
              })}
            </Label>
            <Input
              type="url"
              value={editingId ? "" : draftNotesUrl}
              onChange={(e) => {
                if (editingId) cancelEdit();
                setDraftNotesUrl(e.target.value);
              }}
              placeholder={t("hc_routesAppTeacherBoardCourseId.notesUrlPlaceholder")}
              className="h-8 text-xs"
            />
          </div>
          <Button
            size="sm"
            onClick={createSession}
            disabled={!draftDate || saving || !!editingId}
            className="h-8"
          >
            {saving ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <Plus className="h-3.5 w-3.5 mr-1" />
            )}
            {t("course.boardCreateSession")}
          </Button>
        </div>
      </div>

      {/* Contenidos del curso — material anclado a este curso. Cada
          "Subir contenido" del header agrega una fila acá, sin pasar por
          el módulo de Contenidos. También se ven los generados con IA.
          El badge de la derecha dice DÓNDE lo ve el estudiante. */}
      <div className="rounded-md border">
        <div className="flex items-center gap-1.5 px-3 py-2 border-b bg-muted/30 text-xs font-medium text-muted-foreground">
          <FileText className="h-3.5 w-3.5" />
          {t("course.boardContentsTitle", { defaultValue: "Contenidos del curso" })}
          {boardContents.length > 0 && (
            <span className="text-[10px] tabular-nums">({boardContents.length})</span>
          )}
        </div>
        {boardContents.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            {t("course.boardContentsEmpty", {
              defaultValue:
                'Aún no hay contenidos del curso. Usa "Subir contenido" arriba para agregar material sin ir al módulo de Contenidos.',
            })}
          </div>
        ) : (
          <div className="divide-y">
            {boardContents.map((c) => (
              <div key={c.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                <FileText className="h-3.5 w-3.5 text-primary shrink-0" />
                <span className="font-medium truncate flex-1 min-w-0">{c.displayName}</span>
                {!c.isPublished && (
                  <span className="text-[9px] text-amber-600 dark:text-amber-400 shrink-0">
                    {t("course.boardContentsDraft", { defaultValue: "Borrador" })}
                  </span>
                )}
                {visibilityBadge(c)}
                <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                  {t("course.boardContentsFiles", {
                    defaultValue: "{{count}} archivo(s)",
                    count: c.fileCount,
                  })}
                </span>
                <span className="hidden sm:block text-[10px] text-muted-foreground shrink-0">
                  <DateCell value={c.createdAt} variant="auto" />
                </span>
                <RowAction
                  icon={Layers}
                  label={t("contents.manageCoursesAction", { defaultValue: "Asignar a cursos" })}
                  onClick={() => setManageCoursesFor(c)}
                />
                <RowAction
                  icon={Trash2}
                  label={t("course.boardContentRemove", { defaultValue: "Quitar del curso" })}
                  tone="destructive"
                  onClick={() => void removeBoardContent(c)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner size="xl" className="text-muted-foreground" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
          {t("course.boardNoSessions")}
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => {
            const items = itemsForSession(s);
            const isEditing = editingId === s.id;
            return (
              <Card key={s.id} className={isEditing ? "ring-2 ring-primary/60" : undefined}>
                <CardContent className="p-3 space-y-2">
                  {isEditing ? (
                    // Modo edición inline: reemplaza la fila de display por
                    // los inputs + Save/Cancel. La asignación de contenido y
                    // los items vinculados se ocultan en este modo.
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="space-y-1">
                        <Label className="text-[11px]">{t("common.date")}</Label>
                        <DatePicker
                          value={draftDate}
                          onChange={setDraftDate}
                          className="h-8 text-xs w-44"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px]">{t("course.boardStartTime")}</Label>
                        <Input
                          type="time"
                          value={draftStartTime}
                          onChange={(e) => setDraftStartTime(e.target.value)}
                          className="h-8 text-xs w-36"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px]">{t("course.boardDuration")}</Label>
                        <Input
                          type="number"
                          min={15}
                          max={480}
                          step={5}
                          value={draftDuration}
                          onChange={(e) => setDraftDuration(Number(e.target.value) || 90)}
                          className="h-8 text-xs w-24"
                        />
                      </div>
                      <div className="space-y-1 w-full sm:flex-1 sm:min-w-[160px] md:min-w-48">
                        <Label className="text-[11px]">{t("common.title")}</Label>
                        <Input
                          value={draftTitle}
                          onChange={(e) => setDraftTitle(e.target.value)}
                          placeholder={t("course.boardSessionTitlePlaceholder")}
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1 w-full sm:flex-1 sm:min-w-[160px] md:min-w-48">
                        <Label className="text-[11px]">{t("course.boardMeetingUrl")}</Label>
                        <Input
                          type="url"
                          value={draftMeetingUrl}
                          onChange={(e) => setDraftMeetingUrl(e.target.value)}
                          placeholder="https://meet.google.com/…"
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1 w-full sm:flex-1 sm:min-w-[160px] md:min-w-48">
                        <Label className="text-[11px]">
                          {t("course.boardRecordingUrl", {
                            defaultValue: "Enlace de grabación (opcional)",
                          })}
                        </Label>
                        <Input
                          type="url"
                          value={draftRecordingUrl}
                          onChange={(e) => setDraftRecordingUrl(e.target.value)}
                          placeholder={t("hc_routesAppTeacherBoardCourseId.recordingUrlPlaceholder")}
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="space-y-1 w-full sm:flex-1 sm:min-w-[160px] md:min-w-48">
                        <Label className="text-[11px]">
                          {t("course.boardNotesUrl", {
                            defaultValue: "Enlace de notas / minuta (opcional)",
                          })}
                        </Label>
                        <Input
                          type="url"
                          value={draftNotesUrl}
                          onChange={(e) => setDraftNotesUrl(e.target.value)}
                          placeholder={t("hc_routesAppTeacherBoardCourseId.notesUrlPlaceholder")}
                          className="h-8 text-xs"
                        />
                      </div>
                      <Button
                        size="sm"
                        onClick={saveEdit}
                        disabled={!draftDate || saving}
                        className="h-8"
                      >
                        {saving ? (
                          <Spinner size="sm" className="mr-1" />
                        ) : (
                          <CheckSquare className="h-3.5 w-3.5 mr-1" />
                        )}
                        {t("common.save")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={cancelEdit}
                        disabled={saving}
                        className="h-8"
                      >
                        {t("common.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="text-[11px] tabular-nums">
                            {s.session_date}
                          </Badge>
                          {s.start_time && (
                            <Badge variant="outline" className="text-[11px] tabular-nums">
                              {s.start_time.slice(0, 5)}
                              {s.duration_minutes ? ` · ${s.duration_minutes}m` : ""}
                            </Badge>
                          )}
                          {s.title && <span className="text-sm font-medium">{s.title}</span>}
                          {s.meeting_url && (
                            <a
                              href={s.meeting_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20"
                              title={s.meeting_url}
                            >
                              <Link2 className="h-3 w-3" />
                              {t("course.boardJoinMeeting")}
                            </a>
                          )}
                          {s.recording_url && (
                            <a
                              href={s.recording_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-violet-700 dark:text-violet-300 hover:bg-violet-500/20"
                              title={s.recording_url}
                            >
                              <Video className="h-3 w-3" />
                              {t("course.boardRecording", { defaultValue: "Grabación" })}
                            </a>
                          )}
                          {s.notes_url && (
                            <a
                              href={s.notes_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20"
                              title={s.notes_url}
                            >
                              <FileText className="h-3 w-3" />
                              {t("course.boardNotes", { defaultValue: "Notas" })}
                            </a>
                          )}
                        </div>
                      </div>
                      <ContentAssignmentSelector
                        contents={contents}
                        contentId={s.content_id}
                        classIndex={s.content_class_index}
                        filePaths={s.content_file_paths}
                        assignedClassesByContent={assignedClassesByContent}
                        onChange={(cid, idx, paths) =>
                          void updateAssignment(s.id, cid, idx, paths)
                        }
                      />
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => startEdit(s)}
                          title={t("common.edit")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-destructive hover:bg-destructive/10"
                          onClick={() => removeSession(s)}
                          title={t("common.delete")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                  {!isEditing && items.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1.5 border-t">
                      {items.map((it) => (
                        <Badge
                          key={`${it.kind}-${it.id}`}
                          variant="outline"
                          className="text-[10px] flex items-center gap-1"
                        >
                          {it.kind === "exam" ? (
                            <FileText className="h-3 w-3" />
                          ) : it.kind === "workshop" ? (
                            <Hammer className="h-3 w-3" />
                          ) : (
                            <FolderKanban className="h-3 w-3" />
                          )}
                          {it.title}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Actividades GENERALES del curso — sin sesión asociada. Aparecen aquí
          (y en "Actividades generales" del tablero del estudiante) para que no
          queden escondidas. */}
      {generalScheduled.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("courseBoard.generalActivities", { defaultValue: "Actividades generales" })}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {generalScheduled.map((it) => (
                <Badge
                  key={`${it.kind}-${it.id}`}
                  variant="outline"
                  className="text-[10px] flex items-center gap-1"
                >
                  {it.kind === "exam" ? (
                    <FileText className="h-3 w-3" />
                  ) : it.kind === "workshop" ? (
                    <Hammer className="h-3 w-3" />
                  ) : (
                    <FolderKanban className="h-3 w-3" />
                  )}
                  {it.title}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Dialog de subida con DESTINO: general del curso o clase específica. */}
      <Dialog open={uploadOpen} onOpenChange={(o) => !uploadingContent && setUploadOpen(o)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              {t("course.boardUploadContent", { defaultValue: "Subir contenido" })}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {t("course.boardUploadDestDesc", {
                defaultValue:
                  "Elige dónde lo verá el estudiante: como material general del curso o dentro de una clase específica.",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs" required>
                {t("course.boardUploadDestLabel", { defaultValue: "Destino" })}
              </Label>
              <Select value={uploadDest} onValueChange={(v) => setUploadDest(v as UploadDest)}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">
                    {t("course.boardUploadDestGlobal", {
                      defaultValue: "Material general del curso",
                    })}
                  </SelectItem>
                  {sessions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.session_date}
                      {s.title ? ` — ${s.title}` : ""}
                      {s.content_id
                        ? ` ${t("course.boardUploadDestAppend", { defaultValue: "(se agrega al material existente)" })}`
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {uploadDest === "global"
                  ? t("course.boardUploadDestGlobalHint", {
                      defaultValue:
                        "Visible siempre en el tablero del estudiante, en la sección \"Material del curso\".",
                    })
                  : t("course.boardUploadDestSessionHint", {
                      defaultValue: "El estudiante lo verá dentro de esa clase en su tablero.",
                    })}
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" required>
                {t("course.boardUploadFiles", { defaultValue: "Archivos" })}
              </Label>
              <Label className="flex items-center justify-center gap-2 rounded-md border border-dashed border-input bg-muted/20 hover:bg-muted/40 cursor-pointer px-3 py-4 text-xs text-muted-foreground">
                <Upload className="h-4 w-4" />
                {uploadFiles.length > 0
                  ? t("course.boardUploadFilesPicked", {
                      defaultValue: "{{count}} archivo(s) seleccionados",
                      count: uploadFiles.length,
                    })
                  : t("course.boardUploadPickFiles", { defaultValue: "Elegir archivos…" })}
                <input
                  type="file"
                  multiple
                  accept={BOARD_ACCEPTED_EXTENSIONS.join(",")}
                  className="hidden"
                  onChange={(e) => {
                    setUploadFiles(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                  disabled={uploadingContent}
                />
              </Label>
              {uploadFiles.length > 0 && (
                <div className="max-h-28 overflow-y-auto space-y-0.5 pt-1">
                  {uploadFiles.map((f) => (
                    <div key={f.name} className="text-[11px] text-muted-foreground truncate">
                      • {f.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setUploadOpen(false)}
              disabled={uploadingContent}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={uploadFiles.length === 0 || uploadingContent}
              onClick={async () => {
                await handleBoardUpload(uploadFiles, uploadDest);
                setUploadOpen(false);
                setUploadFiles([]);
              }}
            >
              {uploadingContent ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Upload className="h-3.5 w-3.5 mr-1" />
              )}
              {t("course.boardUploadGo", { defaultValue: "Subir" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LinkCalendarEventsDialog
        open={calendarOpen}
        onOpenChange={setCalendarOpen}
        courseId={course.id}
        onLinked={() => setReloadNonce((n) => n + 1)}
      />

      {/* Generar varias sesiones desde el horario del curso (festivos +
          preview editable). Mismo dialog que Asistencia, abierto sin
          contenido. Al crear, recargamos el tablero. */}
      <GenerateSessionsDialog
        open={generateOpen}
        content={null}
        courseId={course.id}
        onClose={() => setGenerateOpen(false)}
        onCreated={() => {
          setGenerateOpen(false);
          setReloadNonce((n) => n + 1);
        }}
      />

      {/* Editor del horario semanal del curso. Al cerrar recargamos sólo el
          horario (no el tablero completo). */}
      <CourseScheduleEditor
        open={scheduleOpen}
        onOpenChange={(o) => {
          setScheduleOpen(o);
          if (!o) void reloadSchedule();
        }}
        courseId={course.id}
        courseName={course.name}
      />

      {/* "Asignar a cursos" — gestiona la membresía multi-curso del contenido
          del grid sin salir del tablero (#16). Al guardar recargamos para
          reflejar el badge de visibilidad. */}
      <ManageContentCoursesDialog
        target={
          manageCoursesFor
            ? {
                id: manageCoursesFor.id,
                label: manageCoursesFor.displayName,
                anchorCourseId: manageCoursesFor.anchorCourseId,
              }
            : null
        }
        courses={allCourses}
        onClose={() => setManageCoursesFor(null)}
        onSaved={() => setReloadNonce((n) => n + 1)}
      />
    </div>
  );
}
