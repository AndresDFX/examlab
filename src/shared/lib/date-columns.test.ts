import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guardrail contra el bug UTC −1 día en columnas DATE.
 *
 * ── Por qué un test que lee el CÓDIGO FUENTE ──────────────────────────
 * Los helpers ya están testeados: `formatDateOnly` tiene su caso en
 * `format.test.ts` y `DateCell` variant=auto el suyo en `date-cell.test.tsx`.
 * El bug nunca estuvo en los helpers — estuvo en los CALL SITES eligiendo el
 * helper equivocado, y eso ningún test de helper puede atrapar.
 *
 * Y reincide: el comentario de `formatSessionLabel` (format.ts) documenta que
 * ya había pasado en polls, forum y attendance, y el 2026-08-23 aparecieron 7
 * sitios más (los dos foros, dos de asistencia, el Select de sesión de
 * pizarras, los periodos académicos y el tablero de contenidos). Un docente
 * creaba una sesión el 24 de agosto y la plataforma decía 23.
 *
 * ── La regla ──────────────────────────────────────────────────────────
 * Las columnas `DATE` del esquema llegan como `"YYYY-MM-DD"` crudo. `new Date()`
 * las interpreta como MEDIANOCHE UTC, así que en cualquier zona negativa
 * —toda Colombia— se muestran un día antes. Por eso:
 *
 *   · `formatDate` / `formatDateShort` / `formatDateLong` **no** reciben una
 *     columna DATE sin anclar. Se usa `formatDateOnly` (ancla a T12:00:00) o
 *     `formatSessionLabel`, o se concatena `+ "T12:00:00"` explícito.
 *   · `<DateCell>` sobre una columna DATE va **sin** `variant`, para que use el
 *     default `auto` que detecta el patrón y llama a `formatDateOnly`.
 *     `variant="date"` fuerza `formatDate` y saltea la protección.
 *
 * Si este test falla, el arreglo NO es editar el test: es cambiar el call site.
 */

/** Columnas `DATE` (sin hora) del esquema. Extraídas de supabase/migrations. */
const COLUMNAS_DATE = ["session_date", "start_date", "end_date", "holiday_date"];

function archivosFuente(dir: string, out: string[] = []): string[] {
  for (const nombre of readdirSync(dir)) {
    const p = join(dir, nombre);
    if (statSync(p).isDirectory()) {
      archivosFuente(p, out);
    } else if (/\.tsx?$/.test(nombre) && !/\.test\.tsx?$/.test(nombre)) {
      out.push(p);
    }
  }
  return out;
}

const FUENTES = archivosFuente("src");

describe("columnas DATE: nadie las formatea sin anclar (bug UTC -1 día)", () => {
  it.each(COLUMNAS_DATE)(
    "%s no llega crudo a formatDate/formatDateShort/formatDateLong",
    (columna) => {
      // Captura `formatDate(algo.session_date)` y variantes, y descarta las que
      // anclan con `+ "T12:00:00"` en la misma llamada.
      const rx = new RegExp(
        String.raw`format(?:Date|DateShort|DateLong)\(\s*[\w.?[\]]*\b${columna}\b\s*\)`,
        "g",
      );
      const ofensores: string[] = [];
      for (const f of FUENTES) {
        const src = readFileSync(f, "utf8");
        const lineas = src.split("\n");
        lineas.forEach((l, i) => {
          if (l.trimStart().startsWith("*") || l.trimStart().startsWith("//")) return;
          if (rx.test(l)) ofensores.push(`${f}:${i + 1}  ${l.trim().slice(0, 100)}`);
          rx.lastIndex = 0;
        });
      }
      expect(ofensores).toEqual([]);
    },
  );

  it('<DateCell variant="date"> no se usa sobre una columna DATE', () => {
    // `variant="date"` fuerza formatDate. Sobre un timestamptz está bien
    // (created_at, issued_at); sobre una columna DATE corre el día.
    const rx = new RegExp(
      String.raw`<DateCell[^>]*value=\{[^}]*\b(?:${COLUMNAS_DATE.join("|")})\b[^}]*\}[^>]*variant="date"`,
      "g",
    );
    const ofensores: string[] = [];
    for (const f of FUENTES) {
      const src = readFileSync(f, "utf8");
      let m: RegExpExecArray | null;
      while ((m = rx.exec(src)) !== null) {
        ofensores.push(`${f}:${src.slice(0, m.index).split("\n").length}  ${m[0].slice(0, 90)}`);
      }
    }
    expect(ofensores).toEqual([]);
  });
});
