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

  it("un cierre huérfano AL PRINCIPIO descarta lo previo", () => {
    expect(textoUtil("</reasoning>La respuesta.")).toBe("La respuesta.");
  });

  /**
   * Antes esta regla no estaba anclada y borraba desde el principio hasta el
   * primer cierre, esté donde esté, así que `"cola de razonamiento</reasoning>La
   * respuesta."` devolvía `"La respuesta."`. Se cambió porque no hay forma de
   * distinguir por la forma del texto un cierre huérfano real de una mención
   * legítima —en los dos casos lo que precede es prosa— y el precio de
   * equivocarse es asimétrico: dejar pasar el razonamiento es feo pero VISIBLE
   * y reportable; borrar la cabeza de la respuesta es pérdida silenciosa. La
   * forma observada de Bedrock siempre trae la apertura, así que un cierre a
   * mitad de texto es evidencia de mención, no de artefacto.
   */
  it("un cierre huérfano a MITAD de texto ya no se lleva la cabeza de la respuesta", () => {
    const legitimo =
      "Un ADR es un registro de decisión de arquitectura. " +
      "Los modelos que usan </think> marcan así el fin de su razonamiento.";
    expect(textoUtil(legitimo)).toBe(legitimo);
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

/**
 * No-regresión de las reglas que antes no estaban ancladas. Los tres casos se
 * midieron ejecutando el helper: cada uno perdía texto legítimo en silencio, y
 * cuando lo que quedaba era vacío `tutor-chat` / `platform-support-chat` lo
 * sustituían por «No pude generar una respuesta en este momento» —
 * indistinguible de una caída del proveedor.
 */
describe("textoUtil — no se lleva contenido legítimo", () => {
  it("una apertura MENCIONADA a mitad de texto no borra el resto", () => {
    const t = "Respuesta real primero. Y acá menciono <thinking> como etiqueta.";
    expect(textoUtil(t)).toBe(t);
  });

  it("un elemento personalizado <think-box> no cuenta como apertura", () => {
    // `\b` lo aceptaba (el límite de palabra cae entre la «k» y el «-») y se
    // borraba el resto del documento. `generate-contents` produce material en
    // HTML/Markdown, así que ese elemento es contenido plausible.
    const t = "Título\n\n<think-box>Nota lateral</think-box>\n\nCuerpo del documento generado.";
    expect(textoUtil(t)).toContain("Cuerpo del documento generado.");
  });

  it("<reasoning-step> tampoco", () => {
    const t = "Paso a paso:\n<reasoning-step>uno</reasoning-step>\nConclusión.";
    expect(textoUtil(t)).toContain("Conclusión.");
  });

  it("el artefacto REAL de Bedrock sigue limpiándose (la razón de existir)", () => {
    expect(
      textoUtil("<reasoning>We need to respond…</reasoning>Un ADR es un conjunto de métodos."),
    ).toBe("Un ADR es un conjunto de métodos.");
  });

  /**
   * LÍMITE ACEPTADO, no un bug pendiente: un par CERRADO es la señal más
   * confiable de que es markup, así que se limpia donde aparezca aunque eso
   * mutile una frase que hable de las etiquetas. Se pierde media frase, nunca
   * la respuesta. Queda fijado para que el próximo que lo vea no lo tome por
   * una regresión.
   */
  it("una mención EMPAREJADA sí mutila la frase (intercambio deliberado)", () => {
    expect(
      textoUtil("Delimitan su borrador entre <think> y </think>; adentro va el borrador."),
    ).toBe("Delimitan su borrador entre ; adentro va el borrador.");
  });

  /**
   * LÍMITE CONOCIDO: los marcadores nativos del formato «harmony» de gpt-oss no
   * se tocan. No se agrega el patrón por ahora porque no hay ni una salida real
   * de Bedrock guardada que los muestre, y la lista de etiquetas de este helper
   * sale de UNA transcripción a mano. Si aparecen en producción, el patrón
   * `<\|channel\|>analysis[\s\S]*?<\|message\|>` va en `ai-content.ts` y este
   * caso cambia de expectativa.
   */
  it("los marcadores «harmony» pasan intactos (aún no observados)", () => {
    const t = "<|channel|>analysis<|message|>pensando<|end|>La respuesta.";
    expect(textoUtil(t)).toBe(t);
  });
});
