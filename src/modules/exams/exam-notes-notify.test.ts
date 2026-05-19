import { describe, expect, it } from "vitest";
import { buildExamNoteReviewedMessage } from "./exam-notes-notify";

describe("buildExamNoteReviewedMessage — aprobación", () => {
  it("title incluye 'aprobada' + nombre del examen", () => {
    const out = buildExamNoteReviewedMessage({
      examTitle: "Parcial II",
      approved: true,
    });
    expect(out.title).toBe("Nota de apoyo aprobada — Parcial II");
  });

  it("body para aprobada menciona que estará disponible durante el examen", () => {
    const out = buildExamNoteReviewedMessage({
      examTitle: "Parcial II",
      approved: true,
    });
    expect(out.body).toMatch(/aprobada/i);
    expect(out.body).toMatch(/disponible durante el examen/i);
    expect(out.body).toContain("Parcial II");
  });

  it("rejectionReason en caso de aprobación se ignora", () => {
    // Pasar reason cuando approved=true no debe meterlo en el body
    // (no tiene sentido semántico). Edge case defensivo.
    const out = buildExamNoteReviewedMessage({
      examTitle: "Parcial II",
      approved: true,
      rejectionReason: "no debería aparecer",
    });
    expect(out.body).not.toContain("no debería aparecer");
    expect(out.body).not.toMatch(/motivo/i);
  });
});

describe("buildExamNoteReviewedMessage — rechazo", () => {
  it("title incluye 'rechazada' + nombre del examen", () => {
    const out = buildExamNoteReviewedMessage({
      examTitle: "Parcial II",
      approved: false,
    });
    expect(out.title).toBe("Nota de apoyo rechazada — Parcial II");
  });

  it("body para rechazada sin motivo NO incluye 'Motivo:'", () => {
    const out = buildExamNoteReviewedMessage({
      examTitle: "Parcial II",
      approved: false,
    });
    expect(out.body).toMatch(/rechazada/i);
    expect(out.body).not.toMatch(/motivo:/i);
    // Instrucción de re-enviar siempre presente
    expect(out.body).toMatch(/editarla y enviarla/i);
  });

  it("body para rechazada CON motivo lo incluye textualmente", () => {
    const out = buildExamNoteReviewedMessage({
      examTitle: "Parcial II",
      approved: false,
      rejectionReason: "incluye solapamiento con el material original",
    });
    expect(out.body).toMatch(/motivo: incluye solapamiento con el material original/i);
  });

  it("rejectionReason solo con whitespace se trata como ausente", () => {
    // Defensivo: si el textarea queda con espacios, no metemos
    // "Motivo:   " vacío.
    const out = buildExamNoteReviewedMessage({
      examTitle: "Parcial II",
      approved: false,
      rejectionReason: "   ",
    });
    expect(out.body).not.toMatch(/motivo:/i);
  });

  it("trim del rejectionReason (sin espacios de borde en el body)", () => {
    const out = buildExamNoteReviewedMessage({
      examTitle: "Parcial II",
      approved: false,
      rejectionReason: "  copia textual del libro  ",
    });
    expect(out.body).toContain("Motivo: copia textual del libro.");
    expect(out.body).not.toContain("Motivo:   copia");
  });
});

describe("buildExamNoteReviewedMessage — fallback del título", () => {
  it("examTitle null → fallback 'tu examen'", () => {
    const out = buildExamNoteReviewedMessage({ examTitle: null, approved: true });
    expect(out.title).toBe("Nota de apoyo aprobada — tu examen");
    expect(out.body).toContain('"tu examen"');
  });

  it("examTitle undefined → fallback 'tu examen'", () => {
    const out = buildExamNoteReviewedMessage({ approved: false });
    expect(out.title).toBe("Nota de apoyo rechazada — tu examen");
  });

  it("examTitle string vacío → fallback", () => {
    const out = buildExamNoteReviewedMessage({ examTitle: "", approved: true });
    expect(out.title).toBe("Nota de apoyo aprobada — tu examen");
  });

  it("examTitle solo whitespace → fallback", () => {
    const out = buildExamNoteReviewedMessage({ examTitle: "   ", approved: true });
    expect(out.title).toBe("Nota de apoyo aprobada — tu examen");
  });

  it("examTitle válido se preserva con trim", () => {
    const out = buildExamNoteReviewedMessage({
      examTitle: "  Examen Final  ",
      approved: true,
    });
    expect(out.title).toBe("Nota de apoyo aprobada — Examen Final");
  });
});
