import { describe, it, expect } from "vitest";
import {
  MIN_SCHEDULE_LEAD_MS,
  validateScheduledSend,
  SCHEDULED_STATUS_LABEL,
  localToIso,
  type ScheduledStatus,
} from "./scheduled";

const NOW = new Date("2026-05-01T12:00:00.000Z");

describe("validateScheduledSend", () => {
  it("rechaza string vacío", () => {
    expect(validateScheduledSend("", NOW).ok).toBe(false);
    expect(validateScheduledSend("   ", NOW).ok).toBe(false);
  });

  it("rechaza fecha inválida", () => {
    expect(validateScheduledSend("no-es-fecha", NOW).ok).toBe(false);
  });

  it("rechaza fecha en el pasado", () => {
    // 1 hora antes de NOW
    const past = new Date(NOW.getTime() - 3600_000).toISOString();
    const out = validateScheduledSend(past, NOW);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/futuro/i);
  });

  it("rechaza fecha demasiado cercana (< 1 min)", () => {
    const soon = new Date(NOW.getTime() + 30_000).toISOString();
    expect(validateScheduledSend(soon, NOW).ok).toBe(false);
  });

  it("acepta fecha al menos 1 min en el futuro", () => {
    const ok = new Date(NOW.getTime() + MIN_SCHEDULE_LEAD_MS).toISOString();
    expect(validateScheduledSend(ok, NOW)).toEqual({ ok: true });
  });

  it("acepta fecha bien futura", () => {
    const future = new Date(NOW.getTime() + 7 * 24 * 3600_000).toISOString();
    expect(validateScheduledSend(future, NOW).ok).toBe(true);
  });
});

describe("SCHEDULED_STATUS_LABEL", () => {
  it("cubre los 4 estados", () => {
    const expected: Record<ScheduledStatus, string> = {
      pending: "Programado",
      sent: "Enviado",
      cancelled: "Cancelado",
      failed: "Falló",
    };
    expect(SCHEDULED_STATUS_LABEL).toEqual(expected);
  });
});

describe("localToIso", () => {
  it("convierte a un ISO string parseable de vuelta al mismo instante", () => {
    const local = "2026-12-31T23:30";
    const iso = localToIso(local);
    // El ISO debe re-parsear al mismo instante que el string local.
    expect(new Date(iso).getTime()).toBe(new Date(local).getTime());
    // Y debe ser formato ISO (Z al final).
    expect(iso).toMatch(/Z$/);
  });
});
