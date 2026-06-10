import { describe, it, expect } from "vitest";
import { sessionEndsAtMs, sessionIsUpcoming } from "./session-time";

// Helper local: ms de una fecha+hora LOCAL (mismo criterio que el helper).
function localMs(y: number, mo: number, d: number, hh = 0, mm = 0): number {
  return new Date(y, mo - 1, d, hh, mm, 0, 0).getTime();
}

describe("sessionEndsAtMs", () => {
  it("usa start_time + duration_minutes", () => {
    // 2026-06-15 09:00 + 120min → 11:00
    expect(sessionEndsAtMs({ session_date: "2026-06-15", start_time: "09:00", duration_minutes: 120 })).toBe(
      localMs(2026, 6, 15, 11, 0),
    );
  });

  it("acepta start_time con segundos (HH:MM:SS)", () => {
    expect(sessionEndsAtMs({ session_date: "2026-06-15", start_time: "14:30:00", duration_minutes: 60 })).toBe(
      localMs(2026, 6, 15, 15, 30),
    );
  });

  it("fallback start_time 09:00 cuando es null", () => {
    // null start → 09:00 + 90min default → 10:30
    expect(sessionEndsAtMs({ session_date: "2026-06-15", start_time: null })).toBe(localMs(2026, 6, 15, 10, 30));
  });

  it("fallback duración 90min cuando es null o <= 0", () => {
    expect(sessionEndsAtMs({ session_date: "2026-06-15", start_time: "08:00", duration_minutes: null })).toBe(
      localMs(2026, 6, 15, 9, 30),
    );
    expect(sessionEndsAtMs({ session_date: "2026-06-15", start_time: "08:00", duration_minutes: 0 })).toBe(
      localMs(2026, 6, 15, 9, 30),
    );
  });

  it("tolera session_date con timestamp (toma los primeros 10 chars)", () => {
    expect(sessionEndsAtMs({ session_date: "2026-06-15T00:00:00Z", start_time: "09:00", duration_minutes: 60 })).toBe(
      localMs(2026, 6, 15, 10, 0),
    );
  });

  it("NaN para fecha inválida", () => {
    expect(Number.isNaN(sessionEndsAtMs({ session_date: "no-date", start_time: "09:00" }))).toBe(true);
    expect(Number.isNaN(sessionEndsAtMs({ session_date: "", start_time: "09:00" }))).toBe(true);
  });
});

describe("sessionIsUpcoming", () => {
  const now = localMs(2026, 6, 15, 15, 0); // hoy 15:00

  it("sesión de HOY que ya terminó → NO es próxima", () => {
    // 08:00 + 90min = 09:30 < 15:00
    expect(sessionIsUpcoming({ session_date: "2026-06-15", start_time: "08:00", duration_minutes: 90 }, now)).toBe(false);
  });

  it("sesión de HOY más tarde → sí es próxima", () => {
    expect(sessionIsUpcoming({ session_date: "2026-06-15", start_time: "18:00", duration_minutes: 60 }, now)).toBe(true);
  });

  it("sesión EN CURSO ahora → sí es próxima (no terminó)", () => {
    // 14:30 + 60min = 15:30 >= 15:00
    expect(sessionIsUpcoming({ session_date: "2026-06-15", start_time: "14:30", duration_minutes: 60 }, now)).toBe(true);
  });

  it("sesión de un día futuro → próxima", () => {
    expect(sessionIsUpcoming({ session_date: "2026-06-20", start_time: "08:00", duration_minutes: 60 }, now)).toBe(true);
  });

  it("sesión de un día pasado → NO próxima", () => {
    expect(sessionIsUpcoming({ session_date: "2026-06-14", start_time: "23:00", duration_minutes: 60 }, now)).toBe(false);
  });

  it("fecha inválida → conservador, se considera próxima", () => {
    expect(sessionIsUpcoming({ session_date: "garbage", start_time: "09:00" }, now)).toBe(true);
  });
});
