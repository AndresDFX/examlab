import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User, Session } from "@supabase/supabase-js";
import { removePushSubscription } from "@/modules/notifications/push-subscription";

export type AppRole = "Admin" | "Docente" | "Estudiante" | "SuperAdmin";

export interface Profile {
  id: string;
  full_name: string;
  personal_email: string | null;
  institutional_email: string;
  /** Institución a la que pertenece el usuario (Multi-tenancy Fase 1).
   *  NULL solo en ventana transitoria — la Fase 6 cierra el sign-up
   *  para que toda fila tenga tenant. */
  tenant_id: string | null;
  /** Forzar cambio de contraseña en el primer login. true cuando el
   *  Admin creó/reseteó la cuenta con una contraseña temporal. El
   *  AppLayout muestra un diálogo bloqueante hasta que el usuario la
   *  cambia (que setea esto en false). Columna mig 20260710000000;
   *  opcional en el type por compat con entornos sin la migración. */
  must_change_password?: boolean;
  /** Estado académico del estudiante (activo/retirado/graduado/aplazado).
   *  Gobierna el acceso: retirado/aplazado bloquean, graduado = solo
   *  lectura (ver access-control.ts). NULL para staff o estudiantes sin
   *  estado. Columna mig 20260612000000. */
  estado?: string | null;
  /** Cuenta activa. false = desactivada por un Admin/SuperAdmin: no inicia
   *  sesión (ban GoTrue) y no consume licencia. El AppLayout muestra una
   *  pantalla bloqueante cuando es false. Columna mig 20261029000000;
   *  opcional por compat con entornos sin la migración (default true). */
  is_active?: boolean;
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [loading, setLoading] = useState(true);

  const loadExtras = useCallback(async (uid: string) => {
    const [{ data: prof }, { data: roleRows }] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", uid).maybeSingle(),
      supabase.from("user_roles").select("role").eq("user_id", uid),
    ]);
    setProfile(prof as Profile | null);
    setRoles((roleRows ?? []).map((r: any) => r.role as AppRole));
  }, []);

  useEffect(() => {
    // Auth listener FIRST
    const { data: sub } = supabase.auth.onAuthStateChange((evt, sess) => {
      // Log eventos críticos a la consola para diagnosticar pérdidas de
      // sesión inesperadas. Idealmente con telemetría real (Sentry), pero
      // por ahora la consola del browser es suficiente — el alumno puede
      // mandar screenshot.
      if (evt === "SIGNED_OUT") {
        // eslint-disable-next-line no-console
        console.warn(`[auth] ${evt} — session lost`);
      }
      setSession(sess);
      setUser(sess?.user ?? null);
      if (sess?.user) {
        // Defer to avoid deadlock
        setTimeout(() => loadExtras(sess.user.id), 0);
      } else {
        setProfile(null);
        setRoles([]);
      }
    });

    // THEN check existing session. Si getSession() o loadExtras
    // rechazan (token corrupto en storage, JWT expirado, refresh
    // fallido, query bloqueada por RLS), `setLoading(false)` NUNCA se
    // ejecutaba sin `.catch` → la app se quedaba pegada en "Cargando…"
    // indefinidamente. El usuario lo vivió como "infinite reload" tras
    // impersonar. Ahora cualquier falla resuelve loading; el efecto de
    // redirect a /auth se dispara si el user quedó null.
    supabase.auth
      .getSession()
      .then(({ data: { session: sess } }) => {
        setSession(sess);
        setUser(sess?.user ?? null);
        if (sess?.user)
          loadExtras(sess.user.id)
            .catch((e) => console.warn("[useAuth] loadExtras failed", e))
            .finally(() => setLoading(false));
        else setLoading(false);
      })
      .catch((e) => {
        console.warn("[useAuth] getSession failed", e);
        setLoading(false);
      });

    return () => sub.subscription.unsubscribe();
  }, [loadExtras]);

  const signOut = async () => {
    // Limpiar la suscripción push ANTES del signOut: el DELETE de
    // push_subscriptions es owner-only (RLS user_id = auth.uid()), así que debe
    // correr mientras auth.uid() sigue siendo el usuario que sale. Además hace
    // sub.unsubscribe() → mata el endpoint en el push service, así el próximo
    // usuario del navegador obtiene uno nuevo (aísla las notificaciones entre
    // usuarios). Best-effort: no bloquea el logout si falla.
    try {
      await removePushSubscription();
    } catch {
      // ignore
    }
    // `scope: 'local'` es CRÍTICO. Sin esto, Supabase v2 usa scope
    // 'global' por default e invalida los refresh tokens del usuario
    // en TODOS sus dispositivos. Resultado: el alumno cierra sesión en
    // su celular y al rato Chrome desktop también se queda fuera (al
    // próximo intento de refresh).
    await supabase.auth.signOut({ scope: "local" });
    // Defensa en profundidad: limpiar storages locales antes del full
    // reload, por si en el futuro alguien refactoriza a SPA nav y el
    // reload deja de pasar.
    try {
      sessionStorage.clear();
    } catch {
      // ignore
    }
    window.location.href = "/auth";
  };

  const refreshRoles = async () => {
    if (user) await loadExtras(user.id);
  };

  return { user, session, profile, roles, loading, signOut, refreshRoles };
}
