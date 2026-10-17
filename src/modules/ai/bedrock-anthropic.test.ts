// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Del EDGE por ruta relativa: valida el traductor que corre en producción.
import {
  tieneContenidoMultimodal,
  traducirAMensajesAnthropic,
  traducirRespuestaAnthropic,
} from "../../../supabase/functions/_shared/bedrock-anthropic.ts";

const HERRAMIENTA = {
  type: "function",
  function: {
    name: "score_code_zip",
    description: "Calificar",
    parameters: { type: "object", properties: { score: { type: "number" } }, required: ["score"] },
  },
};

describe("tieneContenidoMultimodal — solo las llamadas con imágenes o PDF cambian de API", () => {
  it("texto plano o partes de texto siguen por Converse", () => {
    expect(tieneContenidoMultimodal({ messages: [{ role: "user", content: "hola" }] })).toBe(false);
    expect(
      tieneContenidoMultimodal({ messages: [{ role: "user", content: [{ type: "text", text: "hola" }] }] }),
    ).toBe(false);
    expect(tieneContenidoMultimodal({})).toBe(false);
  });

  it("una imagen o un archivo la mandan a InvokeModel", () => {
    expect(
      tieneContenidoMultimodal({
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }],
      }),
    ).toBe(true);
    expect(
      tieneContenidoMultimodal({
        messages: [{ role: "user", content: [{ type: "file", file: { file_data: "data:application/pdf;base64,AA" } }] }],
      }),
    ).toBe(true);
  });
});

describe("traducirAMensajesAnthropic", () => {
  const cuerpo = traducirAMensajesAnthropic({
    model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    messages: [
      { role: "system", content: "Eres un evaluador." },
      { role: "system", content: "Puntaje máximo: 5." },
      {
        role: "user",
        content: [
          { type: "text", text: "Califica la entrega." },
          { type: "text", text: "   " },
          { type: "text", text: "Adjunto 1 de 2: diagramas/er.png" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          { type: "text", text: "Adjunto 2 de 2: mockup/Mockup.pdf" },
          { type: "file", file: { filename: "Mockup.pdf", file_data: "data:application/pdf;base64,JVBERi0=" } },
          { type: "image_url", image_url: { url: "data:image/bmp;base64,Qk0=" } },
        ],
      },
    ],
    tools: [HERRAMIENTA],
    tool_choice: { type: "function", function: { name: "score_code_zip" } },
  });

  it("lleva la versión de Anthropic para Bedrock, el system aparte y un tope de salida", () => {
    expect(cuerpo.anthropic_version).toBe("bedrock-2023-05-31");
    expect(cuerpo.max_tokens).toBe(4096);
    expect(cuerpo.system).toBe("Eres un evaluador.\n\nPuntaje máximo: 5.");
    expect(cuerpo).not.toHaveProperty("model");
  });

  it("traduce texto, imágenes y PDF a bloques de Anthropic, y descarta lo vacío y lo que no admite", () => {
    const mensajes = cuerpo.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(mensajes).toHaveLength(1);
    expect(mensajes[0].role).toBe("user");
    expect(mensajes[0].content).toEqual([
      { type: "text", text: "Califica la entrega." },
      { type: "text", text: "Adjunto 1 de 2: diagramas/er.png" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      { type: "text", text: "Adjunto 2 de 2: mockup/Mockup.pdf" },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
        title: "Mockup.pdf",
      },
    ]);
  });

  it("la herramienta y la elección forzada quedan en el formato de Anthropic", () => {
    expect(cuerpo.tools).toEqual([
      {
        name: "score_code_zip",
        description: "Calificar",
        input_schema: HERRAMIENTA.function.parameters,
      },
    ]);
    expect(cuerpo.tool_choice).toEqual({ type: "tool", name: "score_code_zip" });
  });

  it("un mensaje de texto plano viaja como un bloque de texto", () => {
    const c = traducirAMensajesAnthropic({ messages: [{ role: "user", content: "hola" }], max_tokens: 100 });
    expect(c.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hola" }] }]);
    expect(c.max_tokens).toBe(100);
    expect(c).not.toHaveProperty("tools");
  });
});

describe("traducirRespuestaAnthropic", () => {
  it("el tool_use vuelve como tool_calls con los argumentos en JSON, que es lo que leen los edges", () => {
    const r = traducirRespuestaAnthropic({
      content: [
        { type: "text", text: "Reviso la entrega." },
        { type: "tool_use", id: "toolu_1", name: "score_code_zip", input: { score: 4.5, feedback: "Bien" } },
      ],
      stop_reason: "tool_use",
    }) as { choices: Array<{ message: { content: string; tool_calls: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }> };
    const m = r.choices[0].message;
    expect(m.content).toBe("Reviso la entrega.");
    expect(m.tool_calls[0].function.name).toBe("score_code_zip");
    expect(JSON.parse(m.tool_calls[0].function.arguments)).toEqual({ score: 4.5, feedback: "Bien" });
    expect(r.choices[0].finish_reason).toBe("tool_use");
  });

  it("sin herramienta devuelve solo el texto", () => {
    const r = traducirRespuestaAnthropic({ content: [{ type: "text", text: "ok" }] }) as {
      choices: Array<{ message: Record<string, unknown> }>;
    };
    expect(r.choices[0].message).toEqual({ role: "assistant", content: "ok" });
  });
});

describe("enrutado en aiChatCompletionFailover (ai-model.ts no se puede importar bajo vitest: usa Deno)", () => {
  const fuente = readFileSync("supabase/functions/_shared/ai-model.ts", "utf8");

  it("una llamada de Claude con adjuntos va por InvokeModel y la de solo texto sigue por Converse", () => {
    // Si volviera a Converse, su traductor convierte el contenido en texto con JSON.stringify: el
    // modelo recibiría megas de base64 como si fueran la entrega.
    expect(fuente).toMatch(/anthropicMultimodal\s*=\s*esAnthropicEnBedrock\s*&&\s*tieneContenidoMultimodal\(payload\)/);
    const invoke = fuente.indexOf("bedrockAnthropicInvokeFetch(key");
    const converse = fuente.indexOf("bedrockConverseFetch(key");
    expect(invoke).toBeGreaterThan(-1);
    expect(converse).toBeGreaterThan(invoke);
    expect(fuente.slice(fuente.lastIndexOf("anthropicMultimodal", invoke), invoke)).toMatch(/anthropicMultimodal\s*\?\s*$/);
  });
});
