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
    let timer: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void reload(), 600);
    };
    const channel = supabase
      .channel(`kahoot-course-lb-${courseId ?? "none"}`)
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
