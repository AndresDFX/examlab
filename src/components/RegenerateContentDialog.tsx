/**
 * RegenerateContentDialog — antes "Regenerar" sobreescribía el row con
 * el mismo `topic` + `instructions` que tenía guardados. Si el docente
 * quería ajustar algo (un detalle del tema, una instrucción nueva)
 * tenía que borrar el contenido y crearlo desde cero. Este dialog
 * cierra ese gap: edita `topic` + `instructions` IN-LINE antes de
 * relanzar la generación.
 *
 * Soporta dos modos:
 *   - mode="full": regenera el contenido completo (intro + todas las
 *     clases). Persiste topic/instructions en la fila + status=queued
 *     y dispara generate-contents.
 *   - mode="class": regenera SOLO la clase `classNumber`. Igual persiste
 *     topic/instructions porque la edge function los relee desde la
 *     fila al armar el prompt; el resto del contenido se mantiene
 *     (merge en la edge function).
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
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
import { RefreshCw, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";

// generated_contents aún no figura en types.ts auto-generados.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export interface RegenerateTarget {
  contentId: string;
  topic: string;
  instructions: string | null;
  /** "full" → regenera todo; "class" → solo classNumber. */
  mode: "full" | "class";
  classNumber?: number;
}

interface RegenerateContentDialogProps {
  target: RegenerateTarget | null;
  onClose: () => void;
  /** Notifica al padre que la regen arrancó; útil para que recargue el
   *  grid y muestre el status queued/processing. */
  onStarted: () => void;
}

export function RegenerateContentDialog({
  target,
  onClose,
  onStarted,
}: RegenerateContentDialogProps) {
  const { t } = useTranslation();
  const [topic, setTopic] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-hidrata desde el target cada vez que abre — útil para que el
  // docente edite la versión actual y no una stale.
  useEffect(() => {
    if (target) {
      setTopic(target.topic ?? "");
      setInstructions(target.instructions ?? "");
    } else {
      setTopic("");
      setInstructions("");
    }
  }, [target]);

  if (!target) return null;

  const handleSubmit = async () => {
    if (!topic.trim()) {
      toast.error(t("contents.errorTopicRequired"));
      return;
    }
    setSaving(true);
    try {
      // 1) Persistir topic + instructions en la fila. Cuando la edge
      //    function arranca, relee estos campos para armar el prompt.
      const update: Record<string, unknown> = {
        topic: topic.trim(),
        instructions: instructions.trim() ? instructions.trim() : null,
      };
      // Para regen completa también reseteamos status + error. Para
      // regen por clase NO tocamos status — la edge function maneja
      // el rollback a 'done' si algo falla parcialmente.
      if (target.mode === "full") {
        update.status = "queued";
        update.error = null;
      }
      const { error } = await db
        .from("generated_contents")
        .update(update)
        .eq("id", target.contentId);
      if (error) throw new Error(error.message);

      // 2) Disparar la edge function.
      if (target.mode === "full") {
        void supabase.functions.invoke("generate-contents", {
          body: { id: target.contentId },
        });
        toast.success(t("contents.regeneratedToast"));
      } else {
        toast.info(t("contents.regeneratingClass", { class: target.classNumber }));
        // Esperamos esta sí porque el caller espera feedback inmediato.
        void supabase.functions
          .invoke("generate-contents", {
            body: { id: target.contentId, target_class: target.classNumber },
          })
          .then(({ data, error: invErr }) => {
            if (invErr) {
              toast.error(invErr.message);
              return;
            }
            if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) {
              const msg = (data as { error?: string }).error ?? "Falló la regeneración";
              toast.error(msg);
            } else {
              toast.success(t("contents.regeneratedClassToast", { class: target.classNumber }));
            }
          });
      }

      onStarted();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={target != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {target.mode === "full" ? (
              <RefreshCw className="h-5 w-5 text-primary" />
            ) : (
              <Wand2 className="h-5 w-5 text-primary" />
            )}
            {target.mode === "full"
              ? t("contents.regenerateDialogFullTitle")
              : t("contents.regenerateDialogClassTitle", { class: target.classNumber })}
          </DialogTitle>
          <DialogDescription>
            {target.mode === "full"
              ? t("contents.regenerateDialogFullSubtitle")
              : t("contents.regenerateDialogClassSubtitle")}
          </DialogDescription>
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
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={saving || !topic.trim()}>
            {saving ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1" />
            )}
            {target.mode === "full"
              ? t("contents.regenerateDialogSubmitFull")
              : t("contents.regenerateDialogSubmitClass")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
