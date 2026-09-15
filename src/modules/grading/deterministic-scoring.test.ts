import { describe, it, expect } from "vitest";
import {
  esDeterminista,
  parseOptionIndex,
  parseOptionIndices,
  respuestaCrudaDeTaller,
  scoreDeterministaCliente,
} from "./deterministic-scoring";

describe("esDeterminista", () => {
  it("cubre los 4 tipos que no necesitan IA", () => {
    for (const t of ["cerrada", "cerrada_multi", "red_consola", "red_gui"]) {
      expect(esDeterminista(t)).toBe(true);
    }
  });
  it("deja fuera los que sí van a la IA", () => {
    for (const t of ["abierta", "codigo", "diagrama", "java_gui", "so_consola", "codigo_zip"]) {
      expect(esDeterminista(t)).toBe(false);
    }
  });
});

describe("parseOptionIndex — tolera el TEXT del taller y el number del examen", () => {
  it("acepta number", () => {
    expect(parseOptionIndex(2)).toBe(2);
    expect(parseOptionIndex(0)).toBe(0);
  });
  it("acepta string numérica (así la guarda el taller)", () => {
    expect(parseOptionIndex("2")).toBe(2);
    expect(parseOptionIndex(" 3 ")).toBe(3);
    expect(parseOptionIndex("0")).toBe(0);
  });
  it("rechaza vacío, basura y no-finitos", () => {
    expect(parseOptionIndex("")).toBeNull();
    expect(parseOptionIndex("   ")).toBeNull();
    expect(parseOptionIndex("abc")).toBeNull();
    expect(parseOptionIndex(null)).toBeNull();
    expect(parseOptionIndex(undefined)).toBeNull();
    expect(parseOptionIndex(NaN)).toBeNull();
    expect(parseOptionIndex({})).toBeNull();
  });
});

describe("parseOptionIndices", () => {
  it("lee el JSON serializado que guarda el taller en answer_text", () => {
    expect(parseOptionIndices("[0,2]")).toEqual([0, 2]);
  });
  it("lee un array crudo", () => {
    expect(parseOptionIndices([1, 3])).toEqual([1, 3]);
  });
  it("deduplica", () => {
    expect(parseOptionIndices("[1,1,2]")).toEqual([1, 2]);
  });
  it("tolera un índice suelto de una fila legacy", () => {
    expect(parseOptionIndices("2")).toEqual([2]);
  });
  it("vacío / basura → sin marcadas", () => {
    expect(parseOptionIndices("")).toEqual([]);
    expect(parseOptionIndices("[]")).toEqual([]);
    expect(parseOptionIndices(null)).toEqual([]);
  });
});

describe("respuestaCrudaDeTaller — de qué columna sale la respuesta", () => {
  it("cerrada sale de selected_option", () => {
    expect(
      respuestaCrudaDeTaller("cerrada", { selected_option: "2", answer_text: null }),
    ).toBe("2");
  });
  it("cerrada_multi sale de answer_text (NO de selected_option)", () => {
    // Éste es el detalle que hacía que leer siempre `selected_option` dejara
    // la opción múltiple vacía y por lo tanto en 0.
    expect(
      respuestaCrudaDeTaller("cerrada_multi", { answer_text: "[0,2]", selected_option: null }),
    ).toBe("[0,2]");
  });
  it("red_* sale de answer_text", () => {
    expect(respuestaCrudaDeTaller("red_consola", { answer_text: "{}" })).toBe("{}");
  });
  it("sin fila → null", () => {
    expect(respuestaCrudaDeTaller("cerrada", undefined)).toBeNull();
  });
});

describe("scoreDeterministaCliente — cerrada", () => {
  const q = { type: "cerrada", points: 1, options: { correct_index: 2 } };

  it("REGRESIÓN: el caso exacto de producción — selected_option TEXT contra correct_index number", () => {
    // Taller "Joins en SQL": selected_option="2", correct_index=2. El camino
    // del docente devolvía 0; el del alumno, el puntaje completo.
    const r = scoreDeterministaCliente(q, "2");
    expect(r.earned).toBe(1);
    expect(r.outcome).toBe("correcta");
  });

  it("acierta también con el number del examen", () => {
    expect(scoreDeterministaCliente(q, 2).earned).toBe(1);
  });

  it("respuesta incorrecta → 0", () => {
    const r = scoreDeterministaCliente(q, "1");
    expect(r.earned).toBe(0);
    expect(r.outcome).toBe("incorrecta");
  });

  it("sin responder → 0 y se distingue de incorrecta", () => {
    expect(scoreDeterministaCliente(q, null).outcome).toBe("sin_respuesta");
    expect(scoreDeterministaCliente(q, "").outcome).toBe("sin_respuesta");
  });

  it("GUARD: sin correct_index y sin respuesta NO regala el puntaje", () => {
    const rota = { type: "cerrada", points: 10, options: {} };
    expect(scoreDeterministaCliente(rota, null).earned).toBe(0);
    expect(scoreDeterministaCliente(rota, "0").earned).toBe(0);
  });

  it("el índice 0 es una opción válida, no un vacío", () => {
    const q0 = { type: "cerrada", points: 5, options: { correct_index: 0 } };
    const r = scoreDeterministaCliente(q0, "0");
    expect(r.earned).toBe(5);
    expect(r.outcome).toBe("correcta");
  });

  it("acertar una pregunta de 0 puntos sigue siendo acertar", () => {
    const qCero = { type: "cerrada", points: 0, options: { correct_index: 1 } };
    const r = scoreDeterministaCliente(qCero, "1");
    expect(r.earned).toBe(0);
    expect(r.outcome).toBe("correcta");
  });
});

describe("scoreDeterministaCliente — cerrada_multi", () => {
  const q = {
    type: "cerrada_multi",
    points: 4,
    options: { correct_indices: [0, 2] },
  };

  it("todas las correctas → puntaje completo, leyendo el JSON de answer_text", () => {
    const r = scoreDeterministaCliente(q, "[0,2]");
    expect(r.earned).toBe(4);
  });

  it("proporcional positivo: la mitad de las correctas → la mitad", () => {
    expect(scoreDeterministaCliente(q, "[0]").earned).toBe(2);
  });

  it("una incorrecta marcada no resta", () => {
    expect(scoreDeterministaCliente(q, "[0,2,1]").earned).toBe(4);
  });

  it("sin marcar nada → sin_respuesta", () => {
    expect(scoreDeterministaCliente(q, "[]").outcome).toBe("sin_respuesta");
  });

  it("supera el máximo permitido → 0 con el motivo", () => {
    const qMax = {
      type: "cerrada_multi",
      points: 4,
      options: { correct_indices: [0, 2], max_selections: 2 },
    };
    const r = scoreDeterministaCliente(qMax, "[0,1,2]");
    expect(r.earned).toBe(0);
    expect(r.outcome).toBe("supera_maximo");
  });

  it("no llega al mínimo → 0 con el motivo", () => {
    const qMin = {
      type: "cerrada_multi",
      points: 4,
      options: { correct_indices: [0, 2], min_selections: 2 },
    };
    const r = scoreDeterministaCliente(qMin, "[0]");
    expect(r.earned).toBe(0);
    expect(r.outcome).toBe("bajo_minimo");
  });
});

describe("scoreDeterministaCliente — tipos no deterministas", () => {
  it("una abierta no se califica acá", () => {
    const r = scoreDeterministaCliente({ type: "abierta", points: 5 }, "una respuesta");
    expect(r.earned).toBe(0);
    expect(r.outcome).toBe("sin_respuesta");
  });
});

describe("scoreDeterministaCliente — red", () => {
  it("una respuesta de red ilegible no rompe la calificación de la entrega", () => {
    const r = scoreDeterministaCliente({ type: "red_consola", points: 5, options: {} }, "no-json");
    expect(r.earned).toBe(0);
    expect(r.outcome).toBe("sin_respuesta");
  });
});
