/**
 * Helpers puros de normalización de provider/model — sin imports de Deno
 * para ser testeables en vitest (Node).
 *
 * Hasta mig 20260824000000 existía el provider 'lovable' (Lovable AI
 * Gateway, ya deprecado). La migración hace backfill server-side, pero
 * estas funciones son la red de seguridad runtime para tres casos:
 *
 *   1. La migración no corrió en algún entorno (Lovable a veces marca
 *      migraciones como aplicadas aunque el SQL no haya ejecutado).
 *   2. Datos viejos en cache de PostgREST schema que llegan al edge
 *      antes del refresh.
 *   3. Tests + entornos locales sin la mig aplicada.
 *
 * Estas funciones son consumidas por `ai-model.ts` (edges) y por
 * `AdminModelPanel.tsx` (UI). Mantenerlas puras + exportadas para que
 * vivan en un solo lugar.
 */

export type AiProvider = "openai" | "gemini" | "bedrock";

/**
 * Mapea el valor crudo de `ai_model_settings.provider` a un provider soportado.
 * Cualquier valor desconocido —'lovable' legacy, vacío, basura— cae a 'gemini',
 * que es el default histórico. Alineado con el CHECK post-mig
 * (provider IN ('openai', 'gemini', 'bedrock')).
 *
 * OJO: se enumeran los providers EXPLÍCITAMENTE en vez de "todo lo que no sea
 * openai es gemini". Con la forma anterior, agregar 'bedrock' al CHECK habría
 * hecho que un tenant configurado en Bedrock se resolviera en silencio como
 * Gemini y usara la key equivocada.
 */
export function normalizeProvider(raw: string | null | undefined): AiProvider {
  if (raw === "openai") return "openai";
  if (raw === "bedrock") return "bedrock";
  return "gemini";
}

/**
 * Limpia el prefijo "google/" del model cuando el provider final es
 * gemini directo — el gateway de Lovable usaba "google/gemini-2.5-flash"
 * pero la API de Gemini directo espera "gemini-2.5-flash". OpenAI no
 * sufre — sus modelos no llevan prefijo.
 */
export function normalizeModel(raw: string, prov: AiProvider): string {
  // Bedrock usa ids con punto y dos puntos ("openai.gpt-oss-120b-1:0"): no se
  // les quita ningún prefijo.
  if (prov === "gemini" && raw.startsWith("google/")) {
    return raw.slice("google/".length);
  }
  return raw;
}
