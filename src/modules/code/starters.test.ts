import { describe, expect, it } from "vitest";
import {
  JAVA_STARTER,
  PYTHON_STARTER,
  JAVASCRIPT_STARTER,
  KOTLIN_STARTER,
  JAVA_GUI_STARTER,
  JAVAFX_STARTER,
  PYTHON_GUI_STARTER,
  getStarterCode,
} from "./starters";

/**
 * El CONTENIDO exacto de las plantillas es load-bearing, no cosmético.
 *
 * `isQuestionAnswered` decide si el alumno tocó el editor comparando su código
 * contra la plantilla. Si la plantilla cambia aunque sea en un salto de línea,
 * las respuestas YA GUARDADAS dejan de coincidir y una pregunta intacta vuelve
 * a contarse como respondida — que es justo el bug que el predicado unificado
 * existe para evitar.
 *
 * Pasó de verdad: al mover estas constantes desde `CodeEditor.tsx` a este
 * módulo, tres de las cuatro plantillas de código quedaron con los saltos de
 * línea DUPLICADOS. Los tests que había no lo vieron porque comparaban
 * `getStarterCode("java")` contra `JAVA_STARTER` —la misma constante contra sí
 * misma— así que seguían en verde con el texto corrupto.
 *
 * Por eso estas afirmaciones son sobre el TEXTO LITERAL. Si alguna falla, no la
 * "actualices" para que pase: revisá si el cambio en la plantilla fue
 * intencional, porque rompe la detección en las entregas anteriores.
 */
describe("plantillas: contenido literal fijado", () => {
  it("JAVA_STARTER es exactamente el esperado", () => {
    expect(JAVA_STARTER).toBe(
      'public class Main {\n    public static void main(String[] args) {\n        System.out.println("¡Hola, mundo!");\n    }\n}',
    );
  });

  it("PYTHON_STARTER es exactamente el esperado", () => {
    expect(PYTHON_STARTER).toBe(
      'def main():\n    print("¡Hola, mundo!")\n\n\nif __name__ == "__main__":\n    main()',
    );
  });

  it("JAVASCRIPT_STARTER es exactamente el esperado", () => {
    expect(JAVASCRIPT_STARTER).toBe('console.log("¡Hola, mundo!");');
  });

  it("KOTLIN_STARTER es exactamente el esperado", () => {
    expect(KOTLIN_STARTER).toBe('fun main() {\n    println("¡Hola, mundo!")\n}');
  });
});

describe("plantillas: ninguna tiene los saltos duplicados", () => {
  // La corrupción concreta que ocurrió: cada línea de código pasó a tener una
  // línea en blanco detrás. Se detecta como líneas vacías INTERCALADAS entre
  // dos líneas con contenido y con la misma indentación de bloque.
  const TODAS: Array<[string, string]> = [
    ["JAVA_STARTER", JAVA_STARTER],
    ["PYTHON_STARTER", PYTHON_STARTER],
    ["JAVASCRIPT_STARTER", JAVASCRIPT_STARTER],
    ["KOTLIN_STARTER", KOTLIN_STARTER],
    ["JAVA_GUI_STARTER", JAVA_GUI_STARTER],
    ["JAVAFX_STARTER", JAVAFX_STARTER],
    ["PYTHON_GUI_STARTER", PYTHON_GUI_STARTER],
  ];

  it("ninguna plantilla tiene un retorno de carro suelto", () => {
    // `\r` dentro del literal es señal de que alguien reescribió el archivo con
    // conversión de fin de línea: fue el primer paso de la corrupción.
    for (const [nombre, texto] of TODAS) {
      expect(texto.includes("\r"), `${nombre} tiene \\r`).toBe(false);
    }
  });

  it("ninguna cierra su bloque con una línea en blanco de más", () => {
    // `}\n\n}` o `)\n\n}` es la firma del salto duplicado en Java/Kotlin.
    for (const [nombre, texto] of TODAS) {
      expect(/\n[ \t]*\n[ \t]*\}/.test(texto), `${nombre} tiene un blanco antes de }`).toBe(false);
    }
  });

  it("la proporción de líneas vacías es razonable", () => {
    // Con los saltos duplicados, la mitad de las líneas quedan vacías.
    for (const [nombre, texto] of TODAS) {
      const lineas = texto.split("\n");
      const vacias = lineas.filter((l) => l.trim() === "").length;
      expect(vacias / lineas.length, `${nombre} tiene demasiadas líneas vacías`).toBeLessThan(0.4);
    }
  });
});

describe("getStarterCode", () => {
  it("devuelve la plantilla del lenguaje", () => {
    expect(getStarterCode("java")).toBe(JAVA_STARTER);
    expect(getStarterCode("python")).toBe(PYTHON_STARTER);
    expect(getStarterCode("javascript")).toBe(JAVASCRIPT_STARTER);
    expect(getStarterCode("kotlin")).toBe(KOTLIN_STARTER);
  });

  it("un lenguaje sin plantilla devuelve vacío, no lanza", () => {
    expect(getStarterCode("rust")).toBe("");
    expect(getStarterCode(null)).toBe("");
    expect(getStarterCode(undefined)).toBe("");
  });
});
