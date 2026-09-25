import { describe, it, expect } from "vitest";
import { cursosSinVocero, dentroDeFechas } from "./cursos-sin-vocero";

// Las fechas se construyen en hora LOCAL (constructor de componentes) y no
// con un ISO que lleve desfase fijo. El helper ancla las columnas DATE a
// mediodía local —misma defensa que `course-status` contra el bug de restar un
// día por UTC—, así que un `-05:00` escrito a mano solo coincide si la máquina
// está en UTC-5. CI corre en UTC y por eso «el día de fin se cuenta ENTERO»
// fallaba allá y pasaba acá.
const local = (a: number, m: number, d: number, h = 0) => new Date(a, m - 1, d, h).getTime();
const AHORA = local(2026, 9, 24, 15);
const curso = (over: Partial<Parameters<typeof cursosSinVocero>[0][number]> = {}) => ({
  id: "c1",
  name: "Curso",
  status: "en_curso",
  start_date: "2026-08-24",
  end_date: "2026-12-10",
  ...over,
});
const SIN = new Set<string>();

describe("dentroDeFechas", () => {
  it("un curso sin fecha de fin cuenta como vigente", () => {
    // Callarlo por un dato que el docente nunca cargó dejaría sin aviso
    // justamente al curso peor configurado.
    expect(dentroDeFechas({ end_date: null }, AHORA)).toBe(true);
    expect(dentroDeFechas({}, AHORA)).toBe(true);
  });

  it("una fecha de fin ilegible no silencia el aviso", () => {
    expect(dentroDeFechas({ end_date: "no-es-fecha" }, AHORA)).toBe(true);
  });

  it("el dia de fin se cuenta ENTERO", () => {
    // El ancla es mediodía: sin correr al cierre de la jornada, el último día
    // del curso el aviso desaparecería a mitad de la mañana.
    const finHoy = { end_date: "2026-09-24" };
    expect(dentroDeFechas(finHoy, local(2026, 9, 24, 8))).toBe(true);
    expect(dentroDeFechas(finHoy, local(2026, 9, 24, 22))).toBe(true);
  });

  it("pasado el dia de fin deja de estar vigente", () => {
    expect(dentroDeFechas({ end_date: "2026-09-24" }, local(2026, 9, 26, 8))).toBe(false);
  });
});

describe("cursosSinVocero", () => {
  it("lista el curso en marcha que no tiene vocero", () => {
    expect(cursosSinVocero([curso()], SIN, AHORA).map((c) => c.id)).toEqual(["c1"]);
  });

  it("no lista el que YA tiene vocero", () => {
    expect(cursosSinVocero([curso()], new Set(["c1"]), AHORA)).toEqual([]);
  });

  it("no avisa de un BORRADOR", () => {
    // Todavía no existe para nadie; pedir su vocero es ruido.
    expect(cursosSinVocero([curso({ status: "borrador" })], SIN, AHORA)).toEqual([]);
  });

  it("no avisa de un curso FINALIZADO", () => {
    // Designarlo ahora no reescribe el acuerdo: el HTML quedó congelado.
    expect(cursosSinVocero([curso({ status: "finalizado" })], SIN, AHORA)).toEqual([]);
  });

  it("no avisa de un curso que todavia NO empieza", () => {
    expect(cursosSinVocero([curso({ start_date: "2026-11-01" })], SIN, AHORA)).toEqual([]);
  });

  it("no avisa de un curso cuya fecha de fin ya paso, aunque siga en_curso", () => {
    // `deriveCourseDisplayState` lo mantiene 'en_curso' a propósito hasta que
    // el cron lo cierre; para ESTE aviso ya no sirve de nada.
    expect(cursosSinVocero([curso({ end_date: "2026-08-30" })], SIN, AHORA)).toEqual([]);
  });

  it("un curso sin fechas y en_curso SI se avisa", () => {
    expect(
      cursosSinVocero([curso({ start_date: null, end_date: null })], SIN, AHORA).map((c) => c.id),
    ).toEqual(["c1"]);
  });

  it("separa los que tienen vocero de los que no, en una tanda mixta", () => {
    const lista = [
      curso({ id: "conVocero" }),
      curso({ id: "sinVocero" }),
      curso({ id: "borrador", status: "borrador" }),
      curso({ id: "terminado", status: "finalizado" }),
    ];
    expect(cursosSinVocero(lista, new Set(["conVocero"]), AHORA).map((c) => c.id)).toEqual([
      "sinVocero",
    ]);
  });

  it("sin cursos no devuelve nada", () => {
    expect(cursosSinVocero([], SIN, AHORA)).toEqual([]);
  });
});
