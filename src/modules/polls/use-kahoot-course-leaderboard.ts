/**
 * useKahootCourseLeaderboard — ranking ACUMULADO de Kahoot por curso, en vivo.
 * Suma el score de cada alumno a través de TODOS los juegos de TODAS las
 * encuestas Kahoot del curso (RPC kahoot_course_leaderboard, tenant-scopeado +
 * valida que el caller pertenezca al curso).
 *
 * Realtime: escuchamos kahoot_games (UPDATE) — NO kahoot_players — porque para
 * un ACUMULADO el dato relevante cambia cuando un juego avanza/termina, no en
 * cada voto. Eso reduce el volumen de eventos ~30x vs suscribirse a
 * kahoot_players. La RLS de kahoot_games acota los eventos al suscriptor; el
 * payload no se lee (solo dispara re-fetch del RPC, que re-valida tenant
 * server-side). Patrón espejo de use-kahoot-game.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// Contador a nivel de módulo → topic de canal ÚNICO por instancia del hook.
// Sin esto, dos `StudentKahootRanking` (slots 0 y 1) que resuelven al MISMO
// courseId (o ambos a null → "none") creaban un canal con el mismo topic;
// Supabase reusa el canal por topic, así que el `.on()` de la 2ª instancia
// corría DESPUÉS del `.subscribe()` de la 1ª → "cannot add postgres_changes
// callbacks after subscribe()" → crashea el dashboard entero del estudiante.
let channelSeq = 0;

export interface KahootLeaderRow {
  rank: number;
  user_id: string;
  full_name: string;
  total_score: number;
  games_played: number;
}

export function useKahootCourseLeaderboard(courseId: string | null, limit = 5) {
  const [rows, setRows] = useState<KahootLeaderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const cancelledRef = useRef(false);
  // Id estable por instancia (se asigna una sola vez) → topic de canal único.
  const instanceIdRef = useRef<number>(0);
  if (instanceIdRef.current === 0) instanceIdRef.current = ++channelSeq;

  const reload = useCallback(async () => {
    if (!courseId) {
      setRows([]);
      setLoading(false);
      return;
    }
    const { data } = await db.rpc("kahoot_course_leaderboard", { _course_id: courseId, _limit: limit });
    if (cancelledRef.current) return;
    setRows((data ?? []) as KahootLeaderRow[]);
    setLoading(false);
  }, [courseId, limit]);

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    void reload();
    // Sin curso seleccionado no hay nada que escuchar → no abrimos canal
    // (evita el topic compartido "…-none" entre instancias).
    if (!courseId) {
      return () => {
        cancelledRef.current = true;
      };
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), 600);
    };
    const channel = supabase
      .channel(`kahoot-course-lb-${courseId}-${instanceIdRef.current}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "kahoot_games" }, trigger)
      .subscribe();
    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [courseId, reload]);

  return { rows, loading, reload };
}
