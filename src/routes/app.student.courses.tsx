import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Calendar,
  ChevronLeft,
  Clock,
  Download,
  FileText,
  Hammer,
  FolderKanban,
  Presentation,
  CheckCircle2,
  XCircle,
  Clock3,
  Sparkles,
  CalendarPlus,
  RefreshCw,
  BookOpen,
  ClipboardList,
  CheckSquare,
  Copy,
  MessageSquareText,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { formatDateOnly, formatWeekdayName } from "@/shared/lib/format";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Eye } from "lucide-react";
import { MarkdownViewer } from "@/shared/components/MarkdownViewer";
import { MeetingLink } from "@/shared/components/MeetingLink";
import {
  classNumberFromFilename,
  extractContentText,
  isTeacherOnlyFile,
  type ContentFile,
} from "@/modules/contents/contents-extract";
import { buildPptxBlob, type PptxBrand } from "@/modules/contents/contents-pptx";

export const Route = createFileRoute("/app/student/courses")({ component: StudentCourses });

// Tipos de Supabase no reflejan generated_contents/attendance_sessions
// (migraciones recién creadas). Cliente sin tipar para query nuevas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type CourseRow = {
  id: string;
  name: string;
  description: string | null;
  period: string | null;
  start_date: string | null;
  end_date: string | null;
  language: string | null;
};

type SessionRow = {
  id: string;
  course_id: string;
  session_date: string;
  title: string | null;
  content_id: string | null;
  content_class_index: number | null;
  meeting_url: string | null;
};

type ContentFileEntry = {
  name: string;
  path: string;
  kind: "pptx-source" | "md" | "txt";
  body?: string;
};

type ContentRow = {
  id: string;
  topic: string;
  mode: "curso_completo" | "material_individual";
  duration_minutes: number | null;
  modality: "teorica" | "practica" | "teorico_practica" | null;
  files: ContentFileEntry[];
  /** Si TRUE, los archivos solo son visibles desde la fecha de la sesión asignada. */
  release_after_session_date: boolean;
};

type BrandRow = {
  university_name: string;
  primary_color: string;
  secondary_color: string;
  logo_url: string | null;
  author_default: string | null;
};

type AttendanceStatus = "present" | "absent" | "late" | "justified";

type AttendanceRecord = {
  session_id: string;
  status: AttendanceStatus;
};

type ScheduledItem = {
  kind: "exam" | "workshop" | "project";
  id: string;
  title: string;
  due: string; // ISO date or datetime
};

function StudentCourses() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      setLoading(true);
      const { data: enr } = await supabase
        .from("course_enrollments")
        .select("course_id")
        .eq("user_id", user.id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const courseIds = (enr ?? []).map((e: any) => e.course_id);
      if (!courseIds.length) {
        setCourses([]);
        setLoading(false);
        return;
      }
      const { data } = await supabase
        .from("courses")
        .select("id, name, description, period, start_date, end_date, language")
        .in("id", courseIds)
        .order("period", { ascending: false, nullsFirst: false })
        .order("name");
      setCourses((data as CourseRow[]) ?? []);
      setLoading(false);
    })();
  }, [user]);

  const selected = courses.find((c) => c.id === selectedId) ?? null;

  if (loading) {
    return (
      <div className="flex items-center justify-center p-10">
        <Spinner size="lg" />
      </div>
    );
  }

  if (selected) {
    return <CourseBoard course={selected} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Calendar className="h-5 w-5 text-primary" />
          {t("nav.studentCourses")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("courseBoard.indexSubtitle")}</p>
      </div>

      <SearchInput value={search} onChange={setSearch} placeholder="Buscar por nombre o período…" />

      {(() => {
        // Filtra por nombre + período. Evita el repintado del grid
        // entero usando useMemo arriba sería un refactor mayor — para
        // listas pequeñas (matrículas de un estudiante) un filter
        // inline es aceptable.
        const filtered = search.trim()
          ? courses.filter(
              (c) =>
                c.name.toLowerCase().includes(search.toLowerCase()) ||
                (c.period?.toLowerCase().includes(search.toLowerCase()) ?? false),
            )
          : courses;
        if (filtered.length === 0) {
          return (
            <EmptyState
              text={
                search.trim() && courses.length > 0
                  ? "Sin coincidencias"
                  : t("courseBoard.noEnrollments")
              }
              hint={
                search.trim() && courses.length > 0
                  ? "Ajusta el buscador para ver más resultados."
                  : undefined
              }
              icon={Calendar}
            />
          );
        }
        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className="text-left rounded-lg border bg-card hover:bg-muted/40 transition-colors p-4 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold text-base leading-tight">{c.name}</h3>
                  {c.period && (
                    <Badge variant="outline" className="text-[11px]">
                      {c.period}
                    </Badge>
                  )}
                </div>
                {c.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{c.description}</p>
                )}
                <div className="text-[11px] text-muted-foreground tabular-nums">
                  {c.start_date ? formatDateOnly(c.start_date) : "—"}
                  {" → "}
                  {c.end_date ? formatDateOnly(c.end_date) : "—"}
                </div>
              </button>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

/**
 * Tablero del curso estilo Moodle. Lista cronológica de sesiones con
 * fecha + título + estado de asistencia + descargas del contenido
 * asignado + tareas vinculadas (exams/workshops/projects con fecha
 * cercana a la sesión). El contenido se descarga al click — el .pptx
 * se construye en cliente con pptxgenjs a partir del bloque texto.
 */
function CourseBoard({ course, onBack }: { course: CourseRow; onBack: () => void }) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [contents, setContents] = useState<Record<string, ContentRow>>({});
  const [brand, setBrand] = useState<BrandRow | null>(null);
  const [attendance, setAttendance] = useState<Map<string, AttendanceStatus>>(new Map());
  const [scheduled, setScheduled] = useState<ScheduledItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  // Archivo .md/.txt seleccionado para preview inline (sin descargar).
  const [previewFile, setPreviewFile] = useState<ContentFileEntry | null>(null);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      setLoading(true);
      // 1. Sesiones del curso (incluye content_id + class_index)
      const { data: ses } = await db
        .from("attendance_sessions")
        .select("id, course_id, session_date, title, content_id, content_class_index, meeting_url")
        .eq("course_id", course.id)
        .order("session_date", { ascending: true });
      const sessRows = (ses ?? []) as SessionRow[];
      setSessions(sessRows);

      // 2. Contenidos asignados — RLS abre lectura via session-link
      const contentIds = Array.from(
        new Set(sessRows.map((s) => s.content_id).filter((x): x is string => !!x)),
      );
      if (contentIds.length > 0) {
        const { data: cs } = await db
          .from("generated_contents")
          .select("id, topic, mode, duration_minutes, modality, files, release_after_session_date")
          .in("id", contentIds);
        const map: Record<string, ContentRow> = {};
        for (const c of (cs ?? []) as ContentRow[]) map[c.id] = c;
        setContents(map);
      }

      // 3. Marca institucional para construir el .pptx en cliente
      const { data: br } = await db.from("content_brand_config").select("*").maybeSingle();
      setBrand((br as BrandRow) ?? null);

      // 4. Asistencia del estudiante en este curso
      const { data: att } = await supabase
        .from("attendance_records")
        .select("session_id, status")
        .eq("user_id", user.id)
        .in(
          "session_id",
          sessRows.map((s) => s.id),
        );
      const attMap = new Map<string, AttendanceStatus>();
      for (const r of (att ?? []) as AttendanceRecord[]) attMap.set(r.session_id, r.status);
      setAttendance(attMap);

      // 5. Tareas calendarizadas: exámenes, talleres, proyectos del
      // curso que tengan fecha. Las cruzamos con cada sesión por
      // proximidad temporal (±3 días) en el render — aquí solo
      // recolectamos.
      const [examsRes, wsRes, projRes] = await Promise.all([
        supabase.from("exams").select("id, title, end_time").eq("course_id", course.id),
        supabase.from("workshops").select("id, title, due_date").eq("course_id", course.id),
        supabase.from("projects").select("id, title, due_date").eq("course_id", course.id),
      ]);
      const items: ScheduledItem[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const e of (examsRes.data ?? []) as any[]) {
        if (e.end_time) items.push({ kind: "exam", id: e.id, title: e.title, due: e.end_time });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const w of (wsRes.data ?? []) as any[]) {
        if (w.due_date) items.push({ kind: "workshop", id: w.id, title: w.title, due: w.due_date });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const p of (projRes.data ?? []) as any[]) {
        if (p.due_date) items.push({ kind: "project", id: p.id, title: p.title, due: p.due_date });
      }
      setScheduled(items);
      setLoading(false);
    })();
  }, [user, course.id]);

  /** Devuelve los archivos relevantes para una sesión. Filtra:
   *   1. Archivos de uso exclusivo del docente (guía docente, solución
   *      del ejercicio) — el estudiante no debe verlos ni descargarlos.
   *   2. Si el contenido tiene `release_after_session_date=true`, oculta
   *      los archivos hasta que llegue la fecha de la sesión (ancla a
   *      00:00 local para que cuente todo el día como liberado).
   *   3. Si el contenido es curso_completo y la sesión tiene class_index
   *      N, filtra a archivos cuyo nombre contenga `_CLASE_N`. */
  const filesForSession = (s: SessionRow): ContentFileEntry[] => {
    const c = s.content_id ? contents[s.content_id] : null;
    if (!c) return [];
    if (c.release_after_session_date && s.session_date) {
      // session_date es DATE (YYYY-MM-DD). Lo anclamos al inicio del día
      // local para liberar el material desde las 00:00 del día de clase.
      const releaseAt = new Date(`${s.session_date}T00:00:00`).getTime();
      if (Date.now() < releaseAt) return [];
    }
    const visible = c.files.filter((f) => !isTeacherOnlyFile(f.name));
    if (s.content_class_index == null) return visible;
    const filtered = visible.filter(
      (f) => classNumberFromFilename(f.name) === s.content_class_index,
    );
    return filtered.length > 0 ? filtered : visible;
  };

  /** Items "vinculados" a una sesión: due dentro de ±3 días de la fecha
   *  de la sesión. Heurística simple pero suficiente para que el
   *  estudiante vea qué se entrega cerca de esa clase. */
  const itemsForSession = (s: SessionRow): ScheduledItem[] => {
    const sessTs = new Date(s.session_date + "T12:00:00").getTime();
    return scheduled.filter((it) => {
      const dueTs = new Date(it.due).getTime();
      const diff = Math.abs(dueTs - sessTs);
      return diff <= 3 * 24 * 60 * 60 * 1000;
    });
  };

  const downloadFile = async (file: ContentFileEntry, topic: string) => {
    setDownloadingPath(file.path);
    try {
      const { data: blob, error } = await supabase.storage
        .from("generated-contents")
        .download(file.path);
      if (error || !blob) throw new Error(error?.message ?? "download failed");

      if (file.kind === "pptx-source") {
        const raw = await blob.text();
        const pptxBrand: PptxBrand = {
          universityName: brand?.university_name ?? "",
          primaryColor: brand?.primary_color ?? "#1e40af",
          secondaryColor: brand?.secondary_color ?? "#64748b",
          logoUrl: brand?.logo_url ?? null,
          author: brand?.author_default ?? null,
        };
        const pptx = await buildPptxBlob(raw, pptxBrand, topic);
        triggerDownload(pptx, file.name.replace(/\.txt$/i, ""));
      } else {
        triggerDownload(blob, file.name);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadingPath(null);
    }
  };

  const upcomingSessions = useMemo(
    () => sessions.filter((s) => new Date(s.session_date + "T23:59:59").getTime() >= Date.now()),
    [sessions],
  );
  const pastSessions = useMemo(
    () => sessions.filter((s) => new Date(s.session_date + "T23:59:59").getTime() < Date.now()),
    [sessions],
  );

  const attendanceStats = useMemo(() => {
    const total = pastSessions.length;
    if (total === 0) return null;
    let present = 0;
    let absent = 0;
    let late = 0;
    let justified = 0;
    for (const s of pastSessions) {
      const st = attendance.get(s.id);
      if (st === "present") present++;
      else if (st === "absent") absent++;
      else if (st === "late") late++;
      else if (st === "justified") justified++;
    }
    const attended = present + late + justified;
    const pct = Math.round((attended / total) * 100);
    return { total, present, absent, late, justified, attended, pct };
  }, [pastSessions, attendance]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-10">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ChevronLeft className="h-4 w-4 mr-1" />
        {t("courseBoard.back")}
      </Button>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <CardTitle className="text-lg">{course.name}</CardTitle>
              {course.description && (
                <p className="text-sm text-muted-foreground">{course.description}</p>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                {course.period && (
                  <Badge variant="outline" className="text-[11px]">
                    {course.period}
                  </Badge>
                )}
                <Badge variant="outline" className="text-[11px] tabular-nums">
                  {course.start_date ? formatDateOnly(course.start_date) : "—"}
                  {" → "}
                  {course.end_date ? formatDateOnly(course.end_date) : "—"}
                </Badge>
              </div>
              {attendanceStats && (
                <div className="flex flex-wrap items-center gap-3 pt-2 text-[11px]">
                  <span className="text-muted-foreground">
                    {t("courseBoard.attendanceSummary", {
                      attended: attendanceStats.attended,
                      total: attendanceStats.total,
                      pct: attendanceStats.pct,
                    })}
                  </span>
                  {attendanceStats.present > 0 && (
                    <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" />
                      {attendanceStats.present}
                    </span>
                  )}
                  {attendanceStats.late > 0 && (
                    <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
                      <Clock3 className="h-3 w-3" />
                      {attendanceStats.late}
                    </span>
                  )}
                  {attendanceStats.absent > 0 && (
                    <span className="flex items-center gap-1 text-destructive">
                      <XCircle className="h-3 w-3" />
                      {attendanceStats.absent}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button size="sm" variant="outline" asChild>
                <Link to="/app/student/tutor/$courseId" params={{ courseId: course.id }}>
                  <Sparkles className="h-4 w-4 mr-1" />
                  Tutor IA
                </Link>
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link to="/app/forum/$courseId" params={{ courseId: course.id }}>
                  <MessageSquareText className="h-4 w-4 mr-1" />
                  Foro
                </Link>
              </Button>
              <SubscribeCalendarButton />
            </div>
          </div>
        </CardHeader>
      </Card>

      {sessions.length === 0 ? (
        <EmptyState text={t("courseBoard.noSessions")} icon={Calendar} />
      ) : (
        <>
          {upcomingSessions.length > 0 && (
            <SessionGroup
              title={t("courseBoard.upcoming")}
              sessions={upcomingSessions}
              attendance={attendance}
              filesForSession={filesForSession}
              itemsForSession={itemsForSession}
              contents={contents}
              onDownload={downloadFile}
              onPreview={setPreviewFile}
              downloadingPath={downloadingPath}
            />
          )}
          {pastSessions.length > 0 && (
            <SessionGroup
              title={t("courseBoard.past")}
              sessions={pastSessions}
              attendance={attendance}
              filesForSession={filesForSession}
              itemsForSession={itemsForSession}
              contents={contents}
              onDownload={downloadFile}
              onPreview={setPreviewFile}
              downloadingPath={downloadingPath}
            />
          )}
        </>
      )}

      {/* Preview inline de archivos .md/.txt — usa el body que viaja en
          generated_contents.files (JSONB), evita un round-trip a Storage. */}
      <Dialog open={previewFile != null} onOpenChange={(o) => !o && setPreviewFile(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              <FileText className="h-4 w-4 text-primary" />
              {previewFile ? humanLabelForFile(previewFile) : ""}
            </DialogTitle>
            <DialogDescription className="text-[11px] font-mono truncate">
              {previewFile?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto text-sm pr-1">
            {previewFile?.body ? (
              <MarkdownViewer>{previewFile.body}</MarkdownViewer>
            ) : (
              <p className="text-muted-foreground text-xs">{t("contents.previewNoBody")}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (previewFile) void downloadFile(previewFile, previewFile.name);
              }}
            >
              <Download className="h-3.5 w-3.5 mr-1" />
              {t("contents.downloadHint")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPreviewFile(null)}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function SessionGroup({
  title,
  sessions,
  attendance,
  filesForSession,
  itemsForSession,
  contents,
  onDownload,
  onPreview,
  downloadingPath,
}: {
  title: string;
  sessions: SessionRow[];
  attendance: Map<string, AttendanceStatus>;
  filesForSession: (s: SessionRow) => ContentFileEntry[];
  itemsForSession: (s: SessionRow) => ScheduledItem[];
  contents: Record<string, ContentRow>;
  onDownload: (file: ContentFileEntry, topic: string) => Promise<void>;
  onPreview: (file: ContentFileEntry) => void;
  downloadingPath: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="space-y-3">
        {sessions.map((s) => {
          const files = filesForSession(s);
          const items = itemsForSession(s);
          const att = attendance.get(s.id);
          const content = s.content_id ? contents[s.content_id] : null;
          return (
            <Card key={s.id}>
              <CardContent className="p-4 space-y-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-[11px] tabular-nums">
                        {formatDateOnly(s.session_date)}
                      </Badge>
                      {/* Subtítulo solo con el nombre del día — la fecha
                          ya está en el badge contiguo y duplicarla con
                          "Sábado, 16 de mayo" generaba además un mismatch
                          (UTC -1 día). `formatWeekdayName` ancla a 12:00
                          local y devuelve solo "sábado". */}
                      <span className="text-[11px] text-muted-foreground capitalize">
                        {formatWeekdayName(s.session_date)}
                      </span>
                    </div>
                    <h3 className="font-medium text-base">
                      {s.title || t("contents.assignSessionUntitled")}
                    </h3>
                    {content && (
                      <div className="text-xs text-muted-foreground flex items-center gap-1">
                        <Sparkles className="h-3 w-3" />
                        {content.topic}
                        {s.content_class_index != null && (
                          <span className="font-medium">
                            {" "}
                            · {t("contents.classNumber")} {s.content_class_index}
                          </span>
                        )}
                      </div>
                    )}
                    {s.meeting_url && (
                      <MeetingLink url={s.meeting_url} label={t("courseBoard.joinMeeting")} />
                    )}
                  </div>
                  <AttendanceBadge status={att} />
                </div>

                {files.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-2 border-t">
                    {files.map((f) => {
                      const busy = downloadingPath === f.path;
                      const canPreview = (f.kind === "md" || f.kind === "txt") && !!f.body;
                      const TypeIcon = iconForFile(f);
                      const label = humanLabelForFile(f);
                      if (canPreview) {
                        return (
                          <div
                            key={f.path}
                            className="inline-flex rounded-md border overflow-hidden"
                          >
                            <button
                              type="button"
                              onClick={() => onPreview(f)}
                              className="flex items-center justify-center w-8 h-8 hover:bg-muted/60 transition-colors"
                              title={`${label} — ${t("contents.previewHint")}`}
                              aria-label={`${label} — ${t("contents.previewHint")}`}
                            >
                              <TypeIcon className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => onDownload(f, content?.topic ?? s.title ?? "Material")}
                              className="flex items-center justify-center w-8 h-8 border-l text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors disabled:opacity-60"
                              title={`${label} — ${t("contents.downloadHint")}`}
                              aria-label={`${label} — ${t("contents.downloadHint")}`}
                            >
                              {busy ? <Spinner size="xs" /> : <Download className="h-3.5 w-3.5" />}
                            </button>
                          </div>
                        );
                      }
                      return (
                        <Button
                          key={f.path}
                          size="icon"
                          variant="outline"
                          className="h-8 w-8"
                          disabled={busy}
                          onClick={() => onDownload(f, content?.topic ?? s.title ?? "Material")}
                          title={`${label} — ${t("contents.downloadHint")}`}
                          aria-label={`${label} — ${t("contents.downloadHint")}`}
                        >
                          {busy ? <Spinner size="xs" /> : <TypeIcon className="h-3.5 w-3.5" />}
                        </Button>
                      );
                    })}
                  </div>
                )}

                {items.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-2 border-t">
                    {items.map((it) => {
                      const isPastDue = new Date(it.due).getTime() < Date.now();
                      const icon =
                        it.kind === "exam" ? (
                          <FileText className="h-3 w-3" />
                        ) : it.kind === "workshop" ? (
                          <Hammer className="h-3 w-3" />
                        ) : (
                          <FolderKanban className="h-3 w-3" />
                        );
                      const href =
                        it.kind === "workshop"
                          ? `/app/student/workshop/${it.id}`
                          : it.kind === "project"
                            ? `/app/student/project/${it.id}`
                            : `/app/student/exams`;
                      return (
                        <Link key={`${it.kind}-${it.id}`} to={href}>
                          <Badge
                            variant="outline"
                            className={`text-[11px] flex items-center gap-1 cursor-pointer hover:bg-muted/60 transition-colors ${
                              isPastDue
                                ? "border-amber-400/60 bg-amber-50/40 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                                : ""
                            }`}
                          >
                            {icon}
                            {it.title}
                          </Badge>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function AttendanceBadge({ status }: { status: AttendanceStatus | undefined }) {
  const { t } = useTranslation();
  if (!status) {
    return (
      <Badge variant="outline" className="text-[10px]">
        <Clock className="h-3 w-3 mr-1" />
        {t("courseBoard.attendancePending")}
      </Badge>
    );
  }
  if (status === "present") {
    return (
      <Badge
        variant="outline"
        className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
      >
        <CheckCircle2 className="h-3 w-3 mr-1" />
        {t("courseBoard.attendancePresent")}
      </Badge>
    );
  }
  if (status === "absent") {
    return (
      <Badge variant="destructive" className="text-[10px]">
        <XCircle className="h-3 w-3 mr-1" />
        {t("courseBoard.attendanceAbsent")}
      </Badge>
    );
  }
  if (status === "late") {
    return (
      <Badge
        variant="outline"
        className="text-[10px] bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-300"
      >
        <Clock3 className="h-3 w-3 mr-1" />
        {t("courseBoard.attendanceLate")}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-[10px]">
      {t("courseBoard.attendanceJustified")}
    </Badge>
  );
}

function humanLabelForFile(f: ContentFileEntry): string {
  if (f.kind === "pptx-source") return "Presentación";
  if (f.kind === "md") {
    const u = f.name.toUpperCase();
    if (u.includes("SOLUCION") || u.includes("SOLUTION")) return "Ejercicio (con solución)";
    if (u.includes("EJERCICIO")) return "Ejercicio (estudiante)";
    if (u.includes("GUIA")) return "Guía docente";
    if (u.includes("TALLER") || u.includes("PRACTICO")) return "Taller práctico";
    if (u.includes("INTRO")) return "Introducción";
    return "Material";
  }
  return f.name;
}

/** Icono distintivo por tipo — los chips del tablero son icon-only y
 *  necesitan que cada tipo se reconozca sin leer el tooltip. */
function iconForFile(f: ContentFileEntry): LucideIcon {
  if (f.kind === "pptx-source") return Presentation;
  if (f.kind === "md") {
    const u = f.name.toUpperCase();
    if (u.includes("SOLUCION") || u.includes("SOLUTION")) return CheckSquare;
    if (u.includes("EJERCICIO")) return ClipboardList;
    if (u.includes("GUIA")) return BookOpen;
    if (u.includes("TALLER") || u.includes("PRACTICO")) return Hammer;
    if (u.includes("INTRO")) return Sparkles;
  }
  return FileText;
}

/**
 * Botón "Suscribir mi calendario" — copia al portapapeles el URL del
 * feed ICS personalizado del usuario (edge function `calendar-ics`).
 * Las edge functions de Supabase aceptan el JWT del usuario tanto en
 * el header Authorization como en el query string `apikey` — para
 * que Google Calendar pueda leer el feed sin headers, lo que ponemos
 * en el clipboard es la URL pública con el `apikey` ya inyectado.
 * El estudiante pega ese URL en Google Calendar (Otros calendarios →
 * Desde URL) y Google se encarga de refrescar el feed cada ~12h.
 *
 * Implementación: leemos `import.meta.env.VITE_SUPABASE_URL` para
 * armar la URL absoluta + obtenemos el `access_token` actual de la
 * sesión de Supabase y lo pasamos como `apikey` (válido por la vida
 * del refresh token, ~1h por access; suficiente para que Google
 * cachée el feed la primera vez y luego use la URL como public).
 */
/**
 * Botón "Suscribir/Actualizar a mi calendario" — un solo click que
 * abre Google Calendar con la suscripción al feed del estudiante
 * pre-armada. El usuario solo confirma en Google.
 *
 * Flujo:
 *   1. Construimos el feed ICS firmado con el JWT del estudiante:
 *      `${SUPABASE_URL}/functions/v1/calendar-ics?apikey=${JWT}`.
 *      Ese feed contiene TODAS las sesiones de los cursos en los que el
 *      estudiante está matriculado, con la hora real que cada docente
 *      configuró.
 *   2. Lo transformamos a `webcal://...` (protocolo que Google reconoce
 *      como "feed suscribible").
 *   3. Abrimos `calendar.google.com/calendar/r?cid=<webcal>` en nueva
 *      pestaña — Google pide confirmar y queda suscrito.
 *   4. Persistimos en localStorage que el estudiante ya se suscribió;
 *      la próxima vez el label cambia a "Actualizar en mi calendario".
 *
 * URL manual como fallback: si Google no abre (popup blocker, browser
 * sin sesión Google, etc.) el dialog ofrece copiar la URL para pegarla
 * a mano en cualquier app de calendario.
 */
const CALENDAR_SUBSCRIBED_KEY = "examlab:calendar_subscribed";

function SubscribeCalendarButton() {
  const { t } = useTranslation();
  const [alreadySubscribed, setAlreadySubscribed] = useState(
    () => typeof window !== "undefined" && !!localStorage.getItem(CALENDAR_SUBSCRIBED_KEY),
  );
  // Dialog de fallback — solo aparece si el primer intento (popup
  // bloqueado) o si el estudiante hace click en "URL manual".
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState("");
  const [fallbackCopied, setFallbackCopied] = useState(false);

  const buildIcsUrl = async (): Promise<string | null> => {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    if (!supabaseUrl) return null;
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    return `${supabaseUrl}/functions/v1/calendar-ics?apikey=${encodeURIComponent(token)}`;
  };

  const subscribeViaGoogle = async () => {
    const icsUrl = await buildIcsUrl();
    if (!icsUrl) {
      toast.error(t("courseBoard.calendarUrlError"));
      return;
    }
    // webcal:// le dice a Google "esto es un feed suscribible".
    const webcal = icsUrl.replace(/^https?:\/\//, "webcal://");
    const target = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
    const opened = window.open(target, "_blank", "noopener,noreferrer");
    if (!opened) {
      // Popup bloqueado: caemos al fallback con la URL para que el
      // estudiante la pegue en su app de calendario favorita.
      setFallbackUrl(icsUrl);
      setFallbackOpen(true);
      return;
    }
    localStorage.setItem(CALENDAR_SUBSCRIBED_KEY, "1");
    setAlreadySubscribed(true);
    toast.success(t("courseBoard.calendarOpenedToast"));
  };

  const showFallback = async () => {
    const icsUrl = await buildIcsUrl();
    if (!icsUrl) {
      toast.error(t("courseBoard.calendarUrlError"));
      return;
    }
    setFallbackUrl(icsUrl);
    setFallbackCopied(false);
    setFallbackOpen(true);
  };

  const copyFallbackUrl = async () => {
    try {
      await navigator.clipboard.writeText(fallbackUrl);
      setFallbackCopied(true);
      setTimeout(() => setFallbackCopied(false), 2500);
    } catch {
      // Algunos browsers móviles bloquean writeText sin gesto previo —
      // mostramos un prompt como último recurso.
      window.prompt(t("courseBoard.subscribeFallbackCopyManual"), fallbackUrl);
    }
  };

  return (
    <>
      <div className="inline-flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={() => void subscribeViaGoogle()}
        >
          {alreadySubscribed ? (
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
          ) : (
            <CalendarPlus className="h-3.5 w-3.5 mr-1" />
          )}
          {alreadySubscribed ? t("courseBoard.updateCalendar") : t("courseBoard.subscribeCalendar")}
        </Button>
        {/* Fallback discreto — solo visible para quien lo necesite. */}
        <button
          type="button"
          onClick={() => void showFallback()}
          className="text-[10px] text-muted-foreground underline hover:text-foreground"
        >
          {t("courseBoard.subscribeFallbackLink")}
        </button>
      </div>

      {/* Dialog de fallback — muestra la URL ICS para pegar manualmente
          en cualquier app de calendario (Outlook, Apple, etc.). */}
      <Dialog open={fallbackOpen} onOpenChange={setFallbackOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarPlus className="h-5 w-5 text-primary" />
              {t("courseBoard.subscribeFallbackTitle")}
            </DialogTitle>
            <DialogDescription>{t("courseBoard.subscribeFallbackBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              value={fallbackUrl}
              readOnly
              onClick={(e) => e.currentTarget.select()}
              className="font-mono text-[11px]"
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void copyFallbackUrl()}>
                <Copy className="h-3.5 w-3.5 mr-1" />
                {fallbackCopied
                  ? t("courseBoard.subscribeFallbackCopied")
                  : t("courseBoard.subscribeFallbackCopy")}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground pt-2 border-t">
              {t("courseBoard.subscribeFallbackHint")}
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
