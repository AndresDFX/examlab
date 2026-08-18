import { describe, expect, it } from "vitest";
import { formatNumber } from "./format";

describe("formatNumber", () => {
  it("usa el separador de miles de es-CO, no el del sistema", () => {
    // El bug que originó el helper: `chart.tsx` llamaba a toLocaleString() sin
    // locale, así que el mismo número se veía 1,234 en un equipo en inglés y
    // 1.234 en uno en español — en la misma pantalla.
    expect(formatNumber(1234)).toBe("1.234");
    expect(formatNumber(1234567)).toBe("1.234.567");
  });

  it("coma como separador decimal", () => {
    expect(formatNumber(1234.5)).toBe("1.234,5");
  });

  it("respeta el default de JS: hasta 3 decimales sin opciones", () => {
    // Importa para que sea reemplazo FIEL de toLocaleString("es-CO").
    expect(formatNumber(1.23456)).toBe("1,235");
  });

  it("pasa las opciones tal cual a Intl", () => {
    expect(formatNumber(1234.567, { maximumFractionDigits: 1 })).toBe("1.234,6");
    expect(formatNumber(0.5, { style: "percent" })).toBe("50%"); // es-CO no separa el %
  });

  it("no rompe con números pequeños ni con cero", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(7)).toBe("7");
    expect(formatNumber(-1234)).toBe("-1.234");
  });

  it("vacíos y no-finitos caen al fallback en vez de mostrar NaN", () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(formatNumber(v as number | null)).toBe("—");
    }
    expect(formatNumber(null, undefined, "0")).toBe("0");
  });
});
