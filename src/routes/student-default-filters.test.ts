/**
 * El default de lo que ve el estudiante al entrar a Exámenes, Talleres y
 * Proyectos.
 *
 * ── El bug que ataja ──────────────────────────────────────────────────
 * El default mostraba solo lo disponible, así que un alumno que ya presentó
 * todo abría la lista y la veía VACÍA — sin forma de mirar qué nota sacó, que
 * es justo lo que va a buscar cuando ya entregó. Y lo CERRADO debe seguir
 * fuera: eso es lo que ya no se puede hacer ni revisar.
 *
 * Se lee del disco porque las constantes viven en archivos de ruta (con JSX y
 * dependencias del router), que no se pueden importar en un test puro.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function defaultDe(archivo: string): string[] {
  const src = readFileSync(resolve(process.cwd(), "src/routes", archivo), "utf8");
  const bloque = src.match(/const FILTRO_POR_DEFECTO[^=]*=\s*(\[[^\]]*\])/);
  if (!bloque) throw new Error(`${archivo}: no encontré FILTRO_POR_DEFECTO`);
  return [...bloque[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

describe("lo que el estudiante ve al entrar", () => {
  it("Exámenes muestra lo completado, para poder ver la nota", () => {
    const d = defaultDe("app.student.exams.tsx");
    expect(d).toContain("completed");
    expect(d).toContain("available");
  });

  it("Talleres y Proyectos muestran lo entregado y lo calificado", () => {
    for (const archivo of ["app.student.workshops.tsx", "app.student.projects.tsx"]) {
      const d = defaultDe(archivo);
      expect(d, archivo).toContain("graded");
      expect(d, archivo).toContain("submitted");
      expect(d, archivo).toContain("available");
    }
  });

  it("lo CERRADO no entra al default en ninguna de las tres", () => {
    for (const archivo of [
      "app.student.exams.tsx",
      "app.student.workshops.tsx",
      "app.student.projects.tsx",
    ]) {
      expect(defaultDe(archivo), archivo).not.toContain("closed");
    }
  });

  it("«limpiar filtros» vuelve al MISMO default, no a otra lista", () => {
    // Estaba escrito dos veces; si vuelven a divergir, limpiar deja al alumno
    // con una lista distinta de la que vio al entrar y nada lo señala.
    for (const archivo of [
      "app.student.exams.tsx",
      "app.student.workshops.tsx",
      "app.student.projects.tsx",
    ]) {
      const src = readFileSync(resolve(process.cwd(), "src/routes", archivo), "utf8");
      const usos = [...src.matchAll(/setStatusFilter\(([^)]*)\)/g)].map((m) => m[1].trim());
      const literales = usos.filter((u) => u.startsWith("["));
      expect(literales, `${archivo}: usá FILTRO_POR_DEFECTO`).toEqual([]);
      expect(usos.filter((u) => u === "FILTRO_POR_DEFECTO").length).toBeGreaterThan(0);
    }
  });
});
