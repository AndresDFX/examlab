import { describe, expect, it } from "vitest";

import {
  efectoDeRestablecer,
  hayAlgoQueRestablecer,
  respuestaRestablecida,
} from "./restablecer-respuesta";
import { getStarterCode, JAVA_GUI_STARTER } from "@/modules/code/starters";
import type { QuestionForAnswered } from "./answered";
import { isQuestionAnswered } from "./answered";

const q = (over: Partial<QuestionForAnswered> & { type: string }): QuestionForAnswered => ({
  id: "q1",
  ...over,
});

describe("respuestaRestablecida", () => {
  it("una pregunta de código vuelve a SU plantilla, no a vacío", () => {
    // Vaciarla dejaría al alumno sin el andamiaje que le dio el enunciado,
    // obligándolo a reescribir algo que él nunca escribió.
    const p = q({ type: "codigo", starter_code: "public class Main {}" });
    expect(respuestaRestablecida(p)).toBe("public class Main {}");
  });

  it("sin plantilla propia, vuelve a la que el editor MUESTRA", () => {
    const p = q({ type: "codigo", language: "java", starter_code: null });
    expect(respuestaRestablecida(p)).toBe(getStarterCode("java"));
  });

  it("java_gui vuelve a su plantilla propia", () => {
    expect(respuestaRestablecida(q({ type: "java_gui", starter_code: null }))).toBe(
      JAVA_GUI_STARTER,
    );
  });

  it("un lenguaje sin plantilla conocida se vacía", () => {
    const p = q({ type: "codigo", language: "rust", starter_code: null });
    expect(respuestaRestablecida(p)).toBeUndefined();
  });

  it.each(["abierta", "cerrada", "cerrada_multi", "bd_sql", "diagrama", "red_consola"])(
    "'%s' vuelve a «sin responder»",
    (type) => {
      expect(respuestaRestablecida(q({ type }))).toBeUndefined();
    },
  );
});

describe("lo restablecido NUNCA cuenta como respondido", () => {
  // Si restableciera y la pregunta siguiera figurando contestada, el aviso de
  // «entregas con N en blanco» mentiría. Es la misma contradicción que el repo
  // ya pagó cuando la plantilla se guardaba como si fuera la respuesta.
  it.each([
    q({ type: "codigo", starter_code: "PLANTILLA" }),
    q({ type: "codigo", language: "java", starter_code: null }),
    q({ type: "java_gui", starter_code: null }),
    q({ type: "abierta" }),
    q({ type: "cerrada" }),
    q({ type: "bd_sql" }),
  ])("tipo $type", (pregunta) => {
    const valor = respuestaRestablecida(pregunta);
    expect(isQuestionAnswered(pregunta, { [pregunta.id]: valor })).toBe(false);
  });
});

describe("efectoDeRestablecer — para poder avisar ANTES", () => {
  it("código dice que vuelve a la plantilla", () => {
    expect(efectoDeRestablecer(q({ type: "codigo" }))).toBe("plantilla");
    expect(efectoDeRestablecer(q({ type: "python_gui" }))).toBe("plantilla");
  });

  it("el resto dice que se vacía", () => {
    expect(efectoDeRestablecer(q({ type: "abierta" }))).toBe("vacio");
  });
});

describe("hayAlgoQueRestablecer — un botón que no hace nada enseña que la pantalla está muerta", () => {
  it("sin valor, no", () => {
    expect(hayAlgoQueRestablecer(q({ type: "abierta" }), undefined)).toBe(false);
    expect(hayAlgoQueRestablecer(q({ type: "abierta" }), "   ")).toBe(false);
  });

  it("con la plantilla intacta, tampoco: ya está restablecida", () => {
    const p = q({ type: "codigo", starter_code: "PLANTILLA" });
    expect(hayAlgoQueRestablecer(p, "PLANTILLA")).toBe(false);
    expect(hayAlgoQueRestablecer(p, "  PLANTILLA  ")).toBe(false);
  });

  it("con código escrito de verdad, sí", () => {
    const p = q({ type: "codigo", starter_code: "PLANTILLA" });
    expect(hayAlgoQueRestablecer(p, "int x = 1;")).toBe(true);
  });

  it("una opción elegida cuenta, incluso la primera (índice 0)", () => {
    // El 0 es una RESPUESTA, no un vacío — el mismo borde que ya documenta el
    // borrador local de talleres.
    expect(hayAlgoQueRestablecer(q({ type: "cerrada" }), 0)).toBe(true);
  });

  it("un arreglo vacío no, uno con selección sí", () => {
    expect(hayAlgoQueRestablecer(q({ type: "cerrada_multi" }), [])).toBe(false);
    expect(hayAlgoQueRestablecer(q({ type: "cerrada_multi" }), [1])).toBe(true);
  });
});
