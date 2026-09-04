/**
 * ¿El modelo de IA que la institución tiene configurado puede LEER una imagen?
 *
 * ── Por qué esto existe ───────────────────────────────────────────────────
 * Medido contra la cuenta real de producción: las seis instituciones resuelven a
 * Bedrock `openai.gpt-oss-120b-1:0`, que es **solo texto**. AWS lo declara
 * (`inputModalities:["TEXT"]`) y un POST con una imagen responde
 * `400 Model does not support image modality`. Ese 400 además **no rota claves**
 * (`ai-failover.ts`: 400 no es un status rotable, y con razón — el body es idéntico,
 * fallaría igual con otra key), así que sube el mensaje del proveedor tal cual.
 *
 * Y cambiar solo el ID del modelo no alcanza: `bedrockChatUrl` fija la ruta del
 * endpoint compatible con OpenAI, que —según lo ya documentado en `ai-model.ts`—
 * sirve la familia `openai.gpt-oss-*` y responde 404 para los demás.
 *
 * ── La salida ─────────────────────────────────────────────────────────────
 * Para ESTA llamada, y solo para esta, se sustituye el modelo por uno con visión.
 * Es una excepción deliberada a "el proveedor lo elige la institución", así que la
 * respuesta del edge la reporta (`sustituido: true`) y queda en la auditoría: una
 * sustitución silenciosa haría que el Admin no entienda por qué se gasta cuota de
 * Gemini cuando él configuró Bedrock.
 *
 * Si no hay ninguna clave de Gemini, esto devuelve `ok:false` y el edge **no llama
 * al proveedor**: mejor un mensaje que dice qué cambiar que un 400 opaco que además
 * gasta una llamada.
 */
/**
 * Forma mínima del modelo activo, declarada acá y NO importada de `ai-model.ts`.
 *
 * Es a propósito: el test de este módulo lo importa desde `src/` por ruta relativa
 * para validar la función que corre en producción (y no una copia). Importar el tipo
 * de `ai-model.ts` arrastraría ese archivo al chequeo de tipos del cliente, y ahí usa
 * globales de Deno que el `tsconfig` de `src/` no conoce — 10 errores de compilación
 * por un `import type`.
 *
 * Es estructuralmente compatible con `ActiveModel`: el resto de los campos viaja por
 * el spread sin que este módulo los nombre.
 */
export interface ModeloConProveedor {
  provider: string;
  model: string;
}

/** El modelo con visión al que se sustituye. Barato y rápido, que es lo que pide
 *  leer una captura en medio de una clase. */
export const MODELO_VISION_GEMINI = "gemini-2.5-flash";

/**
 * Prefijos de OpenAI con visión. Es una **lista blanca**: un id desconocido devuelve
 * `false`, así el edge responde un mensaje accionable en vez de dejar que el
 * proveedor conteste un 400 que nadie puede interpretar.
 */
const OPENAI_CON_VISION = ["gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-5", "o3", "o4"];

export function modeloAceptaImagen(provider: string, model: string): boolean {
  const m = (model ?? "").trim().toLowerCase();
  switch (provider) {
    case "gemini":
      // Toda la familia gemini-1.5+ / 2.x es multimodal.
      return m.startsWith("gemini");
    case "openai":
      return OPENAI_CON_VISION.some((p) => m.startsWith(p));
    case "bedrock":
      // Siempre false, y NO por el modelo: por la URL. Ver el encabezado.
      return false;
    default:
      return false;
  }
}

export type ResolucionVision<T extends ModeloConProveedor = ModeloConProveedor> =
  | { ok: true; modelo: T; sustituido: boolean }
  | {
      ok: false;
      razon: "sin_modelo_con_vision";
      providerActivo: string;
      modeloActivo: string;
    };

/**
 * Devuelve el modelo con el que hacer la llamada con imagen.
 *
 * @param m               el modelo activo de la institución
 * @param hayClaveGemini  si existe alguna clave de Gemini usable (de la fila o del
 *                        entorno). Se pasa como dato y no se lee acá para que esta
 *                        función siga siendo pura y testeable.
 */
export function resolverModeloDeVision<T extends ModeloConProveedor>(
  m: T,
  hayClaveGemini: boolean,
): ResolucionVision<T> {
  if (modeloAceptaImagen(m.provider, m.model)) {
    return { ok: true, modelo: m, sustituido: false };
  }
  if (!hayClaveGemini) {
    return {
      ok: false,
      razon: "sin_modelo_con_vision",
      providerActivo: m.provider,
      modeloActivo: m.model,
    };
  }
  // Se conservan TODAS las claves de la fila: `candidateKeysFor` elige las de Gemini
  // según el provider, así que basta cambiar provider + model.
  return {
    ok: true,
    modelo: { ...m, provider: "gemini", model: MODELO_VISION_GEMINI },
    sustituido: true,
  };
}
