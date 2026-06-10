import { describe, it, expect } from "vitest";
import {
  extensionOf,
  isImageFile,
  isEditableImageFile,
  isPdfFile,
  isViewableMedia,
  canvasExportMimeForName,
  mediaMimeForName,
} from "./media-files";

describe("extensionOf", () => {
  it("devuelve la extensión en minúsculas sin punto", () => {
    expect(extensionOf("foto.PNG")).toBe("png");
    expect(extensionOf("a/b/Diagrama.JPG")).toBe("jpg");
    expect(extensionOf("doc.final.pdf")).toBe("pdf");
  });
  it("maneja casos sin extensión o vacíos", () => {
    expect(extensionOf("README")).toBe("");
    expect(extensionOf("termina.")).toBe("");
    expect(extensionOf("")).toBe("");
    expect(extensionOf(null)).toBe("");
    expect(extensionOf(undefined)).toBe("");
  });
});

describe("isImageFile", () => {
  it("acepta raster + vectorial + animada", () => {
    for (const n of ["a.png", "a.jpg", "a.jpeg", "a.webp", "a.gif", "a.svg", "a.bmp", "a.avif"]) {
      expect(isImageFile(n)).toBe(true);
    }
    expect(isImageFile("FOTO.PNG")).toBe(true);
  });
  it("rechaza no-imágenes", () => {
    for (const n of ["a.pdf", "a.md", "a.py", "a.zip", "noext", null, undefined]) {
      expect(isImageFile(n as string)).toBe(false);
    }
  });
});

describe("isEditableImageFile", () => {
  it("solo raster editables en canvas", () => {
    for (const n of ["a.png", "a.jpg", "a.jpeg", "a.webp", "a.bmp", "a.avif"]) {
      expect(isEditableImageFile(n)).toBe(true);
    }
  });
  it("excluye vectorial (svg) y animada (gif)", () => {
    expect(isEditableImageFile("a.svg")).toBe(false);
    expect(isEditableImageFile("a.gif")).toBe(false);
    expect(isEditableImageFile("a.pdf")).toBe(false);
  });
});

describe("isPdfFile", () => {
  it("detecta pdf por extensión", () => {
    expect(isPdfFile("guia.pdf")).toBe(true);
    expect(isPdfFile("GUIA.PDF")).toBe(true);
    expect(isPdfFile("a.png")).toBe(false);
    expect(isPdfFile(null)).toBe(false);
  });
});

describe("isViewableMedia", () => {
  it("imagen o pdf → true", () => {
    expect(isViewableMedia("a.png")).toBe(true);
    expect(isViewableMedia("a.svg")).toBe(true);
    expect(isViewableMedia("a.pdf")).toBe(true);
  });
  it("otros → false", () => {
    expect(isViewableMedia("a.md")).toBe(false);
    expect(isViewableMedia("a.ipynb")).toBe(false);
    expect(isViewableMedia("a.zip")).toBe(false);
  });
});

describe("canvasExportMimeForName", () => {
  it("mapea a un MIME que canvas.toBlob soporta", () => {
    expect(canvasExportMimeForName("a.jpg")).toBe("image/jpeg");
    expect(canvasExportMimeForName("a.jpeg")).toBe("image/jpeg");
    expect(canvasExportMimeForName("a.webp")).toBe("image/webp");
    expect(canvasExportMimeForName("a.png")).toBe("image/png");
    // bmp/avif no son exportables fiables → caen a PNG.
    expect(canvasExportMimeForName("a.bmp")).toBe("image/png");
    expect(canvasExportMimeForName("a.avif")).toBe("image/png");
  });
});

describe("mediaMimeForName", () => {
  it("devuelve el content-type correcto", () => {
    expect(mediaMimeForName("a.png")).toBe("image/png");
    expect(mediaMimeForName("a.svg")).toBe("image/svg+xml");
    expect(mediaMimeForName("a.pdf")).toBe("application/pdf");
    expect(mediaMimeForName("a.gif")).toBe("image/gif");
    expect(mediaMimeForName("desconocido.xyz")).toBe("application/octet-stream");
  });
});
