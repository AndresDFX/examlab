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

/**
 * Un espacio en blanco cualquiera. Con nombre a propósito: escrito inline como
 * `/\s/` la barra invertida se pierde sin que nada lo note y queda `/s/`, que
 * matchea la LETRA «s» y rompe `mejorMensaje` en silencio. Ya pasó una vez.
 */
const ESPACIO = /\s/;

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
 * El mejor texto para el usuario de un cuerpo `{ error, message }`.
 *
 * `error` casi siempre trae un CODIGO (`rate_limited`, `no_credits`) y
 * `message` la frase redactada. Preferir `error` a secas hacia que el usuario
 * leyera `rate_limited` en pantalla — un identificador interno, justo lo que la
 * convencion del proyecto prohibe. Heuristica: si `error` no tiene espacios es
 * un codigo, y entonces gana `message`.
 *
 * OJO al editar: el patron es ESPACIO EN BLANCO (`\s`), no la letra «s». Esta
 * linea nacio como `/s/` —una barra invertida que se perdio al escribir el
 * archivo— y con eso la heuristica preguntaba «¿no tiene la letra s?»:
 * `rate_limited` funcionaba de casualidad y `server_error`, `no_blocks` o
 * `bad_credentials` seguian pintandose crudos. Al reves, una frase redactada
 * sin ninguna «s» («No autenticado») perdia contra `message`. Los dos modos de
 * falla estan fijados en `edge-error.test.ts`.
 *
 * Limite conocido de la heuristica: «tiene espacios» no equivale a «es prosa
 * apta para el usuario». `Error de IA [400]: {...}` los tiene y es ingles
 * tecnico; `Unauthorized` no los tiene y no trae `message` hermano. Por eso el
 * resultado de estos helpers se envuelve SIEMPRE en `friendlyError` antes de
 * pintarlo — el juicio final de que es legible vive ahi, no aca.
 */
function mejorMensaje(obj: Record<string, unknown>): string {
  const err = typeof obj.error === "string" ? obj.error.trim() : "";
  const msg = typeof obj.message === "string" ? obj.message.trim() : "";
  if (err && !ESPACIO.test(err) && msg) return msg;
  return err || msg;
}
/**
 * Traduce el fallo del PROVEEDOR de IA a algo que se pueda accionar.
 *
 * ── El caso que lo pidió ─────────────────────────────────────────────────
 *
 * Los edges de IA, cuando el proveedor rechaza la llamada, responden
 * `{ error, kind: "http", http_status, response_snippet }`. Pero `mejorMensaje`
 * se queda con `error` —una frase interna del edge, «Fallo al calificar en
 * bloque»— y descarta los otros dos campos, que son los únicos que dicen QUÉ
 * pasó y qué hacer.
 *
 * Medido en producción el 2026-09-28: un docente intentó recalificar 17
 * entregas y las 17 fallaron. La pantalla decía «Fallo al calificar en bloque»
 * en cada fila. Lo que el proveedor había respondido —y que sí quedó en la
 * auditoría— era:
 *
 *     http_status: 403
 *     {"Message":"Authentication failed: Please make sure your API Key is valid."}
 *
 * O sea: la clave de IA de esa institución estaba vencida, y arreglarlo era un
 * cambio de configuración de treinta segundos. El docente no tenía forma de
 * saberlo y quedó bloqueado con un examen entero sin calificar.
 *
 * ── Lo que NO devuelve ───────────────────────────────────────────────────
 *
 * El `response_snippet` crudo no se muestra: está en inglés, es un JSON del
 * proveedor y no dice qué hacer (regla P6). Sigue quedando en `audit_logs`, que
 * es donde soporte lo busca.
 *
 * Devuelve `null` cuando no puede afirmar nada, para que el caller conserve el
 * mensaje que ya tenía en vez de reemplazarlo por una suposición.
 */
export function mensajeDeFalloDeProveedor(obj: Record<string, unknown>): string | null {
  const status = typeof obj.http_status === "number" ? obj.http_status : null;
  if (status === null) return null;
  // 401/403: la clave. Es el caso que se vio, y el fallback por status de más
  // abajo lo leía al revés —«No autorizado para esta acción»— culpando al
  // usuario de un permiso que no le falta.
  if (status === 401 || status === 403)
    return "El proveedor de IA rechazó la clave configurada para esta institución. Revisa Configuración → Modelo IA, o pídeselo a quien la administre.";
  if (status === 402)
    return "La cuenta del proveedor de IA se quedó sin créditos. Revisa Configuración → Modelo IA, o pídeselo a quien la administre.";
  if (status === 429)
    return "Se alcanzó el límite de uso del proveedor de IA. Espera unos minutos y vuelve a intentar.";
  if (status === 404)
    return "El modelo de IA configurado no existe o no acepta este tipo de llamada. Revisa Configuración → Modelo IA.";
  if (status === 400)
    return "El proveedor de IA rechazó la petición. Suele ser el modelo configurado: revisa Configuración → Modelo IA.";
  if (status >= 500)
    return "El proveedor de IA tuvo un error temporal. Vuelve a intentar en unos minutos.";
  return null;
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
    // El fallo del proveedor gana: `error` acá es una frase interna del edge
    // («Fallo al calificar en bloque») y el motivo real viaja en `http_status`.
    const delProveedor = mensajeDeFalloDeProveedor(data as Record<string, unknown>);
    if (delProveedor) return delProveedor;
    const elegido = mejorMensaje(data as Record<string, unknown>);
    if (elegido) return elegido;
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
            const delProveedor = mensajeDeFalloDeProveedor(parsed as Record<string, unknown>);
            if (delProveedor) return delProveedor;
            const elegido = mejorMensaje(parsed as Record<string, unknown>);
            if (elegido) return elegido;
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
 * `Error de IA [500]: {"error":{"message":…}}` — la forma que `describeAiError`
 * (`supabase/functions/_shared/ai-error.ts`) arma en el catch de los edges de
 * IA: el status más 200 caracteres del cuerpo CRUDO del proveedor.
 */
const FORMA_TECNICA_DE_IA = /^Error de IA \[\d+\]/;

/**
 * Separa lo que el usuario tiene que leer de lo que solo sirve para soporte.
 *
 * Los edges de IA devuelven dos clases de mensaje por el mismo campo: frases
 * redactadas en español («Sin créditos de IA…», «La API key del proveedor…
 * pídele al administrador que…»), que se muestran tal cual, y el volcado del
 * proveedor, que está en inglés y no dice qué hacer. Pintar el segundo literal
 * en un banner es la convención P6 al revés: el usuario entra al flujo justo
 * cuando algo falló, que es el peor momento para leer un JSON del proveedor.
 *
 * `visible === null` significa «no hay nada que este usuario pueda leer»: el
 * caller pone su propia frase accionable y manda `detalle` a un «Detalle
 * técnico» colapsado, donde sigue disponible para pegarlo en un ticket.
 */
export function partirMensajeDeError(raw: string): {
  visible: string | null;
  detalle: string | null;
} {
  const m = String(raw ?? "").trim();
  if (!m) return { visible: null, detalle: null };
  if (FORMA_TECNICA_DE_IA.test(m)) return { visible: null, detalle: m };
  return { visible: m, detalle: null };
}

/**
 * Nota: existió una `extractEdgeErrorSync`. Se borró al quedar sin un solo
 * llamador de producción: no puede leer el body de un `Response`, así que en
 * cualquier no-2xx devolvía el genérico en inglés — que es justo el bug que
 * arrastró hasta que su último call site pasó a la versión asíncrona. Si hace
 * falta el mensaje de un error que YA es un `Error`, `friendlyError` alcanza.
 */
