import { describe, expect, it } from "vitest";
import { resumirPendientes, type MatriculaEncuesta } from "./pending-respondents";

const CURSOS = [
  { id: "c1", name: "Arquitectura de Sistemas" },
  { id: "c2", name: "Bases de Datos II" },
];

const nombres = new Map<string, string>([
  ["u1", "Álvarez Ana"],
  ["u2", "Barona Beto"],
  ["u3", "Ñáñez Caro"],
  ["u4", "Zúñiga Dani"],
]);

const m = (courseId: string, userId: string): MatriculaEncuesta => ({ courseId, userId });

describe("resumirPendientes", () => {
  it("desglosa por curso quiénes faltan", () => {
    const r = resumirPendientes(
      CURSOS,
      [m("c1", "u1"), m("c1", "u2"), m("c2", "u3"), m("c2", "u4")],
      nombres,
      new Set(["u1", "u3"]),
    );
    const c1 = r.porCurso.find((x) => x.courseId === "c1")!;
    const c2 = r.porCurso.find((x) => x.courseId === "c2")!;
    expect(c1.total).toBe(2);
    expect(c1.respondieron).toBe(1);
    expect(c1.faltan.map((f) => f.fullName)).toEqual(["Barona Beto"]);
    expect(c2.faltan.map((f) => f.fullName)).toEqual(["Zúñiga Dani"]);
  });

  it("los totales generales cuentan PERSONAS ÚNICAS, no la suma por curso", () => {
    // u1 está en los dos cursos. Sumando los por-curso daría 3 de 3; la verdad
    // es 2 personas. Un total inflado hace que el docente deje de creerle.
    const r = resumirPendientes(
      CURSOS,
      [m("c1", "u1"), m("c2", "u1"), m("c2", "u2")],
      nombres,
      new Set(),
    );
    expect(r.totalUnico).toBe(2);
    expect(r.faltanUnico).toBe(2);
    // pero por curso sí aparece en ambos: ahí la pregunta es a quién escribirle
    expect(r.porCurso.find((x) => x.courseId === "c1")!.faltan).toHaveLength(1);
    expect(r.porCurso.find((x) => x.courseId === "c2")!.faltan).toHaveLength(2);
  });

  it("ordena las secciones por dónde MÁS falta", () => {
    const r = resumirPendientes(
      CURSOS,
      [m("c1", "u1"), m("c2", "u2"), m("c2", "u3"), m("c2", "u4")],
      nombres,
      new Set(["u1"]),
    );
    // c1 no tiene pendientes, c2 tiene 3 → c2 primero.
    expect(r.porCurso.map((x) => x.courseId)).toEqual(["c2", "c1"]);
  });

  it("dentro de cada curso, orden alfabético es-CO", () => {
    const r = resumirPendientes(
      [CURSOS[0]],
      [m("c1", "u4"), m("c1", "u3"), m("c1", "u1")],
      nombres,
      new Set(),
    );
    expect(r.porCurso[0].faltan.map((f) => f.fullName)).toEqual([
      "Álvarez Ana",
      "Ñáñez Caro",
      "Zúñiga Dani",
    ]);
  });

  it("un curso sin matriculados sale con total 0 y sin pendientes", () => {
    const r = resumirPendientes(CURSOS, [m("c1", "u1")], nombres, new Set());
    expect(r.porCurso.find((x) => x.courseId === "c2")).toEqual({
      courseId: "c2",
      courseName: "Bases de Datos II",
      total: 0,
      respondieron: 0,
      faltan: [],
    });
  });

  it("una matrícula de un curso NO vinculado no inventa pendientes", () => {
    const r = resumirPendientes([CURSOS[0]], [m("c1", "u1"), m("c9", "u2")], nombres, new Set());
    expect(r.totalUnico).toBe(1);
    expect(r.porCurso).toHaveLength(1);
  });

  it("respondieron todos: cero pendientes en todos los cursos", () => {
    const r = resumirPendientes(
      CURSOS,
      [m("c1", "u1"), m("c2", "u2")],
      nombres,
      new Set(["u1", "u2"]),
    );
    expect(r.faltanUnico).toBe(0);
    expect(r.porCurso.every((c) => c.faltan.length === 0)).toBe(true);
  });

  it("alguien que respondió pero no está matriculado no descuenta ni aparece", () => {
    // Caso real: el docente desmatricula a alguien después de que respondió.
    const r = resumirPendientes([CURSOS[0]], [m("c1", "u1")], nombres, new Set(["u1", "u9"]));
    expect(r.totalUnico).toBe(1);
    expect(r.respondieronUnico).toBe(1);
    expect(r.faltanUnico).toBe(0);
  });

  it("sin nombre en el mapa muestra un guion, no 'undefined'", () => {
    const r = resumirPendientes([CURSOS[0]], [m("c1", "uX")], new Map(), new Set());
    expect(r.porCurso[0].faltan[0].fullName).toBe("—");
  });

  it("una matrícula duplicada no cuenta dos veces", () => {
    const r = resumirPendientes([CURSOS[0]], [m("c1", "u1"), m("c1", "u1")], nombres, new Set());
    expect(r.porCurso[0].total).toBe(1);
    expect(r.porCurso[0].faltan).toHaveLength(1);
  });

  it("listas vacías no rompen", () => {
    const r = resumirPendientes([], [], new Map(), new Set());
    expect(r).toEqual({ porCurso: [], totalUnico: 0, respondieronUnico: 0, faltanUnico: 0 });
  });

  it("descarta matrículas con campos vacíos", () => {
    const r = resumirPendientes(
      [CURSOS[0]],
      [m("", "u1"), m("c1", ""), m("c1", "u2")] as MatriculaEncuesta[],
      nombres,
      new Set(),
    );
    expect(r.porCurso[0].total).toBe(1);
  });
});
