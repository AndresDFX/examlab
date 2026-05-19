/**
 * Resolución del system prompt para la generación de contenidos.
 *
 * Hay tres orígenes posibles para cada use_case (`content_generation` y
 * los 5 sub-prompts `content.*`):
 *
 *   1) `generated_contents.prompt_overrides[use_case]`
 *      Override POR CONTENIDO específico — lo edita el docente desde el
 *      módulo de contenidos antes (o después) de generar. NO se comparte
 *      con otros contenidos del mismo curso ni del mismo docente.
 *
 *   2) `ai_prompts WHERE use_case=$key AND course_id IS NULL`
 *      Global del módulo de Prompts — lo edita Admin desde
 *      `app.admin.ai-prompts.tsx`. Aplica a todos los contenidos que no
 *      tengan override propio.
 *
 *   3) Fallback hardcoded
 *      Vive en el código del edge function (sub-prompts cortos) y en el
 *      seed inicial de la migración (system prompt orquestador).
 *
 * Este módulo expone únicamente la función pura de resolución para que
 * sea testeable desde Vitest (Node) y reusable desde el edge function
 * (Deno). NO toca Supabase — el caller le pasa los valores ya leídos.
 */

/** Use cases válidos para overrides POR CONTENIDO. Cualquier otra key
 *  en `prompt_overrides` se ignora silenciosamente (la migración ya
 *  agrega un CHECK para rechazarlas a nivel DB, pero defendemos también
 *  en TS para los casos en que el tipo se pierda). */
export const CONTENT_PROMPT_USE_CASES = [
  "content_generation",
  "content.presentacion",
  "content.guia_docente",
  "content.taller_practico",
  "content.ejercicio",
  "content.examen",
] as const;

export type ContentPromptUseCase = (typeof CONTENT_PROMPT_USE_CASES)[number];

export function isContentPromptUseCase(key: string): key is ContentPromptUseCase {
  return (CONTENT_PROMPT_USE_CASES as readonly string[]).includes(key);
}

/** Shape del JSONB `generated_contents.prompt_overrides`. Cada key es
 *  opcional; un string vacío o ausente significa "usar el global". */
export type ContentPromptOverrides = Partial<Record<ContentPromptUseCase, string>>;

/**
 * Resuelve UN prompt aplicando la jerarquía:
 *   override (no vacío) > global (no vacío) > fallback.
 *
 * "No vacío" = string con al menos un caracter no-whitespace. Esto evita
 * que un docente que abre el editor y borra accidentalmente todo el
 * texto del override termine pidiéndole a la IA un prompt vacío — caemos
 * al global automáticamente.
 *
 * Si las tres fuentes son inválidas (null/undefined/whitespace), devuelve
 * string vacío. El caller decide si tolera prompts vacíos (en el edge
 * function eso resulta en que el modelo usa solo el user message, lo que
 * es legítimo para fallback degradado).
 */
export function resolveContentPrompt(
  override: string | null | undefined,
  global: string | null | undefined,
  fallback: string,
): string {
  if (typeof override === "string" && override.trim().length > 0) return override;
  if (typeof global === "string" && global.trim().length > 0) return global;
  return fallback;
}

/**
 * Helper para resolver múltiples sub-prompts de una sola pasada. Útil
 * en el edge function que carga TODOS los sub-prompts globales en una
 * query y luego mezcla con los overrides del row.
 *
 * @param overrides - JSONB de `generated_contents.prompt_overrides`.
 * @param globals - Map use_case → string proveniente de `ai_prompts`.
 * @param fallbacks - Map use_case → string hardcoded (último recurso).
 */
export function resolveAllContentPrompts(
  overrides: ContentPromptOverrides | null | undefined,
  globals: Partial<Record<ContentPromptUseCase, string>>,
  fallbacks: Partial<Record<ContentPromptUseCase, string>>,
): Record<ContentPromptUseCase, string> {
  const out = {} as Record<ContentPromptUseCase, string>;
  for (const key of CONTENT_PROMPT_USE_CASES) {
    out[key] = resolveContentPrompt(overrides?.[key], globals[key], fallbacks[key] ?? "");
  }
  return out;
}

/**
 * Sanea un objeto `prompt_overrides` antes de persistirlo:
 *   - descarta keys no permitidas (defensa en profundidad sobre el CHECK
 *     de la DB);
 *   - convierte strings vacíos o whitespace-only en ausencia (no
 *     persistimos `""` — preferimos NO tener la key, así un futuro
 *     refactor del global no la sobrescribe accidentalmente).
 *
 * Idempotente: aplicarlo dos veces da el mismo resultado.
 */
export function sanitizeContentPromptOverrides(
  raw: Record<string, unknown> | null | undefined,
): ContentPromptOverrides {
  if (!raw || typeof raw !== "object") return {};
  const out: ContentPromptOverrides = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isContentPromptUseCase(k)) continue;
    if (typeof v !== "string") continue;
    if (v.trim().length === 0) continue;
    out[k] = v;
  }
  return out;
}
