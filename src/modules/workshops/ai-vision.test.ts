import { describe, expect, it } from "vitest";

// Se importa del EDGE por ruta relativa, no una copia: Deno no puede importar de
// `src/`, pero vitest sí puede leer el módulo del edge. Así el test valida la función
// que corre en producción y no un duplicado que se desincroniza en silencio.
// Mismo criterio que `identify-types.test.ts` con las constantes de su edge.
import {
  MODELO_VISION_GEMINI,
  modeloAceptaImagen,
  resolverModeloDeVision,
} from "../../../supabase/functions/_shared/ai-vision.ts";

/**
 * Este test es lo que evita que alguien agregue un modelo al selector del panel de
 * Admin y dé por hecho que "ya lee imágenes".
 *
 * El caso que importa está medido contra producción: las seis instituciones resuelven
 * a Bedrock `openai.gpt-oss-120b-1:0`, que responde
 * `400 Model does not support image modality`.
 */
const BASE = {
  gemini_api_key: null,
  openai_api_key: null,
  bedrock_api_key: null,
  gemini_api_keys: [] as string[],
  openai_api_keys: [] as string[],
  bedrock_api_keys: [] as string[],
  bedrock_region: null,
  tenant_id: null,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const modelo = (provider: string, model: string, extra: Record<string, unknown> = {}): any => ({
  ...BASE,
  provider,
  model,
  ...extra,
});

describe("modeloAceptaImagen", () => {
  it("gemini sí", () => {
    expect(modeloAceptaImagen("gemini", "gemini-2.5-flash")).toBe(true);
    expect(modeloAceptaImagen("gemini", "gemini-1.5-pro")).toBe(true);
  });

  it("bedrock NO, y no por el modelo sino por la URL del endpoint", () => {
    // `bedrockChatUrl` fija la ruta compatible con OpenAI, que solo sirve la familia
    // gpt-oss (text-only). Un modelo multimodal ahí responde 404, no una imagen leída.
    expect(modeloAceptaImagen("bedrock", "openai.gpt-oss-120b-1:0")).toBe(false);
    expect(modeloAceptaImagen("bedrock", "anthropic.claude-3-5-sonnet")).toBe(false);
  });

  it("openai: lista blanca, y lo desconocido cae en false", () => {
    expect(modeloAceptaImagen("openai", "gpt-4o")).toBe(true);
    expect(modeloAceptaImagen("openai", "gpt-4o-mini")).toBe(true);
    expect(modeloAceptaImagen("openai", "gpt-4.1")).toBe(true);
    // Fallar cerrado: mejor un mensaje que dice qué cambiar que un 400 del proveedor.
    expect(modeloAceptaImagen("openai", "gpt-3.5-turbo")).toBe(false);
    expect(modeloAceptaImagen("openai", "un-modelo-que-no-existe")).toBe(false);
  });

  it("un provider desconocido no acepta imágenes", () => {
    expect(modeloAceptaImagen("lovable", "cualquiera")).toBe(false);
  });
});

describe("resolverModeloDeVision", () => {
  it("bedrock + clave de gemini disponible ⇒ sustituye solo para esta llamada", () => {
    const r = resolverModeloDeVision(modelo("bedrock", "openai.gpt-oss-120b-1:0"), true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sustituido).toBe(true);
    expect(r.modelo.provider).toBe("gemini");
    expect(r.modelo.model).toBe(MODELO_VISION_GEMINI);
  });

  it("bedrock SIN ninguna clave de gemini ⇒ no se llama al proveedor", () => {
    const r = resolverModeloDeVision(modelo("bedrock", "openai.gpt-oss-120b-1:0"), false);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // El mensaje del edge necesita decir QUÉ está configurado hoy.
    expect(r.providerActivo).toBe("bedrock");
    expect(r.modeloActivo).toBe("openai.gpt-oss-120b-1:0");
  });

  it("gemini activo ⇒ no sustituye nada", () => {
    const r = resolverModeloDeVision(modelo("gemini", "gemini-2.5-flash"), true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sustituido).toBe(false);
    expect(r.modelo.model).toBe("gemini-2.5-flash");
  });

  it("openai con visión ⇒ no sustituye; sin visión y con gemini ⇒ sustituye", () => {
    const conVision = resolverModeloDeVision(modelo("openai", "gpt-4o"), true);
    expect(conVision.ok && conVision.sustituido).toBe(false);

    const sinVision = resolverModeloDeVision(modelo("openai", "gpt-3.5-turbo"), true);
    expect(sinVision.ok && sinVision.sustituido).toBe(true);
  });

  it("la sustitución CONSERVA las claves de la fila", () => {
    // `candidateKeysFor` elige la lista según el provider: si se perdieran las claves,
    // el failover se quedaría solo con la del entorno.
    const r = resolverModeloDeVision(
      modelo("bedrock", "openai.gpt-oss-120b-1:0", {
        gemini_api_keys: ["k1", "k2"],
        tenant_id: "t1",
      }),
      true,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.modelo.gemini_api_keys).toEqual(["k1", "k2"]);
    expect(r.modelo.tenant_id).toBe("t1");
  });
});
