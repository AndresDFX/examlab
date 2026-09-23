import { describe, it, expect } from "vitest";
import { notaEfectivaDeTaller } from "./nota-efectiva";

describe("notaEfectivaDeTaller", () => {
  describe("taller SIN sustentación (el caso de todos los talleres de hoy)", () => {
    it("usa la nota final", () => {
      expect(notaEfectivaDeTaller({ final_grade: 4.5, ai_grade: 4 }, false)).toBe(4.5);
    });

    it("cae a la de la IA cuando no hay final — entregas históricas", () => {
      // Sin este fallback, entregas viejas donde la IA calificó y nadie cerró
      // `final_grade` contarían CERO en el consolidado.
      expect(notaEfectivaDeTaller({ final_grade: null, ai_grade: 3.8 }, false)).toBe(3.8);
    });

    it("sin ninguna de las dos, no hay nota", () => {
      expect(notaEfectivaDeTaller({ final_grade: null, ai_grade: null }, false)).toBeNull();
    });

    it("un CERO real es una nota, no un vacío", () => {
      expect(notaEfectivaDeTaller({ final_grade: 0, ai_grade: 4 }, false)).toBe(0);
      expect(notaEfectivaDeTaller({ final_grade: null, ai_grade: 0 }, false)).toBe(0);
    });
  });

  describe("taller CON sustentación", () => {
    it("usa la nota final cuando ya se sustentó", () => {
      expect(notaEfectivaDeTaller({ final_grade: 3.2, ai_grade: 4 }, true)).toBe(3.2);
    });

    it("NO cae a la de la IA cuando falta sustentar", () => {
      // Este es el caso que motivó el helper: es el estado NORMAL de una entrega
      // recién calificada por la IA. Caer a `ai_grade` anulaba el gate y llegaba
      // hasta la emisión de certificados.
      expect(notaEfectivaDeTaller({ final_grade: null, ai_grade: 4.9 }, true)).toBeNull();
    });

    it("un cero sustentado sigue siendo cero", () => {
      expect(notaEfectivaDeTaller({ final_grade: 0, ai_grade: 5 }, true)).toBe(0);
    });
  });

  it("sin entrega no hay nota, con o sin sustentación", () => {
    for (const req of [true, false, null, undefined]) {
      expect(notaEfectivaDeTaller(null, req)).toBeNull();
      expect(notaEfectivaDeTaller(undefined, req)).toBeNull();
    }
  });

  it("una bandera ausente se trata como SIN sustentación", () => {
    // Importa porque las consultas que no traigan la columna mandan `undefined`,
    // y ahí el comportamiento correcto es el de siempre.
    expect(notaEfectivaDeTaller({ final_grade: null, ai_grade: 4 }, undefined)).toBe(4);
    expect(notaEfectivaDeTaller({ final_grade: null, ai_grade: 4 }, null)).toBe(4);
  });
});
