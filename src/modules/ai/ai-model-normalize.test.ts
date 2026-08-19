import { describe, expect, it } from "vitest";
import {
  normalizeModel,
  normalizeProvider,
  type AiProvider,
} from "../../../supabase/functions/_shared/ai-model-normalize";

/**
 * Estos helpers deciden CON QUÉ API KEY y CONTRA QUÉ ENDPOINT se resuelve cada
 * llamada a la IA, así que un mapeo equivocado no falla ruidosamente: manda la
 * key de un proveedor al endpoint de otro y devuelve 401 en producción.
 *
 * No tenían tests. Se agregan al sumar `bedrock`, porque la forma anterior
 * ("cualquier cosa que no sea openai es gemini") habría resuelto un tenant
 * configurado en Bedrock como Gemini, en silencio.
 */
describe("normalizeProvider", () => {
  it("mapea los tres providers soportados", () => {
    expect(normalizeProvider("openai")).toBe("openai");
    expect(normalizeProvider("gemini")).toBe("gemini");
    expect(normalizeProvider("bedrock")).toBe("bedrock");
  });

  it("bedrock NO se resuelve como gemini (la regresión que este test ataja)", () => {
    expect(normalizeProvider("bedrock")).not.toBe("gemini");
  });

  it("'lovable' legacy y los valores desconocidos caen a gemini", () => {
    for (const v of ["lovable", "", "  ", "anthropic", "BEDROCK", "OpenAI", null, undefined]) {
      expect(normalizeProvider(v as string | null)).toBe("gemini");
    }
  });

  it("es sensible a mayúsculas a propósito: el CHECK de la DB guarda minúsculas", () => {
    // Si alguien escribe 'Bedrock' a mano en la DB, el CHECK lo rechaza antes de
    // llegar acá. Aceptarlo tolerante escondería una fila inválida.
    expect(normalizeProvider("Bedrock")).toBe("gemini");
  });
});

describe("normalizeModel", () => {
  it("quita el prefijo google/ solo para gemini (legacy del gateway)", () => {
    expect(normalizeModel("google/gemini-2.5-flash", "gemini")).toBe("gemini-2.5-flash");
    expect(normalizeModel("gemini-2.5-flash", "gemini")).toBe("gemini-2.5-flash");
  });

  it("no toca los ids de OpenAI", () => {
    expect(normalizeModel("gpt-4o-mini", "openai")).toBe("gpt-4o-mini");
  });

  it("preserva los ids de Bedrock, que llevan punto y dos puntos", () => {
    // "openai.gpt-oss-120b-1:0" — recortar cualquier cosa acá haría que Bedrock
    // devolviera model_not_found.
    for (const m of ["openai.gpt-oss-120b-1:0", "openai.gpt-oss-20b-1:0"]) {
      expect(normalizeModel(m, "bedrock")).toBe(m);
    }
  });

  it("un id de Bedrock que empieza con google/ NO se recorta", () => {
    // El recorte es exclusivo de gemini: aplicarlo por prefijo y no por provider
    // rompería un id de Bedrock que casualmente empiece igual.
    expect(normalizeModel("google/algo", "bedrock" as AiProvider)).toBe("google/algo");
  });
});
