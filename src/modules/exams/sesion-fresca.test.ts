import { describe, expect, it } from "vitest";

import { MARGEN_DE_REFRESCO_MS, necesitaRefresco } from "./sesion-fresca";

const AHORA = new Date("2026-09-24T12:00:00Z").getTime();
const enMinutos = (m: number) => Math.floor((AHORA + m * 60_000) / 1000);

describe("necesitaRefresco", () => {
  it("con el token recién emitido, no", () => {
    expect(necesitaRefresco(enMinutos(60), AHORA)).toBe(false);
  });

  it("dentro del margen, sí", () => {
    // El caso real: el alumno vuelve a la app y le quedan 4 minutos. La
    // librería solo actuaría en los últimos 90 segundos, y solo si la pestaña
    // está en primer plano.
    expect(necesitaRefresco(enMinutos(4), AHORA)).toBe(true);
  });

  it("ya vencido, sí", () => {
    expect(necesitaRefresco(enMinutos(-1), AHORA)).toBe(true);
  });

  it("justo en el borde del margen, sí", () => {
    expect(necesitaRefresco(Math.floor((AHORA + MARGEN_DE_REFRESCO_MS) / 1000), AHORA)).toBe(true);
  });

  it("sin sesión no hay nada que refrescar", () => {
    expect(necesitaRefresco(null, AHORA)).toBe(false);
    expect(necesitaRefresco(undefined, AHORA)).toBe(false);
  });

  it("un valor ilegible refresca: ante la duda, token nuevo", () => {
    expect(necesitaRefresco(Number.NaN, AHORA)).toBe(true);
  });
});
