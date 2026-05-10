import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableEmpty } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { Spinner } from "@/components/ui/spinner";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { DateCell } from "@/components/ui/date-cell";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  Plus,
  Download,
  FileText,
  Presentation,
  RefreshCw,
  Trash2,
  Eye,
  BookOpenCheck,
  CalendarRange,
  AlertCircle,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  availableClassNumbers,
  extractContentText,
  type ContentFile,
} from "@/lib/contents-extract";
import { Textarea } from "@/components/ui/textarea";
import { HelpHint } from "@/components/ui/help-hint";
import { buildPptxBlob, type PptxBrand } from "@/lib/contents-pptx";

export const Route = createFileRoute("/app/teacher/contents")({ component: TeacherContents });

// El tipo `generated_contents` aún no está reflejado en los types
// generados de Supabase (se acaba de crear su migración). Usamos any
// localmente para mantener el contrato sin esperar a la regeneración.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type ContentMode = "curso_completo" | "material_individual";
type ContentStatus = "queued" | "processing" | "done" | "failed";
type ContentModality = "teorica" | "practica" | "teorico_practica";

interface FileEntry {
  name: string;
  path: string;
  kind: "pptx-source" | "md" | "txt";
  body?: string;
}

interface GeneratedContent {
  id: string;
  teacher_id: string;
  course_id: string | null;
  mode: ContentMode;
  topic: string;
  n_classes: number | null;
  duration_minutes: number | null;
  modality: ContentModality | null;
  language: string;
  author: string | null;
  status: ContentStatus;
  files: FileEntry[];
  error: string | null;
  raw_output: string | null;
  created_at: string;
  updated_at: string;
}

interface CourseLite {
  id: string;
  name: string;
}

interface BrandConfig {
  university_name: string;
  primary_color: string;
  secondary_color: string;
  logo_url: string | null;
  author_default: string | null;
}

function statusVariant(s: ContentStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (s) {
    case "done":
      return "default";
    case "processing":
    case "queued":
      return "secondary";
    case "failed":
      return "destructive";
    default:
      return "outline";
  }
}

function TeacherContents() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const navigate = useNavigate();

  const [items, setItems] = useState<GeneratedContent[]>([]);
  const [courses, setCourses] = useState<CourseLite[]>([]);
  const [brand, setBrand] = useState<BrandConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [rawForId, setRawForId] = useState<string | null>(null);
  // Cuando una generación queda en `status='failed'`, el campo `error`
  // de la fila contiene el mensaje completo. Lo abrimos en su propio
  // dialog para que el docente pueda copiar el texto y diagnosticar
  // (timeouts del gateway, VAPID/keys faltantes, prompts inválidos, etc.).
  const [errorForId, setErrorForId] = useState<string | null>(null);
  // Estado del dialog "Crear evaluación con este contenido". Cuando
  // está poblado con un GeneratedContent, abrimos el formulario que
  // permite materializar Talleres/Exámenes/Proyectos con el contenido
  // como contexto de descripción.
  const [assessmentFor, setAssessmentFor] = useState<GeneratedContent | null>(null);
  // "Asignar a sesiones" abre un dialog con la lista de attendance_sessions
  // del curso donde el contenido vive, y deja al docente mapear cada
  // CLASE_N → sesión específica. Requiere que el contenido esté
  // asociado a un curso y que el curso tenga sesiones programadas.
  const [assignFor, setAssignFor] = useState<GeneratedContent | null>(null);

  // Form
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<ContentMode>("material_individual");
  const [nClasses, setNClasses] = useState<number>(8);
  // Duración por clase, en minutos. La IA lo usa como criterio de
  // extensión: <30 → material compacto, >120 → material extenso. Default
  // 60 (clase universitaria estándar).
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  // Modalidad: define QUÉ archivos genera la IA.
  //   teorica          → solo presentación + guía
  //   practica         → solo taller práctico
  //   teorico_practica → todo (default — el caso más común).
  const [modality, setModality] = useState<ContentModality>("teorico_practica");
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [courseId, setCourseId] = useState<string>("");
  const [author, setAuthor] = useState("");
  // Instrucciones libres del docente que se apilan al user message del
  // edge function. NO modifican el system prompt — solo se inyectan
  // como bloque etiquetado al final del mensaje del usuario.
  const [instructions, setInstructions] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [{ data: gens }, { data: brandRow }, { data: cs }] = await Promise.all([
      db
        .from("generated_contents")
        .select("*")
        .eq("teacher_id", user.id)
        .order("created_at", { ascending: false }),
      db.from("content_brand_config").select("*").maybeSingle(),
      // Cursos visibles para este usuario. Antes filtrábamos via
      // `course_teachers`, pero esa tabla no siempre tiene una fila
      // por docente (en orgs chicas o cuando los cursos los crea Admin
      // sin asignación explícita queda vacía). Ahora pedimos `courses`
      // directo y dejamos que la RLS de la tabla recorte: Admin ve
      // todo, Docente ve sus cursos, Estudiante ve los matriculados.
      // Mismo patrón que usan workshops/projects para el selector.
      supabase.from("courses").select("id, name").order("name"),
    ]);
    setItems((gens ?? []) as GeneratedContent[]);
    setBrand((brandRow as BrandConfig) ?? null);
    setCourses((cs ?? []) as CourseLite[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  // Polling suave: si hay items en queued/processing, recargamos cada
  // 5s para reflejar el cambio de estado sin que el docente recargue
  // manualmente. Cuando todos están done/failed, paramos el polling.
  useEffect(() => {
    const hasPending = items.some((i) => i.status === "queued" || i.status === "processing");
    if (!hasPending) return;
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [items, load]);

  const submitNew = async () => {
    if (!user) return;
    if (!topic.trim()) {
      toast.error(t("integrity.applyError"));
      return;
    }
    setCreating(true);
    try {
      const insertPayload: Record<string, unknown> = {
        teacher_id: user.id,
        topic: topic.trim(),
        mode,
        language,
        n_classes: mode === "curso_completo" ? nClasses : null,
        duration_minutes: durationMinutes,
        modality,
        course_id: courseId || null,
        author: author.trim() || null,
        instructions: instructions.trim() || null,
        status: "queued",
      };
      const { data: created, error: insErr } = await db
        .from("generated_contents")
        .insert(insertPayload)
        .select("*")
        .maybeSingle();
      if (insErr || !created) throw new Error(insErr?.message ?? "insert failed");

      // Disparamos la edge function fire-and-forget. El usuario verá
      // el estado en la lista (queued → processing → done/failed) vía polling.
      void supabase.functions.invoke("generate-contents", { body: { id: created.id } });

      toast.success(t("contents.createdToast"));
      setDialogOpen(false);
      // Reset form
      setTopic("");
      setAuthor("");
      setInstructions("");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (item: GeneratedContent) => {
    const ok = await confirm({
      title: t("contents.deleteTitle"),
      description: t("contents.deleteBody"),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    // Borra los archivos del bucket (en el patrón <teacher>/<id>/*) y la fila.
    const paths = (item.files ?? []).map((f) => f.path).filter(Boolean);
    if (paths.length) {
      await supabase.storage.from("generated-contents").remove(paths);
    }
    const { error } = await db.from("generated_contents").delete().eq("id", item.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    toast.success(t("contents.deletedToast"));
  };

  const regenerate = async (item: GeneratedContent) => {
    // Reset al estado queued y re-disparamos la edge function. La función
    // resetea error e ignora si ya está done (en realidad la pasamos a queued
    // con un update explícito antes para reintentar fallos).
    const { error } = await db
      .from("generated_contents")
      .update({ status: "queued", error: null })
      .eq("id", item.id);
    if (error) return toast.error(error.message);
    void supabase.functions.invoke("generate-contents", { body: { id: item.id } });
    toast.success(t("contents.regeneratedToast"));
    void load();
  };

  /**
   * Descarga un archivo. Para `kind='md'` y `'txt'` viene como texto
   * plano del bucket — descargamos directo.
   * Para `pptx-source` leemos el body crudo (que la edge function dejó
   * almacenado como .pptx.txt) y lo convertimos a .pptx real con
   * pptxgenjs en el browser. Esto evita pesar el bundle inicial — el
   * import es lazy dentro de buildPptxBlob.
   */
  const download = async (item: GeneratedContent, file: FileEntry) => {
    setDownloadingId(`${item.id}:${file.path}`);
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
          author: item.author ?? brand?.author_default ?? null,
        };
        const documentTitle = item.topic;
        const pptxBlob = await buildPptxBlob(raw, pptxBrand, documentTitle);
        const url = URL.createObjectURL(pptxBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name.replace(/\.txt$/i, "");
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadingId(null);
    }
  };

  const courseNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of courses) m.set(c.id, c.name);
    return m;
  }, [courses]);

  const rawItem = items.find((i) => i.id === rawForId) ?? null;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Presentation className="h-5 w-5 text-primary" />
            {t("contents.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("contents.subtitle")}</p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          {t("contents.newContent")}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <TableSkeleton rows={5} cols={5} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("contents.topicColumn")}</TableHead>
                  <TableHead>{t("contents.modeColumn")}</TableHead>
                  <TableHead>{t("common.course")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead>{t("contents.filesColumn")}</TableHead>
                  <TableHead>{t("contents.createdColumn")}</TableHead>
                  <TableHead className="text-right">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 && (
                  <TableEmpty
                    colSpan={7}
                    text={t("contents.emptyTitle")}
                    hint={t("contents.emptyHint")}
                    action={
                      <Button onClick={() => setDialogOpen(true)}>
                        <Plus className="h-4 w-4 mr-1" />
                        {t("contents.createFirst")}
                      </Button>
                    }
                  />
                )}
                {items.map((it) => (
                  <TableRow key={it.id}>
                    <TableCell className="font-medium max-w-xs truncate" title={it.topic}>
                      {it.topic}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[11px]">
                        {it.mode === "curso_completo"
                          ? `${t("contents.modeFull")} (${it.n_classes})`
                          : t("contents.modeSingle")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {it.course_id
                        ? (courseNameById.get(it.course_id) ?? "—")
                        : t("contents.noCourse")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(it.status)} className="text-[11px]">
                        {it.status === "processing" && <Spinner size="xs" className="mr-1" />}
                        {t(
                          `contents.status${it.status.charAt(0).toUpperCase()}${it.status.slice(1)}`,
                        )}
                      </Badge>
                      {it.status === "failed" && it.error && (
                        <div
                          className="text-[10px] text-destructive mt-1 max-w-xs truncate"
                          title={it.error}
                        >
                          {t("contents.errorPrefix")}: {it.error}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(it.files ?? []).slice(0, 3).map((f) => (
                          <Button
                            key={f.path}
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            onClick={() => download(it, f)}
                            disabled={downloadingId === `${it.id}:${f.path}`}
                          >
                            {downloadingId === `${it.id}:${f.path}` ? (
                              <Spinner size="xs" className="mr-1" />
                            ) : f.kind === "pptx-source" ? (
                              <Presentation className="h-3 w-3 mr-1" />
                            ) : (
                              <FileText className="h-3 w-3 mr-1" />
                            )}
                            {f.kind === "pptx-source"
                              ? t("contents.filesPpt")
                              : f.kind === "md"
                                ? t("contents.filesMd")
                                : t("contents.filesTxt")}
                          </Button>
                        ))}
                        {(it.files?.length ?? 0) > 3 && (
                          <span className="text-[11px] text-muted-foreground self-center">
                            {t("contents.fileTooManyHint", { count: it.files.length - 3 })}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <DateCell value={it.created_at} variant="datetime" />
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActionsMenu
                        actions={[
                          // "Crear evaluación" solo cuando el contenido
                          // está listo y tiene archivos extraíbles —
                          // sin eso no hay nada que pasar como contexto.
                          it.status === "done" && (it.files?.length ?? 0) > 0
                            ? {
                                label: t("contents.createAssessment"),
                                icon: BookOpenCheck,
                                onClick: () => setAssessmentFor(it),
                              }
                            : null,
                          it.status === "done" && it.course_id
                            ? {
                                label: t("contents.assignToSessions"),
                                icon: CalendarRange,
                                onClick: () => setAssignFor(it),
                              }
                            : null,
                          // "Ver error completo" solo aparece cuando la
                          // generación falló. El campo `error` puede ser
                          // largo (HTML del gateway, stack trace, etc.)
                          // y la celda lo trunca; este dialog lo muestra
                          // íntegro y lo deja seleccionable para copiar.
                          it.status === "failed" && it.error
                            ? {
                                label: t("contents.viewError"),
                                icon: AlertCircle,
                                tone: "destructive",
                                onClick: () => setErrorForId(it.id),
                              }
                            : null,
                          it.raw_output
                            ? {
                                label: t("contents.viewRaw"),
                                icon: Eye,
                                onClick: () => setRawForId(it.id),
                              }
                            : null,
                          {
                            label: t("contents.regenerate"),
                            icon: RefreshCw,
                            onClick: () => regenerate(it),
                            disabled: it.status === "queued" || it.status === "processing",
                          },
                          {
                            label: t("common.delete"),
                            icon: Trash2,
                            tone: "destructive",
                            separatorBefore: true,
                            onClick: () => remove(it),
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("contents.newContent")}</DialogTitle>
            <DialogDescription>{t("contents.queuedHint")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label required>
                {t("contents.topic")}
                <HelpHint>{t("contents.topicHint")}</HelpHint>
              </Label>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t("contents.topicPlaceholder")}
              />
            </div>

            <div className="space-y-1.5">
              <Label>
                {t("contents.mode")}
                <HelpHint>{t("contents.modeHint")}</HelpHint>
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(["material_individual", "curso_completo"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`text-left rounded-md border p-2.5 transition-colors ${
                      mode === m ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                    }`}
                  >
                    <div className="font-medium text-sm">
                      {m === "curso_completo" ? t("contents.modeFull") : t("contents.modeSingle")}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {m === "curso_completo"
                        ? t("contents.modeFullDesc")
                        : t("contents.modeSingleDesc")}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {mode === "curso_completo" && (
                <div className="space-y-1.5">
                  <Label required>
                    {t("contents.nClasses")}
                    <HelpHint>{t("contents.nClassesHint")}</HelpHint>
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={40}
                    value={nClasses}
                    onChange={(e) => setNClasses(Math.max(1, Number(e.target.value) || 1))}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label required>
                  {t("contents.duration")}
                  <HelpHint>{t("contents.durationHelper")}</HelpHint>
                </Label>
                <Input
                  type="number"
                  min={10}
                  max={480}
                  step={5}
                  value={durationMinutes}
                  onChange={(e) =>
                    setDurationMinutes(Math.max(10, Math.min(480, Number(e.target.value) || 60)))
                  }
                />
                <p className="text-[11px] text-muted-foreground">{t("contents.durationHelper")}</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label required>
                {t("contents.modality")}
                <HelpHint>{t("contents.modalityHint")}</HelpHint>
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {(
                  [
                    { key: "teorica", label: t("contents.modalityTheory") },
                    { key: "practica", label: t("contents.modalityPractice") },
                    { key: "teorico_practica", label: t("contents.modalityBoth") },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setModality(opt.key as ContentModality)}
                    className={`text-left rounded-md border p-2 text-xs transition-colors ${
                      modality === opt.key
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/40"
                    }`}
                  >
                    <div className="font-medium text-sm">{opt.label}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {t(`contents.modality_${opt.key}_desc`)}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t("contents.courseOptional")}</Label>
                <Select
                  value={courseId || "none"}
                  onValueChange={(v) => setCourseId(v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("contents.noCourse")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("contents.noCourse")}</SelectItem>
                    {courses.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("contents.language")}</Label>
                <Select value={language} onValueChange={(v) => setLanguage(v as "es" | "en")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="es">Español</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t("contents.author")}</Label>
              <Input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder={t("contents.authorPlaceholder")}
              />
            </div>

            <div className="space-y-1.5">
              <Label>
                {t("contents.instructions")}
                <HelpHint>{t("contents.instructionsHint")}</HelpHint>
              </Label>
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={t("contents.instructionsPlaceholder")}
                className="min-h-[100px] text-xs"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submitNew} disabled={creating || !topic.trim()}>
              {creating ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Download className="h-4 w-4 mr-1" />
              )}
              {creating ? t("contents.submitting") : t("contents.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Raw output dialog */}
      <Dialog open={rawForId != null} onOpenChange={(o) => !o && setRawForId(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("contents.raw")}</DialogTitle>
            <DialogDescription>{rawItem?.topic}</DialogDescription>
          </DialogHeader>
          <pre className="text-[11px] whitespace-pre-wrap max-h-[60vh] overflow-y-auto bg-muted/30 p-3 rounded">
            {rawItem?.raw_output ?? ""}
          </pre>
        </DialogContent>
      </Dialog>

      {/* Error dialog: muestra el campo `error` íntegro de la fila
          para que el docente pueda copiarlo y diagnosticar fallos del
          edge function (timeouts, VAPID/keys faltantes, etc.). */}
      <Dialog open={errorForId != null} onOpenChange={(o) => !o && setErrorForId(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              {t("contents.errorDialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {items.find((i) => i.id === errorForId)?.topic}
            </DialogDescription>
          </DialogHeader>
          <pre className="text-[11px] whitespace-pre-wrap max-h-[60vh] overflow-y-auto bg-destructive/5 border border-destructive/30 p-3 rounded text-destructive-foreground/90 select-text">
            {items.find((i) => i.id === errorForId)?.error ?? ""}
          </pre>
          <p className="text-[11px] text-muted-foreground">{t("contents.errorDialogHint")}</p>
        </DialogContent>
      </Dialog>

      <AssignToSessionsDialog content={assignFor} onClose={() => setAssignFor(null)} />

      <CreateAssessmentDialog
        content={assessmentFor}
        courses={courses}
        onClose={() => setAssessmentFor(null)}
        onCreated={(target, id) => {
          setAssessmentFor(null);
          // Navega al editor de la nueva evaluación. Para Workshop y
          // Project no existe ruta dedicada por id (los editores son
          // dialogs dentro de la lista), así que llevamos al docente
          // a la lista — el row creado aparece arriba por created_at.
          if (target === "exam") void navigate({ to: `/app/teacher/exams/${id}` });
          else if (target === "workshop") void navigate({ to: "/app/teacher/workshops" });
          else void navigate({ to: "/app/teacher/projects" });
          toast.success(t("contents.assessmentCreatedToast"));
        }}
      />
    </div>
  );
}

/**
 * Dialog que materializa una evaluación (Taller / Examen / Proyecto)
 * usando el contenido generado como descripción inicial. Después de
 * crear la fila base, navega al editor para que el docente dispare
 * los flujos existentes de "Generar preguntas con IA" — esos prompts
 * ya saben usar la descripción como contexto.
 */
type AssessmentTarget = "workshop" | "exam" | "project";

function CreateAssessmentDialog({
  content,
  courses,
  onClose,
  onCreated,
}: {
  content: GeneratedContent | null;
  courses: CourseLite[];
  onClose: () => void;
  onCreated: (target: AssessmentTarget, id: string) => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [target, setTarget] = useState<AssessmentTarget>("exam");
  const [courseId, setCourseId] = useState<string>("");
  const [scope, setScope] = useState<"full" | "class">("full");
  const [classNumber, setClassNumber] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  // Resetea el form cada vez que se abre con un contenido distinto.
  // Pre-elige el curso del propio contenido si vino con uno.
  useEffect(() => {
    if (!content) return;
    setTarget("exam");
    setCourseId(content.course_id ?? "");
    setTitle(content.topic);
    const classes = availableClassNumbers((content.files as ContentFile[]) ?? []);
    if (classes.length > 0) {
      setScope("full");
      setClassNumber(classes[0]);
    } else {
      setScope("full");
      setClassNumber(null);
    }
  }, [content]);

  const classes = useMemo(
    () => (content ? availableClassNumbers((content.files as ContentFile[]) ?? []) : []),
    [content],
  );

  if (!content) return null;

  const submit = async () => {
    if (!user) return;
    if (!courseId) {
      toast.error(t("contents.courseRequired"));
      return;
    }
    setCreating(true);
    try {
      const description = extractContentText((content.files as ContentFile[]) ?? [], {
        classNumber: scope === "class" ? classNumber : null,
      });
      const finalTitle =
        title.trim() ||
        (scope === "class" && classNumber != null
          ? `${content.topic} — Clase ${classNumber}`
          : content.topic);

      // Defaults razonables para cada target: aprovechamos
      // duration_minutes del contenido como límite del examen, y
      // ventana de 7 días para start/end. El docente puede ajustar
      // todo en el editor.
      if (target === "exam") {
        const start = new Date();
        const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const { data, error } = await db
          .from("exams")
          .insert({
            course_id: courseId,
            title: finalTitle,
            description,
            start_time: start.toISOString(),
            end_time: end.toISOString(),
            time_limit_minutes: content.duration_minutes ?? 60,
            navigation_type: "libre",
            shuffle_enabled: false,
            created_by: user.id,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(error?.message ?? "exam insert failed");
        onCreated("exam", data.id);
      } else if (target === "workshop") {
        const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const { data, error } = await db
          .from("workshops")
          .insert({
            course_id: courseId,
            title: finalTitle,
            description,
            instructions: null,
            due_date: due.toISOString(),
            max_score: 100,
            status: "draft",
            created_by: user.id,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(error?.message ?? "workshop insert failed");
        onCreated("workshop", data.id);
      } else {
        const { data, error } = await db
          .from("projects")
          .insert({
            course_id: courseId,
            title: finalTitle,
            description,
            max_score: 100,
            status: "draft",
            created_by: user.id,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(error?.message ?? "project insert failed");
        onCreated("project", data.id);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const previewText = extractContentText((content.files as ContentFile[]) ?? [], {
    classNumber: scope === "class" ? classNumber : null,
    maxChars: 600,
  });

  return (
    <Dialog open={!!content} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("contents.createAssessmentTitle")}</DialogTitle>
          <DialogDescription>{t("contents.createAssessmentSubtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Tipo de evaluación */}
          <div className="space-y-1.5">
            <Label required>{t("contents.assessmentType")}</Label>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { key: "workshop", label: t("contents.assessmentWorkshop") },
                  { key: "exam", label: t("contents.assessmentExam") },
                  { key: "project", label: t("contents.assessmentProject") },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setTarget(opt.key)}
                  className={`text-left rounded-md border p-2 text-xs transition-colors ${
                    target === opt.key
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/40"
                  }`}
                >
                  <div className="font-medium text-sm">{opt.label}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label required>{t("common.course")}</Label>
              <Select value={courseId} onValueChange={(v) => setCourseId(v)}>
                <SelectTrigger>
                  <SelectValue placeholder={t("contents.courseRequired")} />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("contents.assessmentTitle")}</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
          </div>

          {/* Alcance: todo / clase específica */}
          <div className="space-y-1.5">
            <Label>{t("contents.assessmentScope")}</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setScope("full")}
                className={`text-left rounded-md border p-2 text-xs transition-colors ${
                  scope === "full"
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/40"
                }`}
              >
                <div className="font-medium text-sm">{t("contents.scopeFull")}</div>
                <div className="text-[10px] text-muted-foreground">
                  {t("contents.scopeFullHint")}
                </div>
              </button>
              <button
                type="button"
                onClick={() => classes.length > 0 && setScope("class")}
                disabled={classes.length === 0}
                className={`text-left rounded-md border p-2 text-xs transition-colors ${
                  scope === "class"
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/40"
                } ${classes.length === 0 ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <div className="font-medium text-sm">{t("contents.scopeClass")}</div>
                <div className="text-[10px] text-muted-foreground">
                  {t("contents.scopeClassHint")}
                </div>
              </button>
            </div>
            {classes.length === 0 && (
              <p className="text-[11px] text-muted-foreground">{t("contents.noClassesDetected")}</p>
            )}
            {scope === "class" && classes.length > 0 && (
              <div className="space-y-1.5 pt-2">
                <Label className="text-xs">{t("contents.classNumber")}</Label>
                <Select
                  value={classNumber != null ? String(classNumber) : ""}
                  onValueChange={(v) => setClassNumber(Number(v))}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {classes.map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {t("contents.classNumber")} {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Preview del texto que se inyectará como descripción.
              Sirve para que el docente vea el contexto que recibirá la
              IA al generar las preguntas, sin sorpresas. */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("contents.raw")}</Label>
            <Textarea
              value={previewText}
              readOnly
              className="font-mono text-[11px] min-h-[120px] max-h-[180px]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={creating || !courseId}>
            {creating ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <BookOpenCheck className="h-4 w-4 mr-1" />
            )}
            {creating ? t("contents.creatingAssessment") : t("contents.createAssessmentSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AttendanceSessionRow {
  id: string;
  session_date: string;
  title: string | null;
  content_id: string | null;
  content_class_index: number | null;
}

/**
 * Dialog "Asignar a sesiones": el docente mapea CADA clase del
 * contenido (curso_completo) o el contenido entero (material_individual)
 * a una sesión de asistencia del curso. La asignación persiste en
 * `attendance_sessions.content_id` + `content_class_index` y aparece
 * en el tablero del estudiante.
 *
 * Estrategia de UI:
 *   - Lista de sesiones del curso (ordenadas por session_date).
 *   - Por cada sesión, un Select con opciones:
 *       * "Sin contenido"
 *       * Para curso_completo: "Clase 1", "Clase 2", … (números de
 *         CLASE_N detectados en files[]).
 *       * Para material_individual: "Asignar este contenido"
 *   - Save persiste todos los cambios en una transacción lógica
 *     (loop de updates; bastante con el INSERT-or-UPDATE flow).
 *
 * Multi-asignación: una clase puede usarse en una sola sesión a la
 * vez (1:1). Si el docente asigna Clase 3 a Sesión X y la sesión Y
 * ya tenía Clase 3, NO bloqueamos — preferimos "última edición gana".
 * El estudiante puede tener material duplicado en dos sesiones, lo
 * cual es válido (clase de repaso, sesión adelantada, etc.).
 */
function AssignToSessionsDialog({
  content,
  onClose,
}: {
  content: GeneratedContent | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<AttendanceSessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Map sesiónId → seleccionado: -1 = sin contenido / N = clase N.
  // Para material_individual, 0 = "asignado al contenido completo".
  const [draft, setDraft] = useState<Record<string, number>>({});

  const classes = useMemo(
    () => (content ? availableClassNumbers((content.files as ContentFile[]) ?? []) : []),
    [content],
  );
  const isCursoCompleto = content?.mode === "curso_completo";

  useEffect(() => {
    if (!content?.course_id) {
      setSessions([]);
      setDraft({});
      return;
    }
    setLoading(true);
    void (async () => {
      const { data } = await db
        .from("attendance_sessions")
        .select("id, session_date, title, content_id, content_class_index")
        .eq("course_id", content.course_id)
        .order("session_date", { ascending: true });
      const rows = (data ?? []) as AttendanceSessionRow[];
      setSessions(rows);
      // Pre-rellena el draft con la asignación actual: si la sesión
      // YA apunta a este contenido, conservamos su class_index. Si
      // apunta a otro contenido o a nada, queda en "sin contenido".
      const next: Record<string, number> = {};
      for (const s of rows) {
        if (s.content_id === content.id) {
          next[s.id] = s.content_class_index ?? 0;
        } else {
          next[s.id] = -1;
        }
      }
      setDraft(next);
      setLoading(false);
    })();
  }, [content]);

  if (!content) return null;

  const save = async () => {
    setSaving(true);
    try {
      // Recorre las sesiones y aplica solo los cambios respecto del
      // estado original. Esto evita escrituras innecesarias y reduce
      // el ruido en triggers/audit logs.
      const ops = sessions
        .map((s) => {
          const target = draft[s.id] ?? -1;
          const wasAssigned = s.content_id === content.id;
          const wasIndex = s.content_class_index ?? (wasAssigned ? 0 : -1);
          if (wasAssigned && target === wasIndex) return null;
          // -1 = limpiar asignación SOLO si actualmente apunta a este content
          if (target === -1 && !wasAssigned) return null;
          return {
            id: s.id,
            content_id: target === -1 ? null : content.id,
            content_class_index: target > 0 ? target : null,
          };
        })
        .filter(
          (x): x is { id: string; content_id: string | null; content_class_index: number | null } =>
            x != null,
        );

      for (const op of ops) {
        const { error } = await db
          .from("attendance_sessions")
          .update({ content_id: op.content_id, content_class_index: op.content_class_index })
          .eq("id", op.id);
        if (error) throw new Error(error.message);
      }
      toast.success(t("contents.assignSavedToast", { count: ops.length }));
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!content} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("contents.assignDialogTitle")}</DialogTitle>
          <DialogDescription>{t("contents.assignDialogSubtitle")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
            {t("contents.assignNoSessions")}
          </div>
        ) : (
          <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-2">
            {sessions.map((s) => {
              const value = draft[s.id] ?? -1;
              return (
                <div key={s.id} className="flex items-center gap-3 rounded-md border p-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium tabular-nums">{s.session_date}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {s.title || t("contents.assignSessionUntitled")}
                    </div>
                  </div>
                  <Select
                    value={String(value)}
                    onValueChange={(v) => setDraft((prev) => ({ ...prev, [s.id]: Number(v) }))}
                  >
                    <SelectTrigger className="w-44 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="-1">{t("contents.assignNone")}</SelectItem>
                      {isCursoCompleto && classes.length > 0 ? (
                        classes.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {t("contents.classNumber")} {n}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="0">{t("contents.assignWhole")}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={saving || loading || sessions.length === 0}>
            {saving ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <CalendarRange className="h-4 w-4 mr-1" />
            )}
            {saving ? t("contents.assignSaving") : t("contents.assignSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
