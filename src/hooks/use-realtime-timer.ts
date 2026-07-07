import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

interface TimerControl {
  id: string;
  exam_id: string;
  target_user_id: string | null;
  action: "pause" | "resume" | "add_time";
  extra_seconds: number;
  created_by: string;
  created_at: string;
}

interface UseRealtimeTimerOptions {
  examId: string;
  userId: string;
  initialSeconds: number;
  onTimeUp?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onTimeAdded?: (seconds: number) => void;
  onEndTimeChanged?: (newSeconds: number) => void;
}

export function useRealtimeTimer({
  examId,
  userId,
  initialSeconds,
  onTimeUp,
  onPause,
  onResume,
  onTimeAdded,
  onEndTimeChanged,
}: UseRealtimeTimerOptions) {
  const [secondsLeft, setSecondsLeft] = useState(initialSeconds);
  const [isPaused, setIsPaused] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const secondsRef = useRef(initialSeconds);
  const initializedRef = useRef(initialSeconds > 0);
  const prevSecondsRef = useRef<number | null>(null);
  const timeUpFiredRef = useRef(false);
  // IDs de controles add_time YA reflejados en secondsLeft (dedup por id entre
  // el load inicial, el handler Realtime y el poll de respaldo). Robusto ante
  // eventos duplicados / tardíos / fuera de orden.
  const appliedAddTimeRef = useRef<Set<string>>(new Set());
  // El poll no aplica add_time hasta que el load inicial sembró el baseline
  // (los add_time pre-existentes YA vienen en initialSeconds); evita que el poll
  // los re-sume por una carrera con el load.
  const baselineLoadedRef = useRef(false);
  // Callbacks via ref: el padre (TakeExam) los pasa INLINE y re-renderiza CADA
  // SEGUNDO por el tick del timer. Si onTimeAdded/onPause/onResume estuvieran en
  // las deps de los efectos de poll y de suscripción Realtime, esos efectos se
  // recrearían cada segundo → el poll resetearía su interval de 4s (y nunca
  // dispararía) y el canal Realtime se removería + re-suscribiría cada segundo
  // (churn + ventana en la que se pierden eventos add_time — causa raíz del tiempo
  // extra perdido). Con refs, ambos efectos dependen solo de [examId, userId].
  const onTimeAddedRef = useRef(onTimeAdded);
  const onPauseRef = useRef(onPause);
  const onResumeRef = useRef(onResume);
  useEffect(() => {
    onTimeAddedRef.current = onTimeAdded;
    onPauseRef.current = onPause;
    onResumeRef.current = onResume;
  }, [onTimeAdded, onPause, onResume]);

  // Initialize secondsLeft once initialSeconds becomes available (exam loaded after mount)
  useEffect(() => {
    if (initialSeconds > 0 && !initializedRef.current) {
      setSecondsLeft(initialSeconds);
      initializedRef.current = true;
    }
  }, [initialSeconds]);

  // Keep ref in sync
  useEffect(() => {
    secondsRef.current = secondsLeft;
  }, [secondsLeft]);

  /** No disparar onTimeUp dentro del updater de setState (React); usar transición 1→0 */
  useEffect(() => {
    if (!initializedRef.current) return;

    const prev = prevSecondsRef.current;
    prevSecondsRef.current = secondsLeft;

    if (prev !== null && prev > 0 && secondsLeft === 0 && !timeUpFiredRef.current) {
      timeUpFiredRef.current = true;
      queueMicrotask(() => onTimeUp?.());
    }
  }, [secondsLeft, onTimeUp]);

  // Countdown timer
  useEffect(() => {
    if (isPaused) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    intervalRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        // Guard: don't tick until we've been initialized with real data
        if (!initializedRef.current || s <= 0) return s;
        return s - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPaused]);

  // Load existing timer controls on mount (requiere userId válido; si no, PostgREST arma `eq.` vacío → 400)
  useEffect(() => {
    if (!examId || !userId) return;

    (async () => {
      const { data } = await supabase
        .from("exam_timer_controls")
        .select("*")
        .eq("exam_id", examId)
        .or(`target_user_id.is.null,target_user_id.eq.${userId}`)
        .order("created_at", { ascending: true });

      // Solo recuperamos el estado de pausa/resume del historial.
      // NO sumamos add_time aquí: el componente padre ya extendió end_time
      // (vía computeExtraSeconds + applyExtraTime) antes de calcular
      // initialSeconds, así que el extra ya está reflejado. Sumarlo de
      // nuevo causaría doble conteo en cada recarga (5 min concedidos →
      // 10 min recibidos por el estudiante). Marcamos sus ids como aplicados
      // para que el poll de respaldo tampoco los re-sume.
      let paused = false;
      for (const ctrl of (data ?? []) as TimerControl[]) {
        if (ctrl.action === "pause") paused = true;
        else if (ctrl.action === "resume") paused = false;
        else if (ctrl.action === "add_time") appliedAddTimeRef.current.add(ctrl.id);
      }
      setIsPaused(paused);
      // Sync: el estado pausado histórico NO es una transición nueva (no toast al
      // cargar en un examen ya pausado).
      lastPausedNotifiedRef.current = paused;
      baselineLoadedRef.current = true; // habilita el poll (baseline sembrado)
    })();
  }, [examId, userId]);

  // Subscribe to realtime changes
  useEffect(() => {
    if (!examId || !userId) return;

    const channel = supabase
      .channel(`timer-${examId}-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "exam_timer_controls",
        },
        (payload) => {
          const ctrl = payload.new as TimerControl;
          if (ctrl.exam_id !== examId) return;
          if (ctrl.target_user_id && ctrl.target_user_id !== userId) return;
          switch (ctrl.action) {
            case "pause":
              setIsPaused(true);
              onPauseRef.current?.();
              lastPausedNotifiedRef.current = true;
              break;
            case "resume":
              setIsPaused(false);
              onResumeRef.current?.();
              lastPausedNotifiedRef.current = false;
              break;
            case "add_time":
              // Dedup por id: si el poll ya lo aplicó, no re-sumar.
              if (!appliedAddTimeRef.current.has(ctrl.id)) {
                appliedAddTimeRef.current.add(ctrl.id);
                setSecondsLeft((s) => s + ctrl.extra_seconds);
                onTimeAddedRef.current?.(ctrl.extra_seconds);
              }
              break;
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // Callbacks via ref (arriba) → deps SOLO [examId, userId] para no re-suscribir
    // el canal cada segundo cuando el padre re-renderiza por el tick.
  }, [examId, userId]);

  // Polling fallback: re-fetch controls every 4 s in case Realtime doesn't fire
  const lastPollRef = useRef<string | null>(null);
  // Último estado pausa/reanuda YA notificado al alumno (vía Realtime o poll). El
  // poll emite el toast SOLO en transición contra este ref → cubre el caso de
  // Realtime-miss sin duplicar el aviso en cada control posterior.
  const lastPausedNotifiedRef = useRef(false);
  useEffect(() => {
    if (!examId || !userId) return;

    const poll = async () => {
      // Esperar a que el load inicial siembre el baseline de add_time ya
      // reflejados en initialSeconds (si no, el poll los re-sumaría).
      if (!baselineLoadedRef.current) return;
      const { data } = await supabase
        .from("exam_timer_controls")
        .select("*")
        .eq("exam_id", examId)
        .or(`target_user_id.is.null,target_user_id.eq.${userId}`)
        .order("created_at", { ascending: false })
        .limit(1);

      if (!data?.length) return;
      const latest = data[0] as TimerControl;
      if (latest.created_at === lastPollRef.current) return;
      lastPollRef.current = latest.created_at;

      // Re-compute full state from all controls
      const { data: all } = await supabase
        .from("exam_timer_controls")
        .select("*")
        .eq("exam_id", examId)
        .or(`target_user_id.is.null,target_user_id.eq.${userId}`)
        .order("created_at", { ascending: true });

      if (!all?.length) return;
      let paused = false;
      // Aplicar SOLO los add_time que Realtime no entregó (no en el set).
      // Antes este extraTime se calculaba y se DESCARTABA → si Realtime perdía
      // el evento, el alumno nunca recibía el tiempo extra concedido y el timer
      // expiraba antes → auto-entrega prematura.
      let newExtra = 0;
      for (const ctrl of all as TimerControl[]) {
        if (ctrl.action === "pause") paused = true;
        else if (ctrl.action === "resume") paused = false;
        else if (ctrl.action === "add_time" && !appliedAddTimeRef.current.has(ctrl.id)) {
          appliedAddTimeRef.current.add(ctrl.id);
          newExtra += ctrl.extra_seconds;
        }
      }
      // Notificar pausa/reanudación SOLO en transición (si Realtime perdió el evento
      // el poll lo recupera; antes congelaba el reloj sin avisar al alumno).
      if (paused !== lastPausedNotifiedRef.current) {
        lastPausedNotifiedRef.current = paused;
        if (paused) onPauseRef.current?.();
        else onResumeRef.current?.();
      }
      setIsPaused(paused);
      if (newExtra > 0) {
        setSecondsLeft((s) => s + newExtra);
        onTimeAddedRef.current?.(newExtra);
      }
    };

    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [examId, userId]);

  const formattedTime = useCallback(() => {
    const mins = Math.floor(secondsLeft / 60);
    const secs = secondsLeft % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }, [secondsLeft]);

  /** Permite sincronizar el timer con una nueva cantidad de segundos
   *  (p.ej. cuando el docente cambia end_time del examen en curso). */
  const syncToSeconds = useCallback((newSeconds: number) => {
    const clamped = Math.max(0, newSeconds);
    secondsRef.current = clamped;
    setSecondsLeft(clamped);
    onEndTimeChanged?.(clamped);
  }, [onEndTimeChanged]);

  return {
    secondsLeft,
    isPaused,
    formattedTime: formattedTime(),
    isLowTime: secondsLeft < 60,
    syncToSeconds,
  };
}
