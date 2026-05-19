import { describe, expect, it } from "vitest";
import {
  buildMessageAttachmentPath,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_MAX_COUNT,
  // Re-exportados desde feedback-attachments: solo verificamos que la
  // re-exportación funciona, los tests profundos viven en
  // feedback-attachments.test.ts.
  attachmentIconKind,
  formatAttachmentSize,
  safeAttachmentName,
  validateAttachmentFile,
} from "./message-attachments";

describe("buildMessageAttachmentPath", () => {
  it("arma <userId>/<messageId>/<safe>", () => {
    expect(buildMessageAttachmentPath("u-1", "m-1", "foto.png")).toBe("u-1/m-1/foto.png");
  });

  it("sanea el filename", () => {
    expect(buildMessageAttachmentPath("u-1", "m-1", "mi foto.png")).toBe(
      "u-1/m-1/mi_foto.png",
    );
  });

  it("throws cuando userId está vacío", () => {
    expect(() => buildMessageAttachmentPath("", "m-1", "x.png")).toThrow();
  });

  it("throws cuando messageId está vacío", () => {
    expect(() => buildMessageAttachmentPath("u-1", "", "x.png")).toThrow();
  });
});

describe("re-exports de feedback-attachments", () => {
  it("constantes están definidas", () => {
    expect(MESSAGE_ATTACHMENT_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(MESSAGE_ATTACHMENT_MAX_COUNT).toBe(8);
  });

  it("attachmentIconKind funciona igual", () => {
    expect(attachmentIconKind("image/png")).toBe("image");
    expect(attachmentIconKind("application/pdf")).toBe("pdf");
  });

  it("formatAttachmentSize funciona igual", () => {
    expect(formatAttachmentSize(1024)).toBe("1 KB");
    expect(formatAttachmentSize(null)).toBe("—");
  });

  it("safeAttachmentName funciona igual", () => {
    expect(safeAttachmentName("mi foto.png")).toBe("mi_foto.png");
  });

  it("validateAttachmentFile funciona igual", () => {
    expect(validateAttachmentFile({ name: "ok.png", size: 1024 })).toBeNull();
    expect(validateAttachmentFile({ name: "", size: 10 })).toMatch(/nombre/);
  });
});
