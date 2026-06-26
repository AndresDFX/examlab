/**
 * Lógica PURA de failover de API keys (sin Deno, sin fetch directo) — así es
 * testeable bajo vitest. `ai-model.ts` (Deno) la consume inyectando el fetch
 * real y el sleep.
 *
 * Modelo: una lista ORDENADA de keys candidatas. Se intenta cada una; si una
 * falla con un status "rotable" (la falla es de esa key/cuenta o transitoria
 * del provider) y quedan más keys, se rota a la siguiente. En la ÚLTIMA key se
 * aplica retry-with-backoff transitorio (absorbe blips cuando ya no hay a dónde
 * rotar).
 */

// Statuses donde rotar a la siguiente key tiene sentido:
//   401/403 → key inválida/expirada · 402 → sin créditos (otra cuenta podría
//   tener) · 429 → rate/cuota (otra key = otra cuota) · 5xx → caída transitoria.
// 400 NO rota: el body es idéntico para todas las keys → fallaría igual.
export const ROTATABLE_STATUS: ReadonlySet<number> = new Set([
  401, 402, 403, 429, 500, 502, 503, 504,
]);
// Subconjunto transitorio para el backoff de la última key.
export const TRANSIENT_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);
export const MAX_RETRIES_LAST_KEY = 3;

/** Deduplica una lista de keys, descartando vacíos/espacios y preservando orden. */
export function dedupeNonEmpty(list: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of list) {
    const v = (k ?? "").trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Shape mínimo de respuesta que la lógica de rotación necesita. */
export interface FailoverResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
}

export interface FailoverDeps<R extends FailoverResponse> {
  /** Ejecuta la request con UNA key concreta; devuelve el Response (o lanza en error de red). */
  fetchWithKey: (key: string, index: number) => Promise<R>;
  /** Espera `ms` (inyectable para tests). */
  sleep: (ms: number) => Promise<void>;
  /** Hook opcional de log al rotar o al usar una key != la principal. */
  onEvent?: (ev: {
    kind: "rotate" | "resolved" | "network-error";
    index: number;
    total: number;
    status?: number;
  }) => void;
}

/**
 * Recorre las keys aplicando la política de failover. Devuelve la primera
 * respuesta OK o, si todas fallan, la última (para que el caller muestre el
 * error real). Lanza solo si la lista está vacía o la ÚLTIMA key tira error de
 * red.
 */
export async function runKeyFailover<R extends FailoverResponse>(
  keys: string[],
  deps: FailoverDeps<R>,
): Promise<R> {
  if (keys.length === 0) throw new Error("runKeyFailover: lista de keys vacía");
  let lastRes: R | null = null;
  let lastErr: unknown = null;

  for (let i = 0; i < keys.length; i++) {
    const isLast = i === keys.length - 1;
    try {
      let res = await deps.fetchWithKey(keys[i], i);
      // Última key: absorber blips transitorios con backoff (respeta Retry-After
      // capeado a 8s). En las anteriores rotamos directo — otra key tiene
      // cuota/cuenta distinta, reintentar la misma sería tiempo perdido.
      if (isLast) {
        for (let a = 1; a < MAX_RETRIES_LAST_KEY && TRANSIENT_STATUS.has(res.status); a++) {
          const ra = Number(res.headers?.get("retry-after"));
          const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 8000) : a * 1500;
          await deps.sleep(waitMs);
          res = await deps.fetchWithKey(keys[i], i);
        }
      }
      if (res.ok || !ROTATABLE_STATUS.has(res.status) || isLast) {
        deps.onEvent?.({ kind: "resolved", index: i, total: keys.length, status: res.status });
        return res;
      }
      deps.onEvent?.({ kind: "rotate", index: i, total: keys.length, status: res.status });
      lastRes = res;
    } catch (e) {
      lastErr = e;
      deps.onEvent?.({ kind: "network-error", index: i, total: keys.length });
      if (isLast) throw e;
    }
  }
  if (lastRes) return lastRes;
  throw lastErr ?? new Error("Fallo de IA: ninguna key produjo respuesta.");
}
