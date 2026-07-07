/**
 * EditExternalContentDialog — edita la metadata de un contenido EXTERNO
 * (subido por el docente, no generado por IA) para corregir una subida
 * mal clasificada. El caso de uso principal: cambiar el modo de
 * `material_individual` a `curso_completo` (o viceversa) cuando el
 * docente eligió el modo equivocado al subir.
 *
 * Por qué SOLO para externos:
 *   En el contenido generado por IA el `mode` es ESTRUCTURAL — define
 *   cómo se generaron los archivos (curso_completo produce N archivos con
 *   sufijo `_CLASE_<N>`). Cambiar el modo ahí no re-estructura los
 *   archivos y dejaría la fila inconsistente. En el externo los archivos
 *   son uploads sueltos, así que el modo es solo metadata de presentación
 *   (cómo los agrupa el visor + qué acciones se habilitan, ej.
 *   "Materializar curso" solo aplica a curso_completo). Por eso el caller
 *   solo ofrece esta acción cuando detecta un contenido externo.
 *
 * Edita: nombre (display_name, UNIQUE por docente), tema (topic), modo y
 * número de clases (solo curso_completo). NO toca archivos — para eso
 * está el flujo de subida / regenerar. Persiste con un UPDATE directo a
 * `generated_contents` (la RLS deja al docente del curso / Admin editar
 * sus propias filas).
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
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
import { Spinner } from "@/components/ui/spinner";
import { HelpHint } from "@/components/ui/help-hint";
import { Pencil } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { logEvent } from "@/shared/lib/audit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type ContentMode = "curso_completo" | "material_individual";

/** Shape mínimo que necesita el dialog. El caller pasa el row completo de
 *  `generated_contents` (estructuralmente compatible). */
export interface EditableExternalContent {
  id: string;
  display_name: string;
  topic: string;
  mode: ContentMode;
  n_classes: number | null;
}

interface Props {
  /** Contenido a editar; `null` cierra el dialog. */
  content: EditableExternalContent | null;
  onOpenChange: (next: boolean) => void;
  /** Callback al guardar OK — el padre recarga la lista. */
  onSaved: () => void;
}

export function EditExternalContentDialog({ content, onOpenChange, onSaved }: Props) {
  const { t } = useTranslation();
  const open = content !== null;

  const [displayName, setDisplayName] = useState("");
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<ContentMode>("material_individual");
  const [nClasses, setNClasses] = useState<number>(8);
  const [saving, setSaving] = useState(false);
  // Guard "cambios sin guardar". Agrupa los campos editables; el hook captura
  // el snapshot al abrir (la hidratación corre en el effect sobre `content`).
  const formMemo = useMemo(
    () => ({ displayName, topic, mode, nClasses }),
    [displayName, topic, mode, nClasses],
  );
  const dirty = useDirtyDialog(open, formMemo);

  // Cargamos los valores actuales cada vez que se abre con un contenido
  // nuevo. Si el contenido venía como individual, partimos n_classes en
  // un default razonable (8) para cuando el docente cambie a curso_completo.
  useEffect(() => {
    if (content) {
      setDisplayName(content.display_name ?? "");
      setTopic(content.topic ?? "");
      setMode(content.mode);
      setNClasses(content.n_classes && content.n_classes >= 1 ? content.n_classes : 8);
      setSaving(false);
    }
  }, [content]);

  const canSubmit =
    !saving &&
    !!content &&
    displayName.trim().length > 0 &&
    displayName.trim().length <= 120 &&
    topic.trim().length > 0 &&
    (mode === "material_individual" || nClasses >= 1);

  const handleSave = async () => {
    if (!content || !canSubmit) return;
    setSaving(true);
    const payload = {
      display_name: displayName.trim(),
      topic: topic.trim(),
      mode,
      // En individual no hay clases que numerar → null (coherente con el
      // INSERT del upload externo). En curso_completo, el conteo elegido.
      n_classes: mode === "curso_completo" ? Math.max(1, Math.floor(nClasses)) : null,
    };
    const { error } = await db.from("generated_contents").update(payload).eq("id", content.id);
    if (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "23505") {
        toast.error(
          i18n.t("toast.modules_contents_EditExternalContentDialog.duplicateName", {
            defaultValue: 'Ya tienes un contenido llamado "{{name}}". Usa otro nombre.',
            name: displayName.trim(),
          }),
        );
      } else {
        toast.error(
          friendlyError(
            error,
            i18n.t("toast.modules_contents_EditExternalContentDialog.saveError", {
              defaultValue: "No se pudo guardar el contenido",
            }),
          ),
        );
      }
      setSaving(false);
      return;
    }
    void logEvent({
      action: "content.edited_external",
      category: "content",
      severity: "info",
      entityType: "generated_contents",
      entityId: content.id,
      entityName: displayName.trim(),
      metadata: { mode, n_classes: payload.n_classes, mode_changed: mode !== content.mode },
    });
    toast.success(
      i18n.t("toast.modules_contents_EditExternalContentDialog.saved", {
        defaultValue: "Contenido actualizado",
      }),
    );
    setSaving(false);
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={dirty.guardOpenChange((o) => {
        if (!saving) onOpenChange(o);
      })}
    >
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5 text-primary" />
            {t("contents.editExternalTitle", { defaultValue: "Editar contenido externo" })}
          </DialogTitle>
          <DialogDescription>
            {t("contents.editExternalSubtitle", {
              defaultValue:
                "Corrige la metadata de un material subido (sin tocar los archivos). Útil cuando lo clasificaste mal — por ejemplo, lo subiste como material individual y en realidad es un curso completo.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Nombre */}
          <div className="space-y-1.5">
            <Label required>
              {t("contents.contentNameLabel", { defaultValue: "Nombre del contenido" })}
              <HelpHint>
                {t("help.contentDisplayNameHint", {
                  defaultValue: "Nombre único que verás en la lista. Distinto del tema.",
                })}
              </HelpHint>
            </Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={120}
              disabled={saving}
            />
          </div>

          {/* Tema */}
          <div className="space-y-1.5">
            <Label required>
              {t("contents.topic", { defaultValue: "Tema" })}
              <HelpHint>{t("contents.topicHint")}</HelpHint>
            </Label>
            <Textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="min-h-[60px] text-sm"
              disabled={saving}
            />
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

          {/* N clases (solo curso_completo) */}
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
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel", { defaultValue: "Cancelar" })}
          </Button>
          <Button onClick={() => void handleSave()} disabled={!canSubmit}>
            {saving ? <Spinner size="sm" className="mr-2" /> : null}
            {t("common.save", { defaultValue: "Guardar" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
