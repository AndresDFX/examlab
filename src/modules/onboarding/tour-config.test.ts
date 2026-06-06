/**
 * Tests del tour config — validan la integridad estructural de los
 * tours (Admin, Docente, Estudiante).
 *
 * Driver.js es estricto:
 *   - Cada step necesita selector + title + description.
 *   - El selector debe ser CSS válido (no rompemos con typos).
 *   - Los selectores DENTRO de un mismo tour no deben duplicarse
 *     (driver.js avanza por orden, dos steps idénticos confunden).
 *
 * Si el selector no existe en el DOM en runtime, OnboardingTour.tsx
 * lo filtra. Pero acá testamos la consistencia DE CONFIG —
 * no usamos jsdom para verificar elementos reales.
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_TOUR,
  TEACHER_TOUR,
  STUDENT_TOUR,
  getTourForRole,
  type TourStep,
} from "./tour-config";

const TOURS: Array<{ name: string; steps: TourStep[] }> = [
  { name: "ADMIN", steps: ADMIN_TOUR },
  { name: "TEACHER", steps: TEACHER_TOUR },
  { name: "STUDENT", steps: STUDENT_TOUR },
];

describe("tour-config — shape de cada step", () => {
  for (const { name, steps } of TOURS) {
    it(`${name}_TOUR no está vacío`, () => {
      expect(steps.length).toBeGreaterThan(0);
    });

    it(`${name}_TOUR cada step tiene element/title/description`, () => {
      for (const step of steps) {
        expect(typeof step.element).toBe("string");
        expect(step.element.length).toBeGreaterThan(0);
        expect(typeof step.title).toBe("string");
        expect(step.title.length).toBeGreaterThan(0);
        expect(typeof step.description).toBe("string");
        expect(step.description.length).toBeGreaterThan(0);
      }
    });

    it(`${name}_TOUR no tiene selectores duplicados`, () => {
      const selectors = steps.map((s) => s.element);
      const unique = new Set(selectors);
      expect(unique.size).toBe(selectors.length);
    });

    it(`${name}_TOUR selectores son CSS válidos (data-tour-* o id-like)`, () => {
      // Los selectores válidos son `[data-tour-nav="..."]` o
      // `[data-tour-id="..."]`. Si alguien introduce un selector
      // distinto (typo, copy-paste mal), lo atajamos acá.
      const validRe = /^\[data-tour-(nav|id)="[^"]+"\]$/;
      for (const step of steps) {
        expect(step.element).toMatch(validRe);
      }
    });

    it(`${name}_TOUR descriptions caben en popover (<~600 chars HTML)`, () => {
      // Si una description excede ~600 chars de HTML el popover se
      // ve denso y a menudo se sale del viewport en mobile. Mantenerla
      // bajo este límite es regla soft pero importante para UX.
      // 600 incluye tags HTML — el texto plano efectivo es ~350-400.
      for (const step of steps) {
        expect(step.description.length).toBeLessThanOrEqual(600);
      }
    });

    it(`${name}_TOUR side es válido cuando se especifica`, () => {
      const validSides = new Set(["top", "right", "bottom", "left", "over"]);
      for (const step of steps) {
        if (step.side !== undefined) {
          expect(validSides.has(step.side)).toBe(true);
        }
      }
    });

    it(`${name}_TOUR align es válido cuando se especifica`, () => {
      const validAligns = new Set(["start", "center", "end"]);
      for (const step of steps) {
        if (step.align !== undefined) {
          expect(validAligns.has(step.align)).toBe(true);
        }
      }
    });
  }
});

describe("tour-config — getTourForRole", () => {
  it("devuelve el tour correcto por rol", () => {
    expect(getTourForRole("Admin")).toBe(ADMIN_TOUR);
    expect(getTourForRole("Docente")).toBe(TEACHER_TOUR);
    expect(getTourForRole("Estudiante")).toBe(STUDENT_TOUR);
  });
});

describe("tour-config — cobertura de módulos nuevos", () => {
  it("ADMIN_TOUR incluye Papelera", () => {
    const hasTrash = ADMIN_TOUR.some((s) => s.element.includes("/app/trash"));
    expect(hasTrash).toBe(true);
  });

  it("TEACHER_TOUR incluye Papelera", () => {
    const hasTrash = TEACHER_TOUR.some((s) => s.element.includes("/app/trash"));
    expect(hasTrash).toBe(true);
  });

  it("TEACHER_TOUR incluye los módulos académicos clave (cursos, exámenes, talleres, proyectos)", () => {
    const selectors = TEACHER_TOUR.map((s) => s.element).join(" ");
    expect(selectors).toContain("/app/teacher/courses");
    expect(selectors).toContain("/app/teacher/exams");
    expect(selectors).toContain("/app/teacher/workshops");
    expect(selectors).toContain("/app/teacher/projects");
    expect(selectors).toContain("/app/teacher/attendance");
    expect(selectors).toContain("/app/teacher/polls");
    expect(selectors).toContain("/app/teacher/whiteboards");
  });

  it("STUDENT_TOUR incluye los módulos de uso diario (cursos, exámenes, asistencia, calificaciones)", () => {
    const selectors = STUDENT_TOUR.map((s) => s.element).join(" ");
    expect(selectors).toContain("/app/student/courses");
    expect(selectors).toContain("/app/student/exams");
    expect(selectors).toContain("/app/student/grades");
    expect(selectors).toContain("/app/student/attendance");
  });
});

describe("tour-config — descriptions detalladas tienen instrucciones de creación", () => {
  it("TEACHER_TOUR usa <ol> en los pasos críticos (crear examen, taller, proyecto, encuesta, sesión)", () => {
    // Buscar steps de creación CRÍTICOS — los más usados por el docente.
    const criticalPaths = [
      "/app/teacher/exams",
      "/app/teacher/workshops",
      "/app/teacher/projects",
      "/app/teacher/attendance",
      "/app/teacher/polls",
    ];
    for (const path of criticalPaths) {
      const step = TEACHER_TOUR.find((s) => s.element.includes(path));
      expect(step).toBeDefined();
      // Description debe incluir lista ordenada con pasos de creación.
      expect(step?.description).toContain("<ol>");
    }
  });

  it("STUDENT_TOUR usa <ol> en los pasos de entrega (examen, taller, proyecto)", () => {
    const criticalPaths = [
      "/app/student/exams",
      "/app/student/workshops",
      "/app/student/projects",
    ];
    for (const path of criticalPaths) {
      const step = STUDENT_TOUR.find((s) => s.element.includes(path));
      expect(step).toBeDefined();
      expect(step?.description).toContain("<ol>");
    }
  });
});
