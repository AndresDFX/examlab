import { describe, expect, it } from "vitest";
import {
  serializeV86Answer,
  parseV86Answer,
  isV86AnswerBlank,
  v86TranscriptForDisplay,
} from "./v86-answer";

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
});
