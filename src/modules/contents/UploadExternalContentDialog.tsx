/**
 * UploadExternalContentDialog — sube archivos externos (PDF/PPTX/DOCX/
 * MD/TXT/imagen/ZIP) Y captura la MISMA metadata pedagógica que el
 * flujo de generación con IA (modo, tema, tags, duración, idioma,
 * instrucciones, autor, release-after-session). Persiste como
 * `generated_contents` con `status='done'` (no pasa por IA) y los
 * archivos reales en `files[]`. Permite asignar el material a UNO o
 * VARIOS cursos vía `content_course_assignments` (junction N-N).
 *
 * Por qué reusar `generated_contents`:
 *   El listado del docente (`/app/teacher/contents`), la papelera, el
 *   visor de archivos y la integración con sesiones ya leen de esta
 *   tabla. Si creamos otra tabla "uploaded_contents" duplicamos UI +
 *   queries. La diferencia con el flujo IA es solo el origen de los
 *   archivos (subidos vs generados) — la metadata es idéntica.
 *
 * Por qué NO ofrecemos "extender con IA":
 *   La edge `generate-contents` espera `{ id }` de una fila YA EXISTENTE
 *   y reemplaza/agrega archivos del bucket — no tiene un modo "complete
 *   este material subido". Hasta que la edge soporte un flag tipo
 *   `extend=true`, este dialog solo sube archivos sin invocar IA. El
 *   docente puede después usar "Regenerar" si quiere reemplazar todo
 *   con IA (acción destructiva, ya disponible en el grid).
 *
 * Storage:
 *   Bucket: `generated-contents` (ya existente). Path:
 *     `${teacher_id}/${content_id}/${filename}`
 *   La RLS del bucket exige que el primer folder = auth.uid() para
 *   INSERT, así que el docente sube bajo su propio prefijo (mismo que
 *   las generadas por IA).
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Upload,
  FileUp,
  X,
  Info,
  AlertTriangle,
  CheckSquare as CheckSquareIcon,
} from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { logEvent } from "@/shared/lib/audit";
// Helpers PUROS — testeados en `upload-external-helpers.test.ts`.
import {
  tagsToModality,
  slugifyFilename,
  parseDurationInput,
  DURATION_MIN,
  DURATION_MAX,
  DURATION_DEFAULT,
  type ContentMode,
  type ContentTag,
} from "./upload-external-helpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const BUCKET = "generated-contents";
const MAX_FILE_SIZE_MB = 25;
const MAX_TOTAL_SIZE_MB = 100;
// Whitelist conservadora — el visor del estudiante hoy soporta md/txt/
// pptx-source/pdf de forma decente. Las imágenes funcionan en cualquier
// browser. ZIP queda como "descarga directa" (no preview).
const ACCEPTED_EXTENSIONS = [
  ".pdf",
  ".pptx",
  ".docx",
  ".xlsx",
  ".md",
  ".txt",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
  ".zip",
];

interface CourseOption {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Cursos donde el docente puede asignar. Se cargan en el padre
   *  (ya sea via `course_teachers` para docente, o vía RLS de courses
   *  para Admin/SuperAdmin). */
  courses: CourseOption[];
  /** Curso pre-seleccionado (típicamente el filtro activo del listado).
   *  El usuario lo puede desmarcar y elegir otros. */
  defaultCourseId?: string | null;
  /** Callback al terminar exitoso — el padre recarga la lista. */
  onCreated: (contentId: string) => void;
}

export function UploadExternalContentDialog({
  open,
  onOpenChange,
  courses,
  defaultCourseId,
  onCreated,
}: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();

  // --- Metadata pedagógica (paralelo al form IA) ---
  const [displayName, setDisplayName] = useState("");
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<ContentMode>("material_individual");
  const [nClasses, setNClasses] = useState<number>(8);
  // `durationInput` es el string crudo del campo de duración mientras el
  // docente teclea. Clampar en CADA keystroke (el patrón anterior)
  // corrompía la entrada de valores de varios dígitos: escribir "185"
  // quedaba en 400 porque cada dígito intermedio se clampaba y el `value`
  // controlado pisaba el DOM. Clampamos SOLO al blur (`commitDuration`) y
  // al submit (`parseDurationInput(durationInput)`).
  const [durationInput, setDurationInput] = useState<string>(String(DURATION_DEFAULT));
  const [tags, setTags] = useState<ContentTag[]>(["teorico"]);
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [author, setAuthor] = useState("");
  const [instructions, setInstructions] = useState("");
  const [releaseAfterSessionDate, setReleaseAfterSessionDate] = useState(false);

  // --- Archivos + cursos destino ---
  const [files, setFiles] = useState<File[]>([]);
  const [selectedCourseIds, setSelectedCourseIds] = useState<Set<string>>(new Set());

  // --- UI state ---
  const [saving, setSaving] = useState(false);
  // % de progreso global durante el upload — útil cuando el docente sube
  // varios PDFs grandes y el dialog se vería como "congelado" si solo
  // mostramos el Spinner.
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });

  // Reset SOLO al abrir el dialog vacío (no entre renders). Permite que
  // el docente cierre y vuelva a abrir sin perder lo que estaba
  // escribiendo si lo abrió por accidente; pero al success o al primer
  // open con state stale, limpia.
  useEffect(() => {
    if (open) {
      setDisplayName("");
      setTopic("");
      setMode("material_individual");
      setNClasses(8);
      setDurationInput(String(DURATION_DEFAULT));
      setTags(["teorico"]);
      setLanguage("es");
      setAuthor("");
      setInstructions("");
      setReleaseAfterSessionDate(false);
      setFiles([]);
      setSelectedCourseIds(
        defaultCourseId ? new Set([defaultCourseId]) : new Set(),
      );
      setProgress({ done: 0, total: 0 });
    }
  }, [open, defaultCourseId]);

  const toggleCourse = (id: string) => {
    setSelectedCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTag = (tag: ContentTag) => {
    setTags((prev) =>
      prev.includes(tag) ? prev.filter((x) => x !== tag) : [...prev, tag],
    );
  };

  // Normaliza el string a su forma clampeada SOLO al salir del campo de
  // duración. Mientras el docente teclea, `durationInput` guarda el
  // string crudo sin tocar (ver comentario en el useState).
  const commitDuration = () => {
    setDurationInput(String(parseDurationInput(durationInput)));
  };

  const onFilesPicked = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    // Validamos cada uno por extensión + tamaño. Filas inválidas se
    // descartan con toast — no bloqueamos las válidas porque el docente
    // ya hizo el esfuerzo de pickear varios.
    const valid: File[] = [];
    let totalBytes = files.reduce((acc, f) => acc + f.size, 0);
    for (const f of incoming) {
      const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        toast.error(
          i18n.t("toast.modules_contents_UploadExternalContentDialog.unsupportedFormat", {
            defaultValue: "Formato no soportado: {{fileName}}",
            fileName: f.name,
          }),
        );
        continue;
      }
      if (f.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        toast.error(
          i18n.t("toast.modules_contents_UploadExternalContentDialog.fileTooLarge", {
            defaultValue: "Archivo > {{maxMb}} MB: {{fileName}}",
            maxMb: MAX_FILE_SIZE_MB,
            fileName: f.name,
          }),
        );
        continue;
      }
      if (totalBytes + f.size > MAX_TOTAL_SIZE_MB * 1024 * 1024) {
        toast.error(
          i18n.t("toast.modules_contents_UploadExternalContentDialog.totalSizeExceeded", {
            defaultValue: "Excede el total de {{maxTotalMb}} MB",
            maxTotalMb: MAX_TOTAL_SIZE_MB,
          }),
        );
        break;
      }
      totalBytes += f.size;
      valid.push(f);
    }
    if (valid.length === 0) return;
    // En modo "material_individual" forzamos un solo archivo (= 1 sesión).
    // Si el docente ya tenía uno cargado y trae otro, reemplaza.
    if (mode === "material_individual") {
      setFiles(valid.slice(-1));
    } else {
      setFiles((prev) => [...prev, ...valid]);
    }
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  // El primer tag activo determina el CHECK constraint del INSERT
  // (`generated_contents_tags_check`: solo {teorico, practico, examen}).
  // Si el docente desmarcó todo, caemos a ["teorico"] como default seguro.
  const tagsForDb: ContentTag[] = tags.length > 0 ? tags : ["teorico"];

  const canSubmit =
    !saving &&
    !!user &&
    displayName.trim().length > 0 &&
    displayName.trim().length <= 120 &&
    topic.trim().length > 0 &&
    tags.length > 0 &&
    files.length > 0 &&
    selectedCourseIds.size > 0 &&
    (mode === "material_individual" || nClasses >= 1);

  const handleSubmit = async () => {
    if (!user) return;
    if (!canSubmit) {
      if (!displayName.trim())
        toast.error(
          i18n.t("toast.modules_contents_UploadExternalContentDialog.nameRequired", {
            defaultValue: "Indica un nombre para el contenido.",
          }),
        );
      else if (!topic.trim())
        toast.error(
          i18n.t("toast.modules_contents_UploadExternalContentDialog.topicRequired", {
            defaultValue: "Indica el tema del contenido.",
          }),
        );
      else if (tags.length === 0) toast.error(t("contents.tagsRequired"));
      else if (files.length === 0)
        toast.error(
          i18n.t("toast.modules_contents_UploadExternalContentDialog.fileRequired", {
            defaultValue: "Adjunta al menos un archivo.",
          }),
        );
      else if (selectedCourseIds.size === 0)
        toast.error(
          i18n.t("toast.modules_contents_UploadExternalContentDialog.courseRequired", {
            defaultValue: "Selecciona al menos un curso destino.",
          }),
        );
      return;
    }
    setSaving(true);
    setProgress({ done: 0, total: files.length });
    const courseIdsArr = Array.from(selectedCourseIds);
    const anchorCourseId = courseIdsArr[0];
    const modality = tagsToModality(tagsForDb);
    // Clampamos desde el string crudo por si el usuario disparó submit
    // (Enter / click) sin que el campo de duración perdiera el foco (blur)
    // — así el valor persistido siempre respeta [10, 480].
    const durationToPersist = parseDurationInput(durationInput);

    // 1) Crear la fila de generated_contents con la MISMA shape que el
    //    flujo IA: status='done' (saltó pipeline), files=[] (se setea
    //    después de subir), metadata completa.
    const insertPayload: Record<string, unknown> = {
      teacher_id: user.id,
      display_name: displayName.trim(),
      topic: topic.trim(),
      mode,
      language,
      n_classes: mode === "curso_completo" ? nClasses : null,
      duration_minutes: durationToPersist,
      modality,
      tags: tagsForDb,
      course_id: anchorCourseId,
      author: author.trim() || null,
      instructions: instructions.trim() || null,
      status: "done",
      is_published: true,
      release_after_session_date: releaseAfterSessionDate,
      files: [] as Array<{ name: string; path: string; kind: string }>,
    };
    const { data: created, error: insErr } = await db
      .from("generated_contents")
      .insert(insertPayload)
      .select("id")
      .maybeSingle();
    if (insErr || !created?.id) {
      const code = (insErr as { code?: string } | null)?.code;
      if (code === "23505") {
        const dupName = displayName.trim();
        toast.error(
          i18n.t("toast.modules_contents_UploadExternalContentDialog.duplicateName", {
            defaultValue: 'Ya tienes un contenido llamado "{{name}}". Usa otro nombre.',
            name: dupName,
          }),
        );
      } else {
        toast.error(friendlyError(insErr, "No se pudo crear el contenido"));
      }
      setSaving(false);
      return;
    }
    const contentId = created.id as string;

    // 2) Subir archivos. Si algún upload falla, lo informamos pero no
    //    abortamos los otros — el docente recibe parcial y puede
    //    reintentar los fallados. Al final actualizamos `files` JSON
    //    con SOLO los que subieron bien.
    const uploaded: Array<{ name: string; path: string; kind: string }> = [];
    const failed: string[] = [];
    for (const f of files) {
      const safeName = slugifyFilename(f.name);
      const path = `${user.id}/${contentId}/${safeName}`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: upErr } = await (supabase.storage as any)
        .from(BUCKET)
        .upload(path, f, { upsert: false, contentType: f.type || undefined });
      if (upErr) {
        console.warn("[upload-external] failed:", path, upErr);
        failed.push(f.name);
      } else {
        uploaded.push({
          name: f.name,
          path,
          // kind="uploaded" distingue de los kinds generados por IA
          // ("pptx-source", "md", "txt"). El viewer del estudiante puede
          // mapear por extensión del path para mostrar el ícono correcto.
          kind: "uploaded",
        });
      }
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    if (uploaded.length === 0) {
      // Todo falló — borramos la fila para no dejarla huérfana.
      await db.from("generated_contents").delete().eq("id", contentId);
      toast.error(
        i18n.t("toast.modules_contents_UploadExternalContentDialog.noFilesUploaded", {
          defaultValue: "No se pudo subir ningún archivo. Reintenta.",
        }),
      );
      setSaving(false);
      return;
    }

    // 3) Actualizar `files` con los uploads exitosos.
    const { error: updErr } = await db
      .from("generated_contents")
      .update({ files: uploaded })
      .eq("id", contentId);
    if (updErr) {
      toast.warning(
        i18n.t("toast.modules_contents_UploadExternalContentDialog.fileListSaveFailed", {
          defaultValue: "Archivos subidos, pero no se pudo guardar el listado: {{error}}",
          error: updErr.message,
        }),
      );
    }

    // 4) Junction N-N: insertar 1 fila por curso elegido. Si alguna
    //    falla (RLS), lo informamos pero seguimos — el contenido queda
    //    al menos asignado al curso ancla via `generated_contents.course_id`.
    const junctionRows = courseIdsArr.map((courseId) => ({
      content_id: contentId,
      course_id: courseId,
      created_by: user.id,
    }));
    const { error: juncErr } = await db
      .from("content_course_assignments")
      .insert(junctionRows);
    if (juncErr) {
      toast.warning(
        i18n.t("toast.modules_contents_UploadExternalContentDialog.courseAssociationFailed", {
          defaultValue:
            "Contenido subido, pero falló la asociación a algunos cursos: {{error}}",
          error: juncErr.message,
        }),
      );
    }

    void logEvent({
      action: "content.uploaded_external",
      category: "content",
      severity: "info",
      entityType: "generated_contents",
      entityId: contentId,
      entityName: displayName.trim(),
      metadata: {
        files_count: uploaded.length,
        files_failed: failed.length,
        courses: courseIdsArr,
        mode,
        tags: tagsForDb,
      },
    });

    const successMsg =
      failed.length === 0
        ? `Contenido subido (${uploaded.length} archivo(s), ${courseIdsArr.length} curso(s)).`
        : `Subidos ${uploaded.length}/${files.length}; falló: ${failed.join(", ")}`;
    toast.success(successMsg);
    onCreated(contentId);
    onOpenChange(false);
    setSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent
        data-tour-id="dialog-upload-external"
        className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            {t("contents.uploadExternalTitle", { defaultValue: "Subir contenido externo" })}
          </DialogTitle>
          <DialogDescription>
            {t("contents.uploadExternalSubtitle", {
              defaultValue:
                "Sube archivos creados por fuera de ExamLab (PDF, presentaciones, docs) y completa la misma metadata pedagógica que usaría la IA. No se invoca generación — solo se registra el material.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Nombre + tema */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label required>
                Nombre del contenido
                <HelpHint>{t("help.contentDisplayNameHint", { defaultValue: "Nombre único que verás en la lista. Distinto del tema." })}</HelpHint>
              </Label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder='Ej. "Semana 5 — Bucles"'
                maxLength={120}
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <Label required>
                {t("contents.topic", { defaultValue: "Tema" })}
                <HelpHint>{t("contents.topicHint")}</HelpHint>
              </Label>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t("contents.topicPlaceholder")}
                disabled={saving}
              />
            </div>
          </div>

          {/* Modo (curso completo vs individual) */}
          <div className="space-y-1.5">
            <Label>
              {t("contents.mode", { defaultValue: "Modo" })}
              <HelpHint>{t("contents.modeHint")}</HelpHint>
            </Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(["material_individual", "curso_completo"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={saving}
                  onClick={() => setMode(m)}
                  className={`text-left rounded-md border p-2.5 transition-colors ${
                    mode === m
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/40"
                  }`}
                >
                  <div className="font-medium text-sm">
                    {m === "curso_completo"
                      ? t("contents.modeFull")
                      : t("contents.modeSingle")}
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

          {/* N clases (solo curso_completo) + duración */}
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
                  disabled={saving}
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
                min={DURATION_MIN}
                max={DURATION_MAX}
                step={5}
                value={durationInput}
                disabled={saving}
                onChange={(e) => setDurationInput(e.target.value)}
                onBlur={commitDuration}
              />
            </div>
          </div>

          {/* Tags compositivos */}
          <div className="space-y-1.5">
            <Label required>
              {t("contents.tags")}
              <HelpHint>{t("contents.tagsHint")}</HelpHint>
            </Label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {(
                [
                  {
                    key: "teorico" as ContentTag,
                    label: t("contents.tagTheory"),
                    desc: t("contents.tagTheoryDesc"),
                  },
                  {
                    key: "practico" as ContentTag,
                    label: t("contents.tagPractice"),
                    desc: t("contents.tagPracticeDesc"),
                  },
                  {
                    key: "examen" as ContentTag,
                    label: t("contents.tagExam"),
                    desc: t("contents.tagExamDesc"),
                  },
                ] as const
              ).map((opt) => {
                const active = tags.includes(opt.key);
                return (
                  <button
                    key={opt.key}
                    type="button"
                    disabled={saving}
                    onClick={() => toggleTag(opt.key)}
                    className={`text-left rounded-md border p-2 text-xs transition-colors ${
                      active
                        ? "border-primary bg-primary/10 ring-1 ring-primary/40"
                        : "border-border hover:bg-muted/40"
                    }`}
                    aria-pressed={active}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <div className="font-medium text-sm">{opt.label}</div>
                      {active && <CheckSquareIcon className="h-3.5 w-3.5 text-primary" />}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{opt.desc}</div>
                  </button>
                );
              })}
            </div>
            {tags.length === 0 && (
              <p className="text-[11px] text-destructive">{t("contents.tagsRequired")}</p>
            )}
          </div>

          {/* Idioma + autor */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("contents.language", { defaultValue: "Idioma" })}</Label>
              <Select
                value={language}
                onValueChange={(v) => setLanguage(v as "es" | "en")}
                disabled={saving}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="es">Español</SelectItem>
                  <SelectItem value="en">English</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("contents.author", { defaultValue: "Autor (opcional)" })}</Label>
              <Input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder={t("contents.authorPlaceholder")}
                disabled={saving}
              />
            </div>
          </div>

          {/* Instrucciones — útiles aunque NO se invoque IA: queda como
              nota pedagógica del contenido (la columna ya existe). */}
          <div className="space-y-1.5">
            <Label>
              {t("contents.instructions", { defaultValue: "Notas / instrucciones (opcional)" })}
              <HelpHint>
                {t("contents.uploadInstructionsHint", {
                  defaultValue:
                    "Notas libres sobre este material. Se guardan con el contenido; útiles si después decides regenerar con IA o materializar evaluaciones.",
                })}
              </HelpHint>
            </Label>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={t("contents.instructionsPlaceholder")}
              className="min-h-[80px] text-xs"
              disabled={saving}
            />
          </div>

          {/* Release after session */}
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <Label
              htmlFor="release-after-session-upload"
              className="text-sm font-medium inline-flex items-center gap-1.5 cursor-pointer min-w-0"
            >
              <span className="truncate">
                Liberar al estudiante solo desde la fecha de sesión
              </span>
              <HelpHint>
                {t("help.contentReleaseAfterSessionHint", {
                  defaultValue:
                    "Si el contenido está asignado a una sesión, solo se mostrará al estudiante desde la fecha de esa sesión.",
                })}
              </HelpHint>
            </Label>
            <Switch
              id="release-after-session-upload"
              checked={releaseAfterSessionDate}
              onCheckedChange={setReleaseAfterSessionDate}
              disabled={saving}
            />
          </div>

          {/* Cursos: multi-select via checkbox list. UX preferible al
              Select para "varios" porque el docente ve TODOS los cursos
              de un vistazo y marca/desmarca sin abrir/cerrar dropdowns. */}
          <div className="space-y-1.5">
            <Label required>
              {t("contents.coursesTarget", {
                defaultValue: "Cursos donde aparecerá",
              })}
              <HelpHint>
                {t("help.coursesTargetHint", {
                  defaultValue:
                    "El primero seleccionado queda como curso ancla; los demás se asocian via tabla N-N.",
                })}
              </HelpHint>
            </Label>
            {courses.length === 0 ? (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  No tienes cursos disponibles. Asociate como docente de al menos un curso antes
                  de subir contenido.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="border rounded-md max-h-40 overflow-y-auto divide-y">
                {courses.map((c) => {
                  const checked = selectedCourseIds.has(c.id);
                  return (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/50 transition-colors"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleCourse(c.id)}
                        disabled={saving}
                      />
                      <span className="text-sm truncate">{c.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
            {selectedCourseIds.size > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {selectedCourseIds.size} curso(s) seleccionado(s).
              </p>
            )}
          </div>

          {/* File picker — multi (o single en mode=individual). */}
          <div className="space-y-1.5">
            <Label required>
              {t("contents.files", { defaultValue: "Archivos" })}
              <HelpHint>
                {mode === "material_individual"
                  ? "Modo individual: 1 archivo (se reemplaza si seleccionas otro)."
                  : "Modo curso completo: puedes subir varios archivos (idealmente 1 por clase)."}{" "}
                Formatos: PDF, PPTX, DOCX, XLSX, MD, TXT, CSV, ZIP, PNG, JPG, WEBP, SVG. Máximo
                {` ${MAX_FILE_SIZE_MB} MB por archivo, ${MAX_TOTAL_SIZE_MB} MB en total.`}
              </HelpHint>
            </Label>
            <label
              className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-md p-4 text-sm transition-colors ${
                saving
                  ? "cursor-not-allowed border-muted opacity-60"
                  : "cursor-pointer border-muted-foreground/30 hover:border-primary/50 hover:bg-accent/30"
              }`}
            >
              <FileUp className="h-5 w-5 text-muted-foreground" />
              <span className="text-muted-foreground text-xs">
                {mode === "material_individual"
                  ? "Click para elegir un archivo"
                  : "Click para elegir archivos o arrastra aquí"}
              </span>
              <input
                type="file"
                multiple={mode === "curso_completo"}
                accept={ACCEPTED_EXTENSIONS.join(",")}
                className="hidden"
                disabled={saving}
                onChange={(e) => onFilesPicked(e.target.files)}
              />
            </label>
            {files.length > 0 && (
              <ul className="space-y-1 max-h-32 overflow-y-auto">
                {files.map((f, idx) => (
                  <li
                    key={`${f.name}-${idx}`}
                    className="flex items-center gap-2 rounded border px-2 py-1 text-xs"
                  >
                    <Badge variant="secondary" className="text-[10px]">
                      {(f.size / 1024).toFixed(0)} KB
                    </Badge>
                    <span className="flex-1 truncate">{f.name}</span>
                    <button
                      type="button"
                      onClick={() => removeFile(idx)}
                      disabled={saving}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Quitar archivo"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {saving && progress.total > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Subiendo {progress.done} / {progress.total} archivo(s)…
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("common.cancel", { defaultValue: "Cancelar" })}
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {saving ? <Spinner size="sm" className="mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
            {t("contents.uploadAndCreate", {
              defaultValue: "Subir y crear contenido",
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
