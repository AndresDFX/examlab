import { describe, it, expect } from "vitest";
import {
  resumirTituloDeSesion,
  encabezadoDeCurso,
  TOPE_TITULO_SESION,
} from "./titulo-sesion";

/**
 * Los títulos de acá son REALES: salieron de las 152 sesiones que hay hoy en
 * producción, de tres cursos distintos. Un test con títulos inventados
 * validaría el formato que yo elegí, no el que la gente usa.
 */
const REALES = {
  dosTemas:
    "Sesión 3 — Principios éticos en la Ingeniería + El rol del ingeniero en el contexto ambiental",
  dosTemasConAcotacion:
    "Sesión 8 — Sesión doble · Documentación y QA (Javadoc y pruebas) + Refactorización con IA y persistencia de archivos (Clases 8 y 9)",
  dobleCorta: "Sesión 8 — Sesión doble · Introducción a UML + Casos de uso (Clases 8 y 9)",
  autonoma: "Sesión 8 — Costos y sostenibilidad cloud · clase autónoma (festivo) (Clase 10)",
  cortoConTema: "Sesión 3 — Pilas y colas",
  soloNumero: "Clase 1",
  unTema: "Sesión 4 — Análisis de problemas tecnológicos del entorno",
};

describe("resumirTituloDeSesion", () => {
  it("un título que ya entra no se toca", () => {
    for (const t of [REALES.cortoConTema, REALES.soloNumero]) {
      const r = resumirTituloDeSesion(t)!;
      expect(r.corto).toBe(t);
      expect(r.recortado).toBe(false);
    }
  });

  it("con dos temas deja el primero, que es con el que se recuerda la clase", () => {
    const r = resumirTituloDeSesion(REALES.dosTemas)!;
    expect(r.corto).toBe("Sesión 3 — Principios éticos en la Ingeniería");
    expect(r.recortado).toBe(true);
    // Y el completo queda entero: resumir no puede ser perder.
    expect(r.completo).toBe(REALES.dosTemas);
  });

  it("saca la acotación final entre paréntesis", () => {
    const r = resumirTituloDeSesion(REALES.dobleCorta)!;
    expect(r.corto).toBe("Sesión 8 — Sesión doble · Introducción a UML");
    expect(r.corto).not.toContain("Clases 8 y 9");
  });

  it("NO corta en « · »: ahí se separa la etiqueta del tema, no dos temas", () => {
    // Cortar en el punto medio daría «Sesión 8 — Sesión doble», que dice menos
    // que el título original. El tema tiene que sobrevivir.
    const r = resumirTituloDeSesion(REALES.dobleCorta)!;
    expect(r.corto).toContain("Introducción a UML");
  });

  it("el peor caso real (140 caracteres) entra en el tope", () => {
    const r = resumirTituloDeSesion(REALES.dosTemasConAcotacion)!;
    expect(r.corto.length).toBeLessThanOrEqual(TOPE_TITULO_SESION + 1); // +1 por el «…»
    expect(r.corto.startsWith("Sesión 8 — Sesión doble")).toBe(true);
    expect(r.recortado).toBe(true);
  });

  it("el tope es un PARÁMETRO (distintos anchos, distintos cursos)", () => {
    const ancho = resumirTituloDeSesion(REALES.unTema, 100)!;
    expect(ancho.corto).toBe(REALES.unTema);
    expect(ancho.recortado).toBe(false);

    const angosto = resumirTituloDeSesion(REALES.unTema, 20)!;
    expect(angosto.corto.length).toBeLessThanOrEqual(21);
    expect(angosto.corto.endsWith("…")).toBe(true);
    expect(angosto.completo).toBe(REALES.unTema);
  });

  it("corta en borde de palabra y sin dejar puntuación colgando", () => {
    const r = resumirTituloDeSesion(REALES.autonoma, 40)!;
    expect(r.corto.endsWith("…")).toBe(true);
    // Ni un espacio, ni un guion, ni un « · » justo antes de los puntos.
    expect(/[\s·+,;:—-]…$/.test(r.corto)).toBe(false);
  });

  it("una primera palabra más larga que el tope se corta igual (no queda vacío)", () => {
    const r = resumirTituloDeSesion("Supercalifragilisticoespialidoso", 10)!;
    expect(r.corto.length).toBeGreaterThan(1);
    expect(r.corto.endsWith("…")).toBe(true);
  });

  it("sin título devuelve null, para que la pantalla ponga su propio texto", () => {
    expect(resumirTituloDeSesion(null)).toBeNull();
    expect(resumirTituloDeSesion(undefined)).toBeNull();
    expect(resumirTituloDeSesion("   ")).toBeNull();
  });

  it("`recortado` dice la verdad: solo es true si se perdió algo", () => {
    expect(resumirTituloDeSesion(REALES.soloNumero)!.recortado).toBe(false);
    expect(resumirTituloDeSesion(REALES.dosTemas)!.recortado).toBe(true);
    expect(resumirTituloDeSesion(REALES.dobleCorta)!.recortado).toBe(true);
  });

  it("todos los títulos reales quedan dentro del tope", () => {
    for (const t of Object.values(REALES)) {
      const r = resumirTituloDeSesion(t)!;
      expect(r.corto.length).toBeLessThanOrEqual(TOPE_TITULO_SESION + 1);
      expect(r.corto.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("encabezadoDeCurso", () => {
  it("no repite el grupo cuando el nombre del curso ya lo trae", () => {
    expect(encabezadoDeCurso("Introduccion a la Ingenieria-2026-2-SB141C", "SB141C")).toBe(
      "Introduccion a la Ingenieria-2026-2-SB141C",
    );
  });

  it("lo agrega cuando no está", () => {
    expect(encabezadoDeCurso("Estructuras de Datos", "LB141F")).toBe(
      "Estructuras de Datos · LB141F",
    );
  });

  it("compara sin importar la caja", () => {
    expect(encabezadoDeCurso("Redes-2026-2-sb141c", "SB141C")).toBe("Redes-2026-2-sb141c");
  });

  it("aguanta que falte cualquiera de los dos", () => {
    expect(encabezadoDeCurso("Redes", null)).toBe("Redes");
    expect(encabezadoDeCurso(null, "SB141C")).toBe("SB141C");
    expect(encabezadoDeCurso(null, null)).toBe("");
  });
});
