import { describe, expect, it } from "vitest";
import {
  MAX_ITEMS,
  TIPOS_PROPONIBLES_POR_DESTINO,
  buildIdentifyTool,
  clampMaxItems,
  identifySystemPrompt,
  identifyUserPrompt,
  isIdentifyTarget,
  normalizeIdentifiedItems,
  type IdentifyTarget,
} from "./identify-questions";

const DESTINOS: IdentifyTarget[] = ["exam", "workshop", "project", "bank"];

/** Item crudo del modelo con lo mínimo para pasar la escalera. */
function crudo(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "abierta",
    statement: "Explique el teorema CAP y sus implicaciones.",
    rubric: "Menciona consistencia, disponibilidad y tolerancia a particiones.",
    confidence: "alta",
    reason: "Pide desarrollo argumentado.",
    source_excerpt: "Pregunta 1\nExplique el teorema CAP.",
    ...over,
  };
}

function normalizar(items: unknown[], target: IdentifyTarget = "exam") {
  return normalizeIdentifiedItems(items, { target });
}

describe("TIPOS_PROPONIBLES_POR_DESTINO", () => {
  it("tiene los 4 destinos", () => {
    expect(Object.keys(TIPOS_PROPONIBLES_POR_DESTINO).sort()).toEqual([
      "bank",
      "exam",
      "project",
      "workshop",
    ]);
  });

  it("nunca ofrece tipos fuera del set de 6 proponibles", () => {
    const permitidos = ["abierta", "cerrada", "cerrada_multi", "codigo", "diagrama", "bd_sql"];
    for (const d of DESTINOS) {
      for (const t of TIPOS_PROPONIBLES_POR_DESTINO[d]) {
        expect(permitidos).toContain(t);
      }
    }
  });

  it("PROYECTO no ofrece bd_sql (su taker no tiene rama para renderizarlo)", () => {
    expect(TIPOS_PROPONIBLES_POR_DESTINO.project).not.toContain("bd_sql");
    expect(TIPOS_PROPONIBLES_POR_DESTINO.exam).toContain("bd_sql");
    expect(TIPOS_PROPONIBLES_POR_DESTINO.workshop).toContain("bd_sql");
    expect(TIPOS_PROPONIBLES_POR_DESTINO.bank).toContain("bd_sql");
  });

  it("ningún destino ofrece los tipos excluidos a propósito", () => {
    const excluidos = [
      "red_consola",
      "red_gui",
      "codigo_zip",
      "so_consola",
      "java_gui",
      "python_gui",
    ];
    for (const d of DESTINOS) {
      for (const e of excluidos) {
        expect(TIPOS_PROPONIBLES_POR_DESTINO[d]).not.toContain(e);
      }
    }
  });
});

describe("isIdentifyTarget", () => {
  it("acepta los 4 destinos y rechaza todo lo demás", () => {
    for (const d of DESTINOS) expect(isIdentifyTarget(d)).toBe(true);
    for (const v of ["kahoot", "questions", "", null, undefined, 0, {}, ["exam"]]) {
      expect(isIdentifyTarget(v)).toBe(false);
    }
  });

  it("rechaza las propiedades heredadas del prototipo", () => {
    // `"toString" in TIPOS_PROPONIBLES_POR_DESTINO` daría true y reventaría
    // después al tratar una función como array de tipos.
    for (const v of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(isIdentifyTarget(v)).toBe(false);
    }
  });
});

describe("buildIdentifyTool", () => {
  it("el enum de type es el set del destino", () => {
    for (const d of DESTINOS) {
      const tool = buildIdentifyTool(d);
      const props = tool.function.parameters.properties.questions.items.properties;
      expect(props.type.enum).toEqual([...TIPOS_PROPONIBLES_POR_DESTINO[d]]);
    }
  });

  it("el tool de proyecto NO le ofrece bd_sql al modelo", () => {
    const tool = buildIdentifyTool("project");
    const enumTipos = tool.function.parameters.properties.questions.items.properties.type.enum;
    expect(enumTipos).not.toContain("bd_sql");
  });

  it("declara las propiedades de options (con properties vacío el modelo devuelve {})", () => {
    const opts =
      buildIdentifyTool("exam").function.parameters.properties.questions.items.properties.options;
    expect(Object.keys(opts.properties).sort()).toEqual([
      "choices",
      "correct_index",
      "correct_indices",
      "db",
      "max_selections",
      "min_selections",
    ]);
  });

  it("exige tipo, enunciado, rúbrica, confianza, motivo y fragmento", () => {
    const req = buildIdentifyTool("exam").function.parameters.properties.questions.items.required;
    expect(req).toEqual(["type", "statement", "rubric", "confidence", "reason", "source_excerpt"]);
  });

  it("se llama identify_questions", () => {
    expect(buildIdentifyTool("bank").function.name).toBe("identify_questions");
  });
});

describe("prompts", () => {
  it("el system prompt sale en español por defecto y en inglés cuando se pide", () => {
    expect(identifySystemPrompt()).toContain("Eres un asistente de diseño de evaluaciones");
    expect(identifySystemPrompt("es")).toContain("REGLAS DURAS");
    expect(identifySystemPrompt("en")).toContain("HARD RULES");
  });

  it("el system prompt nombra los 6 tipos proponibles", () => {
    const p = identifySystemPrompt("es");
    for (const t of ["cerrada", "cerrada_multi", "abierta", "codigo", "diagrama", "bd_sql"]) {
      expect(p).toContain(t);
    }
  });

  it("el user prompt envuelve el texto y lo recorta al tope", () => {
    expect(identifyUserPrompt("Pregunta 1\n¿Qué es un ADR?")).toContain("¿Qué es un ADR?");
    const largo = identifyUserPrompt("x".repeat(30000));
    expect(largo.length).toBeLessThan(21000);
  });
});

describe("clampMaxItems", () => {
  it("clampea al rango 1..MAX_ITEMS con default MAX_ITEMS", () => {
    expect(clampMaxItems(undefined)).toBe(MAX_ITEMS);
    expect(clampMaxItems("nada")).toBe(MAX_ITEMS);
    expect(clampMaxItems(0)).toBe(1);
    expect(clampMaxItems(-4)).toBe(1);
    expect(clampMaxItems(5)).toBe(5);
    expect(clampMaxItems(99)).toBe(MAX_ITEMS);
    expect(clampMaxItems(3.7)).toBe(3);
  });
});

describe("los 3 casos de aceptación", () => {
  it("modelo de nube con runtime gestionado → cerrada con 4 opciones y la correcta marcada", () => {
    const { questions, discarded } = normalizar([
      crudo({
        type: "cerrada",
        statement: "Si solo despliega código y el proveedor gestiona el runtime, ¿qué modelo es?",
        rubric: "PaaS: el proveedor administra el runtime y el despliegue.",
        options: { choices: ["IaaS", "PaaS", "SaaS", "FaaS"], correct_index: 1 },
        confidence: "alta",
        reason: "Respuesta única entre alternativas conocidas del dominio.",
      }),
    ]);
    expect(discarded).toHaveLength(0);
    expect(questions).toHaveLength(1);
    const q = questions[0];
    expect(q.type).toBe("cerrada");
    expect(q.options).toEqual({ choices: ["IaaS", "PaaS", "SaaS", "FaaS"], correct_index: 1 });
    expect(q.degraded_from).toBeUndefined();
    expect(q.confidence).toBe("alta");
    expect(q.rubric).toContain("PaaS");
  });

  it("SaaS dominante ¿cuándo sí/no? → abierta con rúbrica de dos partes", () => {
    const { questions } = normalizar([
      crudo({
        type: "abierta",
        statement: "¿SaaS puede ser el modelo dominante de CloudLite App? ¿Cuándo sí/no?",
        rubric: "Cuándo sí: producto estandarizado. Cuándo no: requiere control del runtime.",
        reason: "Pide argumentar dos escenarios.",
      }),
    ]);
    expect(questions[0].type).toBe("abierta");
    expect(questions[0].options).toBeNull();
    expect(questions[0].language).toBeNull();
    expect(questions[0].rubric).toContain("Cuándo no");
  });

  it("¿Qué es un ADR? → abierta corta con rúbrica útil (no vacía)", () => {
    const { questions } = normalizar([
      crudo({
        type: "abierta",
        statement: "¿Qué es un ADR?",
        rubric: "Decisión, contexto, consecuencias e inmutabilidad del registro.",
        reason: "Definición con desarrollo mínimo.",
      }),
    ]);
    expect(questions[0].type).toBe("abierta");
    expect(questions[0].rubric).not.toBeNull();
    expect(questions[0].statement).toBe("¿Qué es un ADR?");
  });
});

describe("escalera: descarte por enunciado corto", () => {
  it("un fragmento de menos de 10 chars se descarta con su motivo", () => {
    const r = normalizar([crudo({ statement: "Parte II" }), crudo()]);
    expect(r.questions).toHaveLength(1);
    expect(r.discarded).toHaveLength(1);
    expect(r.discarded[0].reason).toMatch(/demasiado corto/i);
  });

  it("el motivo del descarte sale en inglés cuando el curso es en inglés", () => {
    const r = normalizeIdentifiedItems([crudo({ statement: "Part II" })], {
      target: "exam",
      lang: "en",
    });
    expect(r.discarded[0].reason).toMatch(/too short/i);
  });

  it("items que no son objetos se descartan sin lanzar", () => {
    const r = normalizar([null, "texto", 42, crudo()]);
    expect(r.questions).toHaveLength(1);
    expect(r.discarded).toHaveLength(3);
  });

  it("un rawItems que no es array devuelve vacío sin lanzar", () => {
    const r = normalizeIdentifiedItems(undefined, { target: "exam" });
    expect(r.questions).toEqual([]);
    expect(r.discarded).toEqual([]);
    expect(r.truncated).toBe(false);
  });
});

describe("escalera: degradación de tipo", () => {
  it("tipo inventado → abierta, degraded_from con el crudo y confianza baja", () => {
    const { questions } = normalizar([crudo({ type: "verdadero_falso" })]);
    expect(questions[0].type).toBe("abierta");
    expect(questions[0].degraded_from).toBe("verdadero_falso");
    expect(questions[0].confidence).toBe("baja");
    expect(questions[0].reason).toMatch(/no aplica/i);
  });

  it("tipo vacío → abierta con degraded_from vacío", () => {
    const { questions } = normalizar([crudo({ type: "" })]);
    expect(questions[0].type).toBe("abierta");
    expect(questions[0].degraded_from).toBe("");
  });

  it("tipo VÁLIDO pero no proponible en el destino (bd_sql en proyecto) → abierta", () => {
    const item = crudo({
      type: "bd_sql",
      options: { db: { setupSql: "CREATE TABLE t(id int);" } },
    });
    const enProyecto = normalizar([item], "project");
    expect(enProyecto.questions[0].type).toBe("abierta");
    expect(enProyecto.questions[0].degraded_from).toBe("bd_sql");
    expect(enProyecto.questions[0].options).toBeNull();
    // El MISMO item en un examen sí se conserva.
    const enExamen = normalizar([item], "exam");
    expect(enExamen.questions[0].type).toBe("bd_sql");
  });

  it("codigo_zip nunca sobrevive, en ningún destino", () => {
    for (const d of DESTINOS) {
      const { questions } = normalizar([crudo({ type: "codigo_zip" })], d);
      expect(questions[0].type).toBe("abierta");
      expect(questions[0].degraded_from).toBe("codigo_zip");
    }
  });

  it("so_consola, red_consola, red_gui, java_gui y python_gui degradan a abierta", () => {
    for (const t of ["so_consola", "red_consola", "red_gui", "java_gui", "python_gui"]) {
      const { questions } = normalizar([crudo({ type: t })], "exam");
      expect(questions[0].type).toBe("abierta");
      expect(questions[0].degraded_from).toBe(t);
    }
  });
});

describe("escalera: cerrada", () => {
  it("sin correct_index → abierta (si no, puntúa 0 siempre)", () => {
    const { questions } = normalizar([
      crudo({ type: "cerrada", options: { choices: ["A", "B", "C"] } }),
    ]);
    expect(questions[0].type).toBe("abierta");
    expect(questions[0].degraded_from).toBe("cerrada");
    expect(questions[0].reason).toMatch(/opciones válidas/i);
  });

  it("options ausente (el {} del tool schema viejo) → abierta", () => {
    const { questions } = normalizar([crudo({ type: "cerrada", options: {} })]);
    expect(questions[0].type).toBe("abierta");
    expect(questions[0].degraded_from).toBe("cerrada");
  });

  it("con una sola opción → abierta", () => {
    const { questions } = normalizar([
      crudo({ type: "cerrada", options: { choices: ["Única"], correct_index: 0 } }),
    ]);
    expect(questions[0].type).toBe("abierta");
  });

  it("con 7 opciones → abierta (tope de 6)", () => {
    const { questions } = normalizar([
      crudo({
        type: "cerrada",
        options: { choices: ["a", "b", "c", "d", "e", "f", "g"], correct_index: 0 },
      }),
    ]);
    expect(questions[0].type).toBe("abierta");
  });

  it("correct_index fuera de rango, no entero o ausente → abierta", () => {
    // `null`/`""`/`false` NO pueden coercionarse a 0: eso marcaría como correcta
    // la PRIMERA opción, inventando una respuesta que el modelo nunca dio.
    for (const idx of [5, -1, 1.5, null, undefined, "", false, "dos", {}]) {
      const { questions } = normalizar([
        crudo({ type: "cerrada", options: { choices: ["A", "B", "C"], correct_index: idx } }),
      ]);
      expect(questions[0].type).toBe("abierta");
      expect(questions[0].degraded_from).toBe("cerrada");
    }
  });

  it("acepta un correct_index que vino como string numérico", () => {
    const { questions } = normalizar([
      crudo({ type: "cerrada", options: { choices: ["A", "B", "C"], correct_index: "1" } }),
    ]);
    expect(questions[0].type).toBe("cerrada");
    expect(questions[0].options).toEqual({ choices: ["A", "B", "C"], correct_index: 1 });
  });

  it("correct_indices con nulos no inventa el índice 0", () => {
    const { questions } = normalizar([
      crudo({
        type: "cerrada_multi",
        options: { choices: ["A", "B", "C"], correct_indices: [null, "", false] },
      }),
    ]);
    expect(questions[0].type).toBe("abierta");
    expect(questions[0].degraded_from).toBe("cerrada_multi");
  });

  it("filtra choices vacíos y recalcula el rango del índice sobre lo que quedó", () => {
    const { questions } = normalizar([
      crudo({
        type: "cerrada",
        options: { choices: ["IaaS", "   ", "PaaS", ""], correct_index: 1 },
      }),
    ]);
    expect(questions[0].type).toBe("cerrada");
    expect(questions[0].options).toEqual({ choices: ["IaaS", "PaaS"], correct_index: 1 });
  });

  it("una cerrada válida no arrastra language", () => {
    const { questions } = normalizar([
      crudo({
        type: "cerrada",
        language: "python",
        options: { choices: ["A", "B"], correct_index: 0 },
      }),
    ]);
    expect(questions[0].language).toBeNull();
  });
});

describe("escalera: cerrada_multi", () => {
  it("con 2 correctas de 4 se conserva", () => {
    const { questions } = normalizar([
      crudo({
        type: "cerrada_multi",
        options: { choices: ["A", "B", "C", "D"], correct_indices: [2, 0] },
      }),
    ]);
    expect(questions[0].type).toBe("cerrada_multi");
    expect(questions[0].options).toEqual({
      choices: ["A", "B", "C", "D"],
      correct_indices: [0, 2],
    });
  });

  it("con EXACTAMENTE 1 correcta se convierte en cerrada", () => {
    const { questions } = normalizar([
      crudo({
        type: "cerrada_multi",
        options: { choices: ["A", "B", "C"], correct_indices: [1] },
      }),
    ]);
    expect(questions[0].type).toBe("cerrada");
    expect(questions[0].options).toEqual({ choices: ["A", "B", "C"], correct_index: 1 });
    expect(questions[0].degraded_from).toBe("cerrada_multi");
    expect(questions[0].reason).toMatch(/una respuesta correcta/i);
  });

  it("sin correctas → abierta", () => {
    const { questions } = normalizar([
      crudo({ type: "cerrada_multi", options: { choices: ["A", "B", "C"], correct_indices: [] } }),
    ]);
    expect(questions[0].type).toBe("abierta");
    expect(questions[0].degraded_from).toBe("cerrada_multi");
    expect(questions[0].reason).toMatch(/ninguna respuesta correcta/i);
  });

  it("con TODAS las opciones correctas → abierta", () => {
    const { questions } = normalizar([
      crudo({
        type: "cerrada_multi",
        options: { choices: ["A", "B", "C"], correct_indices: [0, 1, 2] },
      }),
    ]);
    expect(questions[0].type).toBe("abierta");
  });

  it("con menos de 3 choices → abierta", () => {
    const { questions } = normalizar([
      crudo({ type: "cerrada_multi", options: { choices: ["A", "B"], correct_indices: [0] } }),
    ]);
    expect(questions[0].type).toBe("abierta");
  });

  it("dedup e índices fuera de rango: quedan solo los válidos", () => {
    const { questions } = normalizar([
      crudo({
        type: "cerrada_multi",
        options: { choices: ["A", "B", "C", "D"], correct_indices: [1, 1, 9, 2, -3, "2"] },
      }),
    ]);
    expect(questions[0].type).toBe("cerrada_multi");
    expect(questions[0].options).toEqual({
      choices: ["A", "B", "C", "D"],
      correct_indices: [1, 2],
    });
  });

  it("min/max coherentes se conservan; incoherentes se OMITEN (no se inventan)", () => {
    const ok = normalizar([
      crudo({
        type: "cerrada_multi",
        options: {
          choices: ["A", "B", "C", "D"],
          correct_indices: [0, 1],
          min_selections: 1,
          max_selections: 3,
        },
      }),
    ]);
    expect(ok.questions[0].options).toEqual({
      choices: ["A", "B", "C", "D"],
      correct_indices: [0, 1],
      min_selections: 1,
      max_selections: 3,
    });

    const malo = normalizar([
      crudo({
        type: "cerrada_multi",
        options: {
          choices: ["A", "B", "C"],
          correct_indices: [0, 1],
          min_selections: 3,
          max_selections: 1,
        },
      }),
    ]);
    expect(malo.questions[0].options).toEqual({
      choices: ["A", "B", "C"],
      correct_indices: [0, 1],
    });
  });
});

describe("escalera: bd_sql", () => {
  it("con setupSql que crea tablas se conserva", () => {
    const setupSql = "CREATE TABLE empleado(id int, salario numeric);\nINSERT INTO empleado ...";
    const { questions } = normalizar([crudo({ type: "bd_sql", options: { db: { setupSql } } })]);
    expect(questions[0].type).toBe("bd_sql");
    expect(questions[0].options).toEqual({ db: { setupSql } });
  });

  it("sin CREATE TABLE → abierta (la base PGlite arrancaría vacía)", () => {
    const { questions } = normalizar([
      crudo({ type: "bd_sql", options: { db: { setupSql: "SELECT 1;" } } }),
    ]);
    expect(questions[0].type).toBe("abierta");
    expect(questions[0].degraded_from).toBe("bd_sql");
    expect(questions[0].reason).toMatch(/esquema de partida/i);
  });

  it("sin db, con db vacío o con setupSql vacío → abierta", () => {
    for (const options of [{}, { db: {} }, { db: { setupSql: "   " } }, { db: null }]) {
      const { questions } = normalizar([crudo({ type: "bd_sql", options })]);
      expect(questions[0].type).toBe("abierta");
      expect(questions[0].degraded_from).toBe("bd_sql");
    }
  });
});

describe("escalera: codigo", () => {
  it("conserva el lenguaje válido y NO degrada el tipo", () => {
    const { questions } = normalizar([crudo({ type: "codigo", language: "python" })]);
    expect(questions[0].type).toBe("codigo");
    expect(questions[0].language).toBe("python");
    expect(questions[0].confidence).toBe("alta");
  });

  it("lenguaje desconocido → cae al del request, conserva el tipo y baja la confianza", () => {
    const { questions } = normalizeIdentifiedItems([crudo({ type: "codigo", language: "cobol" })], {
      target: "exam",
      codeLanguage: "javascript",
    });
    expect(questions[0].type).toBe("codigo");
    expect(questions[0].language).toBe("javascript");
    expect(questions[0].confidence).toBe("baja");
    expect(questions[0].degraded_from).toBeUndefined();
  });

  it("sin codeLanguage en el request, el fallback es java", () => {
    const { questions } = normalizar([crudo({ type: "codigo" })]);
    expect(questions[0].language).toBe("java");
  });

  it("normaliza el lenguaje en mayúsculas", () => {
    const { questions } = normalizar([crudo({ type: "codigo", language: "JAVA" })]);
    expect(questions[0].language).toBe("java");
    expect(questions[0].confidence).toBe("alta");
  });

  it("no arrastra options", () => {
    const { questions } = normalizar([
      crudo({ type: "codigo", language: "java", options: { choices: ["A", "B"] } }),
    ]);
    expect(questions[0].options).toBeNull();
  });
});

describe("escalera: abierta y diagrama nunca llevan options ni language", () => {
  it("fuerza options y language a null", () => {
    for (const type of ["abierta", "diagrama"]) {
      const { questions } = normalizar([
        crudo({
          type,
          language: "python",
          options: { choices: ["A", "B"], correct_index: 0 },
        }),
      ]);
      expect(questions[0].type).toBe(type);
      expect(questions[0].options).toBeNull();
      expect(questions[0].language).toBeNull();
    }
  });

  it("ninguna pregunta abierta o diagrama del resultado tiene options", () => {
    const { questions } = normalizar([
      crudo({ type: "cerrada", options: { choices: ["A"] } }),
      crudo({ type: "diagrama", options: { db: { setupSql: "CREATE TABLE x(i int);" } } }),
      crudo({ type: "verdadero_falso", options: { choices: ["A", "B"], correct_index: 0 } }),
    ]);
    for (const q of questions) {
      if (q.type === "abierta" || q.type === "diagrama") expect(q.options).toBeNull();
    }
  });
});

describe("escalera: campos escalares", () => {
  it("points: entero, clamp 1..100, default 1", () => {
    const casos: Array<[unknown, number]> = [
      [undefined, 1],
      ["nada", 1],
      [0, 1],
      [-5, 1],
      [1, 1],
      [40, 40],
      [999, 100],
      [7.9, 7],
      ["12", 12],
    ];
    for (const [input, esperado] of casos) {
      const { questions } = normalizar([crudo({ points: input })]);
      expect(questions[0].points).toBe(esperado);
    }
  });

  it("rubric vacía queda null", () => {
    const { questions } = normalizar([crudo({ rubric: "   " })]);
    expect(questions[0].rubric).toBeNull();
  });

  it("recorta statement a 4000, reason a 200 y source_excerpt a 600", () => {
    const { questions } = normalizar([
      crudo({
        statement: "a".repeat(5000),
        reason: "b".repeat(400),
        source_excerpt: "c".repeat(900),
      }),
    ]);
    expect(questions[0].statement).toHaveLength(4000);
    expect(questions[0].reason).toHaveLength(200);
    expect(questions[0].source_excerpt).toHaveLength(600);
  });

  it("confianza desconocida cae a media", () => {
    const { questions } = normalizar([crudo({ confidence: "altisima" })]);
    expect(questions[0].confidence).toBe("media");
  });

  it("quita el rótulo de numeración que el modelo arrastra al enunciado", () => {
    const casos: Array<[string, string]> = [
      ["Pregunta 1 ¿Qué es un ADR?", "¿Qué es un ADR?"],
      ["Pregunta 2: ¿Qué es un ADR?", "¿Qué es un ADR?"],
      ["3) ¿Qué es un ADR y para qué sirve?", "¿Qué es un ADR y para qué sirve?"],
      ["- ¿Qué es un ADR y para qué sirve?", "¿Qué es un ADR y para qué sirve?"],
    ];
    for (const [entrada, esperado] of casos) {
      const { questions } = normalizar([crudo({ statement: entrada })]);
      expect(questions[0].statement).toBe(esperado);
    }
  });

  it("no toca un enunciado que empieza con un número que es parte del texto", () => {
    const { questions } = normalizar([
      crudo({ statement: "2026 fue el año de la migración: ¿qué cambió?" }),
    ]);
    expect(questions[0].statement).toBe("2026 fue el año de la migración: ¿qué cambió?");
  });
});

describe("tope de items", () => {
  it("15 items con maxItems=12 → 12 preguntas y truncated=true", () => {
    const items = Array.from({ length: 15 }, (_, i) =>
      crudo({ statement: `Pregunta larga número ${i} sobre arquitectura.` }),
    );
    const r = normalizeIdentifiedItems(items, { target: "exam", maxItems: 12 });
    expect(r.questions).toHaveLength(12);
    expect(r.truncated).toBe(true);
  });

  it("dentro del tope, truncated=false", () => {
    const items = Array.from({ length: 4 }, () => crudo());
    const r = normalizeIdentifiedItems(items, { target: "exam", maxItems: 12 });
    expect(r.questions).toHaveLength(4);
    expect(r.truncated).toBe(false);
  });

  it("maxItems fuera de rango se clampea", () => {
    const items = Array.from({ length: 5 }, () => crudo());
    expect(normalizeIdentifiedItems(items, { target: "exam", maxItems: 0 }).questions).toHaveLength(
      1,
    );
    expect(
      normalizeIdentifiedItems(items, { target: "exam", maxItems: 999 }).questions,
    ).toHaveLength(5);
  });
});

describe("lote mixto realista (el pedido del docente)", () => {
  it("clasifica las 3 preguntas del caso de uso conservando el orden del texto", () => {
    const r = normalizar([
      crudo({
        type: "cerrada",
        statement: "Si solo despliega código y el proveedor gestiona el runtime, ¿qué modelo es?",
        options: { choices: ["IaaS", "PaaS", "SaaS", "FaaS"], correct_index: 1 },
      }),
      crudo({
        type: "abierta",
        statement: "¿SaaS puede ser el modelo dominante de CloudLite App? ¿Cuándo sí/no?",
      }),
      crudo({ type: "abierta", statement: "¿Qué es un ADR?" }),
    ]);
    expect(r.questions.map((q) => q.type)).toEqual(["cerrada", "abierta", "abierta"]);
    expect(r.discarded).toHaveLength(0);
    expect(r.truncated).toBe(false);
  });

  it("un item basura no impide clasificar los demás", () => {
    const r = normalizar([
      crudo({ type: "cerrada", options: { choices: [] } }),
      crudo({ statement: "corto" }),
      crudo({ type: "diagrama", statement: "Modele el flujo de despliegue del sistema." }),
    ]);
    expect(r.questions.map((q) => q.type)).toEqual(["abierta", "diagrama"]);
    expect(r.discarded).toHaveLength(1);
  });
});
