/**
 * Tests de los helpers PUROS de UploadExternalContentDialog.
 *
 * `tagsToModality` y `slugifyFilename` viven en `upload-external-helpers.ts`
 * para poder testearlos sin montar el dialog (que depende de Supabase
 * Storage + i18next + auth context).
 */
import { describe, expect, it } from "vitest";
import { tagsToModality, slugifyFilename } from "./upload-external-helpers";

describe("tagsToModality", () => {
  it("solo teorico → teorica", () => {
    expect(tagsToModality(["teorico"])).toBe("teorica");
  });

  it("solo practico → practica", () => {
    expect(tagsToModality(["practico"])).toBe("practica");
  });

  it("teorico + practico (cualquier orden) → teorico_practica", () => {
    expect(tagsToModality(["teorico", "practico"])).toBe("teorico_practica");
    expect(tagsToModality(["practico", "teorico"])).toBe("teorico_practica");
  });

  it("solo examen → teorica (default fallback)", () => {
    // `examen` no aporta a la modalidad operativa; cae al default.
    expect(tagsToModality(["examen"])).toBe("teorica");
  });

  it("array vacío → teorica (fallback seguro para CHECK constraint)", () => {
    expect(tagsToModality([])).toBe("teorica");
  });

  it("teorico + examen → teorica (examen ignorado)", () => {
    expect(tagsToModality(["teorico", "examen"])).toBe("teorica");
  });

  it("practico + examen → practica (examen ignorado)", () => {
    expect(tagsToModality(["practico", "examen"])).toBe("practica");
  });

  it("los 3 tags juntos → teorico_practica (examen sigue siendo orthogonal)", () => {
    expect(tagsToModality(["teorico", "practico", "examen"])).toBe("teorico_practica");
  });
});

describe("slugifyFilename", () => {
  it("conserva nombre simple", () => {
    expect(slugifyFilename("guia.pdf")).toBe("guia.pdf");
  });

  it("quita acentos castellanos", () => {
    expect(slugifyFilename("Programación.pdf")).toBe("programacion.pdf");
    expect(slugifyFilename("Lección Sintáctica.docx")).toBe("leccion-sintactica.docx");
  });

  it("convierte espacios a guiones", () => {
    expect(slugifyFilename("mi archivo.pdf")).toBe("mi-archivo.pdf");
  });

  it("conserva extensión en minúsculas", () => {
    expect(slugifyFilename("DOC.PDF")).toBe("doc.pdf");
    expect(slugifyFilename("Foto.JPG")).toBe("foto.jpg");
    expect(slugifyFilename("Tabla.XLSX")).toBe("tabla.xlsx");
  });

  it("colapsa secuencias de chars no-[a-z0-9._-] a un solo guión", () => {
    expect(slugifyFilename("foo!!!bar###baz.pdf")).toBe("foo-bar-baz.pdf");
  });

  it("quita guiones colgantes al inicio y al fin del base", () => {
    expect(slugifyFilename("---foo---.pdf")).toBe("foo.pdf");
    expect(slugifyFilename("!!!hola.txt")).toBe("hola.txt");
  });

  it("trunca el base a 80 chars sin tocar la extensión", () => {
    const longBase = "a".repeat(100);
    const out = slugifyFilename(`${longBase}.pdf`);
    expect(out.endsWith(".pdf")).toBe(true);
    // 80 a's + ".pdf" = 84 chars.
    expect(out.length).toBe(84);
    expect(out).toBe(`${"a".repeat(80)}.pdf`);
  });

  it("sin nombre base resoluble → 'archivo' + ext", () => {
    // "----" termina con base vacío después del trim de guiones.
    expect(slugifyFilename("----.pdf")).toBe("archivo.pdf");
    expect(slugifyFilename("///.png")).toBe("archivo.png");
  });

  it("archivo sin extensión queda sin extensión", () => {
    expect(slugifyFilename("Makefile")).toBe("makefile");
  });

  it("preserva caracteres . _ - en el base", () => {
    expect(slugifyFilename("v1.2-beta_final.md")).toBe("v1.2-beta_final.md");
  });

  it("nombre con número y unicode mezclado", () => {
    expect(slugifyFilename("Tarea N°5 — Árboles.pdf")).toBe("tarea-n-5-arboles.pdf");
  });
});
