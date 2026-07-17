/**
 * usePublicKahootGame — versión PÚBLICA (sin login) de `useKahootGame`.
 *
 * El jugador anónimo se identifica con un TOKEN (`playerId` = kahoot_players.id,
 * UUID que obtuvo al unirse con su correo institucional vía `kahoot_join_public`).
 * Pide el snapshot con el RPC anon `kahoot_state_public(_game_id, _player_id)`.
 *
 * A diferencia de `useKahootGame`, acá NO usamos Supabase Realtime: el rol
 * `anon` no tiene SELECT sobre las tablas kahoot (la RLS lo bloquea), así que
 * las suscripciones postgres_changes no entregarían eventos. Nos apoyamos 100%
 * en un POLL corto + re-sync al volver la red / recuperar el foco. Es un solo
 * RPC liviano; la latencia percibida (~1.5s) es aceptable para un reto en vivo.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { KahootState } from "./kahoot";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const POLL_MS = 1500;

export function usePublicKahootGame(gameId: string | null, playerId: string | null) {
  const [state, setState] = useState<KahootState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const loadedOnceRef = useRef(false);

  const reload = useCallback(async () => {
    if (!gameId || !playerId) return;
    const { data, error: rpcErr } = await db.rpc("kahoot_state_public", {
      _game_id: gameId,
      _player_id: playerId,
    });
    if (cancelledRef.current) return;
    if (rpcErr) {
      // Conservamos el último snapshot bueno ante caídas transitorias; solo
      // reportamos error si nunca cargamos (token inválido / juego terminado).
      if (!loadedOnceRef.current) setError(rpcErr.message ?? "error");
      setLoading(false);
      return;
    }
    loadedOnceRef.current = true;
    setState(data as KahootState);
    setError(null);
    setLoading(false);
  }, [gameId, playerId]);

  useEffect(() => {
    cancelledRef.current = false;
    loadedOnceRef.current = false;
    if (!gameId || !playerId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void reload();

    const resyncIfVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    const resync = () => void reload();
    document.addEventListener("visibilitychange", resyncIfVisible);
    window.addEventListener("online", resync);
    window.addEventListener("focus", resync);
    const poll = setInterval(() => void reload(), POLL_MS);

    return () => {
      cancelledRef.current = true;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", resyncIfVisible);
      window.removeEventListener("online", resync);
      window.removeEventListener("focus", resync);
    };
  }, [gameId, playerId, reload]);

  return { state, loading, error, reload };
}
