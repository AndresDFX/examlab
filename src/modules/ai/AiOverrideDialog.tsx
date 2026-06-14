/**
 * AiOverrideDialog — Docente activa un código admin para abrir ventana
 * de IA sincrónica (saltea la cola async global).
 *
 * Flujo:
 *   1. Docente pega el código que recibió por canal externo.
 *   2. Llama RPC `activate_ai_override(code)`.
 *   3. Si OK, persistimos en localStorage el `expires_at`. Mientras la
 *      ventana esté abierta, el helper `aiGradeOrEnqueue` corre en sync.
 *   4. Mostramos badge con el tiempo restante.
 *
 * El dialog también permite cerrar la ventana manualmente (limpia el
 * localStorage). Si la ventana ya estaba abierta al abrir el dialog
 * se muestra el estado y la fecha de expiración.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Zap, Clock, Check } from "lucide-react";
import { toast } from "sonner";
import { readOverrideExpiry, writeOverrideExpiry, clearOverrideExpiry } from "@/modules/ai/ai-grading";
import { formatDateTime } from "@/shared/lib/format";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface OverrideStatus {
  active: boolean;
  expires_at: string | null;
  window_minutes: number | null;
  consumed: number | null;
  cap: number | null;
  remaining: number | null;
}

export function AiOverrideDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activeExpiry, setActiveExpiry] = useState<Date | null>(null);
  // Estado server-authoritative del cap de mensajes. El localStorage
  // solo tiene `expires_at`; el cap consumido vive en DB. Refrescamos
  // cuando se abre el dialog y tras activar para que el docente vea
  // cuántos mensajes le quedan en su ventana actual.
  const [status, setStatus] = useState<OverrideStatus | null>(null);

  const refreshStatus = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).rpc("current_ai_override_status");
    setStatus((data as OverrideStatus | null) ?? null);
  };

  useEffect(() => {
    if (open) {
      setActiveExpiry(readOverrideExpiry());
      void refreshStatus();
    }
  }, [open]);

  const activate = async () => {
    const c = code.trim().toUpperCase();
    if (!c) {
      toast.error(
        i18n.t("toast.modules_ai_AiOverrideDialog.enterOverrideCode", {
          defaultValue: "Ingresa el código de override",
        }),
      );
      return;
    }
    setSubmitting(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("activate_ai_override", { _code: c });
    setSubmitting(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    const res = data as
      | {
          ok: true;
          expires_at: string;
          window_minutes: number;
          max_messages_per_activation: number | null;
        }
      | { ok: false; error: string };
    if (!res.ok) {
      const map: Record<string, string> = {
        invalid_code: t("hc_modulesAiAiOverrideDialog.errorInvalidCode"),
        expired: t("hc_modulesAiAiOverrideDialog.errorExpired"),
        exhausted: t("hc_modulesAiAiOverrideDialog.errorExhausted"),
      };
      toast.error(map[res.error] ?? res.error);
      return;
    }
    writeOverrideExpiry(res.expires_at);
    setActiveExpiry(new Date(res.expires_at));
    setCode("");
    await refreshStatus();
    const capDescr = res.max_messages_per_activation
      ? ` · cupo: ${res.max_messages_per_activation} mensajes`
      : "";
    toast.success(
      i18n.t("toast.modules_ai_AiOverrideDialog.overrideActivated", {
        defaultValue:
          "IA inmediata activa por {{minutes}} min{{capDescr}} — tus próximas calificaciones IA corren al instante.",
        minutes: res.window_minutes,
        capDescr,
      }),
    );
  };

  const deactivate = () => {
    clearOverrideExpiry();
    setActiveExpiry(null);
    toast.info(
      i18n.t("toast.modules_ai_AiOverrideDialog.overrideClosed", {
        defaultValue:
          "Ventana de IA inmediata cerrada. Las nuevas calificaciones vuelven a la cola.",
      }),
    );
  };

  const minutesLeft = activeExpiry
    ? Math.max(0, Math.round((activeExpiry.getTime() - Date.now()) / 60000))
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-500" />
            {t("hc_modulesAiAiOverrideDialog.title")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {activeExpiry ? (
            <div className="rounded-md border border-amber-300/60 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Check className="h-4 w-4 text-amber-700 dark:text-amber-300" />
                <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
                  {t("hc_modulesAiAiOverrideDialog.windowActive")}
                </span>
                <Badge variant="outline" className="text-[10px] ml-auto">
                  {t("hc_modulesAiAiOverrideDialog.minutesLeft", { minutes: minutesLeft })}
                </Badge>
                {status?.cap != null && (
                  <Badge variant="outline" className="text-[10px]">
                    {t("hc_modulesAiAiOverrideDialog.messagesCount", {
                      remaining: status.remaining ?? 0,
                      cap: status.cap,
                    })}
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("hc_modulesAiAiOverrideDialog.syncUntil")}{" "}
                <strong>{formatDateTime(activeExpiry)}</strong>
                {status?.cap != null ? (
                  <>
                    {" "}
                    {t("hc_modulesAiAiOverrideDialog.orUntilConsumePrefix")}{" "}
                    <strong>{status.cap}</strong>{" "}
                    {t("hc_modulesAiAiOverrideDialog.orUntilConsumeSuffix")}
                  </>
                ) : null}
                {t("hc_modulesAiAiOverrideDialog.thenBackToQueue")}
              </p>
              <Button size="sm" variant="outline" onClick={deactivate}>
                <Clock className="h-3.5 w-3.5 mr-1" />
                {t("hc_modulesAiAiOverrideDialog.closeWindowNow")}
              </Button>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {t("hc_modulesAiAiOverrideDialog.helpPrefix")}{" "}
                <strong>{t("hc_modulesAiAiOverrideDialog.helpEmphasis")}</strong>{" "}
                {t("hc_modulesAiAiOverrideDialog.helpSuffix")}
              </p>
              <div>
                <Label>{t("hc_modulesAiAiOverrideDialog.codeLabel")}</Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={t("hc_modulesAiAiOverrideDialog.codePlaceholder")}
                  className="font-mono uppercase tracking-widest"
                  maxLength={32}
                  autoFocus
                />
              </div>
            </>
          )}
        </div>
        {/* className="static" desactiva el sticky bottom-0 del DialogFooter
         *  por defecto. En dialogs cortos como éste, el `-mb-4` negativo
         *  del sticky hace que el footer se solape visualmente con el
         *  input (especialmente en mobile con teclado abierto). Acá no
         *  hay scroll posible, así que sticky no aporta y solo molesta. */}
        <DialogFooter className="static">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("hc_modulesAiAiOverrideDialog.close")}
          </Button>
          {!activeExpiry && (
            <Button onClick={() => void activate()} disabled={submitting}>
              {submitting ? <Spinner size="sm" className="mr-1" /> : null}
              {t("hc_modulesAiAiOverrideDialog.activate")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
