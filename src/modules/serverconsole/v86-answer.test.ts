import { describe, expect, it } from "vitest";
import {
  serializeV86Answer,
  parseV86Answer,
  isV86AnswerBlank,
  stripAnsi,
  v86TranscriptForDisplay,
} from "./v86-answer";

const ESC = "\x1b";

describe("v86-answer", () => {
  it("round-trip serialize → parse", () => {
    const a = { transcript: "$ ls\nfile.txt\n", commands: ["ls", "pwd"] };
    const parsed = parseV86Answer(serializeV86Answer(a));
    expect(parsed).toEqual(a);
  });

  it("parse tolera basura / no-string → null", () => {
    expect(parseV86Answer("no es json")).toBeNull();
    expect(parseV86Answer("")).toBeNull();
    expect(parseV86Answer(null)).toBeNull();
    expect(parseV86Answer(123)).toBeNull();
  });

  it("parse rechaza JSON sin marca v86", () => {
    expect(parseV86Answer(JSON.stringify({ transcript: "x", commands: [] }))).toBeNull();
    expect(parseV86Answer(JSON.stringify({ v86: 2, transcript: "x" }))).toBeNull();
  });

  it("serialize recorta el transcript a 200k", () => {
    const big = "x".repeat(300_000);
    const parsed = parseV86Answer(serializeV86Answer({ transcript: big, commands: [] }));
    expect(parsed?.transcript.length).toBe(200_000);
  });

  it("serialize filtra comandos no-string", () => {
    // @ts-expect-error probamos entrada sucia en runtime
    const parsed = parseV86Answer(serializeV86Answer({ transcript: "", commands: ["ok", 5, null] }));
    expect(parsed?.commands).toEqual(["ok"]);
  });

  it("isV86AnswerBlank: sin comandos ni transcript = blank", () => {
    expect(isV86AnswerBlank(serializeV86Answer({ transcript: "   ", commands: [] }))).toBe(true);
    expect(isV86AnswerBlank("basura")).toBe(true);
    expect(isV86AnswerBlank(serializeV86Answer({ transcript: "", commands: ["ls"] }))).toBe(false);
    expect(isV86AnswerBlank(serializeV86Answer({ transcript: "out", commands: [] }))).toBe(false);
  });

  it("v86TranscriptForDisplay: transcript legible o null si no es v86", () => {
    expect(v86TranscriptForDisplay(serializeV86Answer({ transcript: "$ ls\nfile", commands: ["ls"] }))).toBe(
      "$ ls\nfile",
    );
    // sin transcript → cae a comandos
    expect(v86TranscriptForDisplay(serializeV86Answer({ transcript: "  ", commands: ["ls", "pwd"] }))).toBe(
      "ls\npwd",
    );
    // no-v86 → null (el caller muestra el raw tal cual)
    expect(v86TranscriptForDisplay("solo texto")).toBeNull();
    expect(v86TranscriptForDisplay(serializeV86Answer({ transcript: "", commands: [] }))).toBeNull();
  });

  describe("stripAnsi", () => {
    it("quita CSI de color (SGR) dejando el texto", () => {
      expect(stripAnsi(`${ESC}[1;32mbin${ESC}[0m  etc`)).toBe("bin  etc");
      // `ls` coloreado de BusyBox: varios SGR en la misma línea
      expect(stripAnsi(`${ESC}[01;34mdir${ESC}[0m\n${ESC}[01;32mrun.sh${ESC}[0m\n`)).toBe("dir\nrun.sh\n");
    });

    it("limpia el prompt coloreado con varios escapes", () => {
      const raw = `${ESC}[1;32mroot@examlab${ESC}[0m:${ESC}[1;34m~${ESC}[0m# ls -la\r\ntotal 0\r\n`;
      expect(stripAnsi(raw)).toBe("root@examlab:~# ls -la\ntotal 0\n");
    });

    it("quita OSC (título de ventana) terminado en BEL o en ST", () => {
      expect(stripAnsi(`${ESC}]0;root@examlab\x07listo`)).toBe("listo");
      expect(stripAnsi(`${ESC}]0;titulo${ESC}\\listo`)).toBe("listo");
      // OSC sin terminador (sesión cortada) → se descarta hasta el final
      expect(stripAnsi(`ok\n${ESC}]0;sin fin`)).toBe("ok\n");
    });

    it("quita escapes de dos caracteres (nF y Fe)", () => {
      // ESC ( B = seleccionar charset ASCII; ESC M = reverse index
      expect(stripAnsi(`${ESC}(Bhola${ESC}Mmundo`)).toBe("holamundo");
    });

    it("quita controles sueltos pero preserva tabs y saltos", () => {
      expect(stripAnsi("a\x07b")).toBe("ab");
      expect(stripAnsi("col1\tcol2\nfila2\n")).toBe("col1\tcol2\nfila2\n");
    });

    it("no toca texto sin escapes", () => {
      const plano = "cat /etc/passwd\nroot:x:0:0:root:/root:/bin/sh\n";
      expect(stripAnsi(plano)).toBe(plano);
    });

    it("colapsa \\r de reescritura de línea (barra de progreso) y normaliza CRLF", () => {
      expect(stripAnsi("10%\r20%\r30%\n")).toBe("30%\n");
      expect(stripAnsi("linea1\r\nlinea2\r\n")).toBe("linea1\nlinea2\n");
      // \r al final de la línea NO debe vaciarla
      expect(stripAnsi("hecho\r")).toBe("hecho");
      expect(stripAnsi("abc\rdef")).toBe("def");
    });

    it("entrada vacía / no-string → cadena vacía", () => {
      expect(stripAnsi("")).toBe("");
      expect(stripAnsi(null)).toBe("");
      expect(stripAnsi(undefined)).toBe("");
      expect(stripAnsi(123)).toBe("");
      expect(stripAnsi({})).toBe("");
    });

    it("un ESC incompleto al final no rompe ni deja basura", () => {
      expect(stripAnsi(`texto${ESC}`)).toBe("texto");
      expect(stripAnsi(`texto${ESC}[`)).toBe("texto");
      expect(stripAnsi(`texto${ESC}[1;3`)).toBe("texto");
      expect(stripAnsi(`${ESC}[32mverde${ESC}[0`)).toBe("verde");
    });

    it("v86TranscriptForDisplay limpia los escapes del transcript persistido", () => {
      const raw = serializeV86Answer({
        transcript: `${ESC}[1;32mroot@examlab${ESC}[0m:~# ls\r\n${ESC}[01;34mbin${ESC}[0m\r\n`,
        commands: ["ls"],
      });
      expect(v86TranscriptForDisplay(raw)).toBe("root@examlab:~# ls\nbin");
      // el transcript PERSISTIDO sigue crudo (es la evidencia de la sesión)
      expect(parseV86Answer(raw)?.transcript).toContain(`${ESC}[1;32m`);
    });

    it("v86TranscriptForDisplay: transcript SOLO de escapes cae a los comandos", () => {
      const raw = serializeV86Answer({ transcript: `${ESC}[2J${ESC}[H`, commands: ["clear"] });
      expect(v86TranscriptForDisplay(raw)).toBe("clear");
    });
  });
});
