import { describe, expect, it } from "vitest";
import { extractGoogleErrorStatus, isGoogleEventGoneError } from "./google-error";

// Mensaje real del bug que motivó este helper. Lo conservamos como
// fixture: si el formato de `callGoogle` cambia y rompe la detección,
// este test (y la edge function) fallan al mismo tiempo.
const REAL_ERROR_404 =
  'Google API /calendar/v3/calendars/c_abc%40group.calendar.google.com/events/hj5d0hite4mcn0qat5athmr3nk?sendUpdates=all&conferenceDataVersion=1 falló [404]: { "error": { "errors": [ { "domain": "global", "reason": "notFound", "message": "Not Found" } ], "code": 404, "message": "Not Found" } }';

describe("isGoogleEventGoneError", () => {
  it("true para el formato real de error 404", () => {
    expect(isGoogleEventGoneError(new Error(REAL_ERROR_404))).toBe(true);
  });

  it("true para objeto tipo GoogleApiError con status 404", () => {
    // Mismo shape que `GoogleApiError` que arroja la edge function
    // (sin necesidad de la clase en el cliente — solo el shape).
    const err = { status: 404, path: "/events/x", message: "boom" };
    expect(isGoogleEventGoneError(err)).toBe(true);
  });

  it("true para objeto con status 410", () => {
    expect(isGoogleEventGoneError({ status: 410, message: "gone" })).toBe(true);
  });

  it("false para objeto con status distinto a 404/410", () => {
    expect(isGoogleEventGoneError({ status: 403, message: "forbidden" })).toBe(false);
    expect(isGoogleEventGoneError({ status: 500, message: "oops" })).toBe(false);
  });

  it("propiedad status NO numérica → cae al fallback de mensaje", () => {
    // status como string no califica como "numeric status".
    expect(
      isGoogleEventGoneError({ status: "404", message: "no incluye corchetes" } as unknown),
    ).toBe(false);
  });

  it("true para 410 Gone", () => {
    expect(isGoogleEventGoneError(new Error("Google API /x falló [410]: gone"))).toBe(true);
  });

  it("false para 401 Unauthorized (auth, no event missing)", () => {
    expect(
      isGoogleEventGoneError(new Error("Google API /x falló [401]: no token")),
    ).toBe(false);
  });

  it("false para 403 Forbidden", () => {
    expect(isGoogleEventGoneError(new Error("Google API /x falló [403]: forbidden"))).toBe(
      false,
    );
  });

  it("false para 500 server error", () => {
    expect(isGoogleEventGoneError(new Error("Google API /x falló [500]: oops"))).toBe(false);
  });

  it("acepta string crudo además de Error", () => {
    expect(isGoogleEventGoneError(REAL_ERROR_404)).toBe(true);
  });

  it("false para null/undefined/objetos sin info", () => {
    expect(isGoogleEventGoneError(null)).toBe(false);
    expect(isGoogleEventGoneError(undefined)).toBe(false);
    expect(isGoogleEventGoneError({})).toBe(false);
  });

  it("no se confunde si '404' aparece dentro de un texto pero NO entre corchetes", () => {
    // "Calendar 404 page" no debería matchear — solo el patrón [404]
    // tras "falló".
    expect(isGoogleEventGoneError(new Error("Calendar 404 page"))).toBe(false);
  });

  it("no matchea otros números entre corchetes", () => {
    expect(isGoogleEventGoneError(new Error("Code [1234]"))).toBe(false);
  });
});

describe("extractGoogleErrorStatus", () => {
  it("extrae 404 del mensaje real", () => {
    expect(extractGoogleErrorStatus(new Error(REAL_ERROR_404))).toBe(404);
  });

  it("usa .status numérico cuando está disponible (forma nueva)", () => {
    expect(extractGoogleErrorStatus({ status: 404, message: "x" })).toBe(404);
    expect(extractGoogleErrorStatus({ status: 500, message: "y" })).toBe(500);
  });

  it("prefiere .status sobre el mensaje cuando ambos existen", () => {
    // Si el shape lleva status=403 pero el mensaje tiene [404], el
    // status numérico gana — el status estructurado es más confiable.
    const err = { status: 403, message: "Google API /x falló [404]: foo" };
    expect(extractGoogleErrorStatus(err)).toBe(403);
  });

  it("extrae 500", () => {
    expect(extractGoogleErrorStatus(new Error("Google API /x falló [500]: oops"))).toBe(500);
  });

  it("null si no hay status entre corchetes", () => {
    expect(extractGoogleErrorStatus(new Error("Random error"))).toBeNull();
  });

  it("null para Error sin mensaje", () => {
    expect(extractGoogleErrorStatus(new Error(""))).toBeNull();
  });

  it("matchea solo 3 dígitos (descarta [12345])", () => {
    expect(extractGoogleErrorStatus(new Error("Code [12345]"))).toBeNull();
  });
});
