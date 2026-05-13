import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock de supabase: el hook hace queries iniciales, polling cada 4s y se
// suscribe a un channel. Para los tests del countdown puro mockeamos los
// efectos de red a "no-op" (sin errores, sin filas).
vi.mock("@/integrations/supabase/client", () => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (resolve: (v: unknown) => void) => resolve({ data: [] }),
  };
  return {
    supabase: {
      from: vi.fn(() => builder),
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnThis(),
      })),
      removeChannel: vi.fn(),
    },
  };
});

import { useRealtimeTimer } from "./use-realtime-timer";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useRealtimeTimer — inicialización", () => {
  it("retorna el initialSeconds inicial", () => {
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 600 }),
    );
    expect(result.current.secondsLeft).toBe(600);
    expect(result.current.isPaused).toBe(false);
  });

  it("formattedTime con padding 00:00", () => {
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 65 }),
    );
    expect(result.current.formattedTime).toBe("01:05");
  });

  it("formattedTime con minutos > 9", () => {
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 75 * 60 + 7 }),
    );
    expect(result.current.formattedTime).toBe("75:07");
  });

  it("inicializa después si initialSeconds llega = 0 y luego > 0", () => {
    const { result, rerender } = renderHook(
      ({ s }) => useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: s }),
      { initialProps: { s: 0 } },
    );
    expect(result.current.secondsLeft).toBe(0);
    rerender({ s: 120 });
    expect(result.current.secondsLeft).toBe(120);
  });
});

describe("useRealtimeTimer — isLowTime", () => {
  it("false cuando secondsLeft >= 60", () => {
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 60 }),
    );
    expect(result.current.isLowTime).toBe(false);
  });

  it("true cuando secondsLeft < 60", () => {
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 59 }),
    );
    expect(result.current.isLowTime).toBe(true);
  });
});

describe("useRealtimeTimer — countdown", () => {
  it("decrementa cada segundo cuando no está pausado", async () => {
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 5 }),
    );
    expect(result.current.secondsLeft).toBe(5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.secondsLeft).toBe(2);
  });

  it("no decrementa por debajo de 0", async () => {
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 2 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.secondsLeft).toBe(0);
  });

  it("invoca onTimeUp UNA vez al transicionar 1→0", async () => {
    const onTimeUp = vi.fn();
    renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 1, onTimeUp }),
    );
    expect(onTimeUp).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
      // queueMicrotask para flushear el microtask del onTimeUp
      await Promise.resolve();
    });
    expect(onTimeUp).toHaveBeenCalledTimes(1);
    // Avanzar más no debe re-disparar (timeUpFiredRef bloquea)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.resolve();
    });
    expect(onTimeUp).toHaveBeenCalledTimes(1);
  });

  it("NO invoca onTimeUp si initialSeconds es 0 desde el inicio", async () => {
    const onTimeUp = vi.fn();
    renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 0, onTimeUp }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await Promise.resolve();
    });
    // No hubo transición desde un valor positivo — no se dispara.
    expect(onTimeUp).not.toHaveBeenCalled();
  });
});
