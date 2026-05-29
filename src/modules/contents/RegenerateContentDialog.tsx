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
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";

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
  // Gate IA: regenerar consume cuota Gemini igual que crear. Pedimos
  // confirmación si el modo global es async sin override.
  const aiGate = useAiAuthorizationGate();
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
    // Regeneración de contenido con IA — NO tiene worker async. Pasamos
    // `allowQueue: false` para que el dialog del gate solo ofrezca
    // "Activar IA inmediata" o "Cancelar".
    const decision = await aiGate.ensureAuthorized({ allowQueue: false });
    if (decision === "cancel") return;
    if (decision === "proceed-async") {
      toast.error(
        "La generación con IA no soporta modo cola. Activá un código de IA inmediata para continuar.",
      );
      return;
    }
    setSaving(true);
    try {
      // Para regen COMPLETA: persistimos topic + instructions en la
      // fila — son el tema/contexto del curso entero y la edge function
      // los relee al armar el prompt. También reseteamos status/error.
      //
      // Para regen POR CLASE: NO tocamos `topic` ni `instructions` de
      // la fila. El topic editado es solo de ESTA clase y se pasa al
      // edge function como `class_topic` en el body. Así el tema general
      // del curso queda intacto y future regen de OTRAS clases sigue
      // usando el contexto correcto.
      if (target.mode === "full") {
        const { error } = await db
          .from("generated_contents")
          .update({
            topic: topic.trim(),
            instructions: instructions.trim() ? instructions.trim() : null,
            status: "queued",
            error: null,
          })
          .eq("id", target.contentId);
        if (error) throw new Error(error.message);
      }

      // 2) Disparar la edge function.
      if (target.mode === "full") {
        // Fire-and-forget: la regeneración tarda minutos y el usuario
        // monitorea el estado (queued → processing → done/failed) vía
        // polling de la lista. Pero si el invoke falla de entrada
        // (red caída, edge no desplegada, etc.) sin este .catch el
        // error queda silenciado y la fila se queda en queued para
        // siempre. Toastear para que el docente sepa que debe
        // reintentar.
        void supabase.functions
          .invoke("generate-contents", { body: { id: target.contentId } })
          .then(async ({ error: invErr, data: invData }) => {
            if (invErr || (invData as { error?: string })?.error) {
              const detail = await extractEdgeError(invErr, invData);
              toast.error(friendlyError(invErr ?? new Error(detail || "Falló la regeneración")));
            }
          });
        toast.success(t("contents.regeneratedToast"));
      } else {
        toast.info(t("contents.regeneratingClass", { class: target.classNumber }));
        // Esperamos esta sí porque el caller espera feedback inmediato.
        void supabase.functions
          .invoke("generate-contents", {
            body: {
              id: target.contentId,
              target_class: target.classNumber,
              // Tema específico de esta clase. El edge function lo usa
              // como contexto puntual sin pisar el `topic` del curso.
              class_topic: topic.trim(),
              // Instrucciones puntuales para esta clase, si las hubo.
              // Pueden estar vacías — el edge usará las de la fila.
              class_instructions: instructions.trim() ? instructions.trim() : null,
            },
          })
          .then(({ data, error: invErr }) => {
            if (invErr) {
              toast.error(friendlyError(invErr));
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
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
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
                {target.mode === "class"
                  ? t("contents.classTopic", { defaultValue: "Tema de esta clase" })
                  : t("contents.topic")}
                <HelpHint>
                  {target.mode === "class"
                    ? t("contents.classTopicHint", {
                        defaultValue:
                          "Tema específico de esta clase (no del curso completo). El curso conserva su tema general; solo se regenera esta clase con el nuevo enfoque.",
                      })
                    : t("contents.topicHint")}
                </HelpHint>
              </Label>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={
                  target.mode === "class"
                    ? t("contents.classTopicPlaceholder", {
                        defaultValue: "Ej. Operadores y expresiones aritméticas",
                      })
                    : t("contents.topicPlaceholder")
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                {target.mode === "class"
                  ? t("contents.classInstructions", {
                      defaultValue: "Instrucciones puntuales (opcional)",
                    })
                  : t("contents.instructions")}
                <HelpHint>
                  {target.mode === "class"
                    ? t("contents.classInstructionsHint", {
                        defaultValue:
                          "Notas adicionales solo para esta clase. Si lo dejas vacío, se usan las instrucciones generales del curso.",
                      })
                    : t("contents.instructionsHint")}
                </HelpHint>
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
      <aiGate.GateDialog />
    </>
  );
}
