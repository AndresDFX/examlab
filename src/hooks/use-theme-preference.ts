import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";

/**
 * Persiste la preferencia de tema del usuario en su perfil (DB) para que lo
 * siga entre dispositivos. Fire-and-forget: el cambio local (localStorage +
 * clase .dark) ya lo aplicó `setTheme`; esto solo replica a la DB. Si falla
 * (offline, sesión vencida) el peor caso es que el otro equipo no herede la
 * elección — no bloquea ni molesta al usuario.
 *
 * Usa el RPC SECURITY DEFINER `set_theme_preference` (mig 20261100000000) que
 * escribe solo la fila del caller, sin depender de la RLS de UPDATE de
 * `profiles` (acotada a Admin).
 */
export function persistThemePreference(theme: "light" | "dark") {
  // `as any`: el RPC recién se agrega en la mig 20261100000000 y aún no está
  // en types.ts (lo regenera Lovable en Publish). Mismo patrón que ai-grading.ts.
  void (supabase as any)
    .rpc("set_theme_preference", { _theme: theme })
    .then(
      () => {},
      () => {},
    );
}

/**
 * Aplica la preferencia guardada en el perfil UNA vez por sesión de usuario,
 * cuando el perfil termina de cargar. La DB es la fuente de verdad al entrar:
 * si el usuario eligió "oscuro" en otro equipo, al loguearse acá se aplica
 * aunque el localStorage local esté vacío (default claro). Después de aplicar,
 * las alternancias del usuario mandan (localStorage + persistThemePreference);
 * el guard por id evita que un refresh del perfil vuelva a pisar la elección
 * en curso.
 *
 * NULL en el perfil = el usuario nunca guardó preferencia → no forzamos nada,
 * queda el default claro (o lo que ya haya en localStorage de ese equipo).
 */
export function useProfileThemeSync() {
  const { profile } = useAuth();
  const { setTheme } = useTheme();
  const appliedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!profile?.id) {
      appliedForRef.current = null;
      return;
    }
    if (appliedForRef.current === profile.id) return;
    appliedForRef.current = profile.id;
    const pref = profile.theme_preference;
    if (pref === "light" || pref === "dark") setTheme(pref);
  }, [profile?.id, profile?.theme_preference, setTheme]);
}
