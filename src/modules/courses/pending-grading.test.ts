import { describe, expect, it } from "vitest";
import { aggregatePendingGradingByCourse } from "./pending-grading";

const courses = [
  { id: "c1", name: "Programación II" },
  { id: "c2", name: "Algoritmos" },
];

describe("aggregatePendingGradingByCourse", () => {
  it("agrupa por curso vía activityToCourse y ordena por count desc", () => {
    const activityToCourse = new Map([
      ["ex1", "c1"],
      ["ws1", "c1"],
      ["pr1", "c2"],
    ]);
    // 2 pendientes de c1 (ex1, ws1) + 1 de c2 (pr1).
    const { total, byCourse } = aggregatePendingGradingByCourse(courses, activityToCourse, [
      "ex1",
      "ws1",
      "pr1",
    ]);
    expect(total).toBe(3);
    expect(byCourse[0]).toEqual({ courseId: "c1", courseName: "Programación II", count: 2 });
    expect(byCourse[1]).toEqual({ courseId: "c2", courseName: "Algoritmos", count: 1 });
  });

  it("cuenta cada entrega: misma actividad repetida suma", () => {
    const { total, byCourse } = aggregatePendingGradingByCourse(
      courses,
      new Map([["ex1", "c1"]]),
      ["ex1", "ex1", "ex1"], // 3 submissions del mismo examen
    );
    expect(total).toBe(3);
    expect(byCourse[0].count).toBe(3);
  });

  it("ignora actividades fuera de los cursos del docente (sin mapeo)", () => {
    const { total, byCourse } = aggregatePendingGradingByCourse(
      courses,
      new Map([["ex1", "c1"]]),
      ["ex1", "huerfano"], // 'huerfano' no está en el map
    );
    expect(total).toBe(1);
    expect(byCourse).toHaveLength(1);
  });

  it("cursos sin pendientes no aparecen", () => {
    const { byCourse } = aggregatePendingGradingByCourse(
      courses,
      new Map([["ex1", "c1"]]),
      ["ex1"],
    );
    expect(byCourse.map((c) => c.courseId)).toEqual(["c1"]);
  });

  it("sin pendientes → total 0, lista vacía", () => {
    const { total, byCourse } = aggregatePendingGradingByCourse(courses, new Map(), []);
    expect(total).toBe(0);
    expect(byCourse).toHaveLength(0);
  });

  it("usa el id como nombre si el curso no está en la lista", () => {
    const { byCourse } = aggregatePendingGradingByCourse(
      [],
      new Map([["ex1", "c9"]]),
      ["ex1"],
    );
    expect(byCourse[0].courseName).toBe("c9");
  });
});
