/**
 * MarkdownEditorDialog — visualizador + editor inline para archivos
 * .md/.txt del módulo de Contenidos. Espejo en miniatura del
 * PptxViewerDialog pero para texto libre: el body se renderiza con
 * react-markdown en modo vista, y al pulsar "Editar" se cambia a un
 * Textarea para ajustes rápidos sin tener que regenerar todo con IA.
 *
 * Al guardar:
 *   1) Sube el body editado al storage como `<name>.md/.txt` (upsert).
 *   2) Actualiza `generated_contents.files[].body` en el JSONB.
 *
 * El componente que vivía inline en `FilesByClassDialog` se extrajo
 * acá para no inflar el archivo de la ruta y poder reusarlo si en el
 * futuro hace falta en el tablero del estudiante (o en otro módulo).
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { FileText, Pencil, Save } from "lucide-react";
import { MarkdownViewer } from "@/shared/components/MarkdownViewer";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { friendlyError } from "@/shared/lib/db-errors";

// generated_contents aún no figura en types.ts auto-generados.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface MdLikeFile {
  path: string;
  name: string;
  kind: "pptx-source" | "md" | "txt";
  body?: string;
}

interface MarkdownEditorDialogProps {
  file: MdLikeFile | null;
  contentId: string | null;
  onClose: () => void;
  /** Notifica al padre con el nuevo body después de guardar — útil para
   *  refrescar `bodyOverrides` en el grid sin re-fetch. */
  onSaved?: (newBody: string) => void;
  /** "edit" abre directo en modo edición; "view" (default) muestra
   *  preview con botón Editar. */
  initialMode?: "view" | "edit";
}

function humanLabelForFile(
  f: MdLikeFile,
  t: (key: string, opts: { defaultValue: string }) => string,
): string {
  if (f.kind === "pptx-source")
    return t("contents.fileLabelPresentation", { defaultValue: "Presentación" });
  const u = f.name.toUpperCase();
  if (u.includes("SOLUCION") || u.includes("SOLUTION"))
    return t("contents.fileLabelExerciseSolution", { defaultValue: "Ejercicio (con solución)" });
  if (u.includes("EJERCICIO"))
    return t("contents.fileLabelExerciseStudent", { defaultValue: "Ejercicio (estudiante)" });
  if (u.includes("GUIA"))
    return t("contents.fileLabelTeacherGuide", { defaultValue: "Guía docente" });
  if (u.includes("TALLER") || u.includes("PRACTICO"))
    return t("contents.fileLabelPracticalWorkshop", { defaultValue: "Taller práctico" });
  if (u.includes("INTRO"))
    return t("contents.fileLabelIntro", { defaultValue: "Introducción" });
  return t("contents.fileLabelMaterial", { defaultValue: "Material" });
}

export function MarkdownEditorDialog({
  file,
  contentId,
  onClose,
  onSaved,
  initialMode = "view",
}: MarkdownEditorDialogProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [originalBody, setOriginalBody] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (file?.body != null) {
      setBody(file.body);
      setOriginalBody(file.body);
      setEditing(initialMode === "edit");
    } else if (!file) {
      setBody("");
      setOriginalBody("");
      setEditing(false);
    }
  }, [file, initialMode]);

  const open = file != null;
  const dirty = body !== originalBody;

  const handleSave = async () => {
    if (!file || !contentId) return;
    if (!body.trim()) {
      toast.error(t("pptxViewer.errorEmpty"));
      return;
    }
    setSaving(true);
    try {
      // 1) Storage: subimos como text/plain con upsert (la próxima
      //    descarga ya recoge la versión editada).
      const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
      const { error: stErr } = await supabase.storage
        .from("generated-contents")
        .upload(file.path, blob, { upsert: true, contentType: "text/plain" });
      if (stErr) throw new Error(stErr.message);

      // 2) JSONB: actualizamos solo este file (preservando el resto).
      const { data: row, error: getErr } = await db
        .from("generated_contents")
        .select("files")
        .eq("id", contentId)
        .maybeSingle();
      if (getErr || !row)
        throw new Error(
          getErr?.message ??
            t("contents.loadContentError", { defaultValue: "No se pudo cargar el contenido" }),
        );
      const filesArr = Array.isArray(row.files) ? (row.files as Array<{ path: string }>) : [];
      const updated = filesArr.map((f) => (f.path === file.path ? { ...f, body } : f));
      const { error: updErr } = await db
        .from("generated_contents")
        .update({ files: updated })
        .eq("id", contentId);
      if (updErr) throw new Error(updErr.message);

      toast.success(t("pptxViewer.savedToast"));
      setOriginalBody(body);
      setEditing(false);
      onSaved?.(body);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="h-4 w-4 text-primary" />
            {file ? humanLabelForFile(file, t) : ""}
          </DialogTitle>
          <DialogDescription className="text-[11px] font-mono truncate">
            {file?.name}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto text-sm pr-1">
          {!body ? (
            <p className="text-muted-foreground text-xs">{t("contents.previewNoBody")}</p>
          ) : editing ? (
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="font-mono text-xs min-h-[400px] h-full"
            />
          ) : (
            <MarkdownViewer>{body}</MarkdownViewer>
          )}
        </div>
        <DialogFooter className="flex flex-wrap gap-2">
          {!editing ? (
            <Button size="sm" onClick={() => setEditing(true)} disabled={!body}>
              <Pencil className="h-3.5 w-3.5 mr-1" />
              {t("pptxViewer.edit")}
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBody(originalBody);
                  setEditing(false);
                }}
                disabled={saving}
                className="mr-auto"
              >
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
                {saving ? (
                  <Spinner size="sm" className="mr-1" />
                ) : (
                  <Save className="h-3.5 w-3.5 mr-1" />
                )}
                {t("pptxViewer.saveChanges")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
