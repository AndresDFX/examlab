import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * ¿La institución activó «Pendientes para la próxima sesión»?
 * (`app_settings.session_pending_enabled`, Configuración → General.)
 *
 * `false` mientras carga y si no se puede leer: la función es opcional y
 * APAGADA por defecto, así que ante la duda no se dibuja nada — ni el campo del
 * check-in ni la tarjeta del tablero. Mostrarla un instante y esconderla sería
 * peor que esperar el dato.
 *
 * Mismo patrón de lectura que `useMaxOpenAnswerChars`: la RLS de `app_settings`
 * devuelve la fila de la institución del usuario.
 */
export function usePendientesHabilitados(): boolean {
  // Constante determinista en el initializer (regla de hidratación #418).
  const [habilitado, setHabilitado] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await (
          supabase as unknown as {
            from: (t: string) => {
              select: (c: string) => {
                limit: (n: number) => {
                  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
                };
              };
            };
          }
        )
          .from("app_settings")
          .select("session_pending_enabled")
          .limit(1)
          .maybeSingle();
        if (cancelled || error) return;
        setHabilitado(
          (data as { session_pending_enabled?: boolean | null } | null)?.session_pending_enabled ===
            true,
        );
      } catch {
        // Sin la migración la columna no existe: queda apagada.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return habilitado;
}
