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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { KahootState } from "./kahoot";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export function useKahootGame(gameId: string | null) {
  const [state, setState] = useState<KahootState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const reload = useCallback(async () => {
    if (!gameId) return;
    const { data, error: rpcErr } = await db.rpc("kahoot_get_state", { _game_id: gameId });
    if (cancelledRef.current) return;
    if (rpcErr) {
      setError(rpcErr.message ?? "error");
      setLoading(false);
      return;
    }
    setState(data as KahootState);
    setError(null);
    setLoading(false);
  }, [gameId]);

  useEffect(() => {
    cancelledRef.current = false;
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
      .subscribe();

    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [gameId, reload]);

  return { state, loading, error, reload };
}
