import { describe, it, expect } from "vitest";
import {
  kahootPoints,
  secondsLeft,
  getReadySecondsLeft,
  estimateClockOffsetMs,
  KAHOOT_SHAPES,
  buildKahootJoinUrl,
} from "./kahoot";

describe("kahootPoints", () => {
  it("incorrect answer is always 0", () => {
    expect(kahootPoints({ correct: false, elapsedMs: 0, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(0);
    expect(kahootPoints({ correct: false, elapsedMs: 10000, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(0);
  });

  it("instant correct answer gets full points", () => {
    expect(kahootPoints({ correct: true, elapsedMs: 0, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(1000);
  });

  it("answering at the time limit gets half points", () => {
    expect(kahootPoints({ correct: true, elapsedMs: 20000, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(500);
  });

  it("answering at half the time gets 75% of points", () => {
    // 1 - (0.5)/2 = 0.75
    expect(kahootPoints({ correct: true, elapsedMs: 10000, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(750);
  });

  it("clamps elapsed beyond the limit to half points (never below)", () => {
    expect(kahootPoints({ correct: true, elapsedMs: 999999, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(500);
  });

  it("clamps negative elapsed to full points", () => {
    expect(kahootPoints({ correct: true, elapsedMs: -500, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(1000);
  });

  it("respects maxPoints scaling", () => {
    expect(kahootPoints({ correct: true, elapsedMs: 0, timeLimitSeconds: 20, maxPoints: 2000 })).toBe(2000);
    expect(kahootPoints({ correct: true, elapsedMs: 20000, timeLimitSeconds: 20, maxPoints: 2000 })).toBe(1000);
  });

  it("zero time limit degrades to full points (no division by zero)", () => {
    expect(kahootPoints({ correct: true, elapsedMs: 0, timeLimitSeconds: 0, maxPoints: 1000 })).toBe(1000);
  });
});

describe("secondsLeft", () => {
  const start = "2026-06-09T10:00:00.000Z";
  const startMs = new Date(start).getTime();

  it("returns null when no start time", () => {
    expect(secondsLeft(null, 20, startMs)).toBeNull();
  });

  it("returns full limit at the start", () => {
    expect(secondsLeft(start, 20, startMs)).toBe(20);
  });

  it("counts down as time passes", () => {
    expect(secondsLeft(start, 20, startMs + 5000)).toBe(15);
    expect(secondsLeft(start, 20, startMs + 19000)).toBe(1);
  });

  it("never goes below 0", () => {
    expect(secondsLeft(start, 20, startMs + 25000)).toBe(0);
  });

  it("returns null for an invalid date", () => {
    expect(secondsLeft("not-a-date", 20, startMs)).toBeNull();
  });

  it("returns the FULL limit while now < started (durante el lead de '¡Prepárate!')", () => {
    // started 3s en el futuro respecto a now → debe mostrar el límite completo.
    expect(secondsLeft(start, 20, startMs - 3000)).toBe(20);
  });
});

describe("getReadySecondsLeft", () => {
  const start = "2026-06-09T10:00:00.000Z";
  const startMs = new Date(start).getTime();

  it("returns null when no start time", () => {
    expect(getReadySecondsLeft(null, startMs)).toBeNull();
  });

  it("returns null for an invalid date", () => {
    expect(getReadySecondsLeft("not-a-date", startMs)).toBeNull();
  });

  it("returns the seconds remaining while now < started (lead activo)", () => {
    expect(getReadySecondsLeft(start, startMs - 3000)).toBe(3);
    expect(getReadySecondsLeft(start, startMs - 1500)).toBe(2); // ceil
  });

  it("returns 0 once started has passed (sin lead → la pregunta ya abrió)", () => {
    expect(getReadySecondsLeft(start, startMs)).toBe(0);
    expect(getReadySecondsLeft(start, startMs + 5000)).toBe(0);
  });

  it("clamps a 0 (nunca negativo)", () => {
    expect(getReadySecondsLeft(start, startMs + 100000)).toBe(0);
  });
});

describe("KAHOOT_SHAPES", () => {
  it("has exactly 4 shapes with unique keys", () => {
    expect(KAHOOT_SHAPES).toHaveLength(4);
    expect(new Set(KAHOOT_SHAPES.map((s) => s.key)).size).toBe(4);
  });

  it("each shape has bg + icon", () => {
    for (const s of KAHOOT_SHAPES) {
      expect(s.bg).toMatch(/^bg-\[#/);
      expect(["triangle", "diamond", "circle", "square"]).toContain(s.icon);
    }
  });
});

describe("buildKahootJoinUrl", () => {
  it("apunta a la ruta pública /reto/<pin> (sin login)", () => {
    expect(buildKahootJoinUrl("https://examlab.lovable.app", "842803")).toBe(
      "https://examlab.lovable.app/reto/842803",
    );
  });

  it("respeta el origin pasado (no hardcodea host)", () => {
    expect(buildKahootJoinUrl("http://localhost:5173", "000111")).toBe(
      "http://localhost:5173/reto/000111",
    );
  });
});

describe("estimateClockOffsetMs", () => {
  it("devuelve 0 (no corrige) si no hay hora de servidor — deploy viejo sin RPC", () => {
    expect(estimateClockOffsetMs(null, 1_000, 1_050)).toBe(0);
  });

  it("devuelve 0 ante una fecha inválida (no rompe el cronómetro)", () => {
    expect(estimateClockOffsetMs("no-es-fecha", 1_000, 1_050)).toBe(0);
  });

  it("reloj del dispositivo ADELANTADO → offset negativo (resta al Date.now local)", () => {
    // Cliente cree que son las 12:00:12 (t0..t1) pero el server dice 12:00:00.
    const serverIso = "2026-07-25T12:00:00.000Z";
    const t0 = new Date("2026-07-25T12:00:12.000Z").getTime();
    const t1 = new Date("2026-07-25T12:00:12.100Z").getTime();
    const offset = estimateClockOffsetMs(serverIso, t0, t1);
    // ~-12.05 s: al sumarlo a Date.now() del cliente lo lleva a la hora server.
    expect(offset).toBeGreaterThan(-12_100);
    expect(offset).toBeLessThan(-12_000);
  });

  it("reloj del dispositivo ATRASADO → offset positivo", () => {
    const serverIso = "2026-07-25T12:00:05.000Z";
    const t0 = new Date("2026-07-25T12:00:00.000Z").getTime();
    const t1 = new Date("2026-07-25T12:00:00.200Z").getTime();
    const offset = estimateClockOffsetMs(serverIso, t0, t1);
    // ~+4.9 s
    expect(offset).toBeGreaterThan(4_800);
    expect(offset).toBeLessThan(5_000);
  });

  it("estima el instante del servidor en el punto medio del round-trip (descuenta latencia)", () => {
    // server = mismo instante que el punto medio → offset ≈ 0 pese a 400ms RTT.
    const mid = new Date("2026-07-25T12:00:00.200Z").getTime();
    const t0 = mid - 200;
    const t1 = mid + 200;
    expect(estimateClockOffsetMs("2026-07-25T12:00:00.200Z", t0, t1)).toBe(0);
  });

  it("caso Mario: server-real 7.6s con límite 20s ⇒ reloj adelantado neutralizado", () => {
    // Con el offset aplicado, secondsLeft usa la hora del servidor: a 7.6s
    // reales de una pregunta de 20s deben quedar ~12s (no vencida).
    const startedIso = "2026-07-25T00:00:00.000Z";
    const serverNowIso = "2026-07-25T00:00:07.638Z"; // 7.638s reales transcurridos
    // El dispositivo va ~13s adelantado: su Date.now() marca 20.638s → ya vencida.
    const deviceNowMs = new Date("2026-07-25T00:00:20.638Z").getTime();
    // Sin corrección, el cliente ve la pregunta vencida (lft=0 → auto-envío en blanco):
    expect(secondsLeft(startedIso, 20, deviceNowMs)).toBe(0);
    // El RPC se resuelve "ahora" en el dispositivo (RTT ~0 para el test).
    const offset = estimateClockOffsetMs(serverNowIso, deviceNowMs, deviceNowMs);
    const corrected = deviceNowMs + offset;
    expect(secondsLeft(startedIso, 20, corrected)).toBe(13); // ceil(20 - 7.638) = 13, NO 0
  });
});
