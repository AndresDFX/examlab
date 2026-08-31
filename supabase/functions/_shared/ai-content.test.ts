import { describe, expect, it } from "vitest";
import { textoUtil } from "./ai-content";

/**
 * La entrada de estos casos es la salida REAL medida contra Amazon Bedrock
 * (`us-east-1`, `openai.gpt-oss-120b-1:0`), no una inventada.
 */
describe("textoUtil", () => {
  it("quita el bloque de razonamiento y deja la respuesta", () => {
    const real =
      '<reasoning>We need to respond as a tutor, brief, Spanish, two sentences. ADR = "Alternative Dispute Resolution" or "Arquitectura"? Provide definition.</reasoning>' +
      "Un ADR es un registro de decisiones de arquitectura. Sirve para dejar por escrito el porqué.";
    const r = textoUtil(real);
    expect(r).not.toContain("reasoning");
    expect(r).not.toContain("We need to respond");
    expect(r.startsWith("Un ADR es un registro")).toBe(true);
  });

  it("un texto sin la marca no se toca (Gemini y OpenAI)", () => {
    // Por eso se puede aplicar siempre, sin preguntar por el proveedor: el
    // proveedor lo decide la institución en runtime.
    expect(textoUtil("Respuesta normal, con <b>html</b> y saltos.\nSegunda línea.")).toBe(
      "Respuesta normal, con <b>html</b> y saltos.\nSegunda línea.",
    );
  });

  it("una apertura SIN cierre descarta todo: no hay respuesta que rescatar", () => {
    // Pasa cuando la respuesta se corta por tope de tokens. Devolver el
    // razonamiento a medias sería mostrarle al alumno el borrador del modelo.
    expect(textoUtil("<reasoning>estoy pensando y me cortaron")).toBe("");
  });

  it("un cierre huérfano descarta lo previo", () => {
    expect(textoUtil("cola de razonamiento</reasoning>La respuesta.")).toBe("La respuesta.");
  });

  it("cubre las otras etiquetas de razonamiento y varios bloques", () => {
    expect(textoUtil("<think>a</think>Uno.<thinking>b</thinking> Dos.")).toBe("Uno. Dos.");
  });

  it("no rompe con nada que no sea string", () => {
    expect(textoUtil(null)).toBe("");
    expect(textoUtil(undefined)).toBe("");
    expect(textoUtil(42)).toBe("");
    expect(textoUtil({})).toBe("");
  });

  it("recorta los bordes", () => {
    expect(textoUtil("  <reasoning>x</reasoning>  \n Respuesta. \n ")).toBe("Respuesta.");
  });
});
