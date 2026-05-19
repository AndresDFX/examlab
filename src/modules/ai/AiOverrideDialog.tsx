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
      toast.error("Ingresa el código de override");
      return;
    }
    setSubmitting(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("activate_ai_override", { _code: c });
    setSubmitting(false);
    if (error) {
      toast.error(error.message);
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
        invalid_code: "Código inválido.",
        expired: "El código expiró.",
        exhausted: "El código ya no tiene usos disponibles.",
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
      `IA inmediata activa por ${res.window_minutes} min${capDescr} — tus próximas calificaciones IA corren al instante.`,
    );
  };

  const deactivate = () => {
    clearOverrideExpiry();
    setActiveExpiry(null);
    toast.info("Ventana de IA inmediata cerrada. Las nuevas calificaciones vuelven a la cola.");
  };

  const minutesLeft = activeExpiry
    ? Math.max(0, Math.round((activeExpiry.getTime() - Date.now()) / 60000))
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-500" />
            IA inmediata
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {activeExpiry ? (
            <div className="rounded-md border border-amber-300/60 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Check className="h-4 w-4 text-amber-700 dark:text-amber-300" />
                <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
                  Ventana activa
                </span>
                <Badge variant="outline" className="text-[10px] ml-auto">
                  {minutesLeft} min restantes
                </Badge>
                {status?.cap != null && (
                  <Badge variant="outline" className="text-[10px]">
                    {status.remaining ?? 0}/{status.cap} mensajes
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Tus llamadas IA corren sincrónicas hasta{" "}
                <strong>{formatDateTime(activeExpiry)}</strong>
                {status?.cap != null ? (
                  <>
                    {" "}
                    o hasta consumir <strong>{status.cap}</strong> mensajes (lo que ocurra
                    primero)
                  </>
                ) : null}
                . Después, vuelve al modo en cola (cada hora).
              </p>
              <Button size="sm" variant="outline" onClick={deactivate}>
                <Clock className="h-3.5 w-3.5 mr-1" />
                Cerrar ventana ahora
              </Button>
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Si necesitas calificar con IA <strong>ya</strong> en vez de esperar al worker
                hourly, pega el código que te dio el administrador. La ventana sincrónica dura los
                minutos que el admin haya configurado al generarlo.
              </p>
              <div>
                <Label>Código</Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Ej. ABCDEF12"
                  className="font-mono uppercase tracking-widest"
                  maxLength={32}
                  autoFocus
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
          {!activeExpiry && (
            <Button onClick={() => void activate()} disabled={submitting}>
              {submitting ? <Spinner size="sm" className="mr-1" /> : null}
              Activar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
