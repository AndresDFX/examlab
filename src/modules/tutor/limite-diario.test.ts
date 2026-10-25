import { describe, expect, it } from "vitest";
// Fuente única: el helper vive en el edge (Deno no importa de src), acá se
// importa por ruta relativa — mismo patrón que AdminModelPanel ↔ ai-vision.ts.
import {
  DEFAULT_TUTOR_DAILY_LIMIT,
  MAX_TUTOR_DAILY_LIMIT,
  inicioDelDiaBogota,
  proximaMedianocheBogota,
  resolverLimiteEfectivo,
  restante,
} from "../../../supabase/functions/tutor-chat/limite-diario.ts";

describe("resolverLimiteEfectivo", () => {
  it("usa el valor configurado cuando es un entero válido", () => {
    expect(resolverLimiteEfectivo(10)).toBe(10);
    expect(resolverLimiteEfectivo(1)).toBe(1);
    expect(resolverLimiteEfectivo(MAX_TUTOR_DAILY_LIMIT)).toBe(MAX_TUTOR_DAILY_LIMIT);
  });

  it("cae al default del código ante NULL / undefined", () => {
    expect(resolverLimiteEfectivo(null)).toBe(DEFAULT_TUTOR_DAILY_LIMIT);
    expect(resolverLimiteEfectivo(undefined)).toBe(DEFAULT_TUTOR_DAILY_LIMIT);
  });

  it("cae al default ante valores inválidos (0, negativo, no entero, fuera de rango)", () => {
    expect(resolverLimiteEfectivo(0)).toBe(DEFAULT_TUTOR_DAILY_LIMIT);
    expect(resolverLimiteEfectivo(-3)).toBe(DEFAULT_TUTOR_DAILY_LIMIT);
    expect(resolverLimiteEfectivo(5.5)).toBe(DEFAULT_TUTOR_DAILY_LIMIT);
    expect(resolverLimiteEfectivo(MAX_TUTOR_DAILY_LIMIT + 1)).toBe(DEFAULT_TUTOR_DAILY_LIMIT);
    expect(resolverLimiteEfectivo(Number.NaN)).toBe(DEFAULT_TUTOR_DAILY_LIMIT);
  });
});

describe("inicioDelDiaBogota", () => {
  it("ancla a las 05:00Z del mismo día de Bogotá a media tarde", () => {
    // 2026-10-25 15:00Z = 10:00 en Bogotá → el día Bogotá es el 25.
    const now = new Date("2026-10-25T15:00:00.000Z");
    expect(inicioDelDiaBogota(now).toISOString()).toBe("2026-10-25T05:00:00.000Z");
  });

  it("mapea un instante UTC de madrugada al día de Bogotá anterior", () => {
    // 2026-10-25 03:00Z = 2026-10-24 22:00 en Bogotá → el día Bogotá es el 24.
    const now = new Date("2026-10-25T03:00:00.000Z");
    expect(inicioDelDiaBogota(now).toISOString()).toBe("2026-10-24T05:00:00.000Z");
  });

  it("justo en la medianoche de Bogotá arranca el nuevo día", () => {
    // 2026-10-25 05:00Z = 2026-10-25 00:00 en Bogotá.
    const now = new Date("2026-10-25T05:00:00.000Z");
    expect(inicioDelDiaBogota(now).toISOString()).toBe("2026-10-25T05:00:00.000Z");
  });
});

describe("proximaMedianocheBogota", () => {
  it("es el inicio del día siguiente de Bogotá (24h después)", () => {
    const now = new Date("2026-10-25T15:00:00.000Z");
    expect(proximaMedianocheBogota(now).toISOString()).toBe("2026-10-26T05:00:00.000Z");
  });
});

describe("restante", () => {
  it("nunca es negativo", () => {
    expect(restante(25, 10)).toBe(15);
    expect(restante(25, 25)).toBe(0);
    expect(restante(25, 30)).toBe(0);
  });
});
