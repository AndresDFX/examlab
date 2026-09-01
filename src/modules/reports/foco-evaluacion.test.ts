import { describe, expect, it } from "vitest";
import {
  clasificarResultado,
  construirEvaluacion,
  estadoLegible,
  preguntasDeBanco,
  preguntasDeProyecto,
  respuestaCorrectaLegible,
  respuestaLegible,
  respuestasDeExamen,
  respuestasDeFilas,
  type PreguntaFuente,
  type RespuestaFuente,
} from "./foco-evaluacion";

const abierta = (id: string, puntos = 1, pos = 0): PreguntaFuente => ({
  id,
  enunciado: `Enunciado ${id}`,
  tipo: "abierta",
  puntos,
  posicion: pos,
  criterio: `Criterio de ${id}`,
  opciones: null,
  starter_code: null,
  language: null,
});

const cerrada = (id: string, correcta: number): PreguntaFuente => ({
  ...abierta(id),
  tipo: "cerrada",
  opciones: { choices: ["Tabla intermedia", "Una vista", "Un índice"], correct_index: correcta },
});

const base = {
  tipo: "examen" as const,
  titulo: "Prueba diagnóstica",
  peso: 0,
  nota: null,
  preguntas: [] as PreguntaFuente[],
  respuestas: new Map<string, RespuestaFuente>(),
};

describe("preguntasDeBanco / preguntasDeProyecto", () => {
  it("ordena por posición y toma el enunciado de `content`", () => {
    const p = preguntasDeBanco([
      { id: "b", content: "Segunda", type: "abierta", points: 2, position: 1 },
      { id: "a", content: "Primera", type: "cerrada", points: 1, position: 0 },
    ]);
    expect(p.map((x) => x.id)).toEqual(["a", "b"]);
    expect(p[0].enunciado).toBe("Primera");
    expect(p[1].puntos).toBe(2);
  });

  it("una fila sin `position` no se pierde: cae a su orden de llegada", () => {
    const p = preguntasDeBanco([
      { id: "x", content: "X" },
      { id: "y", content: "Y" },
    ]);
    expect(p.map((x) => x.id)).toEqual(["x", "y"]);
  });

  it("en un proyecto el enunciado es el título MÁS la descripción", () => {
    // Sin la descripción el estudiante lee un rótulo ("Justificación de
    // decisiones de diseño") y no reconoce qué le pidieron.
    const p = preguntasDeProyecto([
      { id: "f1", title: "Manual de usuario", description: "Incluya los 4 casos de uso.", points: 1 },
    ]);
    expect(p[0].enunciado).toBe("Manual de usuario — Incluya los 4 casos de uso.");
  });

  it("un proyecto sin descripción usa solo el título (sin el guion suelto)", () => {
    const p = preguntasDeProyecto([{ id: "f1", title: "Diagrama de clases" }]);
    expect(p[0].enunciado).toBe("Diagrama de clases");
  });

  it("el criterio de corrección viaja en `criterio`, nunca en el enunciado", () => {
    const p = preguntasDeBanco([
      { id: "a", content: "¿Qué es una tabla intermedia?", expected_rubric: "Correcta: 'Una tabla…'" },
    ]);
    expect(p[0].criterio).toBe("Correcta: 'Una tabla…'");
    expect(p[0].enunciado).not.toContain("Correcta:");
  });
});

describe("respuestasDeExamen — las trampas del JSONB", () => {
  const preguntas = [abierta("q1"), abierta("q2")];

  it("el puntaje del DOCENTE gana sobre el de la IA", () => {
    const m = respuestasDeExamen(preguntas, {
      q1: "mi respuesta",
      __breakdown: [{ qid: "q1", earned: 0.5, feedback: "de la IA" }],
      __manual_overrides: { q1: { score: 1, feedback: "corregido a mano" } },
    });
    expect(m.get("q1")!.obtenido).toBe(1);
    expect(m.get("q1")!.retroalimentacion).toBe("corregido a mano");
  });

  it("sin override manda el desglose de la IA", () => {
    const m = respuestasDeExamen(preguntas, {
      q1: "x",
      __breakdown: [{ qid: "q1", earned: 0.5, feedback: "casi" }],
    });
    expect(m.get("q1")!.obtenido).toBe(0.5);
    expect(m.get("q1")!.retroalimentacion).toBe("casi");
  });

  it("un override sin feedback conserva el de la IA", () => {
    const m = respuestasDeExamen(preguntas, {
      q1: "x",
      __breakdown: [{ qid: "q1", earned: 0, feedback: "revisá la definición" }],
      __manual_overrides: { q1: { score: 1 } },
    });
    expect(m.get("q1")!.obtenido).toBe(1);
    expect(m.get("q1")!.retroalimentacion).toBe("revisá la definición");
  });

  it("una pregunta sin desglose queda SIN puntaje (null), no en 0", () => {
    const m = respuestasDeExamen(preguntas, { q1: "x" });
    expect(m.get("q1")!.obtenido).toBeNull();
    expect(m.get("q2")!.obtenido).toBeNull();
  });

  it("NUNCA aparece una clave reservada de `answers` como si fuera pregunta", () => {
    const m = respuestasDeExamen(preguntas, {
      q1: "x",
      __session_id: "abc",
      __warning_events: [{ t: "blur" }],
      __saved_at: "2026-03-12T10:00:00Z",
      __current_idx: 4,
      __breakdown: [],
      __manual_overrides: {},
    });
    expect([...m.keys()]).toEqual(["q1", "q2"]);
  });

  it("tolera un `answers` nulo o de otro tipo sin lanzar", () => {
    expect([...respuestasDeExamen(preguntas, null).keys()]).toEqual(["q1", "q2"]);
    expect(respuestasDeExamen(preguntas, "basura").get("q1")!.obtenido).toBeNull();
  });
});

describe("respuestasDeFilas — taller y proyecto", () => {
  it("toma la nota y la retroalimentación de la fila", () => {
    const preguntas = [abierta("q1")];
    const m = respuestasDeFilas(preguntas, [
      { id: "q1", answer_text: "mi texto", ai_grade: 0.75, ai_feedback: "bien" },
    ]);
    expect(m.get("q1")).toEqual({
      valor: "mi texto",
      obtenido: 0.75,
      retroalimentacion: "bien",
    });
  });

  it("prefiere el código sobre el texto (mismo orden que la pantalla de calificación)", () => {
    const preguntas = [{ ...abierta("q1"), tipo: "codigo" }];
    const m = respuestasDeFilas(preguntas, [
      { id: "q1", answer_text: "no es esto", code_content: "class Main {}" },
    ]);
    expect(m.get("q1")!.valor).toBe("class Main {}");
  });

  it("una pregunta cerrada del taller guarda el índice como TEXTO y se coerce a número", () => {
    // El taller escribe `String(raw)`; el predicado de respondida exige número.
    const preguntas = [cerrada("q1", 0)];
    const m = respuestasDeFilas(preguntas, [{ id: "q1", selected_option: "2" }]);
    expect(m.get("q1")!.valor).toBe(2);
  });

  it("una pregunta sin fila queda sin valor y sin puntaje", () => {
    const m = respuestasDeFilas([abierta("q1")], []);
    expect(m.get("q1")).toEqual({ valor: undefined, obtenido: null, retroalimentacion: "" });
  });

  it("un proyecto usa `content` cuando no hay nada más", () => {
    const m = respuestasDeFilas([abierta("f1")], [{ id: "f1", content: "# Manual" }]);
    expect(m.get("f1")!.valor).toBe("# Manual");
  });
});

describe("respuestaLegible — el valor crudo NUNCA se imprime", () => {
  it("una cerrada muestra el TEXTO de la opción, no el índice", () => {
    expect(respuestaLegible(cerrada("q", 0), 0)).toBe("Tabla intermedia");
    expect(respuestaLegible(cerrada("q", 0), 2)).toBe("Un índice");
  });

  it("una cerrada con un índice fuera de rango cae al número de opción", () => {
    expect(respuestaLegible(cerrada("q", 0), 9)).toBe("10");
  });

  it("una cerrada sin responder queda vacía (no imprime '0')", () => {
    expect(respuestaLegible(cerrada("q", 0), undefined)).toBe("");
    expect(respuestaLegible(cerrada("q", 0), -1)).toBe("");
  });

  it("una múltiple lista los textos elegidos", () => {
    const q: PreguntaFuente = {
      ...cerrada("q", 0),
      tipo: "cerrada_multi",
      opciones: { choices: ["A", "B", "C"], correct_indices: [0, 2] },
    };
    expect(respuestaLegible(q, [0, 2])).toBe("A · C");
  });

  it("una bd_sql muestra el SQL, no el objeto serializado", () => {
    const q = { ...abierta("q"), tipo: "bd_sql" };
    const valor = JSON.stringify({ bdSql: 1, sql: "select * from alumnos", results: [] });
    expect(respuestaLegible(q, valor)).toBe("select * from alumnos");
    // Y jamás el JSON crudo.
    expect(respuestaLegible(q, valor)).not.toContain("bdSql");
  });

  it("un objeto de un tipo que no sabemos leer sale VACÍO, no como JSON", () => {
    const q = abierta("q");
    expect(respuestaLegible(q, { algo: 1 })).toBe("");
  });

  it("un texto suelto pasa tal cual", () => {
    expect(respuestaLegible(abierta("q"), "  mi respuesta  ")).toBe("  mi respuesta  ");
  });
});

describe("respuestaCorrectaLegible", () => {
  it("resuelve el texto de la opción correcta", () => {
    expect(respuestaCorrectaLegible(cerrada("q", 1))).toBe("Una vista");
  });

  it("una abierta no tiene respuesta correcta guardada (el criterio es del docente)", () => {
    expect(respuestaCorrectaLegible(abierta("q"))).toBe("");
  });

  it("una múltiple lista todas las correctas", () => {
    const q: PreguntaFuente = {
      ...abierta("q"),
      tipo: "cerrada_multi",
      opciones: { choices: ["A", "B", "C"], correct_indices: [1, 2] },
    };
    expect(respuestaCorrectaLegible(q)).toBe("B · C");
  });
});

describe("clasificarResultado — cuatro valores, ni uno más", () => {
  it("cubre los cuatro casos", () => {
    expect(clasificarResultado(false, null, 1)).toBe("Sin responder");
    expect(clasificarResultado(true, 1, 1)).toBe("Correcta");
    expect(clasificarResultado(true, 0.5, 1)).toBe("Parcial");
    expect(clasificarResultado(true, 0, 1)).toBe("Incorrecta");
  });

  it("respondida pero sin calificar todavía NO se lee como error", () => {
    expect(clasificarResultado(true, null, 1)).toBe("Parcial");
  });

  it("no se cuela un falso 'Parcial' por redondeo de coma flotante", () => {
    expect(clasificarResultado(true, 0.1 + 0.2, 0.3)).toBe("Correcta");
  });
});

describe("estadoLegible", () => {
  it("traduce el valor crudo de la columna", () => {
    expect(estadoLegible("calificado")).toBe("Calificado");
    expect(estadoLegible("entregado")).toBe("Entregado");
  });

  it("la sospecha de fraude NO se imprime en el documento del estudiante", () => {
    expect(estadoLegible("sospechoso")).toBe("En revisión");
    expect(estadoLegible("requiere_revision")).toBe("En revisión");
  });

  it("sin estado, cadena vacía (la plantilla decide si muestra algo)", () => {
    expect(estadoLegible(null)).toBe("");
  });
});

describe("construirEvaluacion", () => {
  const preguntas = [abierta("q1", 1, 0), abierta("q2", 1, 1), cerrada("q3", 0)];
  const respuestas = respuestasDeExamen(preguntas, {
    q1: "respuesta buena",
    q2: "respuesta a medias",
    q3: 0,
    __breakdown: [
      { qid: "q1", earned: 1, feedback: "perfecto" },
      { qid: "q2", earned: 0.5, feedback: "faltó nombrar la llave" },
      { qid: "q3", earned: 1 },
    ],
  });

  it("suma los puntos del detalle y NO recalcula la nota", () => {
    const ev = construirEvaluacion({
      ...base,
      preguntas,
      respuestas,
      nota: 2.9,
      peso: 10,
    });
    expect(ev.puntaje_obtenido).toBe("2,5");
    expect(ev.puntaje_total).toBe("3");
    // La nota es la que entró, con coma decimal — nunca obtenido/total×escala.
    expect(ev.nota).toBe("2,9");
  });

  it("los números salen con COMA decimal (es-CO), no con punto", () => {
    const ev = construirEvaluacion({ ...base, preguntas, respuestas, nota: 4 });
    expect(ev.nota).toBe("4,0");
    expect(ev.preguntas[1].obtenido).toBe("0,5");
  });

  it("cuenta respondidas sobre las PREGUNTAS y reparte los cuatro resultados", () => {
    const ev = construirEvaluacion({ ...base, preguntas, respuestas });
    expect(ev.respondidas).toBe("3 de 3");
    expect(ev.total_preguntas).toBe("3");
    expect(ev.correctas).toBe("2");
    expect(ev.parciales).toBe("1");
    expect(ev.incorrectas).toBe("0");
    expect(ev.sin_responder).toBe("0");
  });

  it("las tres listas son subconjuntos coherentes de la lista completa", () => {
    const ev = construirEvaluacion({ ...base, preguntas, respuestas });
    expect(ev.preguntas).toHaveLength(3);
    expect(ev.preguntas_a_reforzar.map((p) => p.numero)).toEqual(["2"]);
    expect(ev.preguntas_correctas.map((p) => p.numero)).toEqual(["1", "3"]);
    expect(ev.preguntas_a_reforzar.length + ev.preguntas_correctas.length).toBe(
      ev.preguntas.length,
    );
  });

  it("una entrega en blanco: nada respondido, y el puntaje es '—' y no 0", () => {
    const ev = construirEvaluacion({
      ...base,
      preguntas,
      respuestas: respuestasDeExamen(preguntas, {}),
    });
    expect(ev.respondidas).toBe("0 de 3");
    expect(ev.sin_responder).toBe("3");
    // "—" y no "0": un 0 afirma que no acertó nada; acá no hay nada calificado.
    expect(ev.puntaje_obtenido).toBe("—");
    expect(ev.nota).toBe("—");
  });

  it("una pregunta de código con la plantilla INTACTA cuenta como en blanco", () => {
    // Es la regla del predicado compartido: sin esto, quien entrega sin abrir el
    // editor aparecería como que respondió.
    const q: PreguntaFuente = {
      ...abierta("qc"),
      tipo: "codigo",
      starter_code: "public class Main {}",
      language: "java",
    };
    const ev = construirEvaluacion({
      ...base,
      preguntas: [q],
      respuestas: respuestasDeExamen([q], { qc: "public class Main {}" }),
    });
    expect(ev.respondidas).toBe("0 de 1");
    expect(ev.preguntas[0].resultado).toBe("Sin responder");
  });

  it("la frase del aporte a la nota dice la verdad en los dos casos", () => {
    const conPeso = construirEvaluacion({ ...base, preguntas, respuestas, peso: 15 });
    expect(conPeso.aporte_nota_final).toContain("15%");
    const sinPeso = construirEvaluacion({ ...base, preguntas, respuestas, peso: 0 });
    expect(sinPeso.aporte_nota_final).toBe(
      "Esta actividad no aporta a la nota final del curso.",
    );
  });

  it("el promedio del grupo ignora a quienes no tienen nota", () => {
    const ev = construirEvaluacion({
      ...base,
      preguntas,
      respuestas,
      notasCurso: [3, 4, null, 2],
    });
    expect(ev.grupo.promedio_curso).toBe("3,0");
  });

  it("sin ninguna nota en el curso, el promedio es '—' y no 0", () => {
    const ev = construirEvaluacion({ ...base, preguntas, respuestas, notasCurso: [null] });
    expect(ev.grupo.promedio_curso).toBe("—");
  });

  it("el porcentaje del grupo por pregunta promedia a quienes tienen dato", () => {
    const otro = respuestasDeExamen(preguntas, {
      q1: "x",
      __breakdown: [{ qid: "q1", earned: 0 }],
    });
    const ev = construirEvaluacion({
      ...base,
      preguntas,
      respuestas,
      respuestasCurso: [respuestas, otro],
    });
    // q1: 1 y 0 sobre 1 punto → 50%.
    expect(ev.preguntas[0].porcentaje_curso).toBe("50%");
    // q3: solo una entrega tiene dato (1/1) → 100%.
    expect(ev.preguntas[2].porcentaje_curso).toBe("100%");
  });

  it("sin datos del curso el porcentaje es '—' (no un 0% que parece un dato)", () => {
    const ev = construirEvaluacion({ ...base, preguntas, respuestas });
    expect(ev.preguntas[0].porcentaje_curso).toBe("—");
  });

  it("el criterio de corrección viaja, pero separado de la retroalimentación", () => {
    const ev = construirEvaluacion({ ...base, preguntas, respuestas });
    expect(ev.preguntas[0].criterio_docente).toBe("Criterio de q1");
    expect(ev.preguntas[0].retroalimentacion).toBe("perfecto");
  });

  it("la fecha de entrega sale FORMATEADA, y vacía si no hay", () => {
    const conFecha = construirEvaluacion({
      ...base,
      preguntas,
      respuestas,
      fechaEntrega: "2026-03-12T15:24:00Z",
    });
    expect(conFecha.fecha_entrega).not.toContain("T");
    expect(conFecha.fecha_entrega).toContain("2026");
    expect(
      construirEvaluacion({ ...base, preguntas, respuestas }).fecha_entrega,
    ).toBe("");
  });

  it("una evaluación sin preguntas no rompe (proyecto sin archivos configurados)", () => {
    const ev = construirEvaluacion({ ...base, preguntas: [], respuestas: new Map() });
    expect(ev.respondidas).toBe("0 de 0");
    expect(ev.preguntas).toEqual([]);
    expect(ev.puntaje_total).toBe("0");
  });
});
