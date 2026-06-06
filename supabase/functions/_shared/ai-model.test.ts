/**
 * Tests de los helpers de normalización de provider/model.
 *
 * Estos helpers son la red de seguridad runtime para entornos donde la
 * migración 20260824000000 (deprecación de Lovable) no se aplicó todavía
 * o donde el cache de PostgREST devuelve datos legacy. Si esta lógica
 * se rompe, las edges fallan con provider inválido o el panel admin
 * carga un provider que el Select no muestra.
 */
import { describe, expect, it } from "vitest";
import { normalizeProvider, normalizeModel, type AiProvider } from "./ai-model-normalize";

describe("normalizeProvider", () => {
  it("'openai' → 'openai' (passthrough del único provider distinto)", () => {
    expect(normalizeProvider("openai")).toBe("openai");
  });

  it("'gemini' → 'gemini' (passthrough)", () => {
    expect(normalizeProvider("gemini")).toBe("gemini");
  });

  it("'lovable' legacy → 'gemini' (deprecación)", () => {
    expect(normalizeProvider("lovable")).toBe("gemini");
  });

  it("string vacío → 'gemini' (default)", () => {
    expect(normalizeProvider("")).toBe("gemini");
  });

  it("null → 'gemini' (default)", () => {
    expect(normalizeProvider(null)).toBe("gemini");
  });

  it("undefined → 'gemini' (default)", () => {
    expect(normalizeProvider(undefined)).toBe("gemini");
  });

  it("provider desconocido → 'gemini' (default seguro)", () => {
    expect(normalizeProvider("anthropic")).toBe("gemini");
    expect(normalizeProvider("xai")).toBe("gemini");
    expect(normalizeProvider("ollama")).toBe("gemini");
  });

  it("case-sensitive: 'OpenAI' (mayúscula) NO matchea — cae a gemini", () => {
    // La DB normaliza a lowercase via CHECK constraint, pero por
    // defensiva el helper es estricto. Si esto cambia, ajustar el
    // CHECK también.
    expect(normalizeProvider("OpenAI")).toBe("gemini");
    expect(normalizeProvider("OPENAI")).toBe("gemini");
  });
});

describe("normalizeModel", () => {
  it("gemini directo: limpia el prefijo 'google/' (formato gateway legacy)", () => {
    expect(normalizeModel("google/gemini-2.5-flash", "gemini")).toBe("gemini-2.5-flash");
    expect(normalizeModel("google/gemini-2.5-pro", "gemini")).toBe("gemini-2.5-pro");
    expect(normalizeModel("google/gemini-2.0-flash", "gemini")).toBe("gemini-2.0-flash");
  });

  it("gemini sin prefijo: passthrough", () => {
    expect(normalizeModel("gemini-2.5-flash", "gemini")).toBe("gemini-2.5-flash");
    expect(normalizeModel("gemini-2.5-pro", "gemini")).toBe("gemini-2.5-pro");
  });

  it("openai: NO toca el model (no llevan prefijo google/)", () => {
    expect(normalizeModel("gpt-4o", "openai")).toBe("gpt-4o");
    expect(normalizeModel("gpt-4o-mini", "openai")).toBe("gpt-4o-mini");
    expect(normalizeModel("gpt-4.1", "openai")).toBe("gpt-4.1");
  });

  it("openai con prefijo google/ accidental: NO se limpia (no aplica el caso)", () => {
    // Caso edge: model malformado donde alguien puso "google/X" con
    // provider openai. NO lo tocamos — el error es de input, mejor
    // que falle visible al pegarle a la API de OpenAI con un model
    // inválido que silenciosamente "corregirlo" mal.
    expect(normalizeModel("google/gpt-4o", "openai")).toBe("google/gpt-4o");
  });

  it("string vacío: passthrough (no rompe)", () => {
    expect(normalizeModel("", "gemini")).toBe("");
    expect(normalizeModel("", "openai")).toBe("");
  });

  it("solo 'google/' (sin sufijo): el slice deja string vacío", () => {
    // Caso degenerate: alguien guardó solo el prefijo. El helper
    // devuelve "" — el caller debería validar.
    expect(normalizeModel("google/", "gemini")).toBe("");
  });
});

describe("normalizeProvider + normalizeModel componibles", () => {
  // Smoke test del flujo real: una row legacy con provider='lovable'
  // y model='google/gemini-2.5-flash' debe quedar como provider='gemini'
  // + model='gemini-2.5-flash' tras correr ambos helpers.
  it("legacy row (lovable + google/gemini-2.5-flash) → gemini + gemini-2.5-flash", () => {
    const rawProvider = "lovable";
    const rawModel = "google/gemini-2.5-flash";
    const p: AiProvider = normalizeProvider(rawProvider);
    const m = normalizeModel(rawModel, p);
    expect(p).toBe("gemini");
    expect(m).toBe("gemini-2.5-flash");
  });

  it("row openai válida pasa intacta", () => {
    const p: AiProvider = normalizeProvider("openai");
    const m = normalizeModel("gpt-4o", p);
    expect(p).toBe("openai");
    expect(m).toBe("gpt-4o");
  });
});
