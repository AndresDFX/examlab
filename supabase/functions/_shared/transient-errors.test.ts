import { describe, expect, it } from "vitest";
import { isTransientError, TRANSIENT_ERROR_PATTERN } from "./transient-errors";

describe("isTransientError", () => {
  describe("retorna false para inputs vacíos / no transitorios", () => {
    it("null → false", () => {
      expect(isTransientError(null)).toBe(false);
    });
    it("undefined → false", () => {
      expect(isTransientError(undefined)).toBe(false);
    });
    it("string vacío → false", () => {
      expect(isTransientError("")).toBe(false);
    });
    it("400 bad request → false", () => {
      expect(isTransientError("400 Bad Request: invalid payload")).toBe(false);
    });
    it("401 unauthorized → false", () => {
      expect(isTransientError("401 unauthorized: invalid token")).toBe(false);
    });
    it("403 forbidden → false", () => {
      expect(isTransientError("403 forbidden")).toBe(false);
    });
    it("404 not found → false", () => {
      expect(isTransientError("HTTP 404: target not found")).toBe(false);
    });
    it("content policy violation → false", () => {
      expect(isTransientError("Content policy violation: blocked")).toBe(false);
    });
    it("error de parsing JSON → false", () => {
      expect(isTransientError("SyntaxError: Unexpected token in JSON")).toBe(false);
    });
  });

  describe("retorna true para errores HTTP transitorios (429 / 5xx)", () => {
    it("429 rate limit → true", () => {
      expect(isTransientError("HTTP 429: Too Many Requests")).toBe(true);
    });
    it("500 internal server error → true", () => {
      expect(isTransientError("HTTP 500: internal error")).toBe(true);
    });
    it("502 bad gateway → true", () => {
      expect(isTransientError("502 Bad Gateway")).toBe(true);
    });
    it("503 service unavailable → true", () => {
      expect(isTransientError("503 Service Unavailable")).toBe(true);
    });
    it("504 gateway timeout → true", () => {
      expect(isTransientError("Gateway timeout (504)")).toBe(true);
    });
  });

  describe("retorna true para errores transitorios por texto", () => {
    it("rate limit string", () => {
      expect(isTransientError("Provider rate limit reached")).toBe(true);
    });
    it("too many requests string", () => {
      expect(isTransientError("Too Many Requests")).toBe(true);
    });
    it("timeout", () => {
      expect(isTransientError("Request timeout after 30s")).toBe(true);
    });
    it("timed out", () => {
      expect(isTransientError("Connection timed out")).toBe(true);
    });
    it("ECONNRESET", () => {
      expect(isTransientError("Network error: ECONNRESET")).toBe(true);
    });
    it("ECONNREFUSED", () => {
      expect(isTransientError("ECONNREFUSED 127.0.0.1:5432")).toBe(true);
    });
    it("ENETUNREACH", () => {
      expect(isTransientError("ENETUNREACH")).toBe(true);
    });
    it("fetch failed", () => {
      expect(isTransientError("fetch failed: connection reset")).toBe(true);
    });
    it("quota exceeded", () => {
      expect(isTransientError("quota.exceeded: monthly limit reached")).toBe(true);
    });
    it("service unavailable", () => {
      expect(isTransientError("service.unavailable")).toBe(true);
    });
    it("gateway timeout", () => {
      expect(isTransientError("gateway.timeout from upstream")).toBe(true);
    });
    it("internal server error texto", () => {
      expect(isTransientError("internal.server.error: failure")).toBe(true);
    });
  });

  // Mensajes EXACTOS que producen las edges/workers ante un 503 del gateway.
  // Si estos dejan de matchear, los jobs NO se re-encolarían — por eso los
  // fijamos como invariante de los flujos de cola (grading + generation).
  describe("formatos reales de error que llegan a los workers (503 → re-encola)", () => {
    it("describeAiError: 'Error de IA [503]: ...' → true (el [503] tiene word boundaries)", () => {
      expect(
        isTransientError(
          'Error de IA [503]: {"error":{"message":"The model is overloaded. Please try again later."}}',
        ),
      ).toBe(true);
    });
    it("describeAiError: 'Error de IA [500]: ...' → true", () => {
      expect(isTransientError("Error de IA [500]: internal error")).toBe(true);
    });
    it("grading worker: 'Edge function ai-grade-submission → 503 ...' → true", () => {
      expect(
        isTransientError("Edge function ai-grade-submission → 503 Service Unavailable"),
      ).toBe(true);
    });
    it("generation worker: 'generate-contents HTTP 503: ...' → true", () => {
      expect(isTransientError("generate-contents HTTP 503: upstream overloaded")).toBe(true);
    });
    it("generation worker (regen): 'generate-contents (regen): Error de IA [503]: ...' → true", () => {
      expect(
        isTransientError("generate-contents (regen): Error de IA [503]: overloaded"),
      ).toBe(true);
    });
    it("describeAiError: 'Error de IA [400]: ...' → false (input/contenido, NO se re-encola)", () => {
      expect(isTransientError("Error de IA [400]: invalid request")).toBe(false);
    });
    it("describeAiError: 'Error de IA [401]: ...' → false (API key, NO se re-encola)", () => {
      expect(isTransientError("Error de IA [401]: unauthorized")).toBe(false);
    });
  });

  describe("case-insensitive", () => {
    it("TIMEOUT en mayúsculas", () => {
      expect(isTransientError("TIMEOUT")).toBe(true);
    });
    it("Rate Limit mixto", () => {
      expect(isTransientError("Rate Limit reached")).toBe(true);
    });
  });

  describe("contraejemplos: no matchea fragmentos parciales sospechosos", () => {
    it("'42900' (no es 429) → false", () => {
      // \b429\b exige word boundary — 42900 no matchea como 429 standalone.
      expect(isTransientError("Code 42900: unrelated error")).toBe(false);
    });
    it("'499' (4xx que no es 429) → false", () => {
      expect(isTransientError("HTTP 499 client closed request")).toBe(false);
    });
    it("'600' (no es 5xx) → false", () => {
      expect(isTransientError("Custom error 600")).toBe(false);
    });
  });
});

describe("TRANSIENT_ERROR_PATTERN (regex export)", () => {
  it("se exporta como RegExp con flag i", () => {
    expect(TRANSIENT_ERROR_PATTERN).toBeInstanceOf(RegExp);
    expect(TRANSIENT_ERROR_PATTERN.flags).toContain("i");
  });

  it("el patrón usa word boundaries para 429 y 5xx", () => {
    // Test directo del patrón: \b429\b debe estar en el source.
    expect(TRANSIENT_ERROR_PATTERN.source).toContain("\\b429\\b");
    expect(TRANSIENT_ERROR_PATTERN.source).toContain("\\b5\\d\\d\\b");
  });
});
