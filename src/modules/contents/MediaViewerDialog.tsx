/**
 * MediaViewerDialog — visor inline para archivos de media de Contenidos:
 *   - Imágenes (png/jpg/webp/gif/svg/…) → <img> con zoom.
 *   - PDF → <iframe> (render nativo del navegador desde un object URL).
 *
 * Antes estos archivos SOLO se podían descargar (no había preview). Este
 * visor se usa en el tablero del estudiante (solo ver) y en la gestión de
 * Contenidos del docente (ver + editar/reemplazar).
 *
 * Acciones (según `canEdit`, que solo pasa el docente/Admin dueño):
 *   - Descargar (siempre).
 *   - "Editar imagen" → delega en ImageEditorDialog (solo imágenes raster).
 *   - "Reemplazar (nueva versión)" → sube un archivo nuevo al MISMO path
 *     (upsert), preservando el nombre lógico. Es "guardar la nueva versión"
 *     con la misma semántica que el editor de .md/.pptx (última gana).
 */
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Download, Pencil, Upload, ZoomIn, ZoomOut, FileText, ImageIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  isImageFile,
  isPdfFile,
  isEditableImageFile,
  mediaMimeForName,
} from "@/modules/contents/media-files";

// generated_contents no figura en types.ts auto-generados.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const BUCKET = "generated-contents";

export interface MediaFile {
  path: string;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

interface Props {
  file: MediaFile | null;
  contentId: string | null;
  onClose: () => void;
  /** Solo el dueño (docente/Admin) edita. El estudiante lo recibe false. */
  canEdit?: boolean;
  /** Abre el editor de canvas para una imagen raster (lo monta el caller). */
  onEditImage?: (file: MediaFile) => void;
  /** Se llama tras reemplazar el archivo, para que el caller refresque. */
  onReplaced?: () => void;
}

export function MediaViewerDialog({
  file,
  contentId,
  onClose,
  canEdit = false,
  onEditImage,
  onReplaced,
}: Props) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [replacing, setReplacing] = useState(false);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);

  const open = file != null;
  const isImg = isImageFile(file?.name);
  const isPdf = isPdfFile(file?.name);
  const isEditableImg = isEditableImageFile(file?.name);

  // Descarga el blob y arma un object URL. Se revoca al cerrar / cambiar
  // de archivo para no filtrar memoria.
  useEffect(() => {
    if (!file) {
      setUrl(null);
      setError(null);
      setZoom(1);
      return;
    }
    let revoked: string | null = null;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setZoom(1);
    void (async () => {
      const { data, error: dlErr } = await supabase.storage.from(BUCKET).download(file.path);
      if (cancelled) return;
      if (dlErr || !data) {
        setError(friendlyError(dlErr, t("mediaViewer.loadError")));
        setLoading(false);
        return;
      }
      // Forzamos el MIME por extensión: algunos blobs vienen como
      // application/octet-stream y el navegador no renderiza el PDF/imagen.
      const typed = new Blob([data], { type: mediaMimeForName(file.name) });
      const obj = URL.createObjectURL(typed);
      revoked = obj;
      setUrl(obj);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [file]);

  const handleDownload = async () => {
    if (!file) return;
    const { data, error: dlErr } = await supabase.storage.from(BUCKET).download(file.path);
    if (dlErr || !data) {
      toast.error(friendlyError(dlErr, t("mediaViewer.downloadError")));
      return;
    }
    const obj = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = obj;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(obj);
  };

  const handleReplacePick = () => replaceInputRef.current?.click();

  const handleReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (replaceInputRef.current) replaceInputRef.current.value = "";
    if (!picked || !file || !contentId) return;
    // El reemplazo debe ser del MISMO tipo (PDF↔PDF, imagen↔imagen) para no
    // dejar bytes que no matchean el nombre/extensión del archivo lógico.
    const sameClass = isPdf ? isPdfFile(picked.name) : isImg ? isImageFile(picked.name) : false;
    if (!sameClass) {
      toast.error(isPdf ? t("mediaViewer.replaceMustPdf") : t("mediaViewer.replaceMustImage"));
      return;
    }
    setReplacing(true);
    try {
      // 1) Storage: upsert en el MISMO path → nueva versión (última gana).
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(file.path, picked, { upsert: true, contentType: mediaMimeForName(file.name) });
      if (upErr) throw new Error(upErr.message);

      // 2) Re-escribimos files[] (sin cambiar este entry) para tocar
      //    updated_at y dejar registro de que el contenido cambió.
      const { data: row, error: getErr } = await db
        .from("generated_contents")
        .select("files")
        .eq("id", contentId)
        .maybeSingle();
      if (getErr || !row) throw new Error(getErr?.message ?? "No se pudo cargar el contenido");
      const filesArr = Array.isArray(row.files) ? row.files : [];
      const { error: updErr } = await db
        .from("generated_contents")
        .update({ files: filesArr })
        .eq("id", contentId);
      if (updErr) throw new Error(updErr.message);

      toast.success(t("mediaViewer.replaced"));
      // Recargar el preview con los bytes nuevos.
      const { data: fresh } = await supabase.storage.from(BUCKET).download(file.path);
      if (fresh) {
        if (url) URL.revokeObjectURL(url);
        const typed = new Blob([fresh], { type: mediaMimeForName(file.name) });
        setUrl(URL.createObjectURL(typed));
      }
      onReplaced?.();
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setReplacing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl max-h-[92dvh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            {isPdf ? (
              <FileText className="h-4 w-4 text-red-500" />
            ) : (
              <ImageIcon className="h-4 w-4 text-violet-500" />
            )}
            {isPdf ? t("mediaViewer.titlePdf") : t("mediaViewer.titleImage")}
          </DialogTitle>
          <DialogDescription className="text-[11px] font-mono truncate">
            {file?.name}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-[50vh] overflow-auto rounded-md border bg-muted/30 flex items-center justify-center">
          {loading ? (
            <Spinner size="md" />
          ) : error ? (
            <p className="text-sm text-destructive p-4 text-center">{error}</p>
          ) : !url ? (
            <p className="text-xs text-muted-foreground p-4">{t("mediaViewer.noPreview")}</p>
          ) : isPdf ? (
            <iframe src={url} title={file?.name ?? "PDF"} className="w-full h-[70vh] border-0" />
          ) : (
            <img
              src={url}
              alt={file?.name ?? "imagen"}
              className="max-w-none origin-center transition-transform"
              style={{ transform: `scale(${zoom})` }}
            />
          )}
        </div>

        <DialogFooter className="flex flex-wrap items-center gap-2">
          {isImg && !!url && (
            <div className="flex items-center gap-1 mr-auto">
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)))}
                aria-label={t("mediaViewer.zoomOut")}
                title={t("mediaViewer.zoomOut")}
              >
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="text-[11px] tabular-nums w-10 text-center">
                {Math.round(zoom * 100)}%
              </span>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                onClick={() => setZoom((z) => Math.min(5, +(z + 0.25).toFixed(2)))}
                aria-label={t("mediaViewer.zoomIn")}
                title={t("mediaViewer.zoomIn")}
              >
                <ZoomIn className="h-4 w-4" />
              </Button>
            </div>
          )}

          {canEdit && isEditableImg && onEditImage && file && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onEditImage(file)}
              disabled={replacing}
            >
              <Pencil className="h-3.5 w-3.5 mr-1" />
              {t("mediaViewer.editImage")}
            </Button>
          )}

          {canEdit && (isImg || isPdf) && (
            <>
              <input
                ref={replaceInputRef}
                type="file"
                accept={isPdf ? ".pdf,application/pdf" : "image/*"}
                className="hidden"
                onChange={handleReplaceFile}
              />
              <Button size="sm" variant="outline" onClick={handleReplacePick} disabled={replacing}>
                {replacing ? (
                  <Spinner size="sm" className="mr-1" />
                ) : (
                  <Upload className="h-3.5 w-3.5 mr-1" />
                )}
                {t("mediaViewer.replace")}
              </Button>
            </>
          )}

          <Button size="sm" onClick={handleDownload} disabled={replacing}>
            <Download className="h-3.5 w-3.5 mr-1" />
            {t("mediaViewer.download")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
