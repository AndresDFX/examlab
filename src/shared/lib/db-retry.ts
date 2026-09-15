/**
 * Reintento con backoff corto para escrituras SIMPLES a Postgres/PostgREST
 * desde el CLIENTE (React, supabase-js) — acotado a errores genuinamente
 * TRANSITORIOS (contención momentánea), nunca a errores de validación/RLS.
 *
 * Nace del caso real de "Recalificación con IA" masiva de talleres
 * (`regradeAllWithAI` / `gradeOneWithAI` en app.teacher.workshops.tsx): un
 * lote de N entregas dispara upserts secuenciales a
 * `workshop_submission_answers` (cada uno recomputa la nota vía el trigger
 * `tg_workshop_answer_graded_recompute`) en poco tiempo. Bajo carga eso
 * puede chocar contra el `statement_timeout` de Postgres — SQLSTATE 57014,
 * que `friendlyError()` (`src/shared/lib/db-errors.ts`) traduce como
 * "La operación tardó demasiado. Intenta de nuevo." — y tirar abajo la
 * entrega COMPLETA sin darle ni una segunda oportunidad.
 *
 * A propósito NO tan sofisticado como `runKeyFailover`
 * (`supabase/functions/_shared/ai-failover.ts`): ese reintenta llamadas a
 * proveedores de IA con rotación de keys, del lado EDGE (Deno). Esto es un
 * helper de cliente para una escritura simple — no hay keys que rotar,
 * solo un par de reintentos cortos.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyError = any;

/**
 * Códigos SQLSTATE de Postgres que reflejan CONTENCIÓN transitoria (no un
 * error de datos/permisos) — reintentar la MISMA escritura es seguro y
 * probablemente funcione en el siguiente intento:
 *   - 57014 query_canceled       (statement_timeout — el caso real reportado)
 *   - 40001 serialization_failure
 *   - 40P01 deadlock_detected
 *   - 55P03 lock_not_available
 */
const TRANSIENT_SQLSTATES = new Set(["57014", "40001", "40P01", "55P03"]);

/** Patrones de mensaje para fallos de RED/fetch (sin `code` SQL porque el
 *  request nunca llegó a Postgres) — mismo vocabulario que ya reconoce
 *  `friendlyError` para errores de red. */
const TRANSIENT_MESSAGE_PATTERN =
  /failed to fetch|network|timeout|timed out|econnreset|econnrefused/i;

/**
 * true si el error es transitorio y vale la pena reintentar la MISMA
 * escritura. Errores de validación/permisos (23503, 23502, 23514, 42501,
 * P0001, PGRST116, PGRST301, etc.) devuelven false — reintentarlos solo
 * perdería tiempo y confundiría el mensaje final que ve el docente.
 */
export function isTransientDbError(error: AnyError): boolean {
  if (!error) return false;
  const code = String(error.code ?? error.cause?.code ?? "");
  if (TRANSIENT_SQLSTATES.has(code)) return true;
  const message = String(error.message ?? "");
  return TRANSIENT_MESSAGE_PATTERN.test(message);
}

export interface DbRetryOptions {
  /** Delays entre reintentos, en ms. Con 2 valores hay 3 intentos totales
   *  (el original + 2 reintentos). Default [500, 1500] — corto a propósito:
   *  esto es una escritura simple, no una llamada a un proveedor de IA. */
  delaysMs?: number[];
  /** Signal opcional: si el batch que originó esta escritura fue cancelado
   *  (docente pulsó "Detener"), corta el reintento de inmediato en vez de
   *  seguir insistiendo con algo que ya no hace falta. No cancela el intento
   *  YA en vuelo (eso lo decide `fn`, ej. pasando el signal a `invoke`) —
   *  solo evita encolar un reintento nuevo tras el backoff. */
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Envuelve una escritura supabase-js con forma `{ data, error }` (nunca
 * throwea) con reintento-con-backoff acotado a errores TRANSITORIOS. Si el
 * error no es transitorio, devuelve el resultado del primer intento tal
 * cual — nunca reintenta un 23503/23502/23514/42501/P0001 real.
 *
 * Uso:
 *   const { error } = await withDbRetry(() =>
 *     supabase.from("t").upsert(row, { onConflict: "..." }),
 *   );
 */
export async function withDbRetry<T>(
  fn: () => PromiseLike<{ data: T; error: AnyError }>,
  options: DbRetryOptions = {},
): Promise<{ data: T; error: AnyError }> {
  const delays = options.delaysMs ?? [500, 1500];
  let result = await fn();
  for (let i = 0; i < delays.length; i++) {
    if (!result.error || !isTransientDbError(result.error)) return result;
    if (options.signal?.aborted) return result;
    await sleep(delays[i], options.signal);
    result = await fn();
  }
  return result;
}
