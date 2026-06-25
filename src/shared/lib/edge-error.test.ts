import { describe, expect, it } from "vitest";
import { extractEdgeError, extractEdgeErrorSync } from "./edge-error";

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

describe("extractEdgeErrorSync", () => {
  it("happy path: lee `data.error` cuando está disponible", () => {
    expect(extractEdgeErrorSync(new Error("ignored"), { error: "del data" })).toBe(
      "del data",
    );
  });

  it("Error instance → devuelve .message", () => {
    expect(extractEdgeErrorSync(new Error("boom"))).toBe("boom");
  });

  it("string crudo → se devuelve tal cual", () => {
    expect(extractEdgeErrorSync("plain error")).toBe("plain error");
  });

  it("error null/undefined sin data → string vacío", () => {
    expect(extractEdgeErrorSync(null)).toBe("");
    expect(extractEdgeErrorSync(undefined)).toBe("");
  });

  it("fallback 'Error desconocido' para objetos sin shape conocido", () => {
    expect(extractEdgeErrorSync({ foo: "bar" })).toBe("Error desconocido");
  });

  it("ignora data.error vacío/whitespace y cae al Error", () => {
    expect(extractEdgeErrorSync(new Error("real"), { error: "" })).toBe("real");
    expect(extractEdgeErrorSync(new Error("real"), { error: "   " })).toBe("real");
  });
});
