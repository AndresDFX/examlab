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

export type AiProvider = "openai" | "gemini";

/**
 * Cualquier provider distinto de 'openai' cae a 'gemini' — incluyendo
 * 'lovable' legacy, valores vacíos o strings desconocidos. Alineado
 * con el CHECK constraint post-mig (provider IN ('openai', 'gemini')).
 */
export function normalizeProvider(raw: string | null | undefined): AiProvider {
  return raw === "openai" ? "openai" : "gemini";
}

/**
 * Limpia el prefijo "google/" del model cuando el provider final es
 * gemini directo — el gateway de Lovable usaba "google/gemini-2.5-flash"
 * pero la API de Gemini directo espera "gemini-2.5-flash". OpenAI no
 * sufre — sus modelos no llevan prefijo.
 */
export function normalizeModel(raw: string, prov: AiProvider): string {
  if (prov === "gemini" && raw.startsWith("google/")) {
    return raw.slice("google/".length);
  }
  return raw;
}
