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
import { TOUR_EN } from "./tour-config.en";

const TOURS: Array<{ name: string; steps: TourStep[] }> = [
  { name: "ADMIN", steps: ADMIN_TOUR },
  { name: "TEACHER", steps: TEACHER_TOUR },
  { name: "STUDENT", steps: STUDENT_TOUR },
];

// Paridad EN: OnboardingTour superpone TOUR_EN[role] sobre los steps POR ÍNDICE
// (solo si las longitudes coinciden). Este test rompe si alguien edita un tour
// sin regenerar tour-config.en.ts → obliga a mantener la traducción alineada.
describe("tour-config.en — paridad de longitud con los tours en español", () => {
  const cases: Array<{ role: "Admin" | "Docente" | "Estudiante"; steps: TourStep[] }> = [
    { role: "Admin", steps: ADMIN_TOUR },
    { role: "Docente", steps: TEACHER_TOUR },
    { role: "Estudiante", steps: STUDENT_TOUR },
  ];
  for (const { role, steps } of cases) {
    it(`${role}: TOUR_EN tiene la misma cantidad de steps`, () => {
      expect(TOUR_EN[role]).toBeDefined();
      expect(TOUR_EN[role].length).toBe(steps.length);
    });
    it(`${role}: cada entrada EN tiene title y description no vacíos`, () => {
      for (const s of TOUR_EN[role]) {
        expect(typeof s.title).toBe("string");
        expect(s.title.length).toBeGreaterThan(0);
        expect(typeof s.description).toBe("string");
      }
    });
  }
});

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

    it(`${name}_TOUR selectores son CSS válidos (data-tour-{nav|id|module})`, () => {
      // Selectores válidos: `[data-tour-nav]` (legacy), `[data-tour-id]`
      // (elementos específicos), o `[data-tour-module]` (preferido para
      // items del sidebar — estable contra renombres de path/label).
      const validRe = /^\[data-tour-(nav|id|module)="[^"]+"\]$/;
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
  // Matchear por module_key (preferido) en lugar de path. Los selectores
  // ahora son `[data-tour-module="trash"]` etc. — estables a renombres
  // de path / i18n labels.
  it("ADMIN_TOUR incluye Papelera", () => {
    const hasTrash = ADMIN_TOUR.some((s) => s.element.includes('data-tour-module="trash"'));
    expect(hasTrash).toBe(true);
  });

  it("TEACHER_TOUR incluye Papelera", () => {
    const hasTrash = TEACHER_TOUR.some((s) => s.element.includes('data-tour-module="trash"'));
    expect(hasTrash).toBe(true);
  });

  it("ADMIN_TOUR incluye Cola IA", () => {
    const hasAiCron = ADMIN_TOUR.some((s) => s.element.includes('data-tour-module="ai_cron"'));
    expect(hasAiCron).toBe(true);
  });

  it("TEACHER_TOUR incluye Cola IA", () => {
    const hasAiCron = TEACHER_TOUR.some((s) => s.element.includes('data-tour-module="ai_cron"'));
    expect(hasAiCron).toBe(true);
  });

  it("ADMIN_TOUR incluye el panel de Correos + toggle Bienvenida", () => {
    // Tab Correos del panel de Configuración (kill switch + por categoría).
    const hasEmailTab = ADMIN_TOUR.some((s) =>
      s.element.includes('data-tour-id="settings-email-tab"'),
    );
    // Toggle específico "Bienvenida (nuevos usuarios)" — destacado porque
    // es el único que el Admin típicamente quiere apagar en setups SSO.
    const hasWelcomeKind = ADMIN_TOUR.some((s) =>
      s.element.includes('data-tour-id="email-kind-welcome"'),
    );
    expect(hasEmailTab).toBe(true);
    expect(hasWelcomeKind).toBe(true);
  });

  it("TEACHER_TOUR incluye demo de Subir contenido externo", () => {
    // El refactor 2026-06 expandió "Subir externo" para pedir la misma
    // metadata pedagógica que el flujo IA. El tour lo destaca con un
    // step interactivo que abre el dialog vía clickBefore.
    const uploadDemo = TEACHER_TOUR.find((s) =>
      s.element.includes('data-tour-id="dialog-upload-external"'),
    );
    expect(uploadDemo).toBeDefined();
    expect(uploadDemo?.clickBefore).toBe('[data-tour-id="upload-external-content"]');
  });

  it("TEACHER_TOUR step de sesión usa Hora inicio + Hora fin (no más 'duración')", () => {
    // El form de sesión ahora pide Hora inicio + Hora fin (la duración
    // se calcula sola). El tour debe reflejarlo — si alguien refactoriza
    // el form a otro patrón, este test recuerda actualizar el copy.
    const timeStep = TEACHER_TOUR.find((s) =>
      s.element.includes('data-tour-id="session-field-time"'),
    );
    expect(timeStep).toBeDefined();
    expect(timeStep?.title).toMatch(/Hora.*fin/i);
    expect(timeStep?.description.toLowerCase()).toContain("hora");
    expect(timeStep?.description.toLowerCase()).toContain("fin");
  });

  it("TEACHER_TOUR incluye los módulos académicos clave (cursos, exámenes, talleres, proyectos)", () => {
    const selectors = TEACHER_TOUR.map((s) => s.element).join(" ");
    expect(selectors).toContain('data-tour-module="courses"');
    expect(selectors).toContain('data-tour-module="exams"');
    expect(selectors).toContain('data-tour-module="workshops"');
    expect(selectors).toContain('data-tour-module="projects"');
    expect(selectors).toContain('data-tour-module="attendance"');
    expect(selectors).toContain('data-tour-module="polls"');
    expect(selectors).toContain('data-tour-module="whiteboards"');
  });

  it("STUDENT_TOUR incluye los módulos de uso diario (cursos, exámenes, asistencia, calificaciones)", () => {
    const selectors = STUDENT_TOUR.map((s) => s.element).join(" ");
    expect(selectors).toContain('data-tour-module="courses"');
    expect(selectors).toContain('data-tour-module="exams"');
    expect(selectors).toContain('data-tour-module="grades"');
    expect(selectors).toContain('data-tour-module="attendance"');
  });
});

describe("tour-config — descriptions detalladas tienen instrucciones de creación", () => {
  it("TEACHER_TOUR tiene demo interactivo (clickBefore) para los módulos críticos", () => {
    // Antes el test verificaba `<ol>` en el step del nav. Refactor:
    // los pasos de "cómo crear X" se movieron a sub-steps interactivos
    // que abren el dialog real con clickBefore + apuntan a campos
    // específicos. Ahora verificamos que cada módulo crítico tenga al
    // menos un step con clickBefore apuntando a su botón "Nuevo X".
    const criticalCreators = [
      "create-exam",
      "create-workshop",
      "create-project",
      "create-session",
      "create-poll",
    ];
    for (const creator of criticalCreators) {
      const demoStep = TEACHER_TOUR.find((s) =>
        s.clickBefore?.includes(`data-tour-id="${creator}"`),
      );
      expect(demoStep, `falta demo interactivo para ${creator}`).toBeDefined();
      // El demo step debe apuntar al dialog correspondiente y traer waitMs
      // suficiente para que React monte el dialog tras el click.
      expect(demoStep?.element).toContain("dialog-");
    }
  });

  it("STUDENT_TOUR usa <ol> en los pasos de entrega (examen, taller, proyecto)", () => {
    const criticalModules = ["exams", "workshops", "projects"];
    for (const mod of criticalModules) {
      const step = STUDENT_TOUR.find((s) => s.element.includes(`data-tour-module="${mod}"`));
      expect(step).toBeDefined();
      expect(step?.description).toContain("<ol>");
    }
  });
});
