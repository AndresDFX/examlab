/**
 * usePollRealtime — suscripción a cambios en una encuesta concreta.
 *
 * Cuando el docente lanza un "show of hands" en clase, ambas partes
 * (docente y alumnos) necesitan ver los votos al instante. Este hook
 * abre UN canal Supabase Realtime filtrado por `poll_id` y dispara
 * `onChange` cada vez que llegan:
 *   - UPDATE en `poll_options` (cambia `responses_count`)
 *   - INSERT/DELETE en `poll_responses` (nuevo voto / cambio de voto)
 *   - UPDATE en `polls` (docente cerró/reabrió manualmente)
 *
 * El caller decide qué hacer en `onChange` — típicamente un refetch
 * acotado (la entrada/salida es chica, no vale la pena diffear evento
 * por evento). El callback se llama con debounce de 200ms para
 * coalescer ráfagas (ej. 30 alumnos votando a la vez en una clase).
 *
 * La publicación + REPLICA IDENTITY se configuran en la migración
 * 20260721000000_polls_realtime.sql.
 */
import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Suscribe a cambios de la encuesta `pollId`. Si `pollId` es null o
 * `enabled` es false, no monta nada. La cleanup llama a `removeChannel`.
 */
export function usePollRealtime(
  pollId: string | null | undefined,
  onChange: () => void,
  enabled: boolean = true,
): void {
  // Stable ref al callback para no re-suscribir cada render si el
  // caller no memoiza la función.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!enabled || !pollId) return;

    // Debounce: en una clase con 30 alumnos votando casi simultáneo
    // recibimos 30+ eventos; refetchear 30 veces es desperdicio. 200ms
    // es imperceptible para "tiempo real" desde el punto de vista del
    // docente y agrupa todos los votos de un mismo "round".
    let pending: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        onChangeRef.current();
      }, 200);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channel = (supabase as any)
      .channel(`poll-${pollId}`)
      // poll_options: cambios al contador denormalizado.
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "poll_options",
          filter: `poll_id=eq.${pollId}`,
        },
        trigger,
      )
      // poll_responses: nuevos votos o votos cambiados (clear → vote).
      // No discriminamos INSERT vs DELETE — cualquier cambio en la
      // tabla amerita refetch.
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "poll_responses",
          filter: `poll_id=eq.${pollId}`,
        },
        trigger,
      )
      // polls: el docente cerró/reabrió manualmente.
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "polls",
          filter: `id=eq.${pollId}`,
        },
        trigger,
      )
      .subscribe();

    return () => {
      if (pending) clearTimeout(pending);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (supabase as any).removeChannel(channel);
    };
  }, [pollId, enabled]);
}
