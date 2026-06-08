import { describe, expect, it } from "vitest";
import {
  buildVerifyUrl,
  certificateFileName,
  type CertificateData,
} from "./certificate-pdf";

/**
 * Solo se testean los helpers PUROS del módulo:
 *   - buildVerifyUrl(shortCode, origin?) — determinístico cuando se pasa `origin`.
 *   - certificateFileName(data) — usa el helper interno normalizeForFilename.
 *
 * buildCertificatePdf / downloadCertificate / downloadCertificatesZip dependen
 * de jspdf, qrcode, fflate, DOM y fetch → no se testean acá.
 */

/** Base mínima para CertificateData; cada test sobreescribe lo que necesita. */
function makeData(overrides: Partial<CertificateData> = {}): CertificateData {
  return {
    shortCode: "ABC123",
    studentFullName: "Juan Perez",
    courseName: "Curso",
    finalGrade: 4.5,
    gradeScaleMax: 5,
    teacherNames: [],
    issuedAt: "2026-06-08T12:00:00Z",
    payloadHash: "deadbeef",
    ...overrides,
  };
}

describe("buildVerifyUrl", () => {
  it("compone origin + /verify/ + short code cuando se pasa origin", () => {
    expect(buildVerifyUrl("ABC123", "https://examlab.app")).toBe(
      "https://examlab.app/verify/ABC123",
    );
  });

  it("preserva el origin tal cual sin normalizar slashes", () => {
    // No hay limpieza de trailing slash: se concatena literal.
    expect(buildVerifyUrl("X1", "https://host.com/")).toBe(
      "https://host.com//verify/X1",
    );
  });

  it("aplica encodeURIComponent al short code", () => {
    // Espacios → %20, slash → %2F.
    expect(buildVerifyUrl("a b/c", "https://h")).toBe(
      "https://h/verify/a%20b%2Fc",
    );
  });

  it("no codifica caracteres seguros en URL (guion, alfanumérico)", () => {
    // encodeURIComponent deja intactos A-Z a-z 0-9 - _ . ! ~ * ' ( )
    expect(buildVerifyUrl("ABC-123_xyz", "https://h")).toBe(
      "https://h/verify/ABC-123_xyz",
    );
  });

  it("codifica caracteres reservados como #, ?, &", () => {
    expect(buildVerifyUrl("a#b?c&d", "https://h")).toBe(
      "https://h/verify/a%23b%3Fc%26d",
    );
  });

  it("origin vacío produce una ruta relativa", () => {
    expect(buildVerifyUrl("CODE", "")).toBe("/verify/CODE");
  });

  it("short code vacío deja la ruta con segmento vacío", () => {
    expect(buildVerifyUrl("", "https://h")).toBe("https://h/verify/");
  });

  it("en jsdom (sin origin) usa window.location.origin como base", () => {
    // El runner es jsdom; window.location.origin existe (default http://localhost).
    const url = buildVerifyUrl("ZZ9");
    expect(url).toBe(`${window.location.origin}/verify/ZZ9`);
  });

  it("acepta caracteres unicode/acentos en el short code y los codifica", () => {
    expect(buildVerifyUrl("ñé", "https://h")).toBe(
      `https://h/verify/${encodeURIComponent("ñé")}`,
    );
  });
});

describe("certificateFileName", () => {
  it("formato base <estudiante>_<curso>.pdf con espacios → guion bajo", () => {
    expect(
      certificateFileName(
        makeData({ studentFullName: "Juan Perez", courseName: "Algebra Lineal" }),
      ),
    ).toBe("Juan_Perez_Algebra_Lineal.pdf");
  });

  it("strip de acentos preservando la letra base (NFD + combining marks)", () => {
    // "José" → "Jose", "Programación" → "Programacion".
    expect(
      certificateFileName(
        makeData({ studentFullName: "José Pérez", courseName: "Programación I" }),
      ),
    ).toBe("Jose_Perez_Programacion_I.pdf");
  });

  it("ñ no es un acento combinante: NFD la descompone y queda como n", () => {
    // "ñ" en NFD = "n" + tilde combinante (U+0303), que se descarta → "n".
    expect(
      certificateFileName(
        makeData({ studentFullName: "Iñigo", courseName: "Niño" }),
      ),
    ).toBe("Inigo_Nino.pdf");
  });

  it("elimina caracteres prohibidos de filesystem (/ \\ : * ? \" < > |)", () => {
    expect(
      certificateFileName(
        makeData({
          studentFullName: 'A/B\\C:D*E?F"G<H>I|J',
          courseName: "X",
        }),
      ),
    ).toBe("ABCDEFGHIJ_X.pdf");
  });

  it("elimina caracteres de control (\\x00-\\x1f)", () => {
    expect(
      certificateFileName(
        makeData({
          studentFullName: "Ana\tBeto\nCeci",
          courseName: "Curso",
        }),
      ),
      // \t (\x09) y \n (\x0a) son control chars → se eliminan, NO se vuelven _.
    ).toBe("AnaBetoCeci_Curso.pdf");
  });

  it("colapsa espacios múltiples a un solo guion bajo", () => {
    expect(
      certificateFileName(
        makeData({ studentFullName: "Juan    Carlos", courseName: "Mate" }),
      ),
    ).toBe("Juan_Carlos_Mate.pdf");
  });

  it("hace trim de espacios al inicio y al final antes de reemplazar", () => {
    expect(
      certificateFileName(
        makeData({ studentFullName: "  Ana  ", courseName: "  Fisica  " }),
      ),
    ).toBe("Ana_Fisica.pdf");
  });

  it("colapsa guiones bajos consecutivos resultantes de chars eliminados", () => {
    // "A : B" → quita ':' → "A  B" → trim → "A  B" → \s+→ "A_B".
    expect(
      certificateFileName(
        makeData({ studentFullName: "A : B", courseName: "Z" }),
      ),
    ).toBe("A_B_Z.pdf");
  });

  it("trunca nombre de estudiante y curso a 50 caracteres cada uno", () => {
    const longName = "A".repeat(80);
    const longCourse = "B".repeat(80);
    const result = certificateFileName(
      makeData({ studentFullName: longName, courseName: longCourse }),
    );
    // 50 A + "_" + 50 B + ".pdf"
    expect(result).toBe(`${"A".repeat(50)}_${"B".repeat(50)}.pdf`);
  });

  it("trunca DESPUÉS de normalizar (los acentos no consumen del presupuesto de 50)", () => {
    // 60 "é": cada una colapsa a "e" tras NFD strip → 60 "e", luego slice(0,50).
    const sixtyAccents = "é".repeat(60);
    const result = certificateFileName(
      makeData({ studentFullName: sixtyAccents, courseName: "C" }),
    );
    expect(result).toBe(`${"e".repeat(50)}_C.pdf`);
  });

  it("nombres y cursos vacíos producen _.pdf", () => {
    expect(
      certificateFileName(makeData({ studentFullName: "", courseName: "" })),
    ).toBe("_.pdf");
  });

  it("string compuesto solo por espacios colapsa a vacío tras trim", () => {
    expect(
      certificateFileName(
        makeData({ studentFullName: "   ", courseName: "OK" }),
      ),
    ).toBe("_OK.pdf");
  });

  it("siempre termina en .pdf", () => {
    const result = certificateFileName(
      makeData({ studentFullName: "Quien Sea", courseName: "Lo Que Sea" }),
    );
    expect(result.endsWith(".pdf")).toBe(true);
  });

  it("ignora campos no relevantes al nombre (solo usa student + course)", () => {
    const a = certificateFileName(
      makeData({
        studentFullName: "Pedro",
        courseName: "Logica",
        shortCode: "AAA",
        finalGrade: 1.2,
        coursePeriod: "2026-1",
      }),
    );
    const b = certificateFileName(
      makeData({
        studentFullName: "Pedro",
        courseName: "Logica",
        shortCode: "ZZZ",
        finalGrade: 9.9,
        coursePeriod: "2030-2",
      }),
    );
    expect(a).toBe(b);
    expect(a).toBe("Pedro_Logica.pdf");
  });
});
