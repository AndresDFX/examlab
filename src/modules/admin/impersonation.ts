/**
 * Impersonación: Admin → cualquier no-Admin, o Docente → estudiantes
 * matriculados en uno de sus cursos. La autorización vive en el edge
 * function `admin-impersonate` (a pesar del nombre legacy, soporta
 * ambos roles); el cliente solo cambia la sesión y guarda backup.
 *
 * Flow:
 *   1. Caller pulsa "Iniciar como X" / "Ver como X" (grid de usuarios
 *      Admin, o gradebook del Docente).
 *   2. `startImpersonate(userId)` llama al edge function `admin-impersonate`
 *      que devuelve `hashed_token` (magic link OTP) — el edge revalida
 *      el overlap de cursos si el caller es Docente.
 *   3. Antes de cambiar la sesión, guardamos las tokens del caller en
 *      localStorage bajo `IMPERSONATION_BACKUP_KEY` para poder restaurar.
 *   4. `verifyOtp({ token_hash, type: 'email' })` reemplaza la sesión
 *      activa por la del target. Forzamos un `window.location` para
 *      que TODO el estado (queries, hooks) se re-inicialice limpio.
 *   5. `stopImpersonate()` lee el backup, llama `auth.setSession` con
 *      las tokens originales y vuelve a recargar.
 *
 * Banner global (`ImpersonationBanner`) detecta la presencia del backup
 * en localStorage y se renderiza pegado al top mientras dura la sesión
 * impersonada. Visible en todas las rutas autenticadas vía AppLayout.
 *
 * Limitación: la access_token tiene TTL de 1h. Si la impersonación dura
 * más de 1h, `setSession` la refresca usando la refresh_token (también
 * persistida). Si refresh_token expira (default 1 semana), el restore
 * falla y caemos a logout — el caller debe loguearse manualmente.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { extractEdgeError } from "@/shared/lib/edge-error";

export const IMPERSONATION_BACKUP_KEY = "examlab_admin_impersonation_backup";

interface ImpersonationBackup {
  /** Sesión del caller original (Admin o Docente). Nombre legacy
   *  `admin_session` se mantiene para no romper backups existentes
   *  en localStorage de sesiones impersonadas en curso. */
  admin_session: {
    access_token: string;
    refresh_token: string;
  };
  target: {
    id: string;
    full_name: string | null;
    email: string;
    /** Tenant del target. Lo guardamos en el backup para que
     *  `stopImpersonate` pueda navegar correctamente de vuelta sin
     *  asumir el tenant del caller original (caso: SuperAdmin con
     *  override viendo otro tenant). */
    tenant_slug?: string | null;
  };
  started_at: string;
}

function readBackup(): ImpersonationBackup | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(IMPERSONATION_BACKUP_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ImpersonationBackup;
  } catch {
    return null;
  }
}

/**
 * Hook reactivo para detectar + controlar la impersonación.
 *
 * `isImpersonating` se actualiza al montar y cuando algún componente
 * dispara un `storage` event (cross-tab) o un custom event interno
 * (`examlab:impersonation-changed`) tras start/stop.
 */
export function useImpersonation() {
  const [backup, setBackup] = useState<ImpersonationBackup | null>(() => readBackup());

  useEffect(() => {
    const refresh = () => setBackup(readBackup());
    window.addEventListener("storage", refresh);
    window.addEventListener("examlab:impersonation-changed", refresh as EventListener);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("examlab:impersonation-changed", refresh as EventListener);
    };
  }, []);

  return {
    isImpersonating: backup !== null,
    target: backup?.target ?? null,
    startedAt: backup?.started_at ?? null,
  };
}

/**
 * Inicia la impersonación. Llamar desde un handler async; reciba el
 * userId del target. NO falla silencioso — propaga el Error para que
 * el caller pueda hacer toast.
 */
export async function startImpersonate(userId: string): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const current = sessionData.session;
  if (!current) throw new Error("Sin sesión activa");

  const { data, error } = await supabase.functions.invoke("admin-impersonate", {
    body: { userId },
  });
  if (error || data?.error) {
    const detail = await extractEdgeError(error, data);
    throw new Error(detail || "No se pudo iniciar la impersonación");
  }

  const hashedToken = (data as { hashed_token?: string })?.hashed_token;
  const target = (data as { target?: ImpersonationBackup["target"] })?.target;
  if (!hashedToken || !target) {
    throw new Error("Respuesta inválida del servidor");
  }

  // Guardar backup ANTES de cambiar de sesión. Si verifyOtp falla
  // dejamos esto plantado y `stopImpersonate` lo limpia.
  const backup: ImpersonationBackup = {
    admin_session: {
      access_token: current.access_token,
      refresh_token: current.refresh_token,
    },
    target,
    started_at: new Date().toISOString(),
  };
  localStorage.setItem(IMPERSONATION_BACKUP_KEY, JSON.stringify(backup));

  const { error: otpErr } = await supabase.auth.verifyOtp({
    token_hash: hashedToken,
    type: "email",
  });
  if (otpErr) {
    localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
    throw new Error(otpErr.message);
  }

  // Defensa-en-profundidad antes del hard reload: confirmar que la
  // nueva sesión QUEDÓ persistida en storage y es legible. Hubo un
  // caso de "infinite reload" donde el verifyOtp respondía ok pero la
  // siguiente page-load no veía la sesión (race entre IndexedDB
  // commit y el `window.location.href`). Si getSession devuelve null
  // o un user distinto al target, abortamos para que el caller pueda
  // mostrar el error en vez de dejarnos en estado roto.
  const { data: sessCheck } = await supabase.auth.getSession();
  if (!sessCheck.session || sessCheck.session.user.id !== target.id) {
    localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
    throw new Error("La sesión impersonada no se persistió correctamente. Volvé a intentar.");
  }

  window.dispatchEvent(new Event("examlab:impersonation-changed"));
  // Recarga dura al URL CORRECTO del target. Antes navegábamos a `/app`
  // y dejábamos que `TenantUrlGuard` redirigiera a `/t/<slug>/app` en
  // un segundo hard reload — eso causaba reload loops cuando el target
  // tenía tenant pero la primera carga ejecutaba múltiples efectos en
  // paralelo. Acá navegamos DIRECTO al URL final → el router boota una
  // sola vez con el basepath correcto y el guard no necesita redirect.
  const targetSlug = target.tenant_slug ?? null;
  window.location.href = targetSlug ? `/t/${targetSlug}/app` : "/app";
}

/**
 * Termina la impersonación y restaura la sesión del admin original.
 * Idempotente: si no hay backup, no hace nada.
 */
export async function stopImpersonate(): Promise<void> {
  const backup = readBackup();
  if (!backup) return;

  try {
    const { error } = await supabase.auth.setSession({
      access_token: backup.admin_session.access_token,
      refresh_token: backup.admin_session.refresh_token,
    });
    if (error) {
      // Las tokens del admin expiraron (default jwt_expiry=1h pero
      // refresh_token sobrevive). Si refresh también falló, no podemos
      // restaurar — limpiamos y forzamos al admin a re-loguearse.
      localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
      // scope:'local' para no invalidar refresh tokens del Admin en otros
      // dispositivos. El backup falló SOLO en este browser; las sesiones
      // del Admin en su PC personal/celular deben seguir vivas.
      await supabase.auth.signOut({ scope: "local" });
      window.location.href = "/auth";
      return;
    }

    // Log del stop. Usa el cliente ya restaurado al admin — el RPC
    // captura `auth.uid()` que ya es el admin original.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).rpc("log_audit_event", {
        p_action: "admin.impersonation.stop",
        p_category: "user",
        p_severity: "info",
        p_entity_type: "user",
        p_entity_id: backup.target.id,
        p_entity_name: backup.target.full_name ?? backup.target.email,
        p_course_id: null,
        p_course_name: null,
        p_metadata: {
          target_email: backup.target.email,
          duration_seconds: Math.floor((Date.now() - new Date(backup.started_at).getTime()) / 1000),
        },
      });
    } catch {
      /* best-effort */
    }

    localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
    window.dispatchEvent(new Event("examlab:impersonation-changed"));
    // Navega a `/app` sin prefijo — el `TenantUrlGuard` decide:
    //   - Si el caller restaurado es SuperAdmin → cross-tenant OK.
    //   - Si es Admin/Docente → redirige a su propio /t/<slug>/app.
    // Es una sola hop de redirect (no loop) porque la sesión restaurada
    // es la original del caller, no la impersonada.
    window.location.href = "/app";
  } catch {
    localStorage.removeItem(IMPERSONATION_BACKUP_KEY);
    window.location.href = "/app";
  }
}
