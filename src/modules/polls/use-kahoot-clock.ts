/**
 * useKahootClock — mide UNA vez (al entrar al juego) el desfase entre el reloj
 * del dispositivo y el del servidor (`kahoot_server_now`), para que los
 * cronómetros del reto se anclen a la hora del servidor y NO al reloj local.
 *
 * WHY: `secondsLeft`/`getReadySecondsLeft` calculan el tiempo restante con
 * `Date.now()` del cliente contra `question_started_at` (server). Un dispositivo
 * con el reloj adelantado ve el countdown casi vencido → grilla deshabilitada al
 * instante + auto-envío en blanco que deja al alumno BLOQUEADO para esa pregunta
 * (incidente real FESNA jul-2026, ~12 s de adelanto). El desfase de un reloj es
 * constante durante una partida, así que medirlo una vez alcanza.
 *
 * Devuelve `{ offsetMs, ready }`. `ready` habilita el auto-envío en blanco solo
 * cuando ya conocemos el offset (o el RPC resolvió): así nunca se auto-envía por
 * un cronómetro sin corregir en los primeros ms. Si el RPC falla, `ready` pasa a
 * true con `offsetMs=0` (comportamiento previo, sin bloquear la participación).
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { estimateClockOffsetMs } from "./kahoot";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export function useKahootClock(): { offsetMs: number; ready: boolean } {
  const [offsetMs, setOffsetMs] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const t0 = Date.now();
      try {
        const { data, error } = await db.rpc("kahoot_server_now");
        const t1 = Date.now();
        if (cancelled) return;
        if (!error && data) {
          setOffsetMs(estimateClockOffsetMs(String(data), t0, t1));
        }
      } catch {
        /* red caída / throw inesperado → offset 0 (comportamiento previo) */
      } finally {
        // ready SIEMPRE (RPC ok, {error}, o throw): no bloquear la participación
        // en blanco por un hipo de red. Peor caso: offset 0 = como antes del fix.
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { offsetMs, ready };
}
