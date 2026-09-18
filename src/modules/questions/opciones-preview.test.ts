import { describe, expect, it } from "vitest";
import { previsualizarOpciones, tieneOpciones } from "./opciones-preview";

const marcadas = (p: ReturnType<typeof previsualizarOpciones>) =>
  (p?.opciones ?? []).filter((o) => o.correcta).map((o) => o.letra);

describe("previsualizarOpciones", () => {
  it("no aplica a los tipos que no son de selección", () => {
    expect(previsualizarOpciones("abierta", { choices: ["a", "b"] })).toBeNull();
    expect(previsualizarOpciones("codigo", null)).toBeNull();
    expect(tieneOpciones("cerrada")).toBe(true);
    expect(tieneOpciones("cerrada_multi")).toBe(true);
    expect(tieneOpciones("diagrama")).toBe(false);
  });

  it("sin opciones no hay nada que previsualizar", () => {
    expect(previsualizarOpciones("cerrada", null)).toBeNull();
    expect(previsualizarOpciones("cerrada", { choices: [] })).toBeNull();
  });

  it("numera con letras y marca la correcta de una cerrada", () => {
    const p = previsualizarOpciones("cerrada", {
      choices: ["uno", "dos", "tres"],
      correct_index: 1,
    });
    expect(p?.opciones.map((o) => o.letra)).toEqual(["A", "B", "C"]);
    expect(marcadas(p)).toEqual(["B"]);
    expect(p?.sinClave).toBe(false);
    expect(p?.multiple).toBe(false);
  });

  it("acepta el índice guardado como TEXTO, igual que el calificador", () => {
    // `parseOptionIndex` existe justo porque esta forma vive en producción: el
    // taller guarda la opción en una columna TEXT. La vista que comparaba con
    // `===` estricto no marcaba nada acá.
    const p = previsualizarOpciones("cerrada", {
      choices: ["uno", "dos", "tres"],
      correct_index: "2",
    });
    expect(marcadas(p)).toEqual(["C"]);
    expect(p?.sinClave).toBe(false);
  });

  it("marca TODAS las correctas de una opción múltiple", () => {
    const p = previsualizarOpciones("cerrada_multi", {
      choices: ["uno", "dos", "tres", "cuatro"],
      correct_indices: [0, 2],
    });
    expect(marcadas(p)).toEqual(["A", "C"]);
    expect(p?.multiple).toBe(true);
    expect(p?.sinClave).toBe(false);
  });

  it("lee correct_indices serializado como JSON", () => {
    const p = previsualizarOpciones("cerrada_multi", {
      choices: ["uno", "dos", "tres"],
      correct_indices: "[1,2]",
    });
    expect(marcadas(p)).toEqual(["B", "C"]);
  });

  it("expone el mínimo y el máximo de selecciones, solo en la múltiple", () => {
    const multi = previsualizarOpciones("cerrada_multi", {
      choices: ["a", "b", "c"],
      correct_indices: [0],
      min_selections: 1,
      max_selections: 2,
    });
    expect(multi?.minSelecciones).toBe(1);
    expect(multi?.maxSelecciones).toBe(2);

    const simple = previsualizarOpciones("cerrada", {
      choices: ["a", "b"],
      correct_index: 0,
      min_selections: 1,
    });
    expect(simple?.minSelecciones).toBeNull();
  });

  it("avisa cuando NO hay respuesta correcta: esa pregunta puntúa 0 siempre", () => {
    const p = previsualizarOpciones("cerrada", { choices: ["uno", "dos"] });
    expect(p?.sinClave).toBe(true);
    expect(marcadas(p)).toEqual([]);
  });

  it("un índice fuera de rango cuenta como falta de clave, no como marcado", () => {
    // No marca nada, así que el calificador le dará 0 igual que sin clave. Si
    // esto no contara como `sinClave`, la lista se vería «bien» y el error
    // aparecería recién con la entrega del estudiante.
    const p = previsualizarOpciones("cerrada", { choices: ["uno", "dos"], correct_index: 7 });
    expect(p?.sinClave).toBe(true);
    expect(marcadas(p)).toEqual([]);
  });

  it("una fila con la clave del OTRO tipo se delata, no se disimula", () => {
    // El calificador lee SOLO `correct_index` en una cerrada y SOLO
    // `correct_indices` en una múltiple, en el cliente y en el edge. Así que
    // estas dos filas puntúan 0 a todo el mundo, incluido quien elija «la
    // correcta». Marcarla en verde escondería exactamente el problema que esta
    // vista existe para mostrar.
    const multiConIndiceSimple = previsualizarOpciones("cerrada_multi", {
      choices: ["a", "b", "c"],
      correct_index: 2,
    });
    expect(marcadas(multiConIndiceSimple)).toEqual([]);
    expect(multiConIndiceSimple?.sinClave).toBe(true);

    const simpleConArreglo = previsualizarOpciones("cerrada", {
      choices: ["a", "b", "c"],
      correct_indices: [1],
    });
    expect(marcadas(simpleConArreglo)).toEqual([]);
    expect(simpleConArreglo?.sinClave).toBe(true);
  });

  it("no rompe con opciones que no son texto", () => {
    const p = previsualizarOpciones("cerrada", { choices: [1, null, "tres"], correct_index: 0 });
    expect(p?.opciones.map((o) => o.texto)).toEqual(["1", "", "tres"]);
  });

  it("pasa de 26 opciones sin inventar símbolos", () => {
    const choices = Array.from({ length: 28 }, (_, i) => `op ${i}`);
    const p = previsualizarOpciones("cerrada", { choices, correct_index: 27 });
    expect(p?.opciones[25].letra).toBe("Z");
    expect(p?.opciones[26].letra).toBe("27");
    expect(marcadas(p)).toEqual(["28"]);
  });
});
