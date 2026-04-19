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

  // Countdown timer
  useEffect(() => {
    if (isPaused) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    intervalRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        // Guard: don't tick or fire onTimeUp until we've been initialized with real data
        if (!initializedRef.current || s <= 0) return s;
        const next = s - 1;
        if (next === 0) onTimeUp?.();
        return next;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPaused, onTimeUp]);

  // Load existing timer controls on mount
  useEffect(() => {
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
    const channel = supabase
      .channel(`timer-${examId}-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "exam_timer_controls",
          filter: `exam_id=eq.${examId}`,
        },
        (payload) => {
          const ctrl = payload.new as TimerControl;

          // Only process if it targets this user or is global
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
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [examId, userId, onPause, onResume, onTimeAdded]);

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
