/**
 * Las DOS copias del calificador determinista tienen que dar la MISMA nota.
 *
 * ── Por qué existe este archivo ───────────────────────────────────────
 *
 * La nota de una pregunta cerrada la calcula un código distinto según quién
 * dispare la calificación:
 *
 *   · Al ENTREGAR el estudiante, la pone el edge
 *     `supabase/functions/_shared/deterministic-scoring.ts` (`scoreDeterministic`).
 *   · Al RECALIFICAR el docente, la pone el navegador con
 *     `src/modules/grading/deterministic-scoring.ts` (`scoreDeterministaCliente`),
 *     porque ese camino no manda `submissionId` y no puede delegar en el
 *     servidor.
 *
 * Son dos archivos porque Deno no importa de `src/`. Y ya divergieron una vez,
 * con consecuencias reales: el camino del docente tenía `earned: 0` fijo para
 * toda pregunta cerrada, así que una respuesta correcta valía 1 punto si la
 * calificaba el servidor y 0 si la recalificaba el docente. En producción eso
 * dejó a tres estudiantes de «Joins en SQL» con nota inferior a la que les
 * correspondía —uno con 0 habiendo acertado las dos cerradas— y lo descubrió un
 * estudiante reclamando, no la plataforma.
 *
 * El arreglo de código ya está. Lo que faltaba es esto: algo que falle si
 * alguien vuelve a tocar una copia y no la otra. CLAUDE.md lista la invariante
 * en prosa, y la prosa no corre en CI.
 *
 * ── Qué compara ───────────────────────────────────────────────────────
 *
 * Solo el PUNTAJE (`earned`), no el texto de la retroalimentación: el cliente
 * devuelve un `outcome` para que la pantalla arme su propio mensaje y el edge
 * devuelve la frase ya escrita. Esa diferencia es de diseño. Lo que no puede
 * diferir es cuánto vale la respuesta.
 *
 * Las de red (`red_consola`, `red_gui`) quedan fuera: dependen del simulador y
 * su escenario, que no es lo que este archivo custodia.
 */
import { describe, it, expect } from "vitest";
import { scoreDeterministaCliente } from "./deterministic-scoring";
import { scoreDeterministic } from "../../../supabase/functions/_shared/deterministic-scoring";

/** Una pregunta cerrada con su clave. */
const cerrada = (correct: unknown, points = 1) =>
  ({ type: "cerrada" as const, points, options: { correct_index: correct } });

const multi = (correctIndices: unknown[], points = 2, extra: Record<string, unknown> = {}) =>
  ({ type: "cerrada_multi" as const, points, options: { correct_indices: correctIndices, ...extra } });

describe("paridad entre el calificador del servidor y el del navegador", () => {
  const casos: Array<{ nombre: string; q: ReturnType<typeof cerrada>; respuesta: unknown }> = [
    { nombre: "acierta", q: cerrada(3), respuesta: 3 },
    { nombre: "falla", q: cerrada(3), respuesta: 1 },
    // El taller guarda `selected_option` como TEXTO, y ahí empezó el problema.
    { nombre: "acierta con el indice como texto", q: cerrada(3), respuesta: "3" },
    { nombre: "falla con el indice como texto", q: cerrada(3), respuesta: "0" },
    { nombre: "la opcion 0 es una opcion valida", q: cerrada(0), respuesta: 0 },
    { nombre: "la opcion 0 como texto", q: cerrada(0), respuesta: "0" },
    // Sin responder NO puede valer el punto: fue el otro error real, y le dio
    // puntaje completo a una pregunta en blanco.
    { nombre: "sin responder", q: cerrada(3), respuesta: null },
    { nombre: "sin responder con cadena vacia", q: cerrada(3), respuesta: "" },
    { nombre: "sin responder e indefinido", q: cerrada(3), respuesta: undefined },
    // Y el caso que documenta el guard del edge: clave ausente + sin responder.
    { nombre: "sin clave y sin responder", q: cerrada(undefined), respuesta: undefined },
    { nombre: "sin clave pero respondida", q: cerrada(undefined), respuesta: 2 },
    { nombre: "clave nula", q: cerrada(null), respuesta: 1 },
    { nombre: "respuesta que no es un indice", q: cerrada(3), respuesta: "tres" },
    { nombre: "pregunta que vale 0 puntos", q: cerrada(1, 0), respuesta: 1 },
  ];

  for (const c of casos) {
    it(`da el mismo puntaje: ${c.nombre}`, () => {
      const servidor = scoreDeterministic(c.q as never, c.respuesta);
      const navegador = scoreDeterministaCliente(c.q as never, c.respuesta);
      expect(navegador.earned).toBe(servidor.earned);
    });
  }

  const casosMulti: Array<{ nombre: string; q: ReturnType<typeof multi>; respuesta: unknown }> = [
    { nombre: "todas las correctas", q: multi([0, 2]), respuesta: [0, 2] },
    { nombre: "la mitad", q: multi([0, 2]), respuesta: [0] },
    { nombre: "ninguna", q: multi([0, 2]), respuesta: [1] },
    { nombre: "sin responder", q: multi([0, 2]), respuesta: [] },
    { nombre: "indices como texto", q: multi([0, 2]), respuesta: ["0", "2"] },
    { nombre: "supera el maximo", q: multi([0, 2], 2, { max_selections: 1 }), respuesta: [0, 2] },
    { nombre: "no llega al minimo", q: multi([0, 2], 2, { min_selections: 2 }), respuesta: [0] },
  ];

  for (const c of casosMulti) {
    it(`da el mismo puntaje en multiple: ${c.nombre}`, () => {
      const servidor = scoreDeterministic(c.q as never, c.respuesta);
      const navegador = scoreDeterministaCliente(c.q as never, c.respuesta);
      expect(navegador.earned).toBeCloseTo(servidor.earned, 6);
    });
  }

  it("una respuesta correcta NUNCA vale cero", () => {
    // El sintoma exacto del incidente, escrito como su propia comprobación:
    // si alguien vuelve a fijar `earned: 0`, esto falla antes de llegar a un
    // estudiante.
    for (const respuesta of [3, "3"]) {
      expect(scoreDeterministaCliente(cerrada(3) as never, respuesta).earned).toBe(1);
      expect(scoreDeterministic(cerrada(3) as never, respuesta).earned).toBe(1);
    }
  });

  it("una pregunta en blanco NUNCA vale el punto", () => {
    for (const respuesta of [null, undefined, ""]) {
      expect(scoreDeterministaCliente(cerrada(3) as never, respuesta).earned).toBe(0);
      expect(scoreDeterministic(cerrada(3) as never, respuesta).earned).toBe(0);
    }
  });
});
