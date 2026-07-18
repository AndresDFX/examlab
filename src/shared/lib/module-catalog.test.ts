/**
 * GUARDRAIL de la "organización de módulos".
 *
 * Cruza las 3 fuentes que deben mantenerse en sincronía cuando se agrega,
 * arregla o prueba un módulo:
 *   1. `ALL_MODULE_KEYS` (runtime) ↔ el type `ModuleKey` (compile-time, en
 *      module-catalog.ts vía _exhaustiveModuleKeys).
 *   2. `MODULE_CATALOG` (filas del panel "Módulos") — cada module_key REAL
 *      debe tener fila; el panel no debe referenciar módulos inexistentes.
 *   3. `NAV_PATH_TO_MODULE` (orden/visibility del sidebar) y `PREFIX_TO_MODULE`
 *      (gating de rutas del ModuleRouteGuard) — deben mapear a módulos válidos
 *      y estar sincronizados (un módulo del sidebar sin gating de ruta = bypass
 *      por URL).
 *
 * Si estos tests fallan al agregar un módulo, seguí el checklist de CLAUDE.md
 * ("Checklist para agregar un módulo nuevo").
 */
import { describe, it, expect } from "vitest";
import {
  ALL_MODULE_KEYS,
  MODULE_CATALOG,
  NAV_PATH_TO_MODULE,
  panelCoveredModuleKeys,
} from "./module-catalog";
import { PREFIX_TO_MODULE } from "@/shared/components/ModuleRouteGuard";

const ALL = new Set<string>(ALL_MODULE_KEYS);

describe("organización de módulos — guardrails", () => {
  it("cada ModuleKey tiene fila en el panel Módulos (MODULE_CATALOG)", () => {
    const covered = panelCoveredModuleKeys();
    const missing = ALL_MODULE_KEYS.filter((k) => !covered.has(k));
    expect(
      missing,
      `Módulos sin fila en el panel "Módulos": ${missing.join(", ")}. Agregá la fila en MODULE_CATALOG (module-catalog.ts).`,
    ).toEqual([]);
  });

  it("el panel no referencia module_keys inexistentes (salvo virtuales)", () => {
    const covered = panelCoveredModuleKeys();
    const phantom = [...covered].filter((k) => !ALL.has(k));
    expect(phantom, `Keys en MODULE_CATALOG que no son ModuleKey: ${phantom.join(", ")}`).toEqual([]);
  });

  it("NAV_PATH_TO_MODULE mapea solo a módulos válidos", () => {
    const bad = NAV_PATH_TO_MODULE.filter(([, m]) => !ALL.has(m)).map(([p, m]) => `${p}→${m}`);
    expect(bad, `Rutas del sidebar a módulos inexistentes: ${bad.join(", ")}`).toEqual([]);
  });

  it("PREFIX_TO_MODULE (route guard) mapea solo a módulos válidos", () => {
    const bad = PREFIX_TO_MODULE.filter(([, m]) => !ALL.has(m)).map(([p, m]) => `${p}→${m}`);
    expect(bad, `Prefijos de ruta a módulos inexistentes: ${bad.join(", ")}`).toEqual([]);
  });

  it("cada módulo del sidebar (NAV) está gateado por el route guard (PREFIX)", () => {
    // Excepciones INTENCIONALES: dashboard (`/app`, landing neutral, sin gating
    // per-módulo) y configuration (escape hatch — la ruta queda accesible por
    // URL aunque el toggle esté off, para no dejar al admin sin retorno).
    const EXEMPT = new Set<string>(["dashboard", "configuration"]);
    const prefixModules = new Set(PREFIX_TO_MODULE.map(([, m]) => m));
    const navModules = new Set(NAV_PATH_TO_MODULE.map(([, m]) => m));
    const bypassable = [...navModules].filter((m) => !EXEMPT.has(m) && !prefixModules.has(m));
    expect(
      bypassable,
      `Módulos en el sidebar sin gating de ruta (accesibles por URL con el toggle off): ${bypassable.join(", ")}. Agregá su prefijo a PREFIX_TO_MODULE.`,
    ).toEqual([]);
  });

  it("no hay rutas duplicadas en NAV_PATH_TO_MODULE", () => {
    const paths = NAV_PATH_TO_MODULE.map(([p]) => p);
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
    expect(dupes, `Rutas duplicadas en NAV_PATH_TO_MODULE: ${dupes.join(", ")}`).toEqual([]);
  });

  it("ALL_MODULE_KEYS no tiene duplicados", () => {
    const dupes = ALL_MODULE_KEYS.filter((k, i) => ALL_MODULE_KEYS.indexOf(k) !== i);
    expect(dupes, `Duplicados en ALL_MODULE_KEYS: ${dupes.join(", ")}`).toEqual([]);
  });
});
