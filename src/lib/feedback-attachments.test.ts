import { describe, expect, it } from "vitest";
import {
  attachmentIconKind,
  buildAttachmentPath,
  FEEDBACK_ATTACHMENT_MAX_BYTES,
  formatAttachmentSize,
  safeAttachmentName,
  validateAttachmentFile,
} from "./feedback-attachments";

describe("safeAttachmentName", () => {
  it("retorna 'archivo.bin' para nombres inválidos", () => {
    expect(safeAttachmentName("")).toBe("archivo.bin");
    expect(safeAttachmentName(null as unknown as string)).toBe("archivo.bin");
    expect(safeAttachmentName(undefined as unknown as string)).toBe("archivo.bin");
  });

  it("preserva nombres ya seguros", () => {
    expect(safeAttachmentName("foto.png")).toBe("foto.png");
    expect(safeAttachmentName("captura_2026-01-01.png")).toBe("captura_2026-01-01.png");
  });

  it("reemplaza espacios y caracteres especiales por _", () => {
    expect(safeAttachmentName("mi foto.jpg")).toBe("mi_foto.jpg");
    expect(safeAttachmentName("foto/test.png")).toBe("foto_test.png");
    expect(safeAttachmentName("foto:test.png")).toBe("foto_test.png");
  });

  it("preserva la extensión y recorta '_' colgantes", () => {
    // El "!" se sanea a "_", pero el trim de bordes lo elimina al final
    // del basename para no dejar "doc_.pdf" feo — queda "doc.pdf".
    expect(safeAttachmentName("doc!.pdf")).toBe("doc.pdf");
    // "ñandú" → "_and_" → trim bordes → "and"
    expect(safeAttachmentName("ñandú.png")).toBe("and.png");
  });

  it("conserva solo extensión cuando el nombre se vacía completo", () => {
    // Caracteres puramente no-ASCII → base se vuelve "_" → cae a "archivo"
    expect(safeAttachmentName("👻.png")).toBe("archivo.png");
  });

  it("trata 'foo.tar.gz' como base='foo.tar' + ext='.gz'", () => {
    expect(safeAttachmentName("foo.tar.gz")).toBe("foo.tar.gz");
  });

  it("es idempotente", () => {
    const once = safeAttachmentName("mi archivo!@#.png");
    expect(safeAttachmentName(once)).toBe(once);
  });

  it("nombres sin extensión también funcionan", () => {
    expect(safeAttachmentName("Makefile")).toBe("Makefile");
    expect(safeAttachmentName("mi archivo")).toBe("mi_archivo");
  });
});

describe("buildAttachmentPath", () => {
  it("arma <userId>/<commentId>/<safe-name>", () => {
    expect(buildAttachmentPath("u-1", "c-1", "foto.png")).toBe("u-1/c-1/foto.png");
  });

  it("sanea el filename en el path", () => {
    expect(buildAttachmentPath("u-1", "c-1", "mi foto.png")).toBe("u-1/c-1/mi_foto.png");
  });

  it("throws cuando userId vacío", () => {
    expect(() => buildAttachmentPath("", "c-1", "x.png")).toThrow();
  });

  it("throws cuando commentId vacío", () => {
    expect(() => buildAttachmentPath("u-1", "", "x.png")).toThrow();
  });
});

describe("attachmentIconKind", () => {
  it("image para MIMEs image/*", () => {
    expect(attachmentIconKind("image/png")).toBe("image");
    expect(attachmentIconKind("image/jpeg")).toBe("image");
    expect(attachmentIconKind("image/webp")).toBe("image");
  });

  it("pdf para application/pdf", () => {
    expect(attachmentIconKind("application/pdf")).toBe("pdf");
  });

  it("zip para application/zip y variantes", () => {
    expect(attachmentIconKind("application/zip")).toBe("zip");
    expect(attachmentIconKind("application/x-rar-compressed")).toBe("zip");
    expect(attachmentIconKind("application/x-7z-compressed")).toBe("zip");
  });

  it("doc para officedocument / opendocument", () => {
    expect(
      attachmentIconKind(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("doc");
    expect(attachmentIconKind("application/vnd.oasis.opendocument.text")).toBe("doc");
  });

  it("code para text/* y JSON", () => {
    expect(attachmentIconKind("text/plain")).toBe("code");
    expect(attachmentIconKind("application/json")).toBe("code");
    expect(attachmentIconKind("text/javascript")).toBe("code");
  });

  it("file (fallback) para MIME desconocido sin extensión", () => {
    expect(attachmentIconKind("application/octet-stream")).toBe("file");
  });

  it("usa el nombre como fallback cuando MIME es null", () => {
    expect(attachmentIconKind(null, "foto.png")).toBe("image");
    expect(attachmentIconKind(null, "doc.pdf")).toBe("pdf");
    expect(attachmentIconKind(null, "code.ts")).toBe("code");
    expect(attachmentIconKind(null, "pack.zip")).toBe("zip");
  });

  it("file cuando ni MIME ni extensión ayudan", () => {
    expect(attachmentIconKind(null, "noidea.xyz")).toBe("file");
    expect(attachmentIconKind(undefined, undefined)).toBe("file");
  });
});

describe("formatAttachmentSize", () => {
  it("'—' para null/undefined/negativos", () => {
    expect(formatAttachmentSize(null)).toBe("—");
    expect(formatAttachmentSize(undefined)).toBe("—");
    expect(formatAttachmentSize(-1)).toBe("—");
  });

  it("bytes 0..999", () => {
    expect(formatAttachmentSize(0)).toBe("0 B");
    expect(formatAttachmentSize(999)).toBe("999 B");
  });

  it("KB en 1024..1024*1024-1", () => {
    expect(formatAttachmentSize(1024)).toBe("1 KB");
    expect(formatAttachmentSize(2048)).toBe("2 KB");
    expect(formatAttachmentSize(1024 * 1023)).toBe("1023 KB");
  });

  it("MB con una decimal y coma decimal", () => {
    expect(formatAttachmentSize(1024 * 1024)).toBe("1 MB");
    expect(formatAttachmentSize(1024 * 1024 * 1.5)).toBe("1,5 MB");
    expect(formatAttachmentSize(1024 * 1024 * 12.3)).toBe("12,3 MB");
  });
});

describe("validateAttachmentFile", () => {
  it("acepta archivos válidos", () => {
    expect(validateAttachmentFile({ name: "ok.png", size: 1024 })).toBeNull();
  });

  it("rechaza archivo sin nombre", () => {
    expect(validateAttachmentFile({ name: "", size: 10 })).toMatch(/nombre/);
    expect(validateAttachmentFile({ name: "   ", size: 10 })).toMatch(/nombre/);
  });

  it("rechaza archivo de 0 bytes", () => {
    expect(validateAttachmentFile({ name: "x.png", size: 0 })).toMatch(/vac/);
  });

  it("rechaza archivo > 25 MB", () => {
    const tooBig = FEEDBACK_ATTACHMENT_MAX_BYTES + 1;
    const msg = validateAttachmentFile({ name: "huge.zip", size: tooBig });
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/m[áa]ximo/i);
  });

  it("acepta archivo justo en el límite", () => {
    expect(
      validateAttachmentFile({ name: "edge.zip", size: FEEDBACK_ATTACHMENT_MAX_BYTES }),
    ).toBeNull();
  });
});
