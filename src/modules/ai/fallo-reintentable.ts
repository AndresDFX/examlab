/**
 * ¿El fallo de una llamada SÍNCRONA a un edge de IA de GENERACIÓN se debe
 * reintentar ENCOLÁNDOLO?
 *
 * Regla de producto del dueño (2026-10): «si la IA es sincrónica pero el API
 * está fallando, debería encolarse: el proceso debe seguir como si fuera
 * asíncrono, en todos los procesos de la plataforma». O sea: ante un fallo de
 * PROVEEDOR/TRANSPORTE la petición del docente NO se pierde — se mete en
 * `ai_generation_queue` y la drena el worker/cron, igual que si el modo global
 * fuera `async`.
 *
 * Pero NO todo fallo se encola: un error que volvería a fallar idéntico en el
 * próximo intento (validación 400, prompt demasiado largo, falta el curso,
 * 401/403, cuota de la cuenta agotada) debe seguir mostrándose como error, o la
 * cola se llena de trabajos condenados que el cron reintenta en vano.
 *
 * Por eso la clasificación vive en UN solo lugar, puro y testeado. Es el espejo
 * del lado servidor `isTransientError` / `TRANSIENT_ERROR_PATTERN`
 * (`supabase/functions/_shared/transient-errors.ts`), que decide lo mismo
 * para el worker (re-encolar pending vs failed final). Deno no importa de
 * `src/`, así que el patrón se COPIA acá — invariante cross-file declarado en
 * CLAUDE.md. La diferencia: el worker parte de un string de error; acá partimos
 * del `{ error, data }` crudo de `supabase.functions.invoke`, del que sacamos
 * primero el HTTP status (la señal más confiable) y recién después el texto.
 */

/** Espejo de `TRANSIENT_ERROR_PATTERN` del worker. Si cambia uno, cambia el
 *  otro (ver tabla de invariantes en CLAUDE.md). */
export const PATRON_TRANSITORIO =
  /\b429\b|\b5\d\d\b|rate.?limit|too.many.requests|timeout|timed.?out|ECONN(RESET|REFUSED)|ENETUNREACH|fetch.failed|quota.exceeded|service.unavailable|gateway.timeout|internal.server.error/i;

/**
 * Señales de que el fallo volvería a fallar idéntico — NO encolar. Son códigos
 * internos del edge o frases accionables que piden intervención humana (arreglar
 * el prompt, asignar el curso, recargar créditos), no una espera.
 */
export const PATRON_NO_REINTENTABLE =
  /prompt_too_large|too.?large|demasiado.?(larg|grande)|bad.?request|invalid|inv[áa]lid|validation|validaci[óo]n|unauthorized|no.?autorizado|forbidden|prohibid|not.?found|no.?(existe|encontrad)|missing|requer|required|no_credits|sin.?cr[ée]ditos|cap_reached|l[íi]mite.?(alcanzad|agotad)|sin.?cupo/i;

/** HTTP status que NO se reintenta (el próximo intento fallaría igual). */
const STATUS_NO_REINTENTABLE = new Set([400, 401, 402, 403, 404, 422]);

/** Extrae el HTTP status del error/data de `functions.invoke` sin consumir el
 *  stream del Response (leer `.status` es una propiedad, no el body). */
function statusDe(error: unknown, data: unknown): number | null {
  // supabase-js v2: `error.context` ES el Response (o lo anida en `.response`).
  const ctx = (error as { context?: unknown } | null)?.context as
    | { status?: unknown; response?: { status?: unknown } }
    | undefined;
  const sCtx = ctx?.status ?? ctx?.response?.status;
  if (typeof sCtx === "number") return sCtx;
  // Los edges de IA incluyen `http_status` en el body JSON del error.
  const sBody = (data as { http_status?: unknown } | null)?.http_status;
  if (typeof sBody === "number") return sBody;
  return null;
}

export interface EntradaFallo {
  /** El `error` de `supabase.functions.invoke`. */
  error?: unknown;
  /** El `data` que invoke devuelve (puede traer `{ error, http_status }`). */
  data?: unknown;
  /** El texto ya extraído con `extractEdgeError`, si el caller lo tiene. */
  detalle?: string | null;
}

/**
 * `true` → la petición se encola (el API falló por proveedor/transporte y el
 * próximo intento puede andar). `false` → mostrar el error (fallaría igual).
 *
 * Orden: el HTTP status manda cuando existe (señal inequívoca); si no hay
 * status, se mira el texto — primero lo NO reintentable, después lo transitorio,
 * y por defecto se ENCOLA (regla del dueño: ante un API caído, seguir como
 * async en vez de perder el trabajo).
 */
export function esFalloReintentable(entrada: EntradaFallo): boolean {
  // El tope de uso por hora es un límite DEL USUARIO, no una caída: el edge lo
  // responde con 429 + `rate_limited`. Encolarlo lo saltaría, porque el worker
  // corre con service_role y no pasa por ese cupo.
  if ((entrada.data as { rate_limited?: unknown } | null)?.rate_limited) return false;
  const status = statusDe(entrada.error, entrada.data);
  if (status != null) {
    if (STATUS_NO_REINTENTABLE.has(status)) return false;
    if (status === 408 || status === 429 || status >= 500) return true;
    // Otros status (raros acá) caen a la clasificación por texto.
  }

  const textos = [
    typeof (entrada.data as { error?: unknown } | null)?.error === "string"
      ? ((entrada.data as { error: string }).error)
      : "",
    entrada.detalle ?? "",
    typeof (entrada.error as { message?: unknown } | null)?.message === "string"
      ? ((entrada.error as { message: string }).message)
      : "",
  ].join(" · ");

  if (PATRON_NO_REINTENTABLE.test(textos)) return false;
  if (PATRON_TRANSITORIO.test(textos)) return true;
  // Sin señal clara: encolar. Un fallo de red que no trae status ni texto
  // reconocible es, casi siempre, transporte caído.
  return true;
}
