/**
 * Tests de `isForumOpen` — helper PURO correctness-critical: gatea si un
 * estudiante puede postear. DEBE coincidir con la SQL `is_forum_open` (RLS) y
 * con `computeForumState` de la lista; si divergen, un CTA visible es rechazado
 * por RLS (o viceversa). Verificado en vivo contra la SQL (SQL==JS en los 4
 * estados); estos tests fijan el contrato en el cliente.
 */
import { describe, it, expect } from "vitest";
import { isForumOpen } from "./forum-state";

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;

describe("isForumOpen", () => {
  it("abierto cuando no hay fechas ni cierre manual", () => {
    expect(isForumOpen({ opens_at: null, closes_at: null, manually_closed_at: null })).toBe(true);
  });

  it("CERRADO si tiene cierre manual (aunque las fechas digan abierto)", () => {
    expect(
      isForumOpen({ opens_at: null, closes_at: iso(HOUR), manually_closed_at: iso(-HOUR) }),
    ).toBe(false);
  });

  it("CERRADO (programado) si opens_at está en el futuro", () => {
    expect(isForumOpen({ opens_at: iso(HOUR), closes_at: null, manually_closed_at: null })).toBe(
      false,
    );
  });

  it("abierto si opens_at ya pasó y no hay cierre", () => {
    expect(isForumOpen({ opens_at: iso(-HOUR), closes_at: null, manually_closed_at: null })).toBe(
      true,
    );
  });

  it("CERRADO (auto) si closes_at ya pasó", () => {
    expect(isForumOpen({ opens_at: iso(-2 * HOUR), closes_at: iso(-HOUR), manually_closed_at: null })).toBe(
      false,
    );
  });

  it("abierto si closes_at está en el futuro", () => {
    expect(isForumOpen({ opens_at: null, closes_at: iso(HOUR), manually_closed_at: null })).toBe(
      true,
    );
  });

  it("abierto en la ventana [opens_at pasado, closes_at futuro]", () => {
    expect(
      isForumOpen({ opens_at: iso(-HOUR), closes_at: iso(HOUR), manually_closed_at: null }),
    ).toBe(true);
  });

  it("el cierre manual gana sobre una ventana de fechas abierta", () => {
    expect(
      isForumOpen({ opens_at: iso(-HOUR), closes_at: iso(HOUR), manually_closed_at: iso(-1) }),
    ).toBe(false);
  });
});
