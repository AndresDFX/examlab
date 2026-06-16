/**
 * useKahootGame — suscribe a los cambios realtime de un juego Kahoot y
 * re-pide el snapshot completo vía el RPC `kahoot_get_state`. Lo usan
 * tanto el host (docente) como el jugador (estudiante): el RPC ya devuelve
 * la vista apropiada por rol (oculta is_correct hasta el reveal a los
 * jugadores).
 *
 * Patrón espejo de `use-poll-realtime.ts`: un solo canal con varios
 * postgres_changes + debounce para coalescer ráfagas (ej. 30 alumnos
 * respondiendo a la vez).
 *
 * RESILIENCIA A CAÍDAS DE RED (objetivo del módulo): Supabase Realtime NO
 * re-emite los eventos perdidos cuando el socket se reconecta tras una caída
 * de internet. Sin re-sincronizar, un jugador que pierde la conexión queda
 * CONGELADO en la pregunta que tenía y no "salta" a la pregunta actual hasta
 * que el host vuelve a tocar la DB. Para que al volver la conexión el jugador
 * aterrice SIEMPRE en la pregunta actual, re-pedimos el snapshot:
 *   • al (re)suscribir el canal (status SUBSCRIBED — incluye reconexión),
 *   • cuando el navegador avisa `online` o la pestaña vuelve a ser visible,
 *   • y con un poll de respaldo cada pocos segundos (por si el realtime quedó
 *     "colgado" sin emitir ni reconectar).
 * Además, un `reload()` fallido (ej. el poll mientras NO hay internet) NO
 * descarta el último estado bueno: la pantalla se mantiene y converge a la
 * pregunta actual en cuanto la red regresa.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { KahootState } from "./kahoot";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// Cada cuánto re-sincronizamos como respaldo si el realtime no emite (ms).
// Suficientemente corto para que reconectar "salte" a la pregunta actual en
// pocos segundos; suficientemente largo para no martillar el RPC.
const RESYNC_POLL_MS = 5000;

export function useKahootGame(gameId: string | null) {
  const [state, setState] = useState<KahootState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  // Si ya cargamos el estado al menos una vez, un fallo transitorio (red caída)
  // NO debe romper la pantalla — conservamos el último snapshot bueno.
  const loadedOnceRef = useRef(false);

  const reload = useCallback(async () => {
    if (!gameId) return;
    const { data, error: rpcErr } = await db.rpc("kahoot_get_state", { _game_id: gameId });
    if (cancelledRef.current) return;
    if (rpcErr) {
      // Solo mostramos error si NUNCA logramos cargar. Si ya teníamos estado
      // (caída de red transitoria), lo conservamos y reintentamos luego.
      if (!loadedOnceRef.current) setError(rpcErr.message ?? "error");
      setLoading(false);
      return;
    }
    loadedOnceRef.current = true;
    setState(data as KahootState);
    setError(null);
    setLoading(false);
  }, [gameId]);

  useEffect(() => {
    cancelledRef.current = false;
    loadedOnceRef.current = false;
    if (!gameId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void reload();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), 150);
    };

    const channel = supabase
      .channel(`kahoot-game-${gameId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "kahoot_games", filter: `id=eq.${gameId}` }, trigger)
      .on("postgres_changes", { event: "*", schema: "public", table: "kahoot_players", filter: `game_id=eq.${gameId}` }, trigger)
      .on("postgres_changes", { event: "*", schema: "public", table: "kahoot_answers", filter: `game_id=eq.${gameId}` }, trigger)
      .subscribe((status) => {
        // Al (re)suscribir — incluida la reconexión automática tras una caída
        // de red — pedimos snapshot fresco para saltar a la pregunta actual.
        if (status === "SUBSCRIBED") void reload();
      });

    // Re-sincronizar cuando vuelve la red o la pestaña recupera el foco —
    // cubre los casos donde el socket realtime fue cerrado (móvil en segundo
    // plano, wifi caído) y el jugador regresa al juego.
    const resyncIfVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    const resync = () => void reload();
    document.addEventListener("visibilitychange", resyncIfVisible);
    window.addEventListener("online", resync);
    window.addEventListener("focus", resync);

    // Poll de respaldo: aunque el realtime quede colgado, converge a la
    // pregunta en vivo en pocos segundos. Es un solo RPC liviano.
    const poll = setInterval(() => void reload(), RESYNC_POLL_MS);

    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", resyncIfVisible);
      window.removeEventListener("online", resync);
      window.removeEventListener("focus", resync);
      supabase.removeChannel(channel);
    };
  }, [gameId, reload]);

  return { state, loading, error, reload };
}
