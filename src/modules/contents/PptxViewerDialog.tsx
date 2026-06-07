/**
 * PptxViewerDialog — visualizador/editor inline de presentaciones .pptx
 * generadas por IA.
 *
 * Diseño:
 *  - El "pptx" no es binario en realidad: la IA emite texto estructurado
 *    (un bloque por slide) que vive en `files[].body` (JSONB) y en el
 *    storage como `<name>.pptx.txt`. Recién cuando el docente descarga,
 *    `buildPptxBlob` lo convierte a binario con pptxgenjs.
 *  - Por eso este viewer renderiza la representación parseada (lista de
 *    `ParsedSlide`) en lugar de embeber un visor binario. Eso da TODO lo
 *    que necesita el docente: ver títulos + viñetas slide-by-slide, y
 *    ajustar texto sin tener que regenerar todo con IA.
 *
 * Tres acciones:
 *  - **Editar pequeños detalles**: switch a modo edición; cada slide
 *    expone un Input para el título y un Textarea para las viñetas
 *    (una por línea). Al guardar, serializamos slides → texto, subimos
 *    al storage (upsert) y actualizamos `files[].body` en la fila.
 *    La próxima descarga ya refleja el cambio sin re-llamar a la IA.
 *  - **Regenerar con IA**: dispara el callback `onRegenerate` que el
 *    caller mapea a la mutation existente (`regenerateClass` o regen
 *    completa) — el viewer se cierra y el polling del grid recoge el
 *    nuevo contenido.
 *  - **Descargar**: pasa el body vigente al downloader del caller, que
 *    ya sabe convertir a .pptx binario con pptxgenjs.
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Pencil,
  Save,
  Download,
  Sparkles,
  Plus,
  Trash2,
  Presentation as PresentationIcon,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import {
  parseSlideBlock,
  serializeSlides,
  stripInlineMarkdown,
  type ParsedSlide,
} from "@/modules/contents/contents-pptx";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { friendlyError } from "@/shared/lib/db-errors";

// generated_contents no está en types.ts auto-generado (ver app.teacher.contents).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface PptxFile {
  path: string;
  name: string;
  body?: string;
}

interface PptxViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Archivo pptx-source a visualizar/editar. */
  file: PptxFile | null;
  /** ID del contenido (generated_contents.id) — necesario para persistir
   *  cambios al JSONB `files[]`. */
  contentId: string | null;
  /** Si el caller pasa `onRegenerate`, mostramos el botón "Regenerar con
   *  IA". Útil cuando estamos viendo una clase de un curso_completo y
   *  queremos regenerar solo esa clase. */
  onRegenerate?: () => void;
  /** Trigger de descarga — recibe el body vigente (con o sin edits sin
   *  guardar) para que el caller convierta a .pptx con pptxgenjs. */
  onDownload?: (body: string) => void;
  /** Si processing, el botón de regenerar queda deshabilitado para evitar
   *  cola doble. */
  isProcessing?: boolean;
  /** Notificación al padre cuando los cambios se persisten — útil para
   *  que el grid refresque el `files` cache local sin re-fetch. */
  onSaved?: (newBody: string) => void;
  /** Si "edit", monta directamente en modo edición. "view" por default —
   *  el docente abre vista previa y desde ahí pulsa "Editar". El caller
   *  usa "edit" cuando el botón es explícitamente "Editar online" en el
   *  grid (skip el step de vista para no agregar fricción). */
  initialMode?: "view" | "edit";
}

export function PptxViewerDialog({
  open,
  onOpenChange,
  file,
  contentId,
  onRegenerate,
  onDownload,
  isProcessing,
  onSaved,
  initialMode = "view",
}: PptxViewerDialogProps) {
  const { t } = useTranslation();
  const [slides, setSlides] = useState<ParsedSlide[]>([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [originalBody, setOriginalBody] = useState<string>("");

  // Re-parsea cada vez que el dialog abre con un archivo distinto.
  // Mantener `originalBody` permite detectar dirty + revertir en cancel.
  useEffect(() => {
    if (open && file?.body) {
      setSlides(parseSlideBlock(file.body));
      setOriginalBody(file.body);
      setEditing(initialMode === "edit");
    } else if (!open) {
      // Reset del state al cerrar para no mostrar stale data al re-abrir.
      setSlides([]);
      setOriginalBody("");
      setEditing(false);
    }
  }, [open, file, initialMode]);

  if (!file) return null;

  // Comprueba si hay ediciones sin guardar — compara serialización
  // actual contra el original. Si difieren, "Guardar" se habilita.
  const currentBody = serializeSlides(slides);
  const dirty = currentBody !== originalBody;

  const updateSlideTitle = (idx: number, title: string) => {
    setSlides((prev) => prev.map((s, i) => (i === idx ? { ...s, title } : s)));
  };
  const updateSlideBullets = (idx: number, raw: string) => {
    // NO hacemos trim ni filtramos empties acá — eso rompe Enter (al
    // pulsar Enter en el textarea, una línea vacía se filtraba al instante
    // y el cursor regresaba al final de la línea anterior). La limpieza
    // (trim + drop vacías) ocurre en `serializeSlides` al guardar/exportar,
    // así que el body persistido sigue siendo limpio.
    const bullets = raw.split(/\r?\n/);
    setSlides((prev) => prev.map((s, i) => (i === idx ? { ...s, bullets } : s)));
  };
  const moveSlide = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= slides.length) return;
    setSlides((prev) => {
      const copy = [...prev];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
  };
  const addSlide = (afterIdx: number) => {
    setSlides((prev) => {
      const copy = [...prev];
      copy.splice(afterIdx + 1, 0, {
        title: t("pptxViewer.newSlideTitle"),
        bullets: [],
        isCover: false,
      });
      return copy;
    });
  };
  const removeSlide = (idx: number) => {
    setSlides((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCancelEdit = () => {
    // Restaura desde original sin guardar.
    setSlides(parseSlideBlock(originalBody));
    setEditing(false);
  };

  const handleSave = async () => {
    if (!file || !contentId) return;
    if (slides.length === 0) {
      toast.error(t("pptxViewer.errorEmpty"));
      return;
    }
    setSaving(true);
    try {
      const newBody = serializeSlides(slides);

      // 1) Subir al storage con upsert — sobreescribe el .pptx.txt
      // existente para que la próxima descarga lo recoja directo.
      const blob = new Blob([newBody], { type: "text/plain;charset=utf-8" });
      const { error: stErr } = await supabase.storage
        .from("generated-contents")
        .upload(file.path, blob, { upsert: true, contentType: "text/plain" });
      if (stErr) throw new Error(stErr.message);

      // 2) Actualizar el JSONB `files[]` de la fila — el viewer del
      // estudiante (que lee el body del JSONB y NO del storage) verá
      // los cambios inmediatamente.
      const { data: row, error: getErr } = await db
        .from("generated_contents")
        .select("files")
        .eq("id", contentId)
        .maybeSingle();
      if (getErr || !row) throw new Error(getErr?.message ?? "No se pudo cargar el contenido");
      const filesArr = Array.isArray(row.files) ? (row.files as Array<{ path: string }>) : [];
      const updated = filesArr.map((f) => (f.path === file.path ? { ...f, body: newBody } : f));
      const { error: updErr } = await db
        .from("generated_contents")
        .update({ files: updated })
        .eq("id", contentId);
      if (updErr) throw new Error(updErr.message);

      toast.success(t("pptxViewer.savedToast"));
      setOriginalBody(newBody);
      setEditing(false);
      onSaved?.(newBody);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <PresentationIcon className="h-5 w-5 text-primary" />
            {file.name}
            <Badge variant="outline" className="text-[10px] ml-2 tabular-nums">
              {t("pptxViewer.slideCount", { count: slides.length })}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {editing ? t("pptxViewer.editingSubtitle") : t("pptxViewer.subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-3 pr-1 pb-2">
          {slides.length === 0 ? (
            <div className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
              {t("pptxViewer.empty")}
            </div>
          ) : (
            slides.map((slide, idx) => (
              <Card
                key={idx}
                className={slide.isCover ? "border-primary/40 bg-primary/5" : undefined}
              >
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px] tabular-nums shrink-0">
                      {idx + 1}
                      {slide.isCover ? ` · ${t("pptxViewer.cover")}` : ""}
                    </Badge>
                    {editing ? (
                      <Input
                        value={slide.title}
                        onChange={(e) => updateSlideTitle(idx, e.target.value)}
                        className="h-7 text-sm flex-1"
                        placeholder={t("pptxViewer.titlePlaceholder")}
                      />
                    ) : (
                      <h3 className="text-sm font-semibold text-primary flex-1 truncate">
                        {slide.title || t("pptxViewer.untitled")}
                      </h3>
                    )}
                    {editing && (
                      <div className="flex items-center gap-0.5">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          disabled={idx === 0}
                          onClick={() => moveSlide(idx, -1)}
                          title={t("pptxViewer.moveUp")}
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          disabled={idx === slides.length - 1}
                          onClick={() => moveSlide(idx, 1)}
                          title={t("pptxViewer.moveDown")}
                        >
                          <ChevronDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => removeSlide(idx)}
                          title={t("pptxViewer.removeSlide")}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    )}
                  </div>
                  {editing ? (
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">
                        {t("pptxViewer.bulletsLabel")}
                      </Label>
                      <Textarea
                        value={slide.bullets.join("\n")}
                        onChange={(e) => updateSlideBullets(idx, e.target.value)}
                        placeholder={t("pptxViewer.bulletsPlaceholder")}
                        className="text-xs min-h-[80px] font-mono"
                      />
                    </div>
                  ) : (
                    // Preview "tipo slide" — aspect 16:9, fondo claro,
                    // título grande en accent + bullets/código abajo. Es
                    // un mockup HTML/CSS de cómo se ve la slide en el
                    // .pptx descargado, no un embed binario (los slides
                    // se generan client-side con pptxgenjs al descargar).
                    // El visor real de Office se puede abrir con el
                    // botón "Abrir en visor Office" del footer.
                    <div className="rounded-md border bg-white text-slate-900 shadow-sm aspect-video w-full overflow-hidden">
                      <div className="p-5 flex flex-col h-full">
                        {slide.isCover ? (
                          <div className="flex-1 flex flex-col items-center justify-center text-center gap-2">
                            <h2 className="text-2xl font-bold text-primary leading-tight">
                              {stripInlineMarkdown(slide.title) || t("pptxViewer.cover")}
                            </h2>
                            {slide.bullets.filter(Boolean).length > 0 && (
                              <p className="text-sm text-slate-600 max-w-md">
                                {slide.bullets.map(stripInlineMarkdown).filter(Boolean).join(" · ")}
                              </p>
                            )}
                          </div>
                        ) : (
                          <>
                            <h3 className="text-lg font-bold text-primary border-b border-primary/30 pb-1.5 mb-2 leading-tight">
                              {stripInlineMarkdown(slide.title) || t("pptxViewer.untitled")}
                            </h3>
                            <div className="flex-1 overflow-y-auto space-y-1.5 text-sm pr-1">
                              {slide.bullets.filter(Boolean).length > 0 && (
                                <ul className="list-disc pl-5 space-y-1">
                                  {slide.bullets
                                    .map(stripInlineMarkdown)
                                    .filter((b) => b.trim().length > 0)
                                    .map((b, bi) => (
                                      <li key={bi}>{b}</li>
                                    ))}
                                </ul>
                              )}
                              {(slide.codeBlocks ?? []).map((cb, ci) => (
                                <pre
                                  key={ci}
                                  className="rounded bg-slate-100 border border-slate-200 p-2 text-[10px] font-mono whitespace-pre overflow-x-auto text-slate-800"
                                >
                                  {cb.lang ? (
                                    <div className="text-[9px] uppercase tracking-wide text-slate-500 mb-1">
                                      {cb.lang}
                                    </div>
                                  ) : null}
                                  <code>{cb.code}</code>
                                </pre>
                              ))}
                              {slide.bullets.filter(Boolean).length === 0 &&
                                (slide.codeBlocks?.length ?? 0) === 0 && (
                                  <p className="text-xs text-slate-400 italic">
                                    {t("pptxViewer.noBullets")}
                                  </p>
                                )}
                            </div>
                          </>
                        )}
                        <div className="text-[10px] text-slate-400 text-right mt-2 tabular-nums">
                          {idx + 1} / {slides.length}
                        </div>
                      </div>
                    </div>
                  )}
                  {editing && (
                    <div className="pt-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[11px] text-muted-foreground"
                        onClick={() => addSlide(idx)}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        {t("pptxViewer.addSlideAfter")}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
          {editing && slides.length === 0 && (
            <Button size="sm" variant="outline" onClick={() => addSlide(-1)} className="w-full">
              <Plus className="h-3.5 w-3.5 mr-1" />
              {t("pptxViewer.addFirstSlide")}
            </Button>
          )}
        </div>

        <DialogFooter className="flex flex-wrap gap-2 sm:gap-2">
          {!editing ? (
            <>
              {onRegenerate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRegenerate}
                  disabled={isProcessing}
                  className="mr-auto"
                  title={t("pptxViewer.regenerateHint")}
                >
                  {isProcessing ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 mr-1" />
                  )}
                  {t("pptxViewer.regenerate")}
                </Button>
              )}
              {onDownload && (
                <Button variant="outline" size="sm" onClick={() => onDownload(currentBody)}>
                  <Download className="h-3.5 w-3.5 mr-1" />
                  {t("pptxViewer.download")}
                </Button>
              )}
              <Button size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-3.5 w-3.5 mr-1" />
                {t("pptxViewer.edit")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancelEdit}
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
