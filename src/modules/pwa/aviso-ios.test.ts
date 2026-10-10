import { describe, expect, it } from "vitest";
import { debeMostrarAvisoIos } from "./aviso-ios";

describe("aviso de instalación en iOS", () => {
  it("sale en el inicio", () => {
    expect(debeMostrarAvisoIos("/app")).toBe(true);
  });
  it("no tapa la toma del examen, la asistencia ni las listas", () => {
    for (const p of ["/app/student/take/x", "/asistencia", "/app/student/exams", "/acuerdo/t", "/auth"])
      expect(debeMostrarAvisoIos(p)).toBe(false);
  });
});
