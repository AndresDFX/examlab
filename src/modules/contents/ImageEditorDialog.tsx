/**
 * ImageEditorDialog — editor de imágenes raster sobre <canvas> para el módulo
 * de Contenidos. Permite marcar/anotar y transformar una imagen y GUARDAR LA
 * NUEVA VERSIÓN (upsert al MISMO path del Storage, igual semántica que el
 * editor de .md/.pptx: la última versión gana).
 *
 * Herramientas: lápiz a mano alzada (color + grosor), rotar 90° izq/der,
 * voltear horizontal/vertical, deshacer (snapshots), restablecer (recarga el
 * original). Sin dependencias nuevas — canvas nativo.
 *
 * Soporta png/jpg/webp/bmp/avif (raster). SVG/GIF NO llegan acá (el caller
 * filtra con isEditableImageFile) — editarlos sobre canvas perdería el
 * vector / la animación.
 */
import { useEffect, useRef, useState, useCallback } from "react";
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
import {
  RotateCcw,
  RotateCw,
  FlipHorizontal,
  FlipVertical,
  Undo2,
  RefreshCw,
  Save,
  Pencil,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { friendlyError } from "@/shared/lib/db-errors";
import { canvasExportMimeForName, mediaMimeForName } from "@/modules/contents/media-files";
import { cn } from "@/shared/lib/utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;
const BUCKET = "generated-contents";
const MAX_DIM = 2400; // cota de seguridad para no manejar canvases gigantes
const MAX_UNDO = 15;

const PEN_COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#111827", "#ffffff"];

export interface EditableImageFile {
  path: string;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

interface Snapshot {
  url: string;
  w: number;
  h: number;
}

interface Props {
  file: EditableImageFile | null;
  contentId: string | null;
  onClose: () => void;
  /** Notifica al caller tras guardar (para refrescar / cerrar el visor). */
  onSaved?: () => void;
}

export function ImageEditorDialog({ file, contentId, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const undoRef = useRef<Snapshot[]>([]);
  const drawingRef = useRef(false);
  const lastPtRef = useRef<{ x: number; y: number } | null>(null);
  const strokeStartedRef = useRef(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [color, setColor] = useState(PEN_COLORS[0]);
  const [penSize, setPenSize] = useState(4);
  const [dirty, setDirty] = useState(false);
  const [canUndo, setCanUndo] = useState(false);

  const open = file != null;

  /** Dibuja un HTMLImageElement en el canvas, ajustando dimensiones (con cota). */
  const drawImageToCanvas = useCallback((img: HTMLImageElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    const scale = Math.min(1, MAX_DIM / Math.max(w, h));
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
  }, []);

  const loadOriginal = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    undoRef.current = [];
    setCanUndo(false);
    setDirty(false);
    const { data, error: dlErr } = await supabase.storage.from(BUCKET).download(file.path);
    if (dlErr || !data) {
      setError(friendlyError(dlErr, t("imageEditor.loadError")));
      setLoading(false);
      return;
    }
    const objUrl = URL.createObjectURL(new Blob([data], { type: mediaMimeForName(file.name) }));
    const img = new Image();
    img.onload = () => {
      drawImageToCanvas(img);
      URL.revokeObjectURL(objUrl);
      setLoading(false);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objUrl);
      setError(t("imageEditor.decodeError"));
      setLoading(false);
    };
    img.src = objUrl;
  }, [file, drawImageToCanvas, t]);

  useEffect(() => {
    if (file) void loadOriginal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  /** Captura el estado actual ANTES de una mutación (para deshacer). */
  const pushUndo = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const snap: Snapshot = { url: canvas.toDataURL(), w: canvas.width, h: canvas.height };
    undoRef.current.push(snap);
    if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
    setCanUndo(true);
    setDirty(true);
  };

  const undo = () => {
    const canvas = canvasRef.current;
    const snap = undoRef.current.pop();
    if (!canvas || !snap) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = snap.w;
      canvas.height = snap.h;
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, snap.w, snap.h);
      ctx?.drawImage(img, 0, 0);
      setCanUndo(undoRef.current.length > 0);
      setDirty(undoRef.current.length > 0);
    };
    img.src = snap.url;
  };

  /** Reaplica una transformación geométrica creando un canvas temporal. */
  const transform = (kind: "rot-left" | "rot-right" | "flip-h" | "flip-v") => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    pushUndo();
    const sw = canvas.width;
    const sh = canvas.height;
    const tmp = document.createElement("canvas");
    const rotated = kind === "rot-left" || kind === "rot-right";
    tmp.width = rotated ? sh : sw;
    tmp.height = rotated ? sw : sh;
    const tctx = tmp.getContext("2d");
    if (!tctx) return;
    tctx.save();
    if (kind === "rot-right") {
      tctx.translate(tmp.width, 0);
      tctx.rotate(Math.PI / 2);
    } else if (kind === "rot-left") {
      tctx.translate(0, tmp.height);
      tctx.rotate(-Math.PI / 2);
    } else if (kind === "flip-h") {
      tctx.translate(tmp.width, 0);
      tctx.scale(-1, 1);
    } else if (kind === "flip-v") {
      tctx.translate(0, tmp.height);
      tctx.scale(1, -1);
    }
    tctx.drawImage(canvas, 0, 0);
    tctx.restore();
    canvas.width = tmp.width;
    canvas.height = tmp.height;
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    ctx?.drawImage(tmp, 0, 0);
  };

  // ── Lápiz a mano alzada ──
  const toCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    return { x, y };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pushUndo();
    strokeStartedRef.current = true;
    drawingRef.current = true;
    lastPtRef.current = toCanvasCoords(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const pt = toCanvasCoords(e);
    const last = lastPtRef.current ?? pt;
    ctx.strokeStyle = color;
    ctx.lineWidth = penSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    lastPtRef.current = pt;
  };

  const onPointerUp = () => {
    drawingRef.current = false;
    lastPtRef.current = null;
    strokeStartedRef.current = false;
  };

  const handleSave = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !file || !contentId) return;
    setSaving(true);
    try {
      const mime = canvasExportMimeForName(file.name);
      const blob: Blob | null = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b), mime, mime === "image/jpeg" ? 0.92 : undefined),
      );
      if (!blob) throw new Error(t("imageEditor.exportError"));

      // 1) Storage: upsert en el MISMO path → nueva versión.
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(file.path, blob, { upsert: true, contentType: mediaMimeForName(file.name) });
      if (upErr) throw new Error(upErr.message);

      // 2) Re-escribir files[] para tocar updated_at (sin cambiar el entry).
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

      toast.success(t("imageEditor.saved"));
      setDirty(false);
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-5xl max-h-[94dvh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <Pencil className="h-4 w-4 text-violet-500" />
            {t("imageEditor.title")}
          </DialogTitle>
          <DialogDescription className="text-[11px] font-mono truncate">
            {file?.name}
          </DialogDescription>
        </DialogHeader>

        {/* Barra de herramientas */}
        <div className="flex flex-wrap items-center gap-2 border-b pb-2">
          <div className="flex items-center gap-1">
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={cn(
                  "h-8 w-8 rounded-full border-2 transition-transform",
                  color === c ? "border-foreground scale-110" : "border-transparent",
                )}
                style={{ backgroundColor: c }}
                aria-label={t("imageEditor.colorAria", { color: c })}
                title={t("imageEditor.colorAria", { color: c })}
              />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">{t("imageEditor.thickness")}</span>
            <input
              type="range"
              min={1}
              max={24}
              value={penSize}
              onChange={(e) => setPenSize(Number(e.target.value))}
              className="w-24 accent-violet-500"
              aria-label={t("imageEditor.penThickness")}
            />
            <span className="text-[11px] tabular-nums w-6">{penSize}</span>
          </div>
          <div className="flex items-center gap-1 ml-auto">
            <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => transform("rot-left")} title={t("imageEditor.rotateLeft")} aria-label={t("imageEditor.rotateLeft")}>
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => transform("rot-right")} title={t("imageEditor.rotateRight")} aria-label={t("imageEditor.rotateRight")}>
              <RotateCw className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => transform("flip-h")} title={t("imageEditor.flipH")} aria-label={t("imageEditor.flipH")}>
              <FlipHorizontal className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => transform("flip-v")} title={t("imageEditor.flipV")} aria-label={t("imageEditor.flipV")}>
              <FlipVertical className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="outline" className="h-8 w-8" onClick={undo} disabled={!canUndo} title={t("imageEditor.undo")} aria-label={t("imageEditor.undo")}>
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => void loadOriginal()} disabled={loading} title={t("imageEditor.reset")} aria-label={t("imageEditor.reset")}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Lienzo */}
        <div className="flex-1 min-h-[40dvh] overflow-auto rounded-md border bg-checkerboard flex items-center justify-center p-2">
          {loading ? (
            <Spinner size="md" />
          ) : error ? (
            <p className="text-sm text-destructive p-4 text-center">{error}</p>
          ) : (
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              className="max-w-full h-auto touch-none cursor-crosshair shadow-sm"
            />
          )}
        </div>

        <DialogFooter className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving} className="mr-auto">
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || loading || !dirty}>
            {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            {t("imageEditor.saveVersion")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
