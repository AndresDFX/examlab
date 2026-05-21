/**
 * Helper compartido: traduce una Response de error del proveedor de IA
 * (Gemini/OpenAI/Lovable Gateway) a un mensaje accionable en español.
 *
 * Caso especial: API key inválida (401/403 o body con "API_KEY_INVALID"
 * / "invalid api key" / "api key not valid"). El docente que ve "Error
 * de IA [400]: [{ \"error\": ..." no puede hacer nada con esa cadena —
 * el verdadero remedio es que el admin renueve el secret. El mensaje
 * generado lo dice explícito y nombra el secret exacto a actualizar.
 *
 * Otros errores: status + snippet truncado a 200 chars (suficiente para
 * diagnosticar sin saturar audit logs ni toasts).
 *
 * Mantener sincronizado con `tutor-chat/index.ts` que tiene un check
 * análogo inline (no usa este helper por ahora — vive en otro archivo
 * con sus propias particularidades de manejo de respuestas).
 */

export type AiProvider = "lovable" | "openai" | "gemini";

const SECRET_FOR_PROVIDER: Record<AiProvider, string> = {
  lovable: "LOVABLE_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

/**
 * Consume `res.text()` UNA SOLA VEZ y devuelve el mensaje formateado.
 * Si el caller ya leyó el body, pásalo en `preReadBody` para evitar
 * "body already consumed".
 *
 * `provider` se usa solo para nombrar el secret a renovar en el mensaje
 * de "API key inválida". Si no se conoce, default "lovable".
 */
export async function describeAiError(
  res: Response,
  provider: AiProvider = "lovable",
  preReadBody?: string,
): Promise<string> {
  let body = preReadBody ?? "";
  if (!preReadBody) {
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
  }
  const isKeyInvalid =
    res.status === 401 ||
    res.status === 403 ||
    body.includes("API_KEY_INVALID") ||
    body.includes("invalid_api_key") ||
    body.toLowerCase().includes("invalid api key") ||
    body.toLowerCase().includes("api key not valid");

  if (isKeyInvalid) {
    const secret = SECRET_FOR_PROVIDER[provider];
    return (
      `La API key del proveedor de IA (${provider}) está inválida o expirada. ` +
      `Pídele al administrador que actualice el secret ${secret} en ` +
      `Lovable → Edge Function Secrets, o que cambie el proveedor activo ` +
      `desde Admin → IA → Modelo.`
    );
  }

  const snippet = body.slice(0, 200).replace(/\s+/g, " ").trim();
  return `Error de IA [${res.status}]${snippet ? `: ${snippet}` : ""}`;
}
