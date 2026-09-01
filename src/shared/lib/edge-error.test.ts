import { describe, expect, it } from "vitest";
import { extractEdgeError, partirMensajeDeError } from "./edge-error";

// Helper para construir un FunctionsHttpError-like sin tener que importar
// la clase real de supabase-js. Solo necesitamos el shape:
// `{ message, name, context: { response } }`.
function makeFunctionsHttpError(body: string, contentType = "application/json", status = 500) {
  const response = new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
  // Shape histórico/nested: `context: { response }` (versiones viejas / wrappers).
  return {
    name: "FunctionsHttpError",
    message: "Edge Function returned a non-2xx status code",
    context: { response },
  };
}

// Shape REAL de supabase-js v2: `error.context` ES el Response (functions-js
// hace `throw new FunctionsHttpError(response)`). Este es el caso que el bug
// histórico no manejaba (leía `.context.response` → undefined → genérico).
function makeRealFunctionsHttpError(body: string, status = 429, contentType = "application/json") {
  const context = new Response(body, { status, headers: { "content-type": contentType } });
  return { name: "FunctionsHttpError", message: "Edge Function returned a non-2xx status code", context };
}

describe("extractEdgeError", () => {
  it("happy path: lee `error` del body JSON del Response", async () => {
    const err = makeFunctionsHttpError(JSON.stringify({ error: "Cuota excedida" }));
    expect(await extractEdgeError(err)).toBe("Cuota excedida");
  });

  it("prefiere `data.error` (ya parseado) y NO consume el Response stream", async () => {
    // Si supabase-js ya parseó el body como `data`, debemos usarlo —
    // así el Response queda intacto para otros consumidores.
    const err = makeFunctionsHttpError(JSON.stringify({ error: "del body" }));
    const result = await extractEdgeError(err, { error: "del data" });
    expect(result).toBe("del data");
    // Verificamos que el Response NO fue consumido (sigue siendo legible).
    const stillReadable = await err.context.response.text();
    expect(stillReadable).toContain("del body");
  });

  it("cae a `message` cuando el body JSON no tiene `error`", async () => {
    const err = makeFunctionsHttpError(JSON.stringify({ message: "Sin error pero con message" }));
    expect(await extractEdgeError(err)).toBe("Sin error pero con message");
  });

  it("body no-JSON corto se devuelve tal cual", async () => {
    const err = makeFunctionsHttpError("plain text fail", "text/plain");
    expect(await extractEdgeError(err)).toBe("plain text fail");
  });

  it("body vacío + status 500 → mensaje por status (NO el genérico inútil)", async () => {
    const err = makeFunctionsHttpError("");
    expect(await extractEdgeError(err)).toBe(
      "El servicio tuvo un error temporal. Reintenta en un momento.",
    );
  });

  it("[BUG FIX] shape REAL (context ES el Response, no .context.response): lee el body", async () => {
    // Antes el helper leía `.context.response` (undefined en supabase-js v2) →
    // todo caía al genérico. Este es el caso del 429 de Kahoot reportado.
    const err = makeRealFunctionsHttpError(
      JSON.stringify({ error: "Límite de uso de IA. Intenta en un momento." }),
      429,
    );
    expect(await extractEdgeError(err)).toBe("Límite de uso de IA. Intenta en un momento.");
  });

  it("[BUG FIX] 429 con body vacío → fallback de rate-limit por status", async () => {
    expect(await extractEdgeError(makeRealFunctionsHttpError("", 429))).toContain(
      "Límite de uso de IA",
    );
  });

  it("402 con body vacío → 'Sin créditos'", async () => {
    expect(await extractEdgeError(makeRealFunctionsHttpError("", 402))).toBe("Sin créditos de IA.");
  });

  it("error null/undefined sin data → string vacío", async () => {
    expect(await extractEdgeError(null)).toBe("");
    expect(await extractEdgeError(undefined)).toBe("");
  });

  it("ignora data.error con solo espacios y cae al body del Response", async () => {
    // Trim check: "   " no es un mensaje útil → seguir buscando.
    const err = makeFunctionsHttpError(JSON.stringify({ error: "del body" }));
    expect(await extractEdgeError(err, { error: "   " })).toBe("del body");
  });

  it("PostgrestError genérico → usa .message", async () => {
    const pgErr = { message: "duplicate key", code: "23505" };
    expect(await extractEdgeError(pgErr)).toBe("duplicate key");
  });

  it("fallback final cuando nada coincide (no el genérico de supabase)", async () => {
    expect(await extractEdgeError({})).toBe(
      "No se pudo completar la operación. Reintenta en un momento.",
    );
  });
});

/**
 * La eleccion entre `error` y `message` cuando llegan LOS DOS.
 *
 * Existe porque la heuristica se escribio como `/s/` en vez de `/\s/` —una
 * barra invertida perdida al escribir el archivo— y preguntaba «¿el `error` no
 * tiene la LETRA s?». Sin estos casos nada lo detenia: la unica prueba manual
 * que se hizo fue con `rate_limited`, que no lleva «s» y por eso funcionaba de
 * casualidad. Los dos grupos son cuerpos REALES de edges del proyecto.
 */
describe("mejorMensaje: codigo vs frase", () => {
  it("codigo CON la letra «s» → gana `message` (era el bug)", async () => {
    // `server_error` / `bad_credentials` los emite public-attendance-check-in;
    // `no_blocks`, generate-contents.
    for (const code of ["server_error", "bad_credentials", "no_blocks", "insufficient_quota"]) {
      const err = makeFunctionsHttpError(
        JSON.stringify({ error: code, message: "No pudimos completar la operación." }),
      );
      expect(await extractEdgeError(err)).toBe("No pudimos completar la operación.");
    }
  });

  it("codigo SIN la letra «s» → gana `message`", async () => {
    const err = makeFunctionsHttpError(
      JSON.stringify({ error: "rate_limited", message: "Demasiadas solicitudes." }),
    );
    expect(await extractEdgeError(err)).toBe("Demasiadas solicitudes.");
  });

  it("frase SIN la letra «s» → gana `error`, no el `message`", async () => {
    // Cuerpos reales: «Token invalido», «No autenticado», «text requerido».
    for (const frase of ["No autenticado", "Token invalido", "text requerido"]) {
      const err = makeFunctionsHttpError(
        JSON.stringify({ error: frase, message: "Unhandled error in edge function" }),
      );
      expect(await extractEdgeError(err)).toBe(frase);
    }
  });

  it("frase redactada con espacios → gana `error` aunque haya `message`", async () => {
    const err = makeFunctionsHttpError(
      JSON.stringify({
        error: "Sin créditos de IA.",
        message: "insufficient_quota",
      }),
    );
    expect(await extractEdgeError(err)).toBe("Sin créditos de IA.");
  });

  it("sin `message` hermano → el codigo se devuelve igual (lo cura friendlyError)", async () => {
    const err = makeFunctionsHttpError(JSON.stringify({ error: "server_error" }));
    expect(await extractEdgeError(err)).toBe("server_error");
  });
});

/**
 * Separa la frase que el usuario tiene que leer del volcado del proveedor, que
 * antes se pintaba literal en el banner del diálogo de identificación:
 * `describeAiError` arma `Error de IA [500]: <200 chars del body crudo>`, que es
 * inglés técnico y no dice qué hacer.
 */
describe("partirMensajeDeError", () => {
  it("el volcado del proveedor va a «Detalle técnico», no al banner", () => {
    const crudo = 'Error de IA [500]: {"error":{"message":"internal server error"}}';
    expect(partirMensajeDeError(crudo)).toEqual({ visible: null, detalle: crudo });
  });

  it("una frase redactada en español se muestra tal cual", () => {
    const frase =
      "Sin créditos de IA. Pídele al administrador de la plataforma que revise el saldo del proveedor.";
    expect(partirMensajeDeError(frase)).toEqual({ visible: frase, detalle: null });
  });

  it("el mensaje de la key inválida —accionable y en español— también se muestra", () => {
    const frase =
      "La API key del proveedor de IA (gemini) está inválida o expirada. Pídele al administrador que configure la key correcta en Admin → IA → Modelo.";
    expect(partirMensajeDeError(frase).visible).toBe(frase);
  });

  it("vacío no pinta nada", () => {
    expect(partirMensajeDeError("   ")).toEqual({ visible: null, detalle: null });
  });
});
