/**
 * Predicado para detectar errores transitorios reintenttables.
 *
 * Compartido entre `ai-generation-worker` y `ai-grading-worker` para
 * que ambos tomen la MISMA decisión de "re-encolar pending vs failed
 * final". El regex es el mismo que `complete_ai_grading` SQL (mig
 * 20260601001000) — invariante cross-file declarado en CLAUDE.md.
 *
 * Reintenttables (verdaderos transitorios):
 *   - HTTP 429 (rate limit)
 *   - HTTP 5xx (errores de servidor)
 *   - rate.limit / too.many.requests (texto)
 *   - timeout / timed out
 *   - ECONN* (red caída)
 *   - fetch failed
 *   - quota.exceeded
 *   - service.unavailable / gateway.timeout / internal.server.error
 *
 * NO reintenttables (problemas de input/auth/contenido):
 *   - 400 bad request
 *   - 401 unauthorized
 *   - 403 forbidden
 *   - JSON malformado
 *   - content policy violation
 *
 * Cuando un worker recibe un error, si el mensaje matches este patrón
 * y attempts < MAX, re-encola en `pending` con `last_error` explicativo.
 * Sino, marca `failed` final y el operador decide manualmente.
 *
 * Re-exportado como módulo TS para poder unit-testarlo desde vitest
 * (los archivos `.ts` dentro de `_shared/` son importables desde Deno
 * via path relativo y desde vitest via path absoluto del repo).
 */
export const TRANSIENT_ERROR_PATTERN =
  /\b429\b|\b5\d\d\b|rate.?limit|too.many.requests|timeout|timed.?out|ECONN(RESET|REFUSED)|ENETUNREACH|fetch.failed|quota.exceeded|service.unavailable|gateway.timeout|internal.server.error/i;

export function isTransientError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return TRANSIENT_ERROR_PATTERN.test(msg);
}
