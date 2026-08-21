import { describe, expect, it } from "vitest";
import { anyCourseInScope, courseIdsInScope, itemInScope } from "./course-filter-scope";

/**
 * Lo que estos tests protegen es UNA distinción: `null` (no hay filtro) vs el
 * conjunto vacío (hay filtro y no matchea nada). Si alguien los colapsa, o se
 * esconde toda la tabla sin filtro puesto, o el filtro deja de filtrar. Es el
 * mismo error que `course-scope.ts` documenta con los `[]` de PostgREST.
 */
const CURSOS = [
  { id: "arq", period: "2026-2", subject: "Arquitectura" },
  { id: "bd2", period: "2026-2", subject: "Bases de Datos II" },
  { id: "prog-viejo", period: "2026-1", subject: "Programación II" },
  { id: "prog", period: "2026-2", subject: "Programación II" },
  { id: "sin-asignatura", period: "2026-1", subject: null },
];

describe("courseIdsInScope", () => {
  it("sin filtros devuelve null, que NO es un conjunto vacío", () => {
    expect(courseIdsInScope(CURSOS, null, null)).toBeNull();
    expect(courseIdsInScope(CURSOS, undefined, undefined)).toBeNull();
    expect(courseIdsInScope(CURSOS, "", "")).toBeNull();
  });

  it("filtra por periodo", () => {
    expect(courseIdsInScope(CURSOS, "2026-2", null)).toEqual(new Set(["arq", "bd2", "prog"]));
  });

  it("filtra por asignatura", () => {
    expect(courseIdsInScope(CURSOS, null, "Programación II")).toEqual(
      new Set(["prog-viejo", "prog"]),
    );
  });

  it("combina los dos: es una intersección, no una unión", () => {
    expect(courseIdsInScope(CURSOS, "2026-2", "Programación II")).toEqual(new Set(["prog"]));
  });

  it("una combinación sin cursos devuelve un conjunto VACÍO, no null", () => {
    const r = courseIdsInScope(CURSOS, "2026-1", "Arquitectura");
    expect(r).not.toBeNull();
    expect(r?.size).toBe(0);
  });

  it("un curso sin asignatura queda fuera al filtrar por asignatura", () => {
    // Es lo correcto: no se le puede atribuir una asignatura que no tiene.
    expect(courseIdsInScope(CURSOS, null, "Programación II")?.has("sin-asignatura")).toBe(false);
    // Pero por periodo sí entra.
    expect(courseIdsInScope(CURSOS, "2026-1", null)?.has("sin-asignatura")).toBe(true);
  });
});

describe("itemInScope", () => {
  it("sin filtro pasa todo, incluso lo que no tiene curso", () => {
    expect(itemInScope(null, "arq")).toBe(true);
    expect(itemInScope(null, null)).toBe(true);
  });

  it("con filtro, un item SIN curso queda fuera", () => {
    // Pizarras y contenidos personales del docente: con un periodo elegido no
    // se pueden atribuir a ese periodo, así que no se muestran.
    const scope = courseIdsInScope(CURSOS, "2026-2", null);
    expect(itemInScope(scope, null)).toBe(false);
    expect(itemInScope(scope, undefined)).toBe(false);
  });

  it("con filtro, respeta la pertenencia", () => {
    const scope = courseIdsInScope(CURSOS, "2026-2", null);
    expect(itemInScope(scope, "arq")).toBe(true);
    expect(itemInScope(scope, "prog-viejo")).toBe(false);
  });
});

describe("anyCourseInScope", () => {
  it("un item compartido entra si CUALQUIERA de sus cursos cumple", () => {
    const scope = courseIdsInScope(CURSOS, "2026-2", null);
    // Un taller compartido entre un curso viejo y uno vigente debe verse: si se
    // exigiera que todos cumplan, el docente perdería su propio trabajo.
    expect(anyCourseInScope(scope, ["prog-viejo", "prog"])).toBe(true);
    expect(anyCourseInScope(scope, ["prog-viejo"])).toBe(false);
  });

  it("sin filtro pasa todo, incluso una lista vacía", () => {
    expect(anyCourseInScope(null, [])).toBe(true);
  });

  it("con filtro, una lista vacía queda fuera", () => {
    const scope = courseIdsInScope(CURSOS, "2026-2", null);
    expect(anyCourseInScope(scope, [])).toBe(false);
    expect(anyCourseInScope(scope, [null, undefined])).toBe(false);
  });
});
