/**
 * Motor PURO de la calculadora de costos/precio del SuperAdmin.
 *
 * Sin React, sin Date.now, sin fetch → testeable con `bun test`/vitest sin jsdom.
 * La UI (app.superadmin.pricing-calculator.tsx) solo lo invoca.
 *
 * INVARIANTE DE NEGOCIO (v3.1): la infra la provee SIEMPRE ExamLab en los 3
 * modelos ⇒ `costoInfra(N) >= COSTO_FIJO_MENSUAL > 0` SIEMPRE. NO existe rama
 * "self-host / infra del cliente / costoInfra ≈ 0". Lo único que difiere entre
 * modelos es el costo humano de operación y el nivel de soporte.
 *
 * Los valores por defecto (FALLBACK_ASSUMPTIONS) son idénticos al seed de la
 * migración `pricing_assumptions` — mismo par a mantener en sincronía (ver
 * CLAUDE.md, invariantes cross-file).
 */

export type PlanKey = "Starter" | "Pequena" | "Mediana" | "Grande" | "Enterprise";

/** 1 = sin administración (AUTO) · 2 = con administración · 3 = independiente con mi admin. */
export type ModeloNegocio = 1 | 2 | 3;

export interface ScalePoint {
  matr: number;
  infra: number;
  usdPerMatr: number;
}

export interface PlanDef {
  cap: number | null;
  gb: number;
  listAuto: number;
  listAdmin: number | null;
  infraEst: number;
  adminOfrecido: boolean;
}

export interface AddonDef {
  list: number;
  cost: number;
}

export interface PricingAssumptions {
  costoFijoMensual: number;
  costoHumanoAdmin: number;
  factorHumanoIndep: number;
  storageOverageUsdGb: number;
  egressOverageUsdGb: number;
  gbBasePorMatricula: number;
  margenDefault: number;
  factorMateriasDefault: number;
  descuentoAnual: number;
  scaleCurve: ScalePoint[];
  plans: Record<PlanKey, PlanDef>;
  addons: {
    iaAdmin: AddonDef;
    storageExtra: AddonDef;
    codeRunner: AddonDef;
    aislamiento: AddonDef;
    ssoSetup: AddonDef;
    ssoMensual: AddonDef;
    certificacion: AddonDef;
  };
}

/** Fallback = seed de la migración pricing_assumptions (mantener en sincronía). */
export const FALLBACK_ASSUMPTIONS: PricingAssumptions = {
  costoFijoMensual: 51,
  costoHumanoAdmin: 225,
  factorHumanoIndep: 0.5,
  storageOverageUsdGb: 0.0213,
  egressOverageUsdGb: 0.09,
  gbBasePorMatricula: 0.016,
  margenDefault: 0.9,
  factorMateriasDefault: 6,
  descuentoAnual: 0.1,
  scaleCurve: [
    { matr: 1000, infra: 51, usdPerMatr: 0.051 },
    { matr: 2500, infra: 53, usdPerMatr: 0.021 },
    { matr: 5000, infra: 65, usdPerMatr: 0.013 },
    { matr: 10000, infra: 90, usdPerMatr: 0.009 },
    { matr: 15000, infra: 120, usdPerMatr: 0.008 },
    { matr: 25000, infra: 180, usdPerMatr: 0.007 },
    { matr: 50000, infra: 700, usdPerMatr: 0.014 },
    { matr: 100000, infra: 900, usdPerMatr: 0.009 },
  ],
  plans: {
    Starter: { cap: 200, gb: 25, listAuto: 79, listAdmin: null, infraEst: 10, adminOfrecido: false },
    Pequena: { cap: 1000, gb: 50, listAuto: 149, listAdmin: 449, infraEst: 15, adminOfrecido: true },
    Mediana: { cap: 3000, gb: 100, listAuto: 349, listAdmin: 749, infraEst: 30, adminOfrecido: true },
    Grande: { cap: 10000, gb: 200, listAuto: 799, listAdmin: 1499, infraEst: 80, adminOfrecido: true },
    Enterprise: { cap: null, gb: 500, listAuto: 1499, listAdmin: null, infraEst: 200, adminOfrecido: true },
  },
  addons: {
    iaAdmin: { list: 0.1, cost: 0.062 },
    storageExtra: { list: 10, cost: 2.13 },
    codeRunner: { list: 49, cost: 5 },
    aislamiento: { list: 99, cost: 75 },
    ssoSetup: { list: 99, cost: 50 },
    ssoMensual: { list: 29, cost: 0 },
    certificacion: { list: 29, cost: 0 },
  },
};

export const PLAN_ORDER: PlanKey[] = ["Starter", "Pequena", "Mediana", "Grande", "Enterprise"];

export interface QuoteInput {
  matriculas: number;
  plan: PlanKey;
  modelo: ModeloNegocio;
  /** Aislamiento dedicado (Supabase por tenant gestionado por ExamLab). Ignorado en modelo 3. */
  aislamientoDedicado: boolean;
  /** Margen objetivo sobre precio [0, 0.99]. */
  margen: number;
  descuentoAnual: boolean;
  iaAdmin: boolean;
  storageExtraGb: number;
  codeRunner: boolean;
  sso: boolean;
  certificacion: boolean;
}

export interface QuoteResult {
  matriculas: number;
  modalidad: "Auto" | "Administrada";
  aislamientoDedicado: boolean;
  costoInfra: number;
  costoInfraAtribuido: number;
  costoHumano: number;
  addonCost: number;
  storageOverage: number;
  costoTotal: number;
  precioSugerido: number;
  precioFinal: number;
  margenUsd: number;
  margenPct: number;
  markupPct: number;
  precioLista: number | null;
  deltaVsLista: number | null;
  dollarPorMatricula: number | null;
  gbNecesario: number;
  gbIncluido: number;
  gbSobre: number;
  warnings: string[];
}

const clampMargen = (m: number) => Math.max(0, Math.min(0.99, m));

/** Interpola linealmente usdPerMatr en la curva de escala. */
function interpUsdPerMatr(n: number, curve: ScalePoint[]): number {
  if (curve.length === 0) return 0;
  const sorted = [...curve].sort((a, b) => a.matr - b.matr);
  if (n <= sorted[0].matr) return sorted[0].usdPerMatr;
  const last = sorted[sorted.length - 1];
  if (n >= last.matr) return last.usdPerMatr;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (n >= a.matr && n <= b.matr) {
      const t = (n - a.matr) / (b.matr - a.matr);
      return a.usdPerMatr + t * (b.usdPerMatr - a.usdPerMatr);
    }
  }
  return last.usdPerMatr;
}

/** Modalidad derivada del modelo (1 → Auto; 2 y 3 → Administrada). */
export function modalidadForModelo(modelo: ModeloNegocio): "Auto" | "Administrada" {
  return modelo === 1 ? "Auto" : "Administrada";
}

/**
 * Costo de infra atribuido al cliente (vista STANDALONE, conservadora).
 * SIEMPRE >= COSTO_FIJO_MENSUAL — la infra es de ExamLab en todos los modelos.
 * Si `aislamientoDedicado`, suma el costo real de la instancia dedicada.
 */
export function costoInfra(n: number, a: PricingAssumptions, aislamientoDedicado = false): number {
  let base: number;
  if (n <= 0) {
    base = a.costoFijoMensual;
  } else {
    const marginal = n * interpUsdPerMatr(n, a.scaleCurve);
    base = Math.max(a.costoFijoMensual, marginal);
  }
  if (aislamientoDedicado) base += a.addons.aislamiento.cost;
  return base;
}

export function costoHumano(modelo: ModeloNegocio, a: PricingAssumptions): number {
  if (modelo === 1) return 0;
  if (modelo === 3) return a.costoHumanoAdmin * a.factorHumanoIndep;
  return a.costoHumanoAdmin; // modelo 2
}

export function computeQuote(input: QuoteInput, a: PricingAssumptions = FALLBACK_ASSUMPTIONS): QuoteResult {
  const warnings: string[] = [];
  const n = Math.max(0, Math.floor(input.matriculas || 0));
  const modalidad = modalidadForModelo(input.modelo);
  const plan = a.plans[input.plan];
  // Modelo 3 nunca usa infra dedicada (independiente siempre en compartida).
  const aislamiento = input.modelo === 3 ? false : input.aislamientoDedicado;

  // Infra (siempre > 0)
  const infra = costoInfra(n, a, aislamiento);
  const infraAtribuido = plan.infraEst + (aislamiento ? a.addons.aislamiento.cost : 0);

  // Storage overage
  const gbNecesario = a.gbBasePorMatricula * n;
  const gbIncluido = plan.gb;
  const gbSobre = Math.max(0, gbNecesario - gbIncluido + Math.max(0, input.storageExtraGb || 0));
  const storageOverage = gbSobre * a.storageOverageUsdGb;
  if (gbSobre > 0 && (input.storageExtraGb || 0) <= 0) {
    warnings.push("El storage estimado rompe el cap del plan: agregar Storage extra ($10/100 GB) o subir de plan.");
  }

  // Humano
  const humano = costoHumano(input.modelo, a);

  // Add-ons (costo real a ExamLab). El aislamiento NO se doble-cuenta (ya en infra).
  let addonCost = 0;
  if (input.iaAdmin) addonCost += a.addons.iaAdmin.cost * n;
  if (input.codeRunner) addonCost += a.addons.codeRunner.cost;
  if (input.sso) addonCost += a.addons.ssoMensual.cost + a.addons.ssoSetup.cost / 12;
  if (input.certificacion) addonCost += a.addons.certificacion.cost;

  const costoTotal = infra + humano + addonCost + storageOverage;

  // Precio sugerido = margen sobre precio
  const margen = clampMargen(input.margen);
  const precioSugerido = costoTotal / (1 - margen);
  const precioFinal = precioSugerido * (input.descuentoAnual ? 1 - a.descuentoAnual : 1);
  const margenUsd = precioSugerido - costoTotal;
  const margenPct = precioSugerido > 0 ? margenUsd / precioSugerido : 0;
  const markupPct = costoTotal > 0 ? margenUsd / costoTotal : 0;

  // Comparación vs precio de lista
  const precioLista = modalidad === "Administrada" ? plan.listAdmin : plan.listAuto;
  const deltaVsLista = precioLista == null ? null : precioSugerido - precioLista;

  // Warnings de negocio
  if (input.modelo !== 1 && !plan.adminOfrecido) {
    warnings.push(
      `El plan ${input.plan} no admite administración (el costo humano no cierra margen a este precio). Usar plan Pequeña+ o modelo Autogestionado.`,
    );
  }
  if (plan.cap != null && n > plan.cap) {
    warnings.push(`El volumen (${n}) excede el cap del plan ${input.plan} (${plan.cap}). Sugerir plan superior o Enterprise.`);
  }
  if (modalidad === "Administrada" && precioLista == null) {
    warnings.push("Este plan no tiene precio de lista administrada — cotizar a mano.");
  }
  if (deltaVsLista != null && deltaVsLista > 0.5) {
    warnings.push("El precio sugerido supera el precio de lista — revisar (la lista es el piso comercial).");
  }
  if (n >= 45000) {
    warnings.push("A ~50k matrículas se salta a Supabase Team ($599): el $/matrícula sube, renegociar.");
  }
  if (Math.abs(infra - infraAtribuido) / Math.max(1, infra) > 0.3) {
    warnings.push("Infra standalone vs amortizada difieren >30% (típico en clientes chicos: el fijo $51 sobre-atribuye).");
  }

  return {
    matriculas: n,
    modalidad,
    aislamientoDedicado: aislamiento,
    costoInfra: infra,
    costoInfraAtribuido: infraAtribuido,
    costoHumano: humano,
    addonCost,
    storageOverage,
    costoTotal,
    precioSugerido,
    precioFinal,
    margenUsd,
    margenPct,
    markupPct,
    precioLista,
    deltaVsLista,
    dollarPorMatricula: n > 0 ? precioFinal / n : null,
    gbNecesario,
    gbIncluido,
    gbSobre,
    warnings,
  };
}

/** Sugiere el plan por volumen de matrículas (el primero cuyo cap alcanza). */
export function suggestPlan(n: number, a: PricingAssumptions = FALLBACK_ASSUMPTIONS): PlanKey {
  for (const key of PLAN_ORDER) {
    const cap = a.plans[key].cap;
    if (cap == null || n <= cap) return key;
  }
  return "Enterprise";
}

/** Filas de la tabla por escala (recalculadas con los supuestos actuales). */
export function scaleTable(
  base: Omit<QuoteInput, "matriculas" | "plan">,
  a: PricingAssumptions = FALLBACK_ASSUMPTIONS,
  points: number[] = [250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000],
): QuoteResult[] {
  return points.map((n) => computeQuote({ ...base, matriculas: n, plan: suggestPlan(n, a) }, a));
}
