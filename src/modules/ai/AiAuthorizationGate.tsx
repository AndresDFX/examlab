/**
 * AiAuthorizationGate — gate UX para las acciones IA del docente.
 *
 * Problema:
 *   El helper `aiGradeOrEnqueue` decide sync vs async silenciosamente:
 *   si el modo global es `async` y el docente no tiene override, encola
 *   sin avisar. El docente clickea "Calificar con IA" y no entiende por
 *   qué la nota no aparece (puede tardar hasta 1h).
 *
 * Solución:
 *   Hook + dialog que ANTES de cualquier acción IA del docente:
 *     1. Si user es Admin → bypass (admins ven la cola, gestionan códigos
 *        y suelen estar en modo async por diseño).
 *     2. Si modo global = 'sync' → bypass (no aplica el problema).
 *     3. Si hay override activo CON cupo restante → bypass.
 *     4. Si modo='async' y no hay override (o cap agotado) → muestra
 *        dialog con 3 opciones:
 *          - "Activar IA inmediata" → abre AiOverrideDialog, después
 *            re-checa el estado. Si activó, decision='proceed-sync'.
 *          - "Continuar en cola" → decision='proceed-async'.
 *          - "Cancelar" → decision='cancel', el caller hace return.
 *
 * Diseño:
 *   El hook expone:
 *     - `ensureAuthorized()` async: la promesa resuelve con la decisión.
 *     - `GateDialog`: componente JSX que el caller debe montar UNA VEZ
 *       en el árbol. Sin él, `ensureAuthorized()` queda colgada.
 *
 * Uso típico:
 *   const { ensureAuthorized, GateDialog } = useAiAuthorizationGate();
 *
 *   const onClickGrade = async () => {
 *     const decision = await ensureAuthorized();
 *     if (decision === "cancel") return;
 *     await aiGradeOrEnqueue({ ... });
 *   };
 *
 *   return <>... <GateDialog /></>;
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Zap, Clock, X, KeyRound } from "lucide-react";
import { useActiveRole } from "@/hooks/use-active-role";
import { readOverrideExpiry, getProcessingMode, resolveAiGateDecision } from "@/modules/ai/ai-grading";
import { AiOverrideDialog } from "@/modules/ai/AiOverrideDialog";
import { useTranslation } from "react-i18next";

export type GateDecision = "proceed-sync" | "proceed-async" | "cancel";

/**
 * Opciones por llamada de `ensureAuthorized`. Por default todo se asume
 * "soporta cola" (las calificaciones tienen worker async). Para acciones
 * que NO tienen worker — ej. generación de preguntas con IA — se pasa
 * `allowQueue: false`:
 *   1. El dialog NO muestra el botón "Continuar en cola".
 *   2. Si el modo global es async y el docente no tiene override, las
 *      únicas salidas son "Activar IA inmediata" o "Cancelar".
 *   3. Defensivamente el caller también debería tratar el caso
 *      `proceed-async` como un no-op, pero con `allowQueue: false` el
 *      dialog nunca devuelve esa decisión.
 */
export interface GateOptions {
  allowQueue?: boolean;
}

interface OverrideStatus {
  active: boolean;
  remaining: number | null;
  cap: number | null;
}

/** Lee el estado server-authoritative del override. Si retorna null o
 *  cap agotado, el caller debe tratar como "sin override válido". */
async function fetchOverrideStatus(): Promise<OverrideStatus | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).rpc("current_ai_override_status");
    return (data as OverrideStatus | null) ?? null;
  } catch {
    return null;
  }
}

/** True si el override tiene cupo restante (o cap=null = ilimitado). */
function hasOverrideBudget(status: OverrideStatus | null): boolean {
  if (!status || !status.active) return false;
  if (status.cap == null) return true; // sin tope
  return (status.remaining ?? 0) > 0;
}

interface PendingResolver {
  resolve: (d: GateDecision) => void;
}

export function useAiAuthorizationGate() {
  const { t } = useTranslation();
  const activeRole = useActiveRole();
  // Admin Y SuperAdmin bypassean el gate. Ambos roles gestionan los
  // códigos de IA inmediata + ven la cola, así que pedirles confirmación
  // cada vez sería ruido. El SuperAdmin actuando cross-tenant entra acá
  // (activeRole='SuperAdmin'); el SuperAdmin con override de tenant
  // (activeRole='Admin') también pasa por la primera rama.
  const isAdmin = activeRole === "Admin" || activeRole === "SuperAdmin";

  const [open, setOpen] = useState(false);
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const pendingRef = useRef<PendingResolver | null>(null);
  // `allowQueue` por-llamada: condiciona el dialog para esconder el
  // botón "Continuar en cola" cuando la acción no tiene un worker async.
  // Default `true` por compat (calificación de entregas SÍ tiene cola).
  const [allowQueue, setAllowQueue] = useState(true);

  // Cierre del AiOverrideDialog → re-checa override y resuelve el gate
  // según el nuevo estado. Si el docente activó un código válido,
  // proceed-sync; si no, dejamos el gate dialog abierto para que elija
  // otra cosa (encolar o cancelar).
  const onOverrideDialogChange = useCallback(async (next: boolean) => {
    setOverrideDialogOpen(next);
    if (next) return; // recién abrió, nada que hacer
    if (!pendingRef.current) return;
    const exp = readOverrideExpiry();
    if (!exp) return; // no activó nada → gate dialog sigue abierto
    const status = await fetchOverrideStatus();
    if (hasOverrideBudget(status)) {
      const resolver = pendingRef.current;
      pendingRef.current = null;
      setOpen(false);
      resolver.resolve("proceed-sync");
    }
    // Si activó pero ya viene sin cupo (edge case), dejar el gate
    // dialog abierto para que cancele o encole.
  }, []);

  const handleActivate = useCallback(() => {
    setOverrideDialogOpen(true);
  }, []);

  const handleProceedAsync = useCallback(() => {
    if (!pendingRef.current) return;
    const resolver = pendingRef.current;
    pendingRef.current = null;
    setOpen(false);
    resolver.resolve("proceed-async");
  }, []);

  const handleCancel = useCallback(() => {
    if (!pendingRef.current) return;
    const resolver = pendingRef.current;
    pendingRef.current = null;
    setOpen(false);
    resolver.resolve("cancel");
  }, []);

  // Si el dialog se cierra por escape o click fuera, equivale a cancelar.
  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) handleCancel();
    },
    [handleCancel],
  );

  // Limpieza: si el componente se desmonta con una promesa pendiente,
  // resolvemos como 'cancel' para no dejar al caller colgado para siempre.
  useEffect(() => {
    return () => {
      if (pendingRef.current) {
        pendingRef.current.resolve("cancel");
        pendingRef.current = null;
      }
    };
  }, []);

  const ensureAuthorized = useCallback(
    async (options?: GateOptions): Promise<GateDecision> => {
      // Flag por-llamada que el dialog usa para condicionar el botón
      // "Continuar en cola". Default true (compat con calificación).
      const allowQueue = options?.allowQueue !== false;
      setAllowQueue(allowQueue);

      // Decisión pura (testeable). INVARIANTE: en modo batch (`async`) SIEMPRE
      // se respeta la cola — nadie corre inline salvo modo global `sync` o un
      // código "IA inmediata" vigente. El override local es la fuente de "el
      // docente activó un código"; el cap real lo enforza
      // `claim_ai_override_message` server-side en `aiGradeOrEnqueue`.
      //
      // Admin/SuperAdmin: NO ven el dialog (sería ruido), pero en batch SÍ
      // encolan (`proceed-async`) en vez de correr inline — antes devolvían
      // `proceed-sync` y se saltaban la cola aunque el modo fuera batch.
      const outcome = resolveAiGateDecision({
        isAdmin,
        mode: await getProcessingMode(),
        hasOverride: !!readOverrideExpiry(),
        allowQueue,
      });
      if (outcome !== "dialog") return outcome;

      // async + sin override (y no-admin, o admin sin cola) → pedir confirmación.
      return new Promise<GateDecision>((resolve) => {
        pendingRef.current = { resolve };
        setOpen(true);
      });
    },
    [isAdmin],
  );

  const GateDialog = useCallback(() => {
    return (
      <>
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-500" />
                {t("aiQueue.gateTitle")}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {allowQueue ? t("aiQueue.gateDescQueue") : t("aiQueue.gateDescNoQueue")}
              </DialogDescription>
            </DialogHeader>

            <div className="text-xs text-muted-foreground space-y-1.5 px-1">
              <div className="flex items-start gap-2">
                <KeyRound className="h-3.5 w-3.5 text-amber-500 mt-0.5 shrink-0" />
                <span>{t("aiQueue.gateHintActivate")}</span>
              </div>
              {allowQueue && (
                <div className="flex items-start gap-2">
                  <Clock className="h-3.5 w-3.5 text-sky-500 mt-0.5 shrink-0" />
                  <span>{t("aiQueue.gateHintQueue")}</span>
                </div>
              )}
            </div>

            <DialogFooter className="static gap-2 flex-col sm:flex-row">
              <Button variant="ghost" size="sm" onClick={handleCancel} className="sm:mr-auto">
                <X className="h-3.5 w-3.5 mr-1" />
                {t("aiQueue.gateCancel")}
              </Button>
              {allowQueue && (
                <Button variant="outline" size="sm" onClick={handleProceedAsync}>
                  <Clock className="h-3.5 w-3.5 mr-1" />
                  {t("aiQueue.gateProceedAsync")}
                </Button>
              )}
              <Button size="sm" onClick={handleActivate}>
                <Zap className="h-3.5 w-3.5 mr-1" />
                {t("aiQueue.gateActivate")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <AiOverrideDialog open={overrideDialogOpen} onOpenChange={onOverrideDialogChange} />
      </>
    );
  }, [
    t,
    open,
    overrideDialogOpen,
    onOpenChange,
    onOverrideDialogChange,
    handleActivate,
    handleProceedAsync,
    handleCancel,
    allowQueue,
  ]);

  return { ensureAuthorized, GateDialog };
}
