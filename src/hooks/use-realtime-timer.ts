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
}

export function useRealtimeTimer({
  examId,
  userId,
  initialSeconds,
  onTimeUp,
  onPause,
  onResume,
  onTimeAdded,
}: UseRealtimeTimerOptions) {
  const [secondsLeft, setSecondsLeft] = useState(initialSeconds);
  const [isPaused, setIsPaused] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const secondsRef = useRef(initialSeconds);
  const initializedRef = useRef(initialSeconds > 0);
  const prevSecondsRef = useRef<number | null>(null);
  const timeUpFiredRef = useRef(false);

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

      if (!data?.length) return;

      let paused = false;
      let extraTime = 0;

      for (const ctrl of data as TimerControl[]) {
        if (ctrl.action === "pause") paused = true;
        if (ctrl.action === "resume") paused = false;
        if (ctrl.action === "add_time") extraTime += ctrl.extra_seconds;
      }

      setIsPaused(paused);
      if (extraTime > 0) {
        setSecondsLeft((s) => s + extraTime);
      }
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
              onPause?.();
              break;
            case "resume":
              setIsPaused(false);
              onResume?.();
              break;
            case "add_time":
              setSecondsLeft((s) => s + ctrl.extra_seconds);
              onTimeAdded?.(ctrl.extra_seconds);
              break;
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [examId, userId, onPause, onResume, onTimeAdded]);

  // Polling fallback: re-fetch controls every 4 s in case Realtime doesn't fire
  const lastPollRef = useRef<string | null>(null);
  useEffect(() => {
    if (!examId || !userId) return;

    const poll = async () => {
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
      let extraTime = 0;
      for (const ctrl of all as TimerControl[]) {
        if (ctrl.action === "pause") paused = true;
        if (ctrl.action === "resume") paused = false;
        if (ctrl.action === "add_time") extraTime += ctrl.extra_seconds;
      }
      setIsPaused(paused);
    };

    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [examId, userId]);

  const formattedTime = useCallback(() => {
    const mins = Math.floor(secondsLeft / 60);
    const secs = secondsLeft % 60;
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }, [secondsLeft]);

  return {
    secondsLeft,
    isPaused,
    formattedTime: formattedTime(),
    isLowTime: secondsLeft < 60,
  };
}
