import { describe, expect, it } from "vitest";

import {
  clasificarFalloDeEjecucion,
  esReintentable,
  esperaAntesDeReintentar,
} from "./fallo-de-ejecucion";

describe("clasificarFalloDeEjecucion — mensajes REALES del parcial 2026-09-23", () => {
  it("«No autenticado» es un problema de sesión, no del código", () => {
    expect(clasificarFalloDeEjecucion("No autenticado")).toBe("sesion");
  });

  it("Lambda sin capacidad es un problema de carga", () => {
    expect(
      clasificarFalloDeEjecucion(
        "Function failed due to not having enough compute resources (please check logs)",
      ),
    ).toBe("capacidad");
  });

  it("los 401/403 del runner también son de sesión", () => {
    expect(clasificarFalloDeEjecucion("Error del runner AWS Lambda (HTTP 401): Unauthorized")).toBe(
      "sesion",
    );
  });

  it("un tiempo agotado NO se reintenta aunque nombre al proveedor", () => {
    // Repetir un bucle infinito garantiza otro tiempo agotado, y de paso
    // quema capacidad que otro alumno necesita.
    expect(
      clasificarFalloDeEjecucion("Tiempo de ejecución excedido (30s). ¿Bucle infinito?"),
    ).toBe("otro");
    expect(clasificarFalloDeEjecucion("AWS Lambda timed out after 30s")).toBe("otro");
  });

  it("un error de compilación no se reintenta", () => {
    expect(clasificarFalloDeEjecucion("error: ';' expected")).toBe("otro");
  });

  it("un mensaje vacío o ausente no se reintenta", () => {
    expect(clasificarFalloDeEjecucion("")).toBe("otro");
    expect(clasificarFalloDeEjecucion(null)).toBe("otro");
    expect(clasificarFalloDeEjecucion(undefined)).toBe("otro");
  });
});

describe("política de reintento", () => {
  it("se reintenta sesión y capacidad, nada más", () => {
    expect(esReintentable("sesion")).toBe(true);
    expect(esReintentable("capacidad")).toBe(true);
    expect(esReintentable("otro")).toBe(false);
  });

  it("solo la falta de capacidad espera antes de repetir", () => {
    // Refrescar la sesión es inmediato; que un proveedor saturado se libere, no.
    expect(esperaAntesDeReintentar("sesion")).toBe(0);
    expect(esperaAntesDeReintentar("capacidad")).toBeGreaterThan(0);
  });
});
