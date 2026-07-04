/**
 * Tests del CSV de sustentaciones. Cubre los 2 helpers PUROS:
 *   - parseDefenseCsv      (validación + normalización por fila)
 *   - dedupeBySubmission   (resolución de grupos: 1 submission por N emails)
 *
 * Objetivos:
 *   1. El header del template coincide con DEFENSES_CSV_COLUMNS.
 *   2. Campos obligatorios (email, factor) faltantes → error con línea Excel.
 *   3. Factor fuera de [0,1] → error.
 *   4. Coma decimal (es-CO) parsea bien.
 *   5. URL opcional debe ser http(s) si viene.
 *   6. Notas > 2000 chars → error (no truncamos en silencio).
 *   7. Dedupe por submission descarta duplicados de grupo y reporta
 *      emails sin submission.
 */
import { describe, expect, it } from "vitest";
import {
  DEFENSES_TEMPLATE,
  DEFENSES_CSV_COLUMNS,
  DEFENSE_NOTES_MAX_CHARS,
  parseDefenseCsv,
  dedupeBySubmission,
  type ParsedDefenseRow,
} from "./defense-csv";

describe("DEFENSES_TEMPLATE", () => {
  it("header coincide con DEFENSES_CSV_COLUMNS (round-trip invariant)", () => {
    const header = DEFENSES_TEMPLATE.split("\n")[0];
    expect(header).toBe(DEFENSES_CSV_COLUMNS.join(","));
  });

  it("usa PUNTO decimal en el factor (la coma es delimitador del CSV, 0,8 desalinearía)", () => {
    expect(DEFENSES_TEMPLATE).toContain("0.8");
    expect(DEFENSES_TEMPLATE).toContain("0.5");
    // El template NO debe traer coma decimal en el factor demo.
    expect(DEFENSES_TEMPLATE).not.toContain("0,8");
  });

  it("expone las 4 columnas esperadas", () => {
    expect(DEFENSES_CSV_COLUMNS).toEqual([
      "student_email",
      "defense_factor",
      "defense_notes",
      "defense_video_url",
    ]);
  });
});

describe("parseDefenseCsv — validación de obligatorios", () => {
  it("email vacío → error con número de línea Excel-style", () => {
    const { rows, errors } = parseDefenseCsv([
      { student_email: "", defense_factor: "0.8" },
    ]);
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(2);
    expect(errors[0].message).toMatch(/student_email es obligatorio/);
  });

  it("email mal formado → error mencionando el valor", () => {
    const { rows, errors } = parseDefenseCsv([
      { student_email: "no-es-email", defense_factor: "0.5" },
    ]);
    expect(rows).toHaveLength(0);
    expect(errors[0].message).toMatch(/no-es-email/);
    expect(errors[0].message).toMatch(/formato de email/);
  });

  it("factor vacío → error", () => {
    const { rows, errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "" },
    ]);
    expect(rows).toHaveLength(0);
    expect(errors[0].message).toMatch(/defense_factor es obligatorio/);
  });

  it("factor < 0 → error", () => {
    const { rows, errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "-0.1" },
    ]);
    expect(rows).toHaveLength(0);
    expect(errors[0].message).toMatch(/-0\.1.*entre 0 y 1/);
  });

  it("factor > 1 → error", () => {
    const { rows, errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "1.5" },
    ]);
    expect(rows).toHaveLength(0);
    expect(errors[0].message).toMatch(/1\.5.*entre 0 y 1/);
  });

  it("factor con texto basura → error", () => {
    const { rows, errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "muy bien" },
    ]);
    expect(rows).toHaveLength(0);
    expect(errors[0].message).toMatch(/muy bien.*entre 0 y 1/);
  });

  it("número de línea Excel-style respeta el ÍNDICE del array (idx + 2)", () => {
    const { errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "0.5" }, // línea 2 OK
      { student_email: "ok@b.co", defense_factor: "0.7" }, // línea 3 OK
      { student_email: "", defense_factor: "0.5" }, // línea 4 → error
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(4);
    expect(errors[0].message).toMatch(/Fila 4/);
  });
});

describe("parseDefenseCsv — factor con coma decimal (es-CO)", () => {
  it("0,8 → 0.8", () => {
    const { rows, errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "0,8" },
    ]);
    expect(errors).toHaveLength(0);
    expect(rows[0].defense_factor).toBe(0.8);
  });

  it("0.8 → 0.8 (punto también funciona)", () => {
    const { rows } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "0.8" },
    ]);
    expect(rows[0].defense_factor).toBe(0.8);
  });

  it("límites 0 y 1 inclusivos", () => {
    const { rows, errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "0" },
      { student_email: "b@b.co", defense_factor: "1" },
      { student_email: "c@b.co", defense_factor: "1,0" },
    ]);
    expect(errors).toHaveLength(0);
    expect(rows.map((r) => r.defense_factor)).toEqual([0, 1, 1]);
  });
});

describe("parseDefenseCsv — campos opcionales", () => {
  it("solo email + factor (sin opcionales) → OK", () => {
    const { rows, errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "0.7" },
    ]);
    expect(errors).toHaveLength(0);
    expect(rows[0]).toEqual({
      line: 2,
      student_email: "a@b.co",
      defense_factor: 0.7,
      defense_notes: null,
      defense_video_url: null,
    });
  });

  it("notes presentes → trim y se preservan", () => {
    const { rows, errors } = parseDefenseCsv([
      {
        student_email: "a@b.co",
        defense_factor: "0.9",
        defense_notes: "  Defendió bien la arquitectura  ",
      },
    ]);
    expect(errors).toHaveLength(0);
    expect(rows[0].defense_notes).toBe("Defendió bien la arquitectura");
  });

  it("notes > 2000 chars → error (NO trunca en silencio)", () => {
    const longNotes = "a".repeat(DEFENSE_NOTES_MAX_CHARS + 1);
    const { rows, errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "0.5", defense_notes: longNotes },
    ]);
    expect(rows).toHaveLength(0);
    expect(errors[0].message).toMatch(/defense_notes excede 2000/);
  });

  it("notes EXACTAMENTE 2000 chars → OK", () => {
    const exactNotes = "a".repeat(DEFENSE_NOTES_MAX_CHARS);
    const { rows, errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "0.5", defense_notes: exactNotes },
    ]);
    expect(errors).toHaveLength(0);
    expect(rows[0].defense_notes).toBe(exactNotes);
  });

  it("url https válida → se conserva", () => {
    const { rows, errors } = parseDefenseCsv([
      {
        student_email: "a@b.co",
        defense_factor: "0.8",
        defense_video_url: "https://drive.google.com/file/d/abc/view",
      },
    ]);
    expect(errors).toHaveLength(0);
    expect(rows[0].defense_video_url).toBe(
      "https://drive.google.com/file/d/abc/view",
    );
  });

  it("url http (no https) también acepta", () => {
    const { rows, errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "0.8", defense_video_url: "http://example.com/x" },
    ]);
    expect(errors).toHaveLength(0);
    expect(rows[0].defense_video_url).toBe("http://example.com/x");
  });

  it("url sin esquema → error", () => {
    const { rows, errors } = parseDefenseCsv([
      {
        student_email: "a@b.co",
        defense_factor: "0.8",
        defense_video_url: "drive.google.com/x",
      },
    ]);
    expect(rows).toHaveLength(0);
    expect(errors[0].message).toMatch(/defense_video_url.*http/);
  });

  it("url vacía → se considera ausente, NO error", () => {
    const { rows, errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "0.8", defense_video_url: "" },
    ]);
    expect(errors).toHaveLength(0);
    expect(rows[0].defense_video_url).toBeNull();
  });
});

describe("parseDefenseCsv — normalización", () => {
  it("email lowercaseado para matchear contra la DB", () => {
    const { rows } = parseDefenseCsv([
      { student_email: "JuAn@Correo.EDU.co", defense_factor: "0.5" },
    ]);
    expect(rows[0].student_email).toBe("juan@correo.edu.co");
  });

  it("filas válidas e inválidas coexisten — válidas en rows, inválidas en errors", () => {
    const { rows, errors } = parseDefenseCsv([
      { student_email: "a@b.co", defense_factor: "0.5" }, // OK
      { student_email: "", defense_factor: "0.5" }, // error línea 3
      { student_email: "c@b.co", defense_factor: "0.9" }, // OK
    ]);
    expect(rows).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(3);
    expect(rows.map((r) => r.student_email)).toEqual(["a@b.co", "c@b.co"]);
  });
});

describe("dedupeBySubmission", () => {
  const makeRow = (email: string): ParsedDefenseRow => ({
    line: 2,
    student_email: email,
    defense_factor: 0.8,
    defense_notes: null,
    defense_video_url: null,
  });

  it("emails distintos → submissions distintas → todas se aplican", () => {
    const rows = [makeRow("a@b.co"), makeRow("c@d.co")];
    const map = new Map([
      ["a@b.co", "sub-1"],
      ["c@d.co", "sub-2"],
    ]);
    const result = dedupeBySubmission(rows, map);
    expect(result.toApply).toHaveLength(2);
    expect(result.skippedDuplicateGroup).toHaveLength(0);
    expect(result.skippedNoSubmission).toHaveLength(0);
  });

  it("dos emails apuntan a la misma submission (grupo) → solo 1 se aplica", () => {
    const rows = [makeRow("miembro1@b.co"), makeRow("miembro2@b.co")];
    // Ambos miembros del mismo grupo → misma submission
    const map = new Map([
      ["miembro1@b.co", "sub-grupo"],
      ["miembro2@b.co", "sub-grupo"],
    ]);
    const result = dedupeBySubmission(rows, map);
    expect(result.toApply).toHaveLength(1);
    expect(result.toApply[0].student_email).toBe("miembro1@b.co"); // primera gana
    expect(result.skippedDuplicateGroup).toHaveLength(1);
    expect(result.skippedDuplicateGroup[0].student_email).toBe("miembro2@b.co");
  });

  it("email sin submission → reportado en skippedNoSubmission", () => {
    const rows = [makeRow("noentregado@b.co"), makeRow("ok@b.co")];
    const map = new Map([["ok@b.co", "sub-ok"]]);
    const result = dedupeBySubmission(rows, map);
    expect(result.toApply).toHaveLength(1);
    expect(result.skippedNoSubmission).toHaveLength(1);
    expect(result.skippedNoSubmission[0].student_email).toBe("noentregado@b.co");
  });

  it("orden de las filas preservado en toApply", () => {
    const rows = [makeRow("c@b.co"), makeRow("a@b.co"), makeRow("b@b.co")];
    const map = new Map([
      ["a@b.co", "s-a"],
      ["b@b.co", "s-b"],
      ["c@b.co", "s-c"],
    ]);
    const result = dedupeBySubmission(rows, map);
    expect(result.toApply.map((r) => r.student_email)).toEqual([
      "c@b.co",
      "a@b.co",
      "b@b.co",
    ]);
  });
});
