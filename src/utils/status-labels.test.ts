import { describe, expect, it } from "vitest";
import { statusLabel } from "./status-labels";

describe("statusLabel (es)", () => {
  it("traduce estados de exam/workshop/project en español", () => {
    expect(statusLabel("draft")).toBe("Borrador");
    expect(statusLabel("published")).toBe("Publicado");
    expect(statusLabel("closed")).toBe("Cerrado");
    expect(statusLabel("archived")).toBe("Archivado");
  });

  it("traduce estados de submissions en español", () => {
    expect(statusLabel("en_progreso")).toBe("En progreso");
    expect(statusLabel("entregado")).toBe("Entregado");
    expect(statusLabel("calificado")).toBe("Calificado");
    expect(statusLabel("ai_revisado")).toBe("Revisado por IA");
    expect(statusLabel("sospechoso")).toBe("Sospechoso");
    expect(statusLabel("chequeado")).toBe("Chequeado");
    expect(statusLabel("pending")).toBe("Pendiente");
  });
});

describe("statusLabel (en)", () => {
  it("traduce estados en ingles", () => {
    expect(statusLabel("draft", "en")).toBe("Draft");
    expect(statusLabel("published", "en")).toBe("Published");
    expect(statusLabel("en_progreso", "en")).toBe("In progress");
    expect(statusLabel("entregado", "en")).toBe("Submitted");
    expect(statusLabel("calificado", "en")).toBe("Graded");
    expect(statusLabel("ai_revisado", "en")).toBe("AI reviewed");
    expect(statusLabel("sospechoso", "en")).toBe("Suspicious");
    expect(statusLabel("chequeado", "en")).toBe("Reviewed");
    expect(statusLabel("pending", "en")).toBe("Pending");
  });
});

describe("statusLabel — fallbacks", () => {
  it("retorna em-dash para null/undefined/empty", () => {
    expect(statusLabel(null)).toBe("—");
    expect(statusLabel(undefined)).toBe("—");
    expect(statusLabel("")).toBe("—");
  });

  it("estados desconocidos: reemplaza _ por espacio y capitaliza", () => {
    expect(statusLabel("custom_status")).toBe("Custom status");
    expect(statusLabel("foo")).toBe("Foo");
  });
});
