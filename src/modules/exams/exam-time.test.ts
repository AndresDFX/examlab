import { describe, expect, it } from "vitest";

import {
  computeSecondsLeft,
  computeSecondsLeftRelative,
  formatTimerMMSS,
  getExamAccessState,
  isExamOpen,
} from "./exam-time";

const NOW = new Date("2026-04-20T12:00:00Z").getTime();
const in5min = new Date(NOW + 5 * 60_000).toISOString();
const in1h = new Date(NOW + 60 * 60_000).toISOString();
const ago1h = new Date(NOW - 60 * 60_000).toISOString();
const ago5min = new Date(NOW - 5 * 60_000).toISOString();

describe("computeSecondsLeft", () => {
  it("returns seconds until an ISO end time", () => {
    expect(computeSecondsLeft(in5min, NOW)).toBe(5 * 60);
  });

  it("accepts a Date object as input", () => {
    expect(computeSecondsLeft(new Date(NOW + 90_000), NOW)).toBe(90);
  });

  it("clamps to 0 when the exam has already ended", () => {
    expect(computeSecondsLeft(ago1h, NOW)).toBe(0);
  });

  it("returns 0 for missing end time", () => {
    expect(computeSecondsLeft(null, NOW)).toBe(0);
    expect(computeSecondsLeft(undefined, NOW)).toBe(0);
  });

  it("returns 0 for invalid date strings", () => {
    expect(computeSecondsLeft("not-a-date", NOW)).toBe(0);
  });

  it("does not reset to initial duration when recomputed across ticks", () => {
    const start = NOW;
    const end = new Date(NOW + 60 * 60_000).toISOString();
    const t0 = computeSecondsLeft(end, start);
    const t10s = computeSecondsLeft(end, start + 10_000);
    const t30s = computeSecondsLeft(end, start + 30_000);
    expect(t0).toBe(3600);
    expect(t10s).toBe(3590);
    expect(t30s).toBe(3570);
  });
});

describe("computeSecondsLeftRelative", () => {
  it("usa timeLimit cuando vence antes que el end_time de la ventana", () => {
    const startedAt = new Date(NOW).toISOString();
    // 30 min de límite, ventana cierra en 1h. Vence antes el personal → 30 min.
    expect(computeSecondsLeftRelative(startedAt, 30, in1h, NOW)).toBe(30 * 60);
  });

  it("usa end_time cuando cierra antes que el timeLimit personal", () => {
    const startedAt = new Date(NOW).toISOString();
    // 60 min de límite, ventana cierra en 5 min → vence antes la ventana = 5 min.
    expect(computeSecondsLeftRelative(startedAt, 60, in5min, NOW)).toBe(5 * 60);
  });

  it("decrementa segundos a medida que pasa el tiempo", () => {
    const startedAt = new Date(NOW).toISOString();
    expect(computeSecondsLeftRelative(startedAt, 30, in1h, NOW)).toBe(30 * 60);
    expect(computeSecondsLeftRelative(startedAt, 30, in1h, NOW + 60_000)).toBe(29 * 60);
    expect(computeSecondsLeftRelative(startedAt, 30, in1h, NOW + 30 * 60_000)).toBe(0);
  });

  it("se clampa a 0 cuando ya pasó el limite personal", () => {
    const startedAt = new Date(NOW - 60 * 60_000).toISOString(); // empezó hace 1h
    expect(computeSecondsLeftRelative(startedAt, 30, in1h, NOW)).toBe(0);
  });

  it("retorna 0 si no hay startedAt", () => {
    expect(computeSecondsLeftRelative(null, 30, in1h, NOW)).toBe(0);
    expect(computeSecondsLeftRelative(undefined, 30, in1h, NOW)).toBe(0);
  });

  it("acepta startedAt como Date object", () => {
    const startedAt = new Date(NOW);
    expect(computeSecondsLeftRelative(startedAt, 30, in1h, NOW)).toBe(30 * 60);
  });

  it("ignora timeLimit negativo (lo trata como 0)", () => {
    const startedAt = new Date(NOW).toISOString();
    expect(computeSecondsLeftRelative(startedAt, -10, in1h, NOW)).toBe(0);
  });

  it("retorna 0 cuando startedAt es inválido", () => {
    expect(computeSecondsLeftRelative("not-a-date", 30, in1h, NOW)).toBe(0);
  });

  it("si endTime es null/undefined, usa solo el timeLimit personal", () => {
    const startedAt = new Date(NOW).toISOString();
    expect(computeSecondsLeftRelative(startedAt, 30, null, NOW)).toBe(30 * 60);
    expect(computeSecondsLeftRelative(startedAt, 30, undefined, NOW)).toBe(30 * 60);
  });

  it("endTime inválido se ignora y usa solo el personal", () => {
    const startedAt = new Date(NOW).toISOString();
    expect(computeSecondsLeftRelative(startedAt, 30, "not-a-date", NOW)).toBe(30 * 60);
  });
});

describe("isExamOpen", () => {
  it("is open when now is inside the window", () => {
    expect(isExamOpen({ start_time: ago5min, end_time: in5min }, NOW)).toBe(true);
  });

  it("is closed before the window starts", () => {
    expect(isExamOpen({ start_time: in5min, end_time: in1h }, NOW)).toBe(false);
  });

  it("is closed after the window ends", () => {
    expect(isExamOpen({ start_time: ago1h, end_time: ago5min }, NOW)).toBe(false);
  });
});

describe("getExamAccessState", () => {
  it("returns upcoming for a future window", () => {
    expect(getExamAccessState({ start_time: in5min, end_time: in1h }, NOW)).toBe("upcoming");
  });

  it("returns open for an active window", () => {
    expect(getExamAccessState({ start_time: ago5min, end_time: in5min }, NOW)).toBe("open");
  });

  it("returns closed for a past window", () => {
    expect(getExamAccessState({ start_time: ago1h, end_time: ago5min }, NOW)).toBe("closed");
  });

  it("returns closed for invalid dates", () => {
    expect(getExamAccessState({ start_time: "nope", end_time: "nope" }, NOW)).toBe("closed");
  });
});

describe("formatTimerMMSS", () => {
  it("formats zero as 00:00", () => {
    expect(formatTimerMMSS(0)).toBe("00:00");
  });

  it("pads minutes and seconds", () => {
    expect(formatTimerMMSS(9)).toBe("00:09");
    expect(formatTimerMMSS(65)).toBe("01:05");
  });

  it("handles long durations", () => {
    expect(formatTimerMMSS(3600)).toBe("60:00");
  });

  it("clamps negative values to 00:00", () => {
    expect(formatTimerMMSS(-10)).toBe("00:00");
  });
});
