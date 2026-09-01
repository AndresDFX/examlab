import { describe, expect, it } from "vitest";
// INVARIANTE CROSS-FILE: se importa la constante REAL del edge, no un regex
// sobre el disco, así que reformatear ese archivo no rompe el test pero
// cambiar el set sí. Precedente: `src/modules/ai/ai-model-normalize.test.ts`.
import {
  MAX_ITEMS,
  MAX_TEXT_CHARS,
  TIPOS_PROPONIBLES_POR_DESTINO,
} from "../../../supabase/functions/_shared/identify-questions";
import { MAX_ITEMS_POR_LLAMADA, MAX_TEXTO_CHARS } from "./identify-text";
import { JAVAFX_STARTER, JAVA_GUI_STARTER, PYTHON_GUI_STARTER } from "@/modules/code/starters";
import {
  PROPONIBLES_ESPERADO,
  TIPOS_ACEPTADOS_POR_DESTINO,
  construirFilaPregunta,
  languageDeFila,
  optionsDeFila,
  starterDeFila,
  tipoAceptado,
  validarBorrador,
  type BorradorPregunta,
  type DestinoIdentificacion,
  type TipoAceptado,
} from "./identify-types";

const DESTINOS: DestinoIdentificacion[] = ["exam", "workshop", "project", "bank"];

function fila(over: Partial<BorradorPregunta> = {}): BorradorPregunta {
  return {
    id: "f1",
    tipo: "abierta",
    tipoPropuesto: "abierta",
    enunciado: "¿Qué es un ADR y qué debe registrar?",
    rubrica: "Menciona decisión, contexto y consecuencias.",
    puntos: 1,
    incluida: true,
    confianza: "alta",
    motivo: "pide una definición",
    fragmento: "Pregunta 3\n¿Qué es un ADR?",
    degradadoDe: null,
    opciones: [],
    correcta: null,
    correctas: [],
    minSelecciones: null,
    maxSelecciones: null,
    setupSql: "",
    lenguaje: "java",
    javaFramework: "swing",
    ...over,
  };
}

describe("invariante edge ↔ cliente", () => {
  it("el set proponible del edge es el que este lado espera", () => {
    expect(TIPOS_PROPONIBLES_POR_DESTINO).toEqual(PROPONIBLES_ESPERADO);
  });

  it("todo tipo proponible por el edge es aceptado por el cliente", () => {
    for (const destino of DESTINOS) {
      for (const tipo of TIPOS_PROPONIBLES_POR_DESTINO[destino]) {
        expect(
          tipoAceptado(destino, tipo),
          `el edge propone "${tipo}" para ${destino} y el cliente lo bloquea`,
        ).toBe(true);
      }
    }
  });

  it("project no lleva bd_sql en ninguno de los dos sets", () => {
    // El taker de proyectos no tiene rama `bd_sql` ni fallback: la pregunta
    // sería insertable pero el alumno no tendría con qué responder.
    expect(TIPOS_PROPONIBLES_POR_DESTINO.project).not.toContain("bd_sql");
    expect(TIPOS_ACEPTADOS_POR_DESTINO.project).not.toContain("bd_sql");
  });

  it("ningún destino acepta los tipos que este paso no sabe armar", () => {
    for (const destino of DESTINOS) {
      const aceptados = TIPOS_ACEPTADOS_POR_DESTINO[destino] as readonly string[];
      for (const prohibido of ["red_consola", "red_gui", "so_consola", "codigo_zip"]) {
        expect(aceptados).not.toContain(prohibido);
      }
    }
  });
});

describe("validarBorrador", () => {
  it("acepta una abierta con enunciado y puntos válidos", () => {
    expect(validarBorrador("exam", fila())).toEqual({ ok: true });
  });

  it("rechaza un tipo que el destino no acepta", () => {
    // bd_sql es válido en examen pero no en proyecto.
    const r = validarBorrador("project", fila({ tipo: "bd_sql" }));
    expect(r).toEqual({ ok: false, motivo: "identifyQuestions.invalid.tipoNoAceptado" });
  });

  it("rechaza un tipo que no está en los 12 de la plataforma", () => {
    const r = validarBorrador("exam", fila({ tipo: "adivinanza" as unknown as TipoAceptado }));
    expect(r).toEqual({ ok: false, motivo: "identifyQuestions.invalid.tipoNoAceptado" });
  });

  it("rechaza un enunciado más corto que el mínimo", () => {
    const r = validarBorrador("exam", fila({ enunciado: "SaaS?" }));
    expect(r).toEqual({ ok: false, motivo: "identifyQuestions.invalid.enunciadoCorto" });
  });

  it("rechaza puntos fuera de rango o no enteros", () => {
    expect(validarBorrador("exam", fila({ puntos: 0 })).ok).toBe(false);
    expect(validarBorrador("exam", fila({ puntos: 101 })).ok).toBe(false);
    expect(validarBorrador("exam", fila({ puntos: 1.5 })).ok).toBe(false);
  });

  describe("cerrada", () => {
    const cerrada = (over: Partial<BorradorPregunta> = {}) =>
      fila({
        tipo: "cerrada",
        enunciado: "Si solo despliega código y el proveedor gestiona el runtime, ¿qué modelo es?",
        opciones: ["IaaS", "PaaS", "SaaS", "FaaS"],
        correcta: 1,
        ...over,
      });

    it("acepta 4 opciones con la correcta en rango", () => {
      expect(validarBorrador("exam", cerrada())).toEqual({ ok: true });
    });

    it("rechaza menos de 2 opciones", () => {
      expect(validarBorrador("exam", cerrada({ opciones: ["PaaS"], correcta: 0 })).ok).toBe(false);
    });

    it("rechaza sin índice correcto", () => {
      const r = validarBorrador("exam", cerrada({ correcta: null }));
      expect(r).toEqual({ ok: false, motivo: "identifyQuestions.invalid.faltanOpciones" });
    });

    it("rechaza un índice correcto fuera de rango", () => {
      expect(validarBorrador("exam", cerrada({ correcta: 9 })).ok).toBe(false);
    });

    it("cuenta solo las opciones no vacías", () => {
      // Tres slots pero dos con texto: el índice 2 apuntaría a la vacía.
      const r = validarBorrador("exam", cerrada({ opciones: ["A", "B", "   "], correcta: 2 }));
      expect(r.ok).toBe(false);
    });
  });

  describe("cerrada_multi", () => {
    const multi = (over: Partial<BorradorPregunta> = {}) =>
      fila({
        tipo: "cerrada_multi",
        enunciado: "¿Cuáles de estos son modelos de servicio en la nube?",
        opciones: ["IaaS", "PaaS", "Monolito", "SaaS"],
        correctas: [0, 1, 3],
        ...over,
      });

    it("acepta 4 opciones con 3 correctas", () => {
      expect(validarBorrador("exam", multi())).toEqual({ ok: true });
    });

    it("rechaza menos de 3 opciones", () => {
      expect(validarBorrador("exam", multi({ opciones: ["A", "B"], correctas: [0] })).ok).toBe(
        false,
      );
    });

    it("rechaza sin ninguna correcta", () => {
      const r = validarBorrador("exam", multi({ correctas: [] }));
      expect(r).toEqual({ ok: false, motivo: "identifyQuestions.invalid.faltanCorrectas" });
    });

    it("rechaza si TODAS son correctas (no discrimina nada)", () => {
      const r = validarBorrador("exam", multi({ correctas: [0, 1, 2, 3] }));
      expect(r).toEqual({ ok: false, motivo: "identifyQuestions.invalid.faltanCorrectas" });
    });

    it("descarta correctas duplicadas y fuera de rango antes de contar", () => {
      expect(validarBorrador("exam", multi({ correctas: [0, 0, 99] })).ok).toBe(true);
    });
  });

  describe("bd_sql", () => {
    it("acepta un setupSql con CREATE TABLE", () => {
      const f = fila({
        tipo: "bd_sql",
        enunciado: "Listá los empleados con salario mayor a 3.000.000.",
        setupSql: "CREATE TABLE empleado (id int, salario int);",
      });
      expect(validarBorrador("exam", f)).toEqual({ ok: true });
    });

    it("rechaza sin esquema de partida", () => {
      const f = fila({ tipo: "bd_sql", enunciado: "Listá los empleados.", setupSql: "" });
      expect(validarBorrador("exam", f)).toEqual({
        ok: false,
        motivo: "identifyQuestions.invalid.faltaEsquema",
      });
    });

    it("rechaza un setupSql sin CREATE TABLE (base vacía = ejercicio inútil)", () => {
      const f = fila({
        tipo: "bd_sql",
        enunciado: "Listá los empleados.",
        setupSql: "INSERT INTO empleado VALUES (1, 100);",
      });
      expect(validarBorrador("exam", f).ok).toBe(false);
    });
  });

  describe("codigo", () => {
    it("acepta con lenguaje conocido", () => {
      const f = fila({ tipo: "codigo", enunciado: "Escribí un método que invierta una lista." });
      expect(validarBorrador("exam", f)).toEqual({ ok: true });
    });

    it("rechaza con lenguaje desconocido", () => {
      const f = fila({
        tipo: "codigo",
        enunciado: "Escribí un método que invierta una lista.",
        lenguaje: "cobol" as unknown as BorradorPregunta["lenguaje"],
      });
      expect(validarBorrador("exam", f)).toEqual({
        ok: false,
        motivo: "identifyQuestions.invalid.faltaLenguaje",
      });
    });
  });
});

describe("optionsDeFila", () => {
  it("abierta y diagrama no llevan options", () => {
    expect(optionsDeFila(fila({ tipo: "abierta" }))).toBeNull();
    expect(optionsDeFila(fila({ tipo: "diagrama" }))).toBeNull();
  });

  it("cerrada: choices + correct_index, filtrando vacías y REMAPEANDO el índice", () => {
    // La opción marcada es "PaaS" (índice 2 con la vacía en el medio). Al
    // filtrar queda en el índice 1, y el índice emitido tiene que seguirla.
    // Este test afirmaba `correcta: 1` —la opción VACÍA— y esperaba que saliera
    // 1: pasaba por casualidad, y era el bug que corría la clave de respuesta.
    const o = optionsDeFila(
      fila({ tipo: "cerrada", opciones: ["IaaS", "  ", "PaaS"], correcta: 2 }),
    ) as { choices: string[]; correct_index: number };
    expect(o).toEqual({ choices: ["IaaS", "PaaS"], correct_index: 1 });
    expect(o.choices[o.correct_index]).toBe("PaaS");
  });

  it("cerrada_multi: correct_indices ordenados y sin duplicados", () => {
    const o = optionsDeFila(
      fila({
        tipo: "cerrada_multi",
        opciones: ["A", "B", "C", "D"],
        correctas: [3, 0, 0],
        minSelecciones: 2,
      }),
    );
    expect(o).toEqual({
      choices: ["A", "B", "C", "D"],
      correct_indices: [0, 3],
      min_selections: 2,
    });
  });

  it("cerrada_multi: min/max se OMITEN cuando no vienen", () => {
    const o = optionsDeFila(
      fila({ tipo: "cerrada_multi", opciones: ["A", "B", "C"], correctas: [0] }),
    ) as Record<string, unknown>;
    expect("min_selections" in o).toBe(false);
    expect("max_selections" in o).toBe(false);
  });

  it("java_gui: java_framework", () => {
    expect(optionsDeFila(fila({ tipo: "java_gui", javaFramework: "javafx" }))).toEqual({
      java_framework: "javafx",
    });
  });

  it("bd_sql: db.setupSql recortado", () => {
    expect(
      optionsDeFila(fila({ tipo: "bd_sql", setupSql: "  CREATE TABLE a (i int);  " })),
    ).toEqual({ db: { setupSql: "CREATE TABLE a (i int);" } });
  });
});

describe("languageDeFila / starterDeFila", () => {
  it("solo los tipos de código llevan lenguaje", () => {
    expect(languageDeFila(fila({ tipo: "abierta" }))).toBeNull();
    expect(languageDeFila(fila({ tipo: "cerrada" }))).toBeNull();
    expect(languageDeFila(fila({ tipo: "diagrama" }))).toBeNull();
    expect(languageDeFila(fila({ tipo: "bd_sql" }))).toBeNull();
    expect(languageDeFila(fila({ tipo: "codigo", lenguaje: "python" }))).toBe("python");
    expect(languageDeFila(fila({ tipo: "java_gui" }))).toBe("java");
    expect(languageDeFila(fila({ tipo: "python_gui" }))).toBe("python");
  });

  it("el starter sale de starters.ts, según tipo y framework", () => {
    expect(starterDeFila(fila({ tipo: "abierta" }))).toBeNull();
    expect(starterDeFila(fila({ tipo: "java_gui", javaFramework: "swing" }))).toBe(
      JAVA_GUI_STARTER,
    );
    expect(starterDeFila(fila({ tipo: "java_gui", javaFramework: "javafx" }))).toBe(JAVAFX_STARTER);
    expect(starterDeFila(fila({ tipo: "python_gui" }))).toBe(PYTHON_GUI_STARTER);
    expect(starterDeFila(fila({ tipo: "codigo", lenguaje: "python" }))).toContain("def main");
  });
});

describe("construirFilaPregunta", () => {
  const cerrada = fila({
    tipo: "cerrada",
    enunciado: "Si solo despliega código y el proveedor gestiona el runtime, ¿qué modelo es?",
    opciones: ["IaaS", "PaaS", "SaaS", "FaaS"],
    correcta: 1,
    puntos: 5,
  });

  it("exam: exam_id + content, sin zip_single", () => {
    const row = construirFilaPregunta("exam", cerrada, 7, { targetId: "ex-1" });
    expect(row).toEqual({
      exam_id: "ex-1",
      type: "cerrada",
      content: cerrada.enunciado,
      expected_rubric: cerrada.rubrica,
      options: { choices: ["IaaS", "PaaS", "SaaS", "FaaS"], correct_index: 1 },
      points: 5,
      position: 7,
      language: null,
      starter_code: null,
    });
    expect("zip_single" in row).toBe(false);
  });

  it("workshop: workshop_id + content + zip_single false", () => {
    const row = construirFilaPregunta("workshop", cerrada, 0, { targetId: "ws-1" });
    expect(row.workshop_id).toBe("ws-1");
    expect(row.content).toBe(cerrada.enunciado);
    expect(row.zip_single).toBe(false);
    expect(row.position).toBe(0);
  });

  it("project: el enunciado va a title, SIN truncar, y starter_code null", () => {
    const largo = "¿".concat("a".repeat(400), "?");
    const row = construirFilaPregunta("project", fila({ enunciado: largo }), 3, {
      targetId: "pr-1",
    });
    expect(row.project_id).toBe("pr-1");
    expect(row.title).toBe(largo);
    expect(String(row.title).length).toBeGreaterThan(200);
    expect(row.description).toBeNull();
    expect(row.starter_code).toBeNull();
    expect("content" in row).toBe(false);
  });

  it("bank: course_id + suggested_points, sin position", () => {
    const row = construirFilaPregunta("bank", cerrada, 4, {
      targetId: "curso-1",
      createdBy: "user-1",
    });
    expect(row.course_id).toBe("curso-1");
    expect(row.suggested_points).toBe(5);
    expect(row.created_by).toBe("user-1");
    expect(row.tags).toEqual([]);
    expect(row.shared_org).toBe(false);
    expect("position" in row).toBe(false);
    expect("points" in row).toBe(false);
  });

  it("bank sin createdBy no manda la columna (deja que el default decida)", () => {
    const row = construirFilaPregunta("bank", cerrada, 0, { targetId: "curso-1" });
    expect("created_by" in row).toBe(false);
  });

  it("una rúbrica vacía se guarda como null, no como cadena vacía", () => {
    const row = construirFilaPregunta("exam", fila({ rubrica: "   " }), 0, { targetId: "ex-1" });
    expect(row.expected_rubric).toBeNull();
  });

  it("codigo: language y starter_code por fila (no del request)", () => {
    const row = construirFilaPregunta(
      "exam",
      fila({ tipo: "codigo", lenguaje: "javascript", enunciado: "Escribí un reduce." }),
      1,
      { targetId: "ex-1" },
    );
    expect(row.language).toBe("javascript");
    expect(typeof row.starter_code).toBe("string");
    expect(row.options).toBeNull();
  });
});

describe("opciones en blanco — la clave de respuesta no se corre", () => {
  const base = {
    id: "x",
    enunciado: "Que modelo de servicio es?",
    rubrica: null,
    puntos: 5,
    lenguaje: null,
    setupSql: null,
    javaFramework: null,
    minSelecciones: undefined,
    maxSelecciones: undefined,
  };

  it("una cerrada con la opcion del medio en blanco NO es valida", () => {
    // Antes daba {ok:true} y se insertaba la respuesta CORRIDA: el docente
    // marcaba "PaaS" y quedaba marcada "SaaS".
    const fila = {
      ...base,
      tipo: "cerrada",
      opciones: ["", "PaaS", "SaaS", "FaaS"],
      correcta: 0,
      correctas: [],
    } as never;
    expect(validarBorrador("exam", fila)).toEqual({
      ok: false,
      motivo: "identifyQuestions.invalid.faltanOpciones",
    });
  });

  it("si la marcada sobrevive al filtro, el indice se REMAPEA", () => {
    const fila = {
      ...base,
      tipo: "cerrada",
      opciones: ["", "PaaS", "SaaS", "FaaS"],
      correcta: 1,
      correctas: [],
    } as never;
    expect(validarBorrador("exam", fila)).toEqual({ ok: true });
    // choices queda [PaaS, SaaS, FaaS] y la correcta tiene que seguir siendo PaaS.
    const o = optionsDeFila(fila) as { choices: string[]; correct_index: number };
    expect(o.choices).toEqual(["PaaS", "SaaS", "FaaS"]);
    expect(o.correct_index).toBe(0);
    expect(o.choices[o.correct_index]).toBe("PaaS");
  });

  it("en una multiple, las correctas tambien se remapean", () => {
    const fila = {
      ...base,
      tipo: "cerrada_multi",
      opciones: ["IaaS", "", "SaaS", "FaaS"],
      correcta: null,
      correctas: [2, 3],
    } as never;
    expect(validarBorrador("exam", fila)).toEqual({ ok: true });
    const o = optionsDeFila(fila) as { choices: string[]; correct_indices: number[] };
    expect(o.choices).toEqual(["IaaS", "SaaS", "FaaS"]);
    expect(o.correct_indices).toEqual([1, 2]);
    expect(o.correct_indices.map((i) => o.choices[i])).toEqual(["SaaS", "FaaS"]);
  });
});

describe("cerrada_multi — min y max coherentes", () => {
  const fila = (min: number | undefined, max: number | undefined) =>
    ({
      id: "y",
      tipo: "cerrada_multi",
      enunciado: "Cuales son de plataforma?",
      rubrica: null,
      opciones: ["A", "B", "C"],
      correcta: null,
      correctas: [0, 1],
      puntos: 5,
      lenguaje: null,
      setupSql: null,
      javaFramework: null,
      minSelecciones: min,
      maxSelecciones: max,
    }) as never;

  it("min mayor que max se rechaza", () => {
    // Antes se insertaba min=5/max=1 sobre 3 opciones y la calificacion
    // deterministica le daba CERO a todos, marcaran lo que marcaran.
    expect(validarBorrador("exam", fila(5, 1))).toEqual({
      ok: false,
      motivo: "identifyQuestions.invalid.selecciones",
    });
  });

  it("un max mayor que la cantidad de opciones se rechaza", () => {
    expect(validarBorrador("exam", fila(1, 9))).toEqual({
      ok: false,
      motivo: "identifyQuestions.invalid.selecciones",
    });
  });

  it("un rango razonable pasa", () => {
    expect(validarBorrador("exam", fila(1, 2))).toEqual({ ok: true });
    expect(validarBorrador("exam", fila(undefined, undefined))).toEqual({ ok: true });
  });
});

/**
 * INVARIANTE CROSS-FILE: los topes del cliente son espejo de los del edge.
 * Se importan las constantes REALES de los dos lados; si el edge baja el suyo,
 * este test rompe en vez de dejar que el docente cobre un 400 al pulsar
 * «Identificar» después de pegar 20 000 caracteres.
 */
describe("topes espejo del edge", () => {
  it("MAX_TEXTO_CHARS === MAX_TEXT_CHARS del edge", () => {
    expect(MAX_TEXTO_CHARS).toBe(MAX_TEXT_CHARS);
  });

  it("MAX_ITEMS_POR_LLAMADA === MAX_ITEMS del edge", () => {
    expect(MAX_ITEMS_POR_LLAMADA).toBe(MAX_ITEMS);
  });
});

describe("validarBorrador — la opción marcada quedó en blanco", () => {
  const base = {
    id: "z",
    tipoPropuesto: "",
    enunciado: "Si solo despliega código y el proveedor gestiona el runtime, ¿qué modelo es?",
    rubrica: "r",
    puntos: 5,
    incluida: true,
    confianza: "alta",
    motivo: "",
    fragmento: "",
    degradadoDe: null,
    minSelecciones: null,
    maxSelecciones: null,
    setupSql: "",
    lenguaje: "java",
    javaFramework: "swing",
  };

  it("cerrada: se rechaza (ya estaba)", () => {
    const f = {
      ...base,
      tipo: "cerrada",
      opciones: ["", "PaaS", "SaaS"],
      correcta: 0,
      correctas: [],
    } as never;
    expect(validarBorrador("exam", f)).toEqual({
      ok: false,
      motivo: "identifyQuestions.invalid.faltanOpciones",
    });
  });

  it("cerrada_multi: se rechaza igual que cerrada, no se guarda la clave RECORTADA", () => {
    // Antes `correctasRemapeadas` descartaba en silencio el índice huérfano y la
    // fila quedaba válida con UNA de las dos correctas que la IA propuso. Con el
    // scoring proporcional eso cambia la nota de todo el curso sin avisar.
    const f = {
      ...base,
      tipo: "cerrada_multi",
      opciones: ["", "PaaS", "SaaS", "FaaS"],
      correcta: null,
      correctas: [0, 1],
    } as never;
    expect(validarBorrador("exam", f)).toEqual({
      ok: false,
      motivo: "identifyQuestions.invalid.faltanCorrectas",
    });
  });

  it("cerrada_multi: si ninguna marcada quedó en blanco, sigue válida", () => {
    const f = {
      ...base,
      tipo: "cerrada_multi",
      opciones: ["IaaS", "", "SaaS", "FaaS"],
      correcta: null,
      correctas: [0, 2],
    } as never;
    expect(validarBorrador("exam", f)).toEqual({ ok: true });
  });
});

describe("cerrada_multi — el mínimo no puede exceder la cantidad de correctas", () => {
  const f = (correctas: number[], min: number, max: number) =>
    ({
      id: "m",
      tipo: "cerrada_multi",
      tipoPropuesto: "",
      enunciado: "¿Cuáles de los siguientes son modelos de servicio en la nube?",
      rubrica: "r",
      puntos: 5,
      incluida: true,
      confianza: "alta",
      motivo: "",
      fragmento: "",
      degradadoDe: null,
      opciones: ["IaaS", "PaaS", "SaaS", "FaaS"],
      correcta: null,
      correctas,
      minSelecciones: min,
      maxSelecciones: max,
      setupSql: "",
      lenguaje: "java",
      javaFramework: "swing",
    }) as never;

  it("min 3 con UNA correcta se rechaza (premiaba adivinar)", () => {
    // Con el scoring proporcional sin penalización, quien marca solo la
    // correcta queda en 0 por no llegar al mínimo y quien rellena con dos
    // incorrectas se lleva el 100%.
    expect(validarBorrador("exam", f([0], 3, 4))).toEqual({
      ok: false,
      motivo: "identifyQuestions.invalid.selecciones",
    });
  });

  it("min 2 con DOS correctas es válido", () => {
    expect(validarBorrador("exam", f([0, 1], 2, 3))).toEqual({ ok: true });
  });
});

describe("optionsDeFila / construirFilaPregunta — la precondición se hace cumplir", () => {
  const invalida = {
    id: "q",
    tipo: "cerrada",
    tipoPropuesto: "",
    enunciado: "Si solo despliega código y el proveedor gestiona el runtime, ¿qué modelo es?",
    rubrica: "r",
    puntos: 5,
    incluida: true,
    confianza: "alta",
    motivo: "",
    fragmento: "",
    degradadoDe: null,
    opciones: ["", "PaaS", "SaaS"],
    correcta: 0,
    correctas: [],
    minSelecciones: null,
    maxSelecciones: null,
    setupSql: "",
    lenguaje: "java",
    javaFramework: "swing",
  } as never;

  it("optionsDeFila devuelve null en vez de inventar la opción 0 como correcta", () => {
    expect(optionsDeFila(invalida)).toBeNull();
  });

  it("construirFilaPregunta lanza si la fila no pasa validarBorrador", () => {
    expect(() => construirFilaPregunta("exam", invalida, 0, { targetId: "ex-1" })).toThrow(
      /no pasa la validación/,
    );
  });
});
