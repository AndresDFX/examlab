/**
 * GUARDRAIL de las reglas de UI (P1-P9, design system, responsive de 375px).
 *
 * ── Por qué un test y no solo el script ────────────────────────────────
 * CLAUdE.md documenta cada principio con su check y explica en la misma página
 * por qué eso no alcanzó: *"el repo ya sabía detectar estos bugs —el fix del
 * doble padding y su justificación están escritos hace meses— y aun así nunca se
 * propagó al resto de las rutas"*. Un check que hay que acordarse de correr no se
 * corre. Este test lo mete en `bun test`, así que una pantalla nueva que rompa
 * una regla falla ANTES de mergear.
 *
 * Si este test falla: correr `node scripts/audit-ui.mjs` para ver el detalle con
 * archivo y línea. NO agregar la violación a la lista de aceptados para que pase
 * — esa lista es para casos donde el principio NO APLICA, y cada entrada lleva su
 * motivo escrito.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SCRIPT = path.join(process.cwd(), "scripts", "audit-ui.mjs");

function auditar(): Array<{ regla: string; archivo: string; linea: number; detalle: string }> {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--json"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (e) {
    // exit 1 = hay hallazgos; el JSON sigue estando en stdout.
    const err = e as { stdout?: string };
    if (typeof err.stdout === "string" && err.stdout.trim().startsWith("[")) {
      return JSON.parse(err.stdout);
    }
    throw e;
  }
}

describe("reglas de UI del proyecto", () => {
  it("ninguna pantalla rompe P1-P9, el design system ni las reglas de 375px", () => {
    const hallazgos = auditar();
    const legible = hallazgos
      .map((h) => `  ${h.regla}  ${h.archivo}:${h.linea}\n      ${h.detalle}`)
      .join("\n");
    expect(
      hallazgos,
      hallazgos.length === 0
        ? ""
        : `\n${hallazgos.length} violación(es) de las reglas de UI de CLAUDE.md:\n${legible}\n\n` +
            `Corré \`node scripts/audit-ui.mjs\` para el detalle.`,
    ).toEqual([]);
  });

  it("P1 revisa la raíz de la GRAN MAYORÍA de las pantallas", () => {
    /**
     * La parte que se puede romper sin que nadie note: un auditor que se saltea
     * pantallas devuelve cero hallazgos igual que uno que las revisó todas.
     * Este script ya tuvo ese defecto DOS veces —un tope de 400 líneas y el `\r`
     * de CRLF rompiendo el ancla `$`— y las dos veces decía "limpio".
     */
    const out = execFileSync(process.execPath, [SCRIPT, "--cobertura"], { encoding: "utf8" });
    const c = JSON.parse(out) as {
      candidatas: number;
      revisadas: number;
      pct: number;
      saltadas: string[];
    };
    expect(c.candidatas, "el auditor no encontró rutas dentro del shell").toBeGreaterThan(50);
    expect(
      c.pct,
      `P1 solo revisó ${c.revisadas}/${c.candidatas} pantallas. Saltadas:\n  ${c.saltadas.join("\n  ")}`,
    ).toBeGreaterThanOrEqual(85);
    // Y las que se saltean deben decir POR QUÉ: sin motivo no se distingue
    // "acá no aplica la regla" de "el check no supo leer el archivo".
    for (const s of c.saltadas) {
      expect(s, `salteo sin motivo: ${s}`).toMatch(/: .+/);
    }
  });

  it("el auditor de verdad revisa algo: cubre las rutas y los módulos", () => {
    // Un auditor que no encuentra archivos también devuelve cero hallazgos, y
    // pasaría este test para siempre sin mirar nada. Se comprueba el universo.
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).toContain('archivos(path.join(RAIZ, "src/routes")');
    expect(src).toContain('archivos(path.join(RAIZ, "src")');
    // Y que siga cubriendo los principios que dice cubrir.
    for (const regla of ["P1", "P2", "P3", "P7", "DS-loader", "DS-confirm", "DS-vh", "DS-fecha"]) {
      expect(src, `el auditor dejó de chequear ${regla}`).toContain(`"${regla}"`);
    }
    for (const regla of ["R1-modal", "R2-grid", "R3-minw", "R4-padding", "R5-touch"]) {
      expect(src, `el auditor dejó de chequear ${regla}`).toContain(`"${regla}"`);
    }
  });

  it("cada excepción aceptada tiene su motivo escrito", () => {
    // Una excepción sin motivo es un check apagado en silencio: en seis meses
    // nadie sabe si sigue siendo válida.
    const src = fs.readFileSync(SCRIPT, "utf8");
    const bloque = src.slice(src.indexOf("const ACEPTADOS"), src.indexOf("const esAceptado"));
    const entradas = (bloque.match(/regla:/g) ?? []).length;
    const motivos = (bloque.match(/porque:/g) ?? []).length;
    expect(entradas).toBeGreaterThan(0);
    expect(motivos, "hay excepciones sin `porque`").toBe(entradas);
  });
});
