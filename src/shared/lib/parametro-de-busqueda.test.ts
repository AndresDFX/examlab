import { describe, expect, it } from "vitest";
import { parametroComoTexto } from "./parametro-de-busqueda";
import { Route as Asistencia } from "@/routes/asistencia";

describe("parametroComoTexto", () => {
  it("convierte el número que deja JSON.parse", () => {
    expect(parametroComoTexto(446320)).toBe("446320");
  });
  it("conserva el texto (y los ceros a la izquierda)", () => {
    expect(parametroComoTexto("074664")).toBe("074664");
  });
  it("lo que no es texto ni número queda indefinido", () => {
    expect(parametroComoTexto(undefined)).toBeUndefined();
    expect(parametroComoTexto({ a: 1 })).toBeUndefined();
    expect(parametroComoTexto(Number.NaN)).toBeUndefined();
  });
});

describe("enlace público de asistencia", () => {
  const validar = (Asistencia.options.validateSearch as (s: Record<string, unknown>) => {
    session: string;
    code: string;
  });
  it("conserva un código que la query trae como número", () => {
    expect(validar({ session: "s1", code: 446320 }).code).toBe("446320");
  });
  it("conserva un código con cero inicial", () => {
    expect(validar({ session: "s1", code: "074664" }).code).toBe("074664");
  });
});
