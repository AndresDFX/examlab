import { describe, expect, it } from "vitest";
import {
  FALLBACK_ASSUMPTIONS as A,
  computeQuote,
  costoInfra,
  costoHumano,
  modalidadForModelo,
  suggestPlan,
  scaleTable,
  type QuoteInput,
} from "./pricing-engine";

const baseInput = (over: Partial<QuoteInput> = {}): QuoteInput => ({
  matriculas: 1000,
  plan: "Pequena",
  modelo: 1,
  aislamientoDedicado: false,
  margen: 0.9,
  descuentoAnual: false,
  iaAdmin: false,
  storageExtraGb: 0,
  codeRunner: false,
  sso: false,
  certificacion: false,
  ...over,
});

describe("costoInfra — invariante: SIEMPRE > 0 (infra siempre de ExamLab)", () => {
  it("piso = costo fijo compartido, incluso con 0 matrículas", () => {
    expect(costoInfra(0, A)).toBe(A.costoFijoMensual);
    expect(costoInfra(0, A)).toBeGreaterThan(0);
  });
  it("nunca por debajo del fijo, a cualquier escala", () => {
    for (const n of [1, 200, 1000, 3000, 10000, 25000, 100000]) {
      expect(costoInfra(n, A)).toBeGreaterThanOrEqual(A.costoFijoMensual);
    }
  });
  it("aislamiento dedicado suma su costo real a la infra", () => {
    expect(costoInfra(1000, A, true)).toBeCloseTo(costoInfra(1000, A, false) + A.addons.aislamiento.cost, 5);
  });
});

describe("costoHumano — única palanca que separa modelos", () => {
  it("modelo 1 (sin admin) = 0", () => expect(costoHumano(1, A)).toBe(0));
  it("modelo 2 (con admin) = 225", () => expect(costoHumano(2, A)).toBe(225));
  it("modelo 3 (independiente) = 225 × 0.5 = 112.5", () => expect(costoHumano(3, A)).toBe(112.5));
});

describe("modalidad derivada del modelo", () => {
  it("modelo 1 → Auto; 2 y 3 → Administrada", () => {
    expect(modalidadForModelo(1)).toBe("Auto");
    expect(modalidadForModelo(2)).toBe("Administrada");
    expect(modalidadForModelo(3)).toBe("Administrada");
  });
});

describe("computeQuote — costoTotal y precio", () => {
  it("costoTotal SIEMPRE incluye infra > 0 en los 3 modelos", () => {
    for (const modelo of [1, 2, 3] as const) {
      const r = computeQuote(baseInput({ modelo, plan: "Mediana", matriculas: 3000 }));
      expect(r.costoInfra).toBeGreaterThan(0);
      expect(r.costoTotal).toBeGreaterThanOrEqual(r.costoInfra);
    }
  });
  it("modelo 2 suma humano $225; modelo 1 no", () => {
    const m1 = computeQuote(baseInput({ modelo: 1 }));
    const m2 = computeQuote(baseInput({ modelo: 2, plan: "Pequena" }));
    expect(m1.costoHumano).toBe(0);
    expect(m2.costoHumano).toBe(225);
    expect(m2.costoTotal - m1.costoTotal).toBeCloseTo(225, 5);
  });
  it("precioSugerido = costoTotal / (1 - margen) y margenPct ≈ margen", () => {
    const r = computeQuote(baseInput({ margen: 0.9 }));
    expect(r.precioSugerido).toBeCloseTo(r.costoTotal / 0.1, 5);
    expect(r.margenPct).toBeCloseTo(0.9, 5);
  });
  it("margen ≥ 100% se clampa a 99% (sin división por cero)", () => {
    const r = computeQuote(baseInput({ margen: 1.5 }));
    expect(Number.isFinite(r.precioSugerido)).toBe(true);
    expect(r.margenPct).toBeCloseTo(0.99, 5);
  });
  it("descuento anual aplica -10% al precio final", () => {
    const r = computeQuote(baseInput({ descuentoAnual: true }));
    expect(r.precioFinal).toBeCloseTo(r.precioSugerido * 0.9, 5);
  });
  it("IA administrada suma cost × matrículas", () => {
    const sin = computeQuote(baseInput({ iaAdmin: false, matriculas: 1000 }));
    const con = computeQuote(baseInput({ iaAdmin: true, matriculas: 1000 }));
    expect(con.costoTotal - sin.costoTotal).toBeCloseTo(A.addons.iaAdmin.cost * 1000, 5);
  });
  it("modelo 3 ignora aislamiento dedicado (independiente siempre compartida)", () => {
    const r = computeQuote(baseInput({ modelo: 3, plan: "Pequena", aislamientoDedicado: true }));
    expect(r.aislamientoDedicado).toBe(false);
  });
  it("0 matrículas → costoInfra = fijo, $/matrícula = null", () => {
    const r = computeQuote(baseInput({ matriculas: 0 }));
    expect(r.costoInfra).toBe(A.costoFijoMensual);
    expect(r.dollarPorMatricula).toBeNull();
  });
  it("Starter + administración → warning (admin no ofrecido)", () => {
    const r = computeQuote(baseInput({ plan: "Starter", modelo: 2 }));
    expect(r.warnings.some((w) => /no admite administraci/i.test(w))).toBe(true);
  });
  it("volumen sobre el cap → warning", () => {
    const r = computeQuote(baseInput({ plan: "Pequena", matriculas: 5000 }));
    expect(r.warnings.some((w) => /excede el cap/i.test(w))).toBe(true);
  });
});

describe("cross-check amortizado vs lista v3", () => {
  it("infraEst amortizado da márgenes ~v3 (Mediana ~91%, Grande ~90%)", () => {
    const med = A.plans.Mediana;
    const gra = A.plans.Grande;
    expect((med.listAuto - med.infraEst) / med.listAuto).toBeCloseTo(0.914, 2);
    expect((gra.listAuto - gra.infraEst) / gra.listAuto).toBeCloseTo(0.9, 2);
  });
});

describe("suggestPlan + scaleTable", () => {
  it("sugiere plan por cap", () => {
    expect(suggestPlan(150)).toBe("Starter");
    expect(suggestPlan(800)).toBe("Pequena");
    expect(suggestPlan(2500)).toBe("Mediana");
    expect(suggestPlan(9000)).toBe("Grande");
    expect(suggestPlan(50000)).toBe("Enterprise");
  });
  it("scaleTable: toda fila tiene costoInfra > 0", () => {
    const rows = scaleTable({
      modelo: 1, aislamientoDedicado: false, margen: 0.9, descuentoAnual: false,
      iaAdmin: false, storageExtraGb: 0, codeRunner: false, sso: false, certificacion: false,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.costoInfra).toBeGreaterThan(0);
  });
});
