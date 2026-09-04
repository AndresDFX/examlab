import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Dos tipos de pregunta DISTINTOS no pueden mostrar el mismo rótulo en el mismo
 * selector.
 *
 * ── El bug que ataja ──────────────────────────────────────────────────────
 * En el editor de exámenes, `cerrada` (una respuesta) y `cerrada_multi` (varias)
 * salían las dos como «Opción múltiple»: el docente veía la misma opción repetida y
 * no podía saber cuál elegía. Reporte textual: "en las preguntas veo duplicado
 * Opción Múltiple".
 *
 * No es la primera vez. El encabezado de `question-type-label.ts` documenta el MISMO
 * error en el selector de talleres, arreglado antes; el de exámenes quedó igual y
 * nadie lo notó, porque un rótulo repetido no rompe nada: compila, renderiza, y el
 * único síntoma es una persona confundida.
 *
 * ── Por qué un test que lee los archivos ──────────────────────────────────
 * No hay un tipo que pueda expresar "estas dos claves i18n distintas resuelven al
 * mismo texto". Lo único que lo detecta es resolver los rótulos de verdad y
 * comparar, que es lo que hace este test — sobre TODOS los selectores del repo, así
 * que también cubre los que se agreguen después.
 */

const SRC = resolve(__dirname, "../..");
const LOCALES = resolve(__dirname, "../../i18n/locales");

/** Tipos internos de pregunta. Un `value` que no esté acá no es un tipo. */
const TIPOS = new Set([
  "abierta",
  "cerrada",
  "cerrada_multi",
  "codigo",
  "codigo_zip",
  "diagrama",
  "java_gui",
  "python_gui",
  "red_consola",
  "red_gui",
  "so_consola",
  "bd_sql",
]);

function archivosTsx(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) archivosTsx(p, out);
    else if (f.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function cargarLocale(l: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(LOCALES, `${l}.json`), "utf8"));
}

function resolverClave(dic: Record<string, unknown>, clave: string): string | null {
  const v = clave.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], dic);
  return typeof v === "string" ? v : null;
}

/** `<SelectItem value="<tipo>">{t("<clave>")` de un archivo. */
function opcionesDeTipo(texto: string): Array<{ tipo: string; clave: string }> {
  const re = /<SelectItem\s+value="([a-z_]+)"[^>]*>\{t\("([^"]+)"/g;
  const out: Array<{ tipo: string; clave: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    if (TIPOS.has(m[1])) out.push({ tipo: m[1], clave: m[2] });
  }
  return out;
}

describe("los rótulos de tipo de pregunta son únicos por selector", () => {
  const archivos = archivosTsx(SRC).filter((f) => opcionesDeTipo(readFileSync(f, "utf8")).length >= 2);

  it("hay selectores de tipo de pregunta que revisar", () => {
    // Si este test se queda sin nada que mirar (una refactorización cambió el
    // markup), los demás pasarían en vacío y el guardrail sería decorativo.
    expect(archivos.length).toBeGreaterThan(0);
  });

  for (const locale of ["es", "en"]) {
    it(`ningún selector repite un rótulo en ${locale}`, () => {
      const dic = cargarLocale(locale);
      const problemas: string[] = [];
      for (const f of archivos) {
        const porRotulo = new Map<string, Set<string>>();
        for (const { tipo, clave } of opcionesDeTipo(readFileSync(f, "utf8"))) {
          const rotulo = resolverClave(dic, clave);
          if (!rotulo) continue;
          if (!porRotulo.has(rotulo)) porRotulo.set(rotulo, new Set());
          porRotulo.get(rotulo)!.add(tipo);
        }
        for (const [rotulo, tipos] of porRotulo) {
          if (tipos.size > 1) {
            problemas.push(`${f.replace(SRC, "src")}: «${rotulo}» → ${[...tipos].join(" y ")}`);
          }
        }
      }
      expect(problemas, problemas.join("\n")).toEqual([]);
    });

    it(`toda clave de rótulo usada existe en ${locale}`, () => {
      // Una clave inexistente hace que i18next imprima la clave cruda —
      // «hc_routesAppTeacherExamsExamId.typeSingleChoice» en un selector.
      const dic = cargarLocale(locale);
      const faltan: string[] = [];
      for (const f of archivos) {
        for (const { clave } of opcionesDeTipo(readFileSync(f, "utf8"))) {
          if (resolverClave(dic, clave) === null) faltan.push(`${f.replace(SRC, "src")}: ${clave}`);
        }
      }
      expect(faltan, faltan.join("\n")).toEqual([]);
    });
  }
});
