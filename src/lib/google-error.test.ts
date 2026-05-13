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
