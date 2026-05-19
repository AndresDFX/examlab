import { describe, expect, it } from "vitest";
import {
  buildTutorSystemPrompt,
  estimateTokens,
  truncateHistory,
  type ChatMessage,
} from "./tutor-prompt";

describe("buildTutorSystemPrompt", () => {
  const template =
    'Eres tutor del curso "{{course_name}}".\n\nDescripción: {{course_description}}\n\nTemas:\n{{course_content_topics}}';

  it("sustituye placeholders con datos del curso", () => {
    const out = buildTutorSystemPrompt({
      template,
      courseName: "Programación II",
      courseDescription: "Algoritmos y estructuras de datos",
      contentTopics: ["Recursividad", "Listas enlazadas", "Árboles binarios"],
    });
    expect(out).toContain('Eres tutor del curso "Programación II"');
    expect(out).toContain("Descripción: Algoritmos y estructuras de datos");
    expect(out).toContain("- Recursividad");
    expect(out).toContain("- Listas enlazadas");
    expect(out).toContain("- Árboles binarios");
  });

  it("fallback amigable cuando no hay descripción", () => {
    const out = buildTutorSystemPrompt({
      template,
      courseName: "Cálculo",
      courseDescription: null,
      contentTopics: ["Derivadas"],
    });
    expect(out).toContain("(El docente no proporcionó descripción del curso.)");
  });

  it("fallback amigable cuando no hay topics", () => {
    const out = buildTutorSystemPrompt({
      template,
      courseName: "Cálculo",
      courseDescription: "X",
      contentTopics: [],
    });
    expect(out).toContain("(Aún no hay material generado.)");
  });

  it("usa nombre genérico si courseName está vacío", () => {
    const out = buildTutorSystemPrompt({
      template,
      courseName: "",
      courseDescription: "X",
      contentTopics: [],
    });
    expect(out).toContain('Eres tutor del curso "el curso"');
  });

  it("ignora placeholders desconocidos (los deja literales)", () => {
    const out = buildTutorSystemPrompt({
      template: "Hola {{unknown_placeholder}}",
      courseName: "X",
      contentTopics: [],
    });
    expect(out).toBe("Hola {{unknown_placeholder}}");
  });

  it("trunca el bloque de topics si excede maxTopicsChars", () => {
    const manyTopics = Array.from({ length: 200 }, (_, i) => `Tema ${i + 1}`);
    const out = buildTutorSystemPrompt({
      template: "{{course_content_topics}}",
      courseName: "X",
      contentTopics: manyTopics,
      maxTopicsChars: 200,
    });
    // El resultado debería estar truncado, mencionando los temas omitidos
    expect(out).toMatch(/truncados por longitud/);
    expect(out.length).toBeLessThan(400); // generoso, pero acotado
  });

  it("ignora topics vacíos / whitespace", () => {
    const out = buildTutorSystemPrompt({
      template: "{{course_content_topics}}",
      courseName: "X",
      contentTopics: ["Tema A", "   ", "", "Tema B"],
    });
    expect(out).toContain("- Tema A");
    expect(out).toContain("- Tema B");
    // No debería aparecer un bullet vacío
    expect(out).not.toMatch(/^- $/m);
  });
});

describe("truncateHistory", () => {
  const mk = (n: number): ChatMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Mensaje ${i + 1}`,
    }));

  it("devuelve copia si messages.length <= maxMessages", () => {
    const msgs = mk(3);
    const out = truncateHistory(msgs, 10);
    expect(out).toHaveLength(3);
    expect(out).not.toBe(msgs); // copia, no referencia
  });

  it("conserva los últimos N cuando excede", () => {
    const msgs = mk(20);
    const out = truncateHistory(msgs, 5);
    expect(out).toHaveLength(5);
    expect(out[0].content).toBe("Mensaje 16");
    expect(out[4].content).toBe("Mensaje 20");
  });

  it("maxMessages = 0 retorna lista completa (copia)", () => {
    const msgs = mk(3);
    const out = truncateHistory(msgs, 0);
    expect(out).toHaveLength(3);
  });

  it("maxMessages negativo retorna lista completa (copia)", () => {
    const msgs = mk(3);
    const out = truncateHistory(msgs, -1);
    expect(out).toHaveLength(3);
  });

  it("lista vacía → lista vacía", () => {
    expect(truncateHistory([], 5)).toEqual([]);
  });
});

describe("estimateTokens", () => {
  it("heurística ~4 chars/token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("redondea hacia arriba (textos cortos no se subestiman)", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("ab")).toBe(1);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
