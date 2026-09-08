// Pruebas de la calificación DETERMINISTA server-side (cerradas, opción
// múltiple). Import real del módulo del edge, no una copia.
//
// El caso que justifica este archivo es el primero: en el EXAMEN la respuesta
// de una cerrada viaja como NÚMERO (JSONB) y en el TALLER como STRING
// (`selected_option` es TEXT y el cliente guarda `String(raw)`). Ahora que la
// nota determinista la calcula el servidor para los dos, un helper que solo
// aceptara `number` pondría 0 a TODAS las cerradas de todos los talleres —
// sin error, sin log y sin que nadie lo note hasta el reclamo.
import { describe, expect, it } from "vitest";
import { esDeterminista, esRespuestaVacia, scoreDeterministic } from "./deterministic-scoring.ts";

const cerrada = (correct_index: unknown, points = 2) => ({
  id: "q1",
  type: "cerrada",
  points,
  options: { correct_index },
});

describe("esDeterminista", () => {
  it("cubre los cuatro tipos que no necesitan modelo", () => {
    for (const t of ["cerrada", "cerrada_multi", "red_consola", "red_gui"]) {
      expect(esDeterminista(t)).toBe(true);
    }
  });

  it("deja fuera los que sí necesitan IA", () => {
    for (const t of ["abierta", "codigo", "bd_sql", "diagrama", "so_consola", "codigo_zip"]) {
      expect(esDeterminista(t)).toBe(false);
    }
  });
});

describe("scoreDeterministic — cerrada", () => {
  it("acepta el índice como STRING, que es la forma del taller", () => {
    // selected_option es TEXT: si esto se rompe, toda cerrada de taller vale 0.
    expect(scoreDeterministic(cerrada(2), "2").earned).toBe(2);
    expect(scoreDeterministic(cerrada(2), " 2 ").earned).toBe(2);
    expect(scoreDeterministic(cerrada(0), "0").earned).toBe(2);
  });

  it("acepta el índice como NÚMERO, que es la forma del examen", () => {
    expect(scoreDeterministic(cerrada(2), 2).earned).toBe(2);
    expect(scoreDeterministic(cerrada(0), 0).earned).toBe(2);
  });

  it("la opción 0 no se confunde con «sin responder»", () => {
    // 0 es un índice válido y además falsy: el bug clásico sería darlo por vacío.
    expect(scoreDeterministic(cerrada(0), "0").earned).toBe(2);
    expect(scoreDeterministic(cerrada(1), "0").earned).toBe(0);
  });

  it("una respuesta equivocada da 0", () => {
    expect(scoreDeterministic(cerrada(2), "1").earned).toBe(0);
    expect(scoreDeterministic(cerrada(2), 1).earned).toBe(0);
  });

  it("sin responder da 0", () => {
    expect(scoreDeterministic(cerrada(2), "").earned).toBe(0);
    expect(scoreDeterministic(cerrada(2), null).earned).toBe(0);
    expect(scoreDeterministic(cerrada(2), undefined).earned).toBe(0);
    expect(scoreDeterministic(cerrada(2), "no es un numero").earned).toBe(0);
  });

  it("una pregunta MAL CONFIGURADA (sin correct_index) no regala el puntaje", () => {
    // Sin el guard, undefined === undefined daba puntaje completo por una
    // pregunta en blanco.
    expect(scoreDeterministic(cerrada(undefined), undefined).earned).toBe(0);
    expect(scoreDeterministic(cerrada(null), null).earned).toBe(0);
    expect(scoreDeterministic(cerrada("ninguno"), "ninguno").earned).toBe(0);
  });

  it("el feedback sale en el idioma del curso", () => {
    expect(scoreDeterministic(cerrada(1), "1", "es").feedback).toBe("Respuesta correcta");
    expect(scoreDeterministic(cerrada(1), "1", "en").feedback).toBe("Correct answer");
    expect(scoreDeterministic(cerrada(1), "0", "en").feedback).toBe("Incorrect answer");
  });
});

describe("scoreDeterministic — cerrada_multi", () => {
  const multi = (options: Record<string, unknown>, points = 4) => ({
    id: "q2",
    type: "cerrada_multi",
    points,
    options,
  });

  it("es proporcional a los aciertos, sin penalizar", () => {
    const q = multi({ correct_indices: [0, 1] });
    expect(scoreDeterministic(q, [0, 1]).earned).toBe(4);
    expect(scoreDeterministic(q, [0]).earned).toBe(2);
    expect(scoreDeterministic(q, [2, 3]).earned).toBe(0);
  });

  it("marcar una de más no resta lo acertado", () => {
    const q = multi({ correct_indices: [0, 1] });
    expect(scoreDeterministic(q, [0, 1, 2]).earned).toBe(4);
  });

  it("respeta el mínimo y el máximo de marcadas", () => {
    expect(scoreDeterministic(multi({ correct_indices: [0, 1], max_selections: 1 }), [0, 1]).earned)
      .toBe(0);
    expect(scoreDeterministic(multi({ correct_indices: [0, 1], min_selections: 2 }), [0]).earned)
      .toBe(0);
  });

  it("sin marcar nada da 0", () => {
    expect(scoreDeterministic(multi({ correct_indices: [0] }), []).earned).toBe(0);
    expect(scoreDeterministic(multi({ correct_indices: [0] }), null).earned).toBe(0);
  });

  it("no cuenta dos veces la misma opción marcada", () => {
    const q = multi({ correct_indices: [0, 1] });
    expect(scoreDeterministic(q, [0, 0, 0]).earned).toBe(2);
  });
});

describe("esRespuestaVacia", () => {
  it("vacío, espacios y nulos son vacío", () => {
    expect(esRespuestaVacia({}, "")).toBe(true);
    expect(esRespuestaVacia({}, "   ")).toBe(true);
    expect(esRespuestaVacia({}, null)).toBe(true);
    expect(esRespuestaVacia({}, undefined)).toBe(true);
    expect(esRespuestaVacia({}, [])).toBe(true);
  });

  it("la plantilla del docente intacta cuenta como NO respondida", () => {
    const q = { starter_code: "public class Main {\n}\n" };
    expect(esRespuestaVacia(q, "public class Main {\n}\n")).toBe(true);
    expect(esRespuestaVacia(q, "  public class Main {\n}\n  ")).toBe(true);
    expect(esRespuestaVacia(q, "public class Main {\n  int x = 1;\n}\n")).toBe(false);
  });

  it("una respuesta de verdad no es vacía", () => {
    expect(esRespuestaVacia({}, "algo")).toBe(false);
    expect(esRespuestaVacia({}, [0])).toBe(false);
  });
});
