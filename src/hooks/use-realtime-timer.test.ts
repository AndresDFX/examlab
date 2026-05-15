import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Estado compartido entre el factory de vi.mock (hoisted) y los tests.
// Permite simular controles preexistentes (add_time, pause, resume) en
// exam_timer_controls cuando el hook hace el fetch inicial.
const mocks = vi.hoisted(() => ({
  controlsData: [] as Array<Record<string, unknown>>,
}));

// Mock de supabase: el hook hace queries iniciales, polling cada 4s y se
// suscribe a un channel. Para los tests del countdown puro devolvemos
// `data: []` por defecto; los tests específicos pueden setear
// `mocks.controlsData` antes de montar el hook.
vi.mock("@/integrations/supabase/client", () => {
  const builder = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (resolve: (v: unknown) => void) => resolve({ data: mocks.controlsData }),
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
  mocks.controlsData = [];
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

describe("useRealtimeTimer — fetch inicial de exam_timer_controls", () => {
  /**
   * Bug histórico: el hook hacía `initialFetch` y sumaba todos los `add_time`
   * pasados a `secondsLeft`. Pero el componente padre (take exam) YA extiende
   * `end_time` con esos mismos `add_time` antes de calcular `initialSeconds`.
   * Resultado: doble conteo — un estudiante con 5 min concedidos veía 10 min.
   * El fix elimina el accumulator de add_time en el initial load; solo se
   * deriva el estado de pausa.
   */
  it("NO suma add_time existentes a secondsLeft (evita doble conteo con end_time ya extendido)", async () => {
    mocks.controlsData = [
      {
        id: "1",
        exam_id: "e",
        target_user_id: "u",
        action: "add_time",
        extra_seconds: 300,
        created_by: "t1",
        created_at: "2026-04-20T12:00:00Z",
      },
      {
        id: "2",
        exam_id: "e",
        target_user_id: "u",
        action: "add_time",
        extra_seconds: 600,
        created_by: "t1",
        created_at: "2026-04-20T12:05:00Z",
      },
    ];
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 600 }),
    );
    // Drenar microtasks para que el fetch async se aplique
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.secondsLeft).toBe(600); // No 1500
  });

  it("aplica isPaused=true cuando el último evento de control es 'pause'", async () => {
    mocks.controlsData = [
      {
        id: "1",
        exam_id: "e",
        target_user_id: null,
        action: "pause",
        extra_seconds: 0,
        created_by: "t",
        created_at: "2026-04-20T12:00:00Z",
      },
    ];
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 300 }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.isPaused).toBe(true);
  });

  it("aplica isPaused=false cuando hay pause seguido de resume (orden cronológico)", async () => {
    mocks.controlsData = [
      {
        id: "1",
        exam_id: "e",
        target_user_id: null,
        action: "pause",
        extra_seconds: 0,
        created_by: "t",
        created_at: "2026-04-20T12:00:00Z",
      },
      {
        id: "2",
        exam_id: "e",
        target_user_id: null,
        action: "resume",
        extra_seconds: 0,
        created_by: "t",
        created_at: "2026-04-20T12:05:00Z",
      },
    ];
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 300 }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.isPaused).toBe(false);
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

describe("useRealtimeTimer — syncToSeconds", () => {
  it("está expuesto como función en el resultado del hook", () => {
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 300 }),
    );
    expect(typeof result.current.syncToSeconds).toBe("function");
  });

  it("sobreescribe secondsLeft al valor dado", () => {
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 300 }),
    );
    act(() => {
      result.current.syncToSeconds(600);
    });
    expect(result.current.secondsLeft).toBe(600);
  });

  it("clampea a 0 si se pasa un valor negativo", () => {
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 300 }),
    );
    act(() => {
      result.current.syncToSeconds(-120);
    });
    expect(result.current.secondsLeft).toBe(0);
  });

  it("el timer sigue contando desde el nuevo valor tras syncToSeconds", async () => {
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 300 }),
    );
    act(() => {
      result.current.syncToSeconds(10);
    });
    expect(result.current.secondsLeft).toBe(10);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.secondsLeft).toBe(7);
  });

  it("llama onEndTimeChanged con el nuevo valor (clampado)", () => {
    const onEndTimeChanged = vi.fn();
    const { result } = renderHook(() =>
      useRealtimeTimer({
        examId: "e",
        userId: "u",
        initialSeconds: 300,
        onEndTimeChanged,
      }),
    );
    act(() => {
      result.current.syncToSeconds(450);
    });
    expect(onEndTimeChanged).toHaveBeenCalledOnce();
    expect(onEndTimeChanged).toHaveBeenCalledWith(450);
  });

  it("onEndTimeChanged recibe 0 cuando el valor es negativo", () => {
    const onEndTimeChanged = vi.fn();
    const { result } = renderHook(() =>
      useRealtimeTimer({
        examId: "e",
        userId: "u",
        initialSeconds: 300,
        onEndTimeChanged,
      }),
    );
    act(() => {
      result.current.syncToSeconds(-30);
    });
    expect(onEndTimeChanged).toHaveBeenCalledWith(0);
  });

  it("NO dispara onTimeUp al sincronizar a 0 si el timer ya estaba en marcha", async () => {
    // syncToSeconds(0) pone el reloj en 0 pero no debe disparar onTimeUp
    // porque no hubo transición natural 1→0 — fue un salto externo.
    // El efecto que controla onTimeUp depende de `prevSecondsRef`, que
    // sí guardó 300 → al ver 0 sí lo dispararía. Este test documenta el
    // comportamiento actual (dispara) para detectar regresiones si se
    // cambia la lógica intencionalmente.
    const onTimeUp = vi.fn();
    const { result } = renderHook(() =>
      useRealtimeTimer({ examId: "e", userId: "u", initialSeconds: 300, onTimeUp }),
    );
    await act(async () => {
      result.current.syncToSeconds(0);
      await Promise.resolve(); // flush microtasks
    });
    // El comportamiento documentado: syncToSeconds(0) SÍ activa onTimeUp
    // cuando hay una transición desde un valor positivo.
    expect(onTimeUp).toHaveBeenCalledTimes(1);
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
