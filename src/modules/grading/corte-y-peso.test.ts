import { describe, it, expect } from "vitest";
import {
  resolverCorteYPeso,
  indiceDeCortes,
  indicePorActividad,
  filaQueManda,
} from "./corte-y-peso";

const CORTES = indiceDeCortes([
  { id: "k1", name: "Corte 1" },
  { id: "k2", name: "Corte 2" },
]);

describe("resolverCorteYPeso", () => {
  it("devuelve el corte y el porcentaje", () => {
    expect(resolverCorteYPeso("k1", 7.5, CORTES)).toEqual({ corte: "Corte 1", porcentaje: 7.5 });
  });

  it("un 0% SI se muestra", () => {
    // «No cuenta para la nota» y «no sé cuánto vale» son cosas distintas, y la
    // primera es justo lo que el estudiante quiere saber de un quiz de
    // práctica. Callarla lo deja suponiendo que pesa.
    expect(resolverCorteYPeso("k1", 0, CORTES)).toEqual({ corte: "Corte 1", porcentaje: 0 });
  });

  it("sin corte no se muestra nada, aunque tenga peso", () => {
    // El presupuesto vive en el corte: un peso suelto no significa nada.
    expect(resolverCorteYPeso(null, 10, CORTES)).toBeNull();
    expect(resolverCorteYPeso(undefined, 10, CORTES)).toBeNull();
    expect(resolverCorteYPeso("", 10, CORTES)).toBeNull();
  });

  it("un corte DESCONOCIDO falla cerrado", () => {
    // Casi siempre es un corte de OTRO curso; mostrar su peso le atribuiría al
    // estudiante un porcentaje que no es el suyo.
    expect(resolverCorteYPeso("k9", 10, CORTES)).toBeNull();
  });

  it("sin peso no se muestra el porcentaje", () => {
    expect(resolverCorteYPeso("k1", null, CORTES)).toBeNull();
    expect(resolverCorteYPeso("k1", undefined, CORTES)).toBeNull();
  });

  it("un peso que no es un numero no se muestra", () => {
    expect(resolverCorteYPeso("k1", Number.NaN, CORTES)).toBeNull();
    expect(resolverCorteYPeso("k1", Number.POSITIVE_INFINITY, CORTES)).toBeNull();
    expect(resolverCorteYPeso("k1", -5, CORTES)).toBeNull();
  });

  it("acepta el peso como texto, que es como lo devuelve PostgREST en numeric", () => {
    expect(resolverCorteYPeso("k1", "7.5" as unknown as number, CORTES)?.porcentaje).toBe(7.5);
  });
});

describe("indiceDeCortes", () => {
  it("mezcla cortes de varios cursos", () => {
    // La lista del estudiante junta actividades de todos sus cursos y los
    // `cut_id` son únicos entre cursos.
    const m = indiceDeCortes([
      { id: "a", name: "Corte 1" },
      { id: "b", name: "Corte 1" },
    ]);
    expect(m.get("a")).toBe("Corte 1");
    expect(m.get("b")).toBe("Corte 1");
  });

  it("descarta un corte SIN nombre", () => {
    // Dejarlo entrar pintaría una etiqueta vacía con un porcentaje al lado.
    const m = indiceDeCortes([{ id: "a", name: "" }, { id: "b", name: "   " }, { id: "c", name: null }]);
    expect(m.size).toBe(0);
  });

  it("tolera filas nulas", () => {
    expect(indiceDeCortes([null, undefined, { id: "a", name: "Corte 1" }]).size).toBe(1);
  });
});

describe("indicePorActividad", () => {
  it("indexa por el id de la actividad", () => {
    const m = indicePorActividad([
      { actividadId: "w1", cut_id: "k1", weight: 7.5 },
      { actividadId: "w2", cut_id: "k2", weight: 3 },
    ]);
    expect(m.get("w1")?.weight).toBe(7.5);
    expect(m.get("w2")?.cut_id).toBe("k2");
  });

  it("con el taller compartido a dos cursos del alumno, gana la primera fila", () => {
    // Hay que elegir: el taller es uno y su tarjeta también. Dos porcentajes
    // contradictorios sobre la misma tarjeta es peor que elegir.
    const m = indicePorActividad([
      { actividadId: "w1", cut_id: "k1", weight: 7.5 },
      { actividadId: "w1", cut_id: "k2", weight: 2 },
    ]);
    expect(m.get("w1")?.weight).toBe(7.5);
    expect(m.size).toBe(1);
  });

  it("tolera filas sin actividad", () => {
    const m = indicePorActividad([null, { actividadId: null, cut_id: "k1", weight: 1 }]);
    expect(m.size).toBe(0);
  });
});

describe("filaQueManda", () => {
  it("sin fila de union usa la de la actividad", () => {
    // El caso NORMAL en producción: 57 de 66 talleres publicados no tienen
    // fila de unión. Sin este respaldo el 86% de las tarjetas saldría vacía.
    expect(filaQueManda(null, { cut_id: "k1", weight: 2.4 })).toEqual({
      cut_id: "k1",
      weight: 2.4,
    });
  });

  it("con las dos, gana la de UNION", () => {
    // Es la que usan el gradebook y las notas del estudiante para calcular.
    // Mostrar la otra contradiría la nota del propio alumno.
    expect(
      filaQueManda({ cut_id: "k1", weight: 2.5 }, { cut_id: "k1", weight: 10 }),
    ).toEqual({ cut_id: "k1", weight: 2.5 });
  });

  it("una fila de union SIN corte no tapa a la de la actividad", () => {
    // Existe la fila pero nunca se le asignó corte en ese curso; la actividad
    // sí lo tiene. Tomarla como respuesta dejaría la tarjeta en blanco.
    expect(filaQueManda({ cut_id: null, weight: null }, { cut_id: "k1", weight: 2 })).toEqual({
      cut_id: "k1",
      weight: 2,
    });
  });

  it("sin ninguna de las dos no inventa nada", () => {
    expect(filaQueManda(null, null)).toEqual({ cut_id: undefined, weight: undefined });
    expect(resolverCorteYPeso(filaQueManda(null, null).cut_id, undefined, CORTES)).toBeNull();
  });
});
