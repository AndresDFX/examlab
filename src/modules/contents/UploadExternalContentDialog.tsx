/**
 * UploadExternalContentDialog — sube archivos externos (PDF/PPTX/DOCX/
 * MD/TXT/imagen/ZIP) y los registra como un `generated_contents` con
 * status='done' (no pasa por IA). Permite asignar el material a UNO o
 * VARIOS cursos vía `content_course_assignments` (junction N-N).
 *
 * Por qué reusar `generated_contents`:
 *   El listado del docente (`/app/teacher/contents`), la papelera, el
 *   visor de archivos y la integración con sesiones ya leen de esta
 *   tabla. Si creamos otra tabla "uploaded_contents" duplicamos UI +
 *   queries. Marcamos las filas con `tags=["material_externo"]` para
 *   distinguirlas; el flujo IA usa tags como `teorico/practico/examen`.
 *
 * Por qué `mode='material_individual'`:
 *   `curso_completo` implica N clases con índice (`content_class_index`).
 *   El material externo es 1 entrega plana sin clases — encaja en
 *   "individual". El docente ya conoce este modo del flujo IA.
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HelpHint } from "@/components/ui/help-hint";
import { Upload, FileUp, X, Info, AlertTriangle } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { logEvent } from "@/shared/lib/audit";

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

/** Slugifica un nombre de archivo para que sea seguro en storage.
 *  - Quita acentos
 *  - Convierte espacios a `-`
 *  - Deja solo [a-z0-9._-]
 *  - Conserva la extensión */
function slugifyFilename(name: string): string {
  const lastDot = name.lastIndexOf(".");
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot) : "";
  const cleanBase = base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${cleanBase || "archivo"}${ext.toLowerCase()}`;
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
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [selectedCourseIds, setSelectedCourseIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  // % de progreso global durante el upload — útil cuando el docente sube
  // varios PDFs grandes y el dialog se vería como "congelado" si solo
  // mostramos el Spinner.
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });

  // Reset al abrir; cuando se cierra, el state se descarta naturalmente
  // en el unmount del DialogContent.
  useEffect(() => {
    if (open) {
      setDisplayName("");
      setDescription("");
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
        toast.error(`Formato no soportado: ${f.name}`);
        continue;
      }
      if (f.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        toast.error(`Archivo > ${MAX_FILE_SIZE_MB} MB: ${f.name}`);
        continue;
      }
      if (totalBytes + f.size > MAX_TOTAL_SIZE_MB * 1024 * 1024) {
        toast.error(`Excede el total de ${MAX_TOTAL_SIZE_MB} MB`);
        break;
      }
      totalBytes += f.size;
      valid.push(f);
    }
    if (valid.length === 0) return;
    setFiles((prev) => [...prev, ...valid]);
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const canSubmit =
    !saving &&
    !!user &&
    displayName.trim().length > 0 &&
    displayName.trim().length <= 120 &&
    files.length > 0 &&
    selectedCourseIds.size > 0;

  const handleSubmit = async () => {
    if (!user) return;
    if (!canSubmit) {
      if (!displayName.trim()) toast.error("Indica un nombre para el contenido.");
      else if (files.length === 0) toast.error("Adjunta al menos un archivo.");
      else if (selectedCourseIds.size === 0)
        toast.error("Selecciona al menos un curso destino.");
      return;
    }
    setSaving(true);
    setProgress({ done: 0, total: files.length });
    const courseIdsArr = Array.from(selectedCourseIds);
    const anchorCourseId = courseIdsArr[0];

    // 1) Crear la fila de generated_contents (status='done', no IA).
    //    El `course_id` queda como "ancla" (primer curso elegido) para
    //    compat con queries existentes que asumen 1-1. La junction abajo
    //    cubre la asociación N-N real.
    const insertPayload = {
      teacher_id: user.id,
      display_name: displayName.trim(),
      topic: description.trim() || displayName.trim(),
      mode: "material_individual" as const,
      language: "es",
      n_classes: null,
      duration_minutes: 60,
      modality: "teorica",
      // `tags` está restringido por CHECK constraint
      // `generated_contents_tags_check` (mig 20260513230000): solo acepta
      // valores del set {teorico, practico, examen}. El valor
      // "material_externo" rompía el INSERT con error 23514 al subir
      // contenido externo. Usamos "teorico" como default que matchea
      // la modality "teorica" del payload. La marca de "externo" queda
      // implícita por `status='done'` (saltó el pipeline IA) + ausencia
      // de archivos `kind: 'pptx-source'` o `kind: 'md'` (todos los
      // uploads externos usan `kind: 'uploaded'`).
      tags: ["teorico"],
      course_id: anchorCourseId,
      author: null,
      instructions: null,
      status: "done" as const,
      is_published: true,
      release_after_session_date: false,
      // files se setea después de subir.
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
        toast.error(`Ya tienes un contenido llamado "${displayName.trim()}". Usa otro nombre.`);
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
      toast.error("No se pudo subir ningún archivo. Reintenta.");
      setSaving(false);
      return;
    }

    // 3) Actualizar `files` con los uploads exitosos.
    const { error: updErr } = await db
      .from("generated_contents")
      .update({ files: uploaded })
      .eq("id", contentId);
    if (updErr) {
      toast.warning(`Archivos subidos, pero no se pudo guardar el listado: ${updErr.message}`);
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
        `Contenido subido, pero falló la asociación a algunos cursos: ${juncErr.message}`,
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
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            {t("contents.uploadExternalTitle", { defaultValue: "Subir contenido externo" })}
          </DialogTitle>
          <DialogDescription>
            {t("contents.uploadExternalSubtitle", {
              defaultValue:
                "Sube archivos creados por fuera de ExamLab (PDF, presentaciones, docs) y asígnalos a uno o varios cursos.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label required>
              {t("contents.displayName", { defaultValue: "Nombre" })}
              <HelpHint>{t("help.displayNameHint")}</HelpHint>
            </Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ej. Bibliografía complementaria semana 3"
              maxLength={120}
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label>
              {t("contents.descriptionOptional", {
                defaultValue: "Descripción (opcional)",
              })}
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Breve nota sobre el material — opcional"
              rows={2}
              disabled={saving}
              className="text-xs"
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
              <HelpHint>{t("help.coursesTargetHint")}</HelpHint>
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

          {/* File picker — multi. Drag-and-drop opcional vía label. */}
          <div className="space-y-1.5">
            <Label required>
              {t("contents.files", { defaultValue: "Archivos" })}
              <HelpHint>
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
                Click para elegir archivos o arrastra aquí
              </span>
              <input
                type="file"
                multiple
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
            {t("contents.uploadAndAssign", { defaultValue: "Subir y asignar" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
