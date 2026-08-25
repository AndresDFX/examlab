import { describe, expect, it } from "vitest";
import {
  countAnswered,
  getUnansweredIndices,
  isQuestionAnswered,
  type QuestionForAnswered,
} from "./answered";
import { JAVA_GUI_STARTER, PYTHON_GUI_STARTER, getStarterCode } from "@/modules/code/starters";
import { serializeSqlAnswer } from "@/modules/database/sql-answer";

const q = (over: Partial<QuestionForAnswered> & { type: string }): QuestionForAnswered => ({
  id: "q1",
  ...over,
});

describe("isQuestionAnswered — código: la plantilla intacta NO cuenta", () => {
  // El bug que originó la unificación: el examen contaba la plantilla como
  // respondida, así que un alumno que pulsaba Entregar SIN ABRIR el editor no
  // recibía ninguna advertencia y entregaba en 0. El taller ya lo detectaba.
  it("el starter_code de la pregunta, tal cual, es NO respondida", () => {
    const p = q({ type: "codigo", starter_code: "public class Main {}" });
    expect(isQuestionAnswered(p, { q1: "public class Main {}" })).toBe(false);
  });

  it("y tampoco cuenta con espacios de más alrededor", () => {
    const p = q({ type: "codigo", starter_code: "public class Main {}" });
    expect(isQuestionAnswered(p, { q1: "\n  public class Main {}  \n" })).toBe(false);
  });

  it("una sola línea agregada YA cuenta como respondida", () => {
    const p = q({ type: "codigo", starter_code: "public class Main {}" });
    expect(isQuestionAnswered(p, { q1: "public class Main {}\n// mi solución" })).toBe(true);
  });

  it("sin starter_code propio, se compara contra la plantilla que el editor MUESTRA", () => {
    // Si se comparara contra "" (vacío), una pregunta sin `starter_code` en la
    // base contaría como respondida apenas se abre el editor.
    const p = q({ type: "codigo", language: "java", starter_code: null });
    expect(getStarterCode("java")).not.toBe("");
    expect(isQuestionAnswered(p, { q1: getStarterCode("java") })).toBe(false);
    expect(isQuestionAnswered(p, { q1: getStarterCode("java") + "\nint x;" })).toBe(true);
  });

  it("java_gui y python_gui usan su propia plantilla", () => {
    const java = q({ type: "java_gui", starter_code: null });
    expect(isQuestionAnswered(java, { q1: JAVA_GUI_STARTER })).toBe(false);
    const py = q({ type: "python_gui", starter_code: null });
    expect(isQuestionAnswered(py, { q1: PYTHON_GUI_STARTER })).toBe(false);
  });

  it("un lenguaje sin plantilla conocida: cualquier texto cuenta", () => {
    // `getStarterCode` devuelve "" para los 10 lenguajes que no tiene mapeados.
    // Sin la guarda `plantilla === ""`, comparar contra vacío haría que NADA
    // contara como respondida en esos lenguajes.
    const p = q({ type: "codigo", language: "rust", starter_code: null });
    expect(getStarterCode("rust")).toBe("");
    expect(isQuestionAnswered(p, { q1: "fn main() {}" })).toBe(true);
  });

  it("vacío es no respondida en cualquier caso", () => {
    const p = q({ type: "codigo", starter_code: "x" });
    for (const v of ["", "   ", null, undefined]) {
      expect(isQuestionAnswered(p, { q1: v })).toBe(false);
    }
  });
});

describe("isQuestionAnswered — cerrada y cerrada_multi", () => {
  it("cerrada exige el ÍNDICE numérico de la opción", () => {
    const p = q({ type: "cerrada" });
    expect(isQuestionAnswered(p, { q1: 0 })).toBe(true);
    expect(isQuestionAnswered(p, { q1: 3 })).toBe(true);
    expect(isQuestionAnswered(p, { q1: -1 })).toBe(false);
    expect(isQuestionAnswered(p, {})).toBe(false);
  });

  it("cerrada NO acepta un string suelto como respuesta", () => {
    // El predicado del taller sí lo aceptaba (miraba solo "no vacío"). Un
    // string acá es un dato corrupto, no una opción elegida.
    expect(isQuestionAnswered(q({ type: "cerrada" }), { q1: "2" })).toBe(false);
  });

  it("la opción 0 (la primera) cuenta como respondida", () => {
    // Caso clásico de falsy: si se chequeara `if (v)`, elegir la primera opción
    // se leería como no responder.
    expect(isQuestionAnswered(q({ type: "cerrada" }), { q1: 0 })).toBe(true);
  });

  it("cerrada_multi respeta min_selections", () => {
    const p = q({ type: "cerrada_multi", options: { min_selections: 2 } });
    expect(isQuestionAnswered(p, { q1: [1] })).toBe(false);
    expect(isQuestionAnswered(p, { q1: [1, 3] })).toBe(true);
    expect(isQuestionAnswered(p, { q1: [] })).toBe(false);
  });

  it("cerrada_multi sin min_selections: una marca alcanza", () => {
    expect(isQuestionAnswered(q({ type: "cerrada_multi" }), { q1: [0] })).toBe(true);
  });
});

describe("isQuestionAnswered — bd_sql y so_consola", () => {
  it("bd_sql: SQL escrito cuenta aunque no se haya ejecutado", () => {
    const p = q({ type: "bd_sql" });
    const conSql = serializeSqlAnswer({ sql: "select 1", results: [] });
    expect(isQuestionAnswered(p, { q1: conSql })).toBe(true);
  });

  it("bd_sql: el sobre JSON sin SQL NO cuenta", () => {
    // Acá estaba el bug: el examen caía al chequeo genérico de string y, como
    // la respuesta SQL SIEMPRE se serializa a un JSON no vacío, un alumno que
    // escribió y borró contaba como respondido. El fixture se arma con el
    // serializador REAL para que no pueda divergir del formato persistido.
    const p = q({ type: "bd_sql" });
    const vacio = serializeSqlAnswer({ sql: "   ", results: [] });
    expect(vacio.length).toBeGreaterThan(10); // el sobre NO es vacío...
    expect(isQuestionAnswered(p, { q1: vacio })).toBe(false); // ...y aun así no cuenta
    expect(isQuestionAnswered(p, { q1: "" })).toBe(false);
  });

  it("so_consola: sin interacción con la terminal NO cuenta", () => {
    const p = q({ type: "so_consola" });
    expect(isQuestionAnswered(p, { q1: "" })).toBe(false);
    expect(isQuestionAnswered(p, {})).toBe(false);
  });
});

describe("isQuestionAnswered — red", () => {
  it("red_consola exige comandos, no solo una topología parseable", () => {
    const p = q({ type: "red_consola" });
    const topology = { devices: [], links: [] };
    const sinComandos = JSON.stringify({ topology, histories: { pc1: [] } });
    expect(isQuestionAnswered(p, { q1: sinComandos })).toBe(false);
    const conComandos = JSON.stringify({ topology, histories: { pc1: ["ping"] } });
    expect(isQuestionAnswered(p, { q1: conComandos })).toBe(true);
  });

  it("red_gui alcanza con una topología parseable", () => {
    const p = q({ type: "red_gui" });
    const t = JSON.stringify({ topology: { devices: [], links: [] }, histories: {} });
    expect(isQuestionAnswered(p, { q1: t })).toBe(true);
  });
});

describe("countAnswered", () => {
  const preguntas = [
    q({ id: "a", type: "abierta" }),
    q({ id: "b", type: "cerrada" }),
    q({ id: "c", type: "codigo", starter_code: "PLANTILLA" }),
  ];

  it("cuenta solo las respondidas de verdad", () => {
    const n = countAnswered(preguntas, { a: "mi respuesta", b: 1, c: "PLANTILLA" });
    expect(n).toBe(2); // la de código quedó intacta
  });

  it("los metadatos de answers NO inflan el conteo", () => {
    // `__session_id` se inyecta al ABRIR el examen, antes de responder nada:
    // contar sobre Object.keys(answers) daría 1 desde el primer render.
    const n = countAnswered(preguntas, {
      __session_id: "abc",
      __current_idx: 2,
      __warning_events: [{ type: "pestaña" }],
    });
    expect(n).toBe(0);
  });

  it("answers nulo o ausente da 0, no explota", () => {
    expect(countAnswered(preguntas, null)).toBe(0);
    expect(countAnswered(preguntas, undefined)).toBe(0);
    expect(countAnswered([], { a: "x" })).toBe(0);
  });

  it("es independiente del ORDEN de las preguntas", () => {
    // El examen baraja por alumno; el monitor ordena por `position`. Un conteo
    // que dependiera del orden daría números distintos en cada pantalla.
    const answers = { a: "x", b: 0, c: "PLANTILLA y algo más" };
    const alReves = [...preguntas].reverse();
    expect(countAnswered(preguntas, answers)).toBe(countAnswered(alReves, answers));
    expect(countAnswered(preguntas, answers)).toBe(3);
  });

  it("concuerda con getUnansweredIndices: respondidas + en blanco = total", () => {
    const answers = { a: "x", c: "PLANTILLA" };
    const respondidas = countAnswered(preguntas, answers);
    const enBlanco = getUnansweredIndices(preguntas, answers).length;
    expect(respondidas + enBlanco).toBe(preguntas.length);
  });
});

describe("los casos que encontró la auditoría adversarial", () => {
  it("so_consola: un string plano (lo que guarda el EXAMEN) SÍ cuenta", () => {
    // El examen no renderiza la consola: cae al textarea genérico, así que la
    // respuesta es texto plano y NO el sobre `{"v86":1,…}` del taller. Tratarlo
    // solo con `isV86AnswerBlank` invertía una respuesta correcta a "en blanco".
    const p = q({ type: "so_consola" });
    expect(isQuestionAnswered(p, { q1: "ls -la /etc" })).toBe(true);
    expect(isQuestionAnswered(p, { q1: "   " })).toBe(false);
  });

  it("codigo con language NULL compara contra la MISMA plantilla que ve el alumno", () => {
    // El editor pinta `getStarterCode(q.language ?? "java")`. Si el predicado
    // usara `getStarterCode(null)` -> "", la guarda de plantilla vacía haría que
    // una pregunta intacta contara como respondida, y la regla quedaba sin
    // efecto justo en las preguntas legacy sin lenguaje.
    const p = q({ type: "codigo", language: null, starter_code: null });
    expect(isQuestionAnswered(p, { q1: getStarterCode("java") })).toBe(false);
    expect(isQuestionAnswered(p, { q1: getStarterCode("java") + " int x;" })).toBe(true);
  });
});
