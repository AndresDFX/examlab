import { createFileRoute } from "@tanstack/react-router";
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
  Video,
  CalendarPlus,
  Copy as CopyIcon,
} from "lucide-react";
import { formatDateOnly, formatWeekday } from "@/lib/format";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { extractContentText, type ContentFile } from "@/lib/contents-extract";
import { buildPptxBlob, type PptxBrand } from "@/lib/contents-pptx";

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

      {courses.length === 0 ? (
        <EmptyState text={t("courseBoard.noEnrollments")} icon={Calendar} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {courses.map((c) => (
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
      )}
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
          .select("id, topic, mode, duration_minutes, modality, files")
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

  /** Devuelve los archivos relevantes para una sesión. Si el contenido
   *  es curso_completo y la sesión tiene class_index N, filtra a
   *  archivos cuyo nombre contenga `_CLASE_N`. */
  const filesForSession = (s: SessionRow): ContentFileEntry[] => {
    const c = s.content_id ? contents[s.content_id] : null;
    if (!c) return [];
    if (s.content_class_index == null) return c.files;
    const re = new RegExp(`(?:CLASE|CLASS|SESION|SESSION)[_\\s-]*${s.content_class_index}\\b`, "i");
    const filtered = c.files.filter((f) => re.test(f.name));
    return filtered.length > 0 ? filtered : c.files;
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
            </div>
            {/* Botón "Suscribir mi calendario" — copia al portapapeles
                el URL del feed ICS de la edge function `calendar-ics`.
                El estudiante lo pega UNA VEZ en Google Calendar
                (Otros calendarios → Desde URL) y queda sincronizado:
                cualquier sesión que el docente cree/edite/borre se
                refleja automáticamente cada ~12h. No requiere OAuth. */}
            <SubscribeCalendarButton />
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
              downloadingPath={downloadingPath}
            />
          )}
        </>
      )}
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
  downloadingPath,
}: {
  title: string;
  sessions: SessionRow[];
  attendance: Map<string, AttendanceStatus>;
  filesForSession: (s: SessionRow) => ContentFileEntry[];
  itemsForSession: (s: SessionRow) => ScheduledItem[];
  contents: Record<string, ContentRow>;
  onDownload: (file: ContentFileEntry, topic: string) => Promise<void>;
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
                      <span className="text-[11px] text-muted-foreground capitalize">
                        {formatWeekday(s.session_date)}
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
                      <a
                        href={s.meeting_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 mt-1 text-xs rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20"
                      >
                        <Video className="h-3.5 w-3.5" />
                        {t("courseBoard.joinMeeting")}
                      </a>
                    )}
                  </div>
                  <AttendanceBadge status={att} />
                </div>

                {files.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-2 border-t">
                    {files.map((f) => (
                      <Button
                        key={f.path}
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs"
                        disabled={downloadingPath === f.path}
                        onClick={() => onDownload(f, content?.topic ?? s.title ?? "Material")}
                      >
                        {downloadingPath === f.path ? (
                          <Spinner size="xs" className="mr-1" />
                        ) : f.kind === "pptx-source" ? (
                          <Presentation className="h-3.5 w-3.5 mr-1" />
                        ) : (
                          <FileText className="h-3.5 w-3.5 mr-1" />
                        )}
                        {humanLabelForFile(f)}
                        <Download className="h-3 w-3 ml-1.5 opacity-60" />
                      </Button>
                    ))}
                  </div>
                )}

                {items.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-2 border-t">
                    {items.map((it) => (
                      <Badge
                        key={`${it.kind}-${it.id}`}
                        variant="outline"
                        className="text-[11px] flex items-center gap-1"
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
    if (u.includes("GUIA")) return "Guía docente";
    if (u.includes("TALLER") || u.includes("PRACTICO")) return "Taller";
    return "Material";
  }
  return f.name;
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
function SubscribeCalendarButton() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const buildUrl = async (): Promise<string | null> => {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    if (!supabaseUrl) return null;
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    return `${supabaseUrl}/functions/v1/calendar-ics?apikey=${encodeURIComponent(token)}`;
  };

  const onClick = async () => {
    const url = await buildUrl();
    if (!url) {
      toast.error(t("courseBoard.calendarUrlError"));
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success(t("courseBoard.calendarUrlCopied"), {
        description: t("courseBoard.calendarUrlHint"),
        duration: 8000,
      });
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Algunos browsers móviles no permiten writeText sin gesto. Como
      // fallback, mostramos el URL en un prompt para copiar manual.
      window.prompt(t("courseBoard.calendarUrlManualCopy"), url);
    }
  };

  return (
    <Button size="sm" variant="outline" className="shrink-0 h-8 text-xs" onClick={onClick}>
      {copied ? (
        <CopyIcon className="h-3.5 w-3.5 mr-1 text-emerald-600" />
      ) : (
        <CalendarPlus className="h-3.5 w-3.5 mr-1" />
      )}
      {copied ? t("courseBoard.calendarUrlCopiedShort") : t("courseBoard.subscribeCalendar")}
    </Button>
  );
}
