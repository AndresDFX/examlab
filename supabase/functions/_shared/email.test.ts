import { describe, expect, it } from "vitest";
import {
  asciiEmailSubject,
  asciiDisplayName,
  formatEmailAddress,
  b64MimeBody,
  emailMimeContent,
} from "./email";

// Todo char > 0x7E rompe el encoder de asunto de denomailer 1.6.0. El asunto
// que sale de asciiEmailSubject DEBE ser ASCII imprimible puro y NO empezar con
// "=?" (o denomailer lo re-encodearía). Ese es el contrato que evita el bug del
// "cuerpo MIME como texto crudo".
const isSafeSubject = (s: string) => /^[\x20-\x7E]*$/.test(s) && !s.startsWith("=?");

describe("asciiEmailSubject", () => {
  it("quita emoji y transliterá acentos (correo de bienvenida)", () => {
    expect(
      asciiEmailSubject("ExamLab: \u{1F393} Bienvenido a Administración de Sistemas Operativos de Servidor"),
    ).toBe("ExamLab: Bienvenido a Administracion de Sistemas Operativos de Servidor");
  });

  it("quita ✅ y em-dash del aviso de cambio de correo", () => {
    expect(asciiEmailSubject("ExamLab: ✅ Tu correo fue cambiado — 24h para revertir si no fuiste vos")).toBe(
      "ExamLab: Tu correo fue cambiado 24h para revertir si no fuiste vos",
    );
  });

  it("quita ⚠️ y acento de solicitó", () => {
    expect(asciiEmailSubject("ExamLab: ⚠️ Se solicitó cambiar el correo de tu cuenta")).toBe(
      "ExamLab: Se solicito cambiar el correo de tu cuenta",
    );
  });

  it("un asunto ya ASCII pasa intacto", () => {
    expect(asciiEmailSubject("ExamLab: Nota publicada")).toBe("ExamLab: Nota publicada");
  });

  it("colapsa saltos de línea y tabs (defensa header-injection)", () => {
    expect(asciiEmailSubject("ExamLab:  Título   con\n\tsaltos")).toBe("ExamLab: Titulo con saltos");
  });

  it("nunca deja que el resultado empiece con '=?'", () => {
    expect(asciiEmailSubject("=?utf-8?Q?raro?=").startsWith("=?")).toBe(false);
  });

  it("null/undefined → cadena vacía", () => {
    // @ts-expect-error probamos el guard de nullish
    expect(asciiEmailSubject(null)).toBe("");
    // @ts-expect-error probamos el guard de nullish
    expect(asciiEmailSubject(undefined)).toBe("");
  });

  it("el contrato de seguridad se cumple para asuntos ricos en UTF-8", () => {
    const inputs = [
      "ExamLab: \u{1F393} Bienvenido a Administración",
      "ExamLab: ✅ Tu correo fue cambiado — revertir",
      "ExamLab: ⚠️ Se solicitó cambiar el correo",
      "ExamLab: 📢 Recordatorio: parcial el miércoles a las 8",
      "Fundación Ñandú: 🚀 evaluación de programación",
    ];
    for (const i of inputs) expect(isSafeSubject(asciiEmailSubject(i))).toBe(true);
  });
});

describe("asciiDisplayName / formatEmailAddress (display-name del From)", () => {
  const isSafeName = (s: string) => /^[\x20-\x7E]*$/.test(s) && !/["<>]/.test(s);

  it("transliterá acentos y quita ñ del nombre de institución", () => {
    expect(asciiDisplayName("Fundación Ñandú")).toBe("Fundacion Nandu");
    expect(asciiDisplayName("Institución Educativa")).toBe("Institucion Educativa");
  });

  it("quita emoji y símbolos no-ASCII", () => {
    expect(asciiDisplayName("Colegio 🎓")).toBe("Colegio");
    expect(asciiDisplayName("ExamLab · Notificaciones")).toBe("ExamLab Notificaciones");
  });

  it("quita comillas y ángulos (anti header-injection de sintaxis)", () => {
    expect(asciiDisplayName('Rogue" <evil@x>')).toBe("Rogue evil@x");
  });

  it("colapsa CR/LF/TAB (anti CRLF header-injection)", () => {
    expect(asciiDisplayName("Marca\r\nBcc: victima@x.com")).toBe("Marca Bcc: victima@x.com");
    expect(asciiDisplayName("Marca\r\nBcc: victima@x.com")).not.toContain("\n");
  });

  it("nombre ASCII pasa intacto; nulo → vacío", () => {
    expect(asciiDisplayName("ExamLab")).toBe("ExamLab");
    // @ts-expect-error guard de nullish
    expect(asciiDisplayName(null)).toBe("");
  });

  it("formatEmailAddress arma 'Name <email>' saneado y preserva la dirección", () => {
    expect(formatEmailAddress("Fundación X", "no-reply@x.edu.co")).toBe(
      "Fundacion X <no-reply@x.edu.co>",
    );
    // nombre vacío tras sanear → solo <email>
    expect(formatEmailAddress("🎓", "a@b.co")).toBe("<a@b.co>");
    expect(formatEmailAddress("", "a@b.co")).toBe("<a@b.co>");
  });

  it("el resultado del display-name siempre cumple el contrato seguro", () => {
    for (const n of ["Fundación Ñandú", "Colegio 🎓", 'X" <y>', "A\r\nB"]) {
      expect(isSafeName(asciiDisplayName(n))).toBe(true);
    }
  });
});

describe("b64MimeBody / emailMimeContent (cuerpo)", () => {
  it("base64 round-trip conserva el UTF-8 del cuerpo", () => {
    const body = "Hola 🎓 Administración — ñ á é í ó ú";
    const b64 = b64MimeBody(body).replace(/\r\n/g, "");
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(body);
  });

  it("las líneas base64 no superan 76 chars (RFC 2045)", () => {
    const b64 = b64MimeBody("x".repeat(500));
    for (const line of b64.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
  });

  it("emailMimeContent produce partes text/plain + text/html en base64", () => {
    const parts = emailMimeContent("texto", "<b>html</b>");
    expect(parts).toHaveLength(2);
    expect(parts[0].mimeType).toContain("text/plain");
    expect(parts[1].mimeType).toContain("text/html");
    expect(parts.every((p) => p.transferEncoding === "base64")).toBe(true);
  });
});
