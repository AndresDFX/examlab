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

interface FunctionsHttpErrorLike {
  message?: string;
  name?: string;
  context?: { response?: Response };
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

  // 2) FunctionsHttpError: leer body desde context.response
  const errLike = error as FunctionsHttpErrorLike;
  const response = errLike?.context?.response;
  if (response && typeof response.text === "function") {
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
          if (text.length < 500) return text;
        }
      }
    } catch {
      /* response stream ya consumido o falló — caemos al fallback */
    }
  }

  // 3) PostgrestError / Error genérico
  const postgresErr = error as PostgrestError;
  if (postgresErr?.message) return postgresErr.message;
  if (errLike?.message) return errLike.message;

  return "Error desconocido";
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
