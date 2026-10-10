/**
 * `fetch` con tope de tiempo para el cliente de Supabase.
 *
 * Sin tope, una conexión que queda colgada (pasa en iOS al reanudar Safari con
 * una conexión vieja) deja PARA SIEMPRE pendiente la renovación del token, y
 * con ella `initializePromise` de auth-js: toda petición de la app espera detrás
 * y se ve «Cargando…» sin error. Abortar convierte el cuelgue en un error de
 * red, que auth-js trata como reintentable (AuthRetryableFetchError) sin borrar
 * la sesión.
 *
 * Solo /auth/v1 y /rest/v1: PostgREST corta a los 8 s (statement_timeout de
 * `authenticated`) y a los 30 s (`authenticator`), así que pasado ese tiempo no
 * hay respuesta que esperar. Las funciones (la IA tarda minutos), el storage
 * (subidas grandes) y realtime quedan sin tope.
 */
export const MS_TOPE_AUTH = 20_000;
export const MS_TOPE_REST = 30_000;

export function topeParaUrl(url: string): number | null {
  if (url.includes("/auth/v1/")) return MS_TOPE_AUTH;
  if (url.includes("/rest/v1/")) return MS_TOPE_REST;
  return null;
}

export function crearFetchConTope(base: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const ms = topeParaUrl(url);
    if (ms == null) return base(input, init);
    // Sin AbortSignal.any (Safari 17.4+) ni AbortSignal.timeout (Safari 16+):
    // se combinan a mano la señal de quien llama y la del tope.
    const ctrl = new AbortController();
    const externa = init?.signal;
    const alAbortarExterna = () => ctrl.abort(externa?.reason);
    if (externa) {
      if (externa.aborted) ctrl.abort(externa.reason);
      else externa.addEventListener("abort", alAbortarExterna, { once: true });
    }
    const id = setTimeout(() => ctrl.abort(new Error(`Tiempo de espera agotado (${ms} ms)`)), ms);
    return base(input, { ...init, signal: ctrl.signal }).finally(() => {
      clearTimeout(id);
      externa?.removeEventListener("abort", alAbortarExterna);
    });
  };
}
