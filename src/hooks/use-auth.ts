import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User, Session } from "@supabase/supabase-js";

export type AppRole = "Admin" | "Docente" | "Estudiante";

export interface Profile {
  id: string;
  full_name: string;
  personal_email: string | null;
  institutional_email: string;
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
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, sess) => {
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

    // THEN check existing session
    supabase.auth.getSession().then(({ data: { session: sess } }) => {
      setSession(sess);
      setUser(sess?.user ?? null);
      if (sess?.user) loadExtras(sess.user.id).finally(() => setLoading(false));
      else setLoading(false);
    });

    return () => sub.subscription.unsubscribe();
  }, [loadExtras]);

  const signOut = async () => {
    await supabase.auth.signOut();
    // Defensa en profundidad: limpiar caches del cliente antes del
    // full reload, por si en el futuro alguien refactoriza a SPA nav.
    try {
      const { queryClient } = await import("@/router");
      queryClient.clear();
    } catch {
      // queryClient no disponible — el reload limpia igual.
    }
    window.location.href = "/auth";
  };

  const refreshRoles = async () => {
    if (user) await loadExtras(user.id);
  };

  return { user, session, profile, roles, loading, signOut, refreshRoles };
}
