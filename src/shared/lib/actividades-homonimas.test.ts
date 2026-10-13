import { describe, expect, it } from "vitest";
import { homonimasEnOtrosCursos } from "./actividades-homonimas";

const a = (id: string, title: string, courseId: string, courseName: string) => ({ id, title, courseId, courseName });

describe("homonimasEnOtrosCursos", () => {
  it("marca el mismo nombre en dos cursos, cada uno con el otro curso", () => {
    const m = homonimasEnOtrosCursos([
      a("p2", "Taller Corte 1 (Clases 1 a 4)", "c1", "Programación II"),
      a("sem", "Taller Corte 1 (Clases 1 a 4)", "c2", "Seminario de Sistemas"),
      a("x", "Taller Corte 2", "c1", "Programación II"),
    ]);
    expect(m.get("p2")).toEqual(["Seminario de Sistemas"]);
    expect(m.get("sem")).toEqual(["Programación II"]);
    expect(m.has("x")).toBe(false);
  });

  it("compara sin tildes, mayúsculas ni espacios repetidos (el normalizador del buscador)", () => {
    const m = homonimasEnOtrosCursos([
      a("1", "Proyecto  Integrador", "c1", "Programación II"),
      a("2", "proyecto integrador", "c2", "Seminario"),
      a("3", "Próyecto Integrador ", "c3", "Bases de Datos II"),
    ]);
    expect(m.get("1")).toEqual(["Seminario", "Bases de Datos II"]);
    expect(m.get("3")).toEqual(["Programación II", "Seminario"]);
  });

  it("no marca dos actividades del MISMO curso con el mismo nombre", () => {
    const m = homonimasEnOtrosCursos([
      a("1", "Parcial 1", "c1", "Programación II"),
      a("2", "Parcial 1", "c1", "Programación II"),
    ]);
    expect(m.size).toBe(0);
  });

  it("no compara contra cursos finalizados (semestres pasados)", () => {
    const m = homonimasEnOtrosCursos([
      { ...a("viejo", "Parcial 1", "c0", "Programación II 2026-1"), courseStatus: "finalizado" },
      { ...a("nuevo", "Parcial 1", "c1", "Programación II 2026-2"), courseStatus: "en_curso" },
    ]);
    expect(m.size).toBe(0);
  });

  it("ignora títulos vacíos y no repite el nombre de un curso", () => {
    const m = homonimasEnOtrosCursos([
      a("1", "", "c1", "A"),
      a("2", "", "c2", "B"),
      a("3", "Quiz", "c1", "A"),
      a("4", "Quiz", "c2", "B"),
      a("5", "Quiz", "c2", "B"),
    ]);
    expect(m.has("1")).toBe(false);
    expect(m.get("3")).toEqual(["B"]);
    expect(m.get("4")).toEqual(["A"]);
  });
});
