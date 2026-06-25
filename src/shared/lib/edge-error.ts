/**
 * Helpers para extraer el mensaje REAL de error cuando un edge function
 * de Supabase responde con un status no-2xx.
 *
 * Problema: `supabase.functions.invoke` envuelve respuestas no-2xx en
 * un `FunctionsHttpError` cuyo `.message` siempre dice
 * "Edge Function returned a non-2xx status code". El cuerpo real (un
 * JSON con `{ error: "detalle..." }`) queda atrapado en
 * `.context.response` (un Response object).
 *
 * Estos helpers leen ese body y devuelven el mensaje útil para tostear
 * al usuario o loguear con detalle.
 *
 * IMPORTANTE: `error.context.response` es un Response stream — se lee
 * UNA SOLA VEZ. Si llamas dos veces a `extractEdgeError` con el mismo
 * objeto, la segunda recibe vacío. Por eso el helper devuelve el detalle
 * decodificado, no el Response crudo.
 */
import type { PostgrestError } from "@supabase/supabase-js";

/** Mensaje genérico que supabase-js pone en `FunctionsHttpError.message` —
 *  inútil para el usuario; nunca lo devolvemos si hay algo mejor. */
const GENERIC_FUNCTIONS_MSG = "Edge Function returned a non-2xx status code";

interface FunctionsHttpErrorLike {
  message?: string;
  name?: string;
  // supabase-js v2: `error.context` ES el Response (ver functions-js:
  // `throw new FunctionsHttpError(response)` + doc `await error.context.json()`).
  // Algunas versiones/wrappers lo anidan en `.context.response`. Soportamos AMBOS.
  context?: Response | { response?: Response };
}

/** Resuelve el Response real desde el `context` del FunctionsHttpError,
 *  tolerando que `context` SEA el Response (caso real) o lo anide en
 *  `.response` (versiones viejas / mocks). */
function resolveResponse(errLike: FunctionsHttpErrorLike): Response | undefined {
  const ctx = errLike?.context as unknown;
  if (ctx && typeof (ctx as Response).text === "function") return ctx as Response;
  const nested = (ctx as { response?: Response } | undefined)?.response;
  if (nested && typeof nested.text === "function") return nested;
  return undefined;
}

/**
 * Recupera el mensaje real de error de un edge function. Acepta:
 *  - FunctionsHttpError de supabase-js (con `.context.response`)
 *  - El segundo argumento `data` que invoke devuelve junto con el error
 *    (a veces tiene la respuesta JSON ya parseada cuando supabase-js la
 *    capturó del response).
 *  - PostgrestError o Error genérico
 *
 * Devuelve un mensaje legible. Si no puede extraer detalle, cae al
 * `.message` original (que será "Edge Function returned a non-2xx ...").
 */
export async function extractEdgeError(
  error: unknown,
  data?: unknown,
): Promise<string> {
  // 1) Si supabase-js ya parseó el body como `data` y tiene `error`,
  //    usar eso (no consume el Response stream).
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error.trim()) return obj.error;
    if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
  }

  if (!error) return "";

  // 2) FunctionsHttpError: el Response vive en `error.context` (no en
  //    `.context.response` — bug histórico que dejaba todo en el genérico).
  const errLike = error as FunctionsHttpErrorLike;
  const response = resolveResponse(errLike);
  if (response) {
    let status: number | undefined;
    try {
      status = response.status;
    } catch {
      /* algunos mocks no exponen status */
    }
    try {
      const text = await response.text();
      if (text) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object") {
            const p = parsed as Record<string, unknown>;
            if (typeof p.error === "string" && p.error.trim()) return p.error;
            if (typeof p.message === "string" && p.message.trim()) return p.message;
          }
        } catch {
          // No era JSON. Si es texto corto, lo devolvemos tal cual.
          if (text.trim() && text.length < 500) return text.trim();
        }
      }
    } catch {
      /* response stream ya consumido o falló — caemos al fallback por status */
    }
    // Fallback por status cuando el body no trajo un mensaje útil (vacío, ya
    // leído, o no-JSON largo). Cubre el caso reportado: 429 sin friendly visible.
    if (status === 429)
      return "Límite de uso de IA o demasiadas solicitudes. Espera un momento y reintenta.";
    if (status === 402) return "Sin créditos de IA.";
    if (status === 401 || status === 403) return "No autorizado para esta acción.";
    if (typeof status === "number" && status >= 500)
      return "El servicio tuvo un error temporal. Reintenta en un momento.";
  }

  // 3) PostgrestError / Error genérico. Evitamos devolver el wrapper inútil
  //    "Edge Function returned a non-2xx status code" si no hay nada mejor.
  const postgresErr = error as PostgrestError;
  if (postgresErr?.message && postgresErr.message !== GENERIC_FUNCTIONS_MSG)
    return postgresErr.message;
  if (errLike?.message && errLike.message !== GENERIC_FUNCTIONS_MSG) return errLike.message;

  return "No se pudo completar la operación. Reintenta en un momento.";
}

/**
 * Versión síncrona — útil cuando estás seguro de que el body NO está
 * en un Response stream (ej. errores que ya vienen como Error con
 * mensaje propio, o `data` ya parseado).
 */
export function extractEdgeErrorSync(error: unknown, data?: unknown): string {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error.trim()) return obj.error;
    if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
  }
  if (!error) return "";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Error desconocido";
}
