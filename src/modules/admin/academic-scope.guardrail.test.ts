import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guardrail del alcance por institución de la estructura académica.
 *
 * Las policies de lectura de `academic_programs` / `academic_periods` /
 * `academic_subjects` (mig 20260622000000) son
 *   tenant_id = current_tenant_id() OR public.is_super_admin()
 * o sea que para quien posee el rol SuperAdmin la base devuelve las filas de
 * TODAS las instituciones, a propósito. El filtro solo puede vivir en el
 * cliente, y así se propagó el defecto: cada pantalla nueva que agregaba un
 * selector de programa/asignatura/periodo lo hacía sin acotar, porque "la RLS
 * ya acota" es cierto para el Admin y falso para el SuperAdmin.
 *
 * Este test lee el árbol del disco: cualquier archivo que consulte una de esas
 * tres tablas tiene que pasar por `@/modules/admin/academic-scope`. Es lo que
 * impide que el próximo selector nazca sin filtro.
 *
 * Precedente en el repo: `src/modules/whiteboard/page-types.test.ts` y
 * `src/modules/tutor/tutor-default-prompt.test.ts`, que también fijan
 * invariantes leyendo archivos.
 */

const RAIZ = resolve(__dirname, "../..");
const DIRECTORIOS = ["routes", "modules"];

const TABLAS = ["academic_programs", "academic_periods", "academic_subjects"];

/**
 * Excepciones revisadas. NO agregues un archivo acá para que el test pase:
 * es para casos donde el principio no aplica.
 */
const EXCEPCIONES = new Set([
  // Lee la estructura académica por EMBED colgado de una fila padre (el curso
  // del reporte) que ya viene acotada por su propia consulta, así que no hay una
  // lista cross-tenant que recortar.
  "modules/reports/report-context.ts",
  // El módulo del alcance y sus tests.
  "modules/admin/academic-scope.ts",
  "modules/admin/academic-scope.test.ts",
  "modules/admin/academic-scope.guardrail.test.ts",
]);

function archivosFuente(dir: string): string[] {
  const salida: string[] = [];
  const recorrer = (actual: string) => {
    for (const entrada of readdirSync(actual)) {
      const ruta = join(actual, entrada);
      if (statSync(ruta).isDirectory()) {
        recorrer(ruta);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entrada)) salida.push(ruta);
    }
  };
  recorrer(resolve(RAIZ, dir));
  return salida;
}

/** Consulta directa a la tabla: `from("academic_x")` o `from('academic_x')`. */
function consultaDirecta(fuente: string): boolean {
  return TABLAS.some((tabla) => fuente.includes(`from("${tabla}"`) || fuente.includes(`from('${tabla}'`));
}

describe("alcance por institución de la estructura académica", () => {
  const sospechosos = DIRECTORIOS.flatMap(archivosFuente)
    .map((ruta) => ({ ruta, rel: relative(RAIZ, ruta).split(sep).join("/") }))
    .filter(({ rel }) => !EXCEPCIONES.has(rel))
    .map((x) => ({ ...x, fuente: readFileSync(x.ruta, "utf8") }))
    .filter(({ fuente }) => consultaDirecta(fuente));

  it("hay al menos un archivo que consulta la estructura académica (el barrido no quedó vacío)", () => {
    expect(sospechosos.length).toBeGreaterThan(0);
  });

  it.each(sospechosos.map((s) => s.rel))(
    "%s importa academic-scope y aplica conTenant()",
    (rel) => {
      const { fuente } = sospechosos.find((s) => s.rel === rel)!;
      expect(fuente).toContain("@/modules/admin/academic-scope");
      expect(fuente).toContain("conTenant(");
    },
  );
});
