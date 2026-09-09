import { describe, expect, it } from "vitest";
import { clampSqlZoom, SQL_ZOOM_MAX, SQL_ZOOM_MIN } from "./use-sql-zoom";

describe("clampSqlZoom", () => {
  it("acepta un valor válido guardado como string", () => {
    expect(clampSqlZoom("1.5")).toBe(1.5);
    expect(clampSqlZoom(1.75)).toBe(1.75);
  });

  it("sube al piso lo que quede por debajo (no hay zoom < 100%)", () => {
    expect(clampSqlZoom(0.4)).toBe(SQL_ZOOM_MIN);
    expect(clampSqlZoom(-3)).toBe(SQL_ZOOM_MIN);
  });

  it("baja al techo lo que quede por encima", () => {
    expect(clampSqlZoom(5)).toBe(SQL_ZOOM_MAX);
    expect(clampSqlZoom("999")).toBe(SQL_ZOOM_MAX);
  });

  it("cae al default con basura en localStorage", () => {
    expect(clampSqlZoom("basura")).toBe(SQL_ZOOM_MIN);
    expect(clampSqlZoom(null)).toBe(SQL_ZOOM_MIN);
    expect(clampSqlZoom(undefined)).toBe(SQL_ZOOM_MIN);
    expect(clampSqlZoom(NaN)).toBe(SQL_ZOOM_MIN);
    expect(clampSqlZoom(Infinity)).toBe(SQL_ZOOM_MIN);
  });

  it("hace snap al paso de 0,25 (un valor viejo fuera de la escala no queda intermedio)", () => {
    expect(clampSqlZoom(1.3)).toBe(1.25);
    expect(clampSqlZoom(1.4)).toBe(1.5);
    expect(clampSqlZoom(1.62)).toBe(1.5);
  });
});
