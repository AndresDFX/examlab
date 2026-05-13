import { describe, expect, it } from "vitest";
import {
  CONTENT_PROMPT_USE_CASES,
  isContentPromptUseCase,
  resolveAllContentPrompts,
  resolveContentPrompt,
  sanitizeContentPromptOverrides,
  type ContentPromptOverrides,
  type ContentPromptUseCase,
} from "./content-prompts";

describe("resolveContentPrompt — jerarquía", () => {
  it("override (no vacío) gana sobre global y fallback", () => {
    expect(resolveContentPrompt("OVERRIDE", "GLOBAL", "FALLBACK")).toBe("OVERRIDE");
  });

  it("global gana cuando override es null", () => {
    expect(resolveContentPrompt(null, "GLOBAL", "FALLBACK")).toBe("GLOBAL");
  });

  it("global gana cuando override es undefined", () => {
    expect(resolveContentPrompt(undefined, "GLOBAL", "FALLBACK")).toBe("GLOBAL");
  });

  it("global gana cuando override es string vacío", () => {
    expect(resolveContentPrompt("", "GLOBAL", "FALLBACK")).toBe("GLOBAL");
  });

  it("global gana cuando override es solo whitespace", () => {
    expect(resolveContentPrompt("   \n\t  ", "GLOBAL", "FALLBACK")).toBe("GLOBAL");
  });

  it("fallback gana cuando override y global son null", () => {
    expect(resolveContentPrompt(null, null, "FALLBACK")).toBe("FALLBACK");
  });

  it("fallback gana cuando override y global son vacíos", () => {
    expect(resolveContentPrompt("", "  ", "FALLBACK")).toBe("FALLBACK");
  });

  it("string vacío cuando los tres son inválidos", () => {
    expect(resolveContentPrompt(null, undefined, "")).toBe("");
  });

  it("override con un solo caracter no-whitespace cuenta como válido", () => {
    expect(resolveContentPrompt("X", "GLOBAL", "FALLBACK")).toBe("X");
  });
});

describe("isContentPromptUseCase", () => {
  it("acepta los 6 use cases válidos", () => {
    for (const k of CONTENT_PROMPT_USE_CASES) {
      expect(isContentPromptUseCase(k)).toBe(true);
    }
  });

  it("rechaza use cases de otros módulos", () => {
    expect(isContentPromptUseCase("workshop_full")).toBe(false);
    expect(isContentPromptUseCase("exam_question")).toBe(false);
    expect(isContentPromptUseCase("project_full")).toBe(false);
  });

  it("rechaza strings desconocidos", () => {
    expect(isContentPromptUseCase("random")).toBe(false);
    expect(isContentPromptUseCase("")).toBe(false);
    expect(isContentPromptUseCase("content_generation ")).toBe(false); // trailing space
  });

  it("expone exactamente los 6 use cases esperados", () => {
    expect(CONTENT_PROMPT_USE_CASES).toEqual([
      "content_generation",
      "content.presentacion",
      "content.guia_docente",
      "content.taller_practico",
      "content.ejercicio",
      "content.examen",
    ]);
  });
});

describe("sanitizeContentPromptOverrides", () => {
  it("retorna {} para null/undefined", () => {
    expect(sanitizeContentPromptOverrides(null)).toEqual({});
    expect(sanitizeContentPromptOverrides(undefined)).toEqual({});
  });

  it("retorna {} para objeto vacío", () => {
    expect(sanitizeContentPromptOverrides({})).toEqual({});
  });

  it("preserva keys válidas con strings no vacíos", () => {
    const result = sanitizeContentPromptOverrides({
      content_generation: "custom orchestrator",
      "content.presentacion": "custom pres",
    });
    expect(result).toEqual({
      content_generation: "custom orchestrator",
      "content.presentacion": "custom pres",
    });
  });

  it("descarta keys de otros módulos (defensa en profundidad)", () => {
    const result = sanitizeContentPromptOverrides({
      content_generation: "valid",
      workshop_full: "should be dropped",
      exam_question: "also dropped",
    });
    expect(result).toEqual({ content_generation: "valid" });
  });

  it("descarta valores no-string", () => {
    const result = sanitizeContentPromptOverrides({
      content_generation: 123 as unknown as string,
      "content.presentacion": null as unknown as string,
      "content.guia_docente": { nested: "obj" } as unknown as string,
      "content.examen": "valid",
    });
    expect(result).toEqual({ "content.examen": "valid" });
  });

  it("descarta strings vacíos y whitespace-only", () => {
    const result = sanitizeContentPromptOverrides({
      content_generation: "",
      "content.presentacion": "   ",
      "content.guia_docente": "\n\t",
      "content.examen": "real value",
    });
    expect(result).toEqual({ "content.examen": "real value" });
  });

  it("es idempotente — aplicar dos veces da el mismo resultado", () => {
    const raw = {
      content_generation: "valid",
      "content.examen": "  ",
      workshop_full: "drop",
    };
    const once = sanitizeContentPromptOverrides(raw);
    const twice = sanitizeContentPromptOverrides(once);
    expect(once).toEqual(twice);
  });
});

describe("resolveAllContentPrompts", () => {
  it("resuelve todos los 6 use cases en una pasada", () => {
    const overrides: ContentPromptOverrides = {
      content_generation: "OVR-orch",
      "content.examen": "OVR-exam",
    };
    const globals: Partial<Record<ContentPromptUseCase, string>> = {
      content_generation: "GLB-orch",
      "content.presentacion": "GLB-pres",
      "content.guia_docente": "GLB-guia",
      "content.taller_practico": "GLB-taller",
      "content.ejercicio": "GLB-ejer",
      "content.examen": "GLB-exam",
    };
    const fallbacks = {} as Partial<Record<ContentPromptUseCase, string>>;
    const out = resolveAllContentPrompts(overrides, globals, fallbacks);
    expect(out.content_generation).toBe("OVR-orch"); // override gana
    expect(out["content.presentacion"]).toBe("GLB-pres"); // global gana
    expect(out["content.examen"]).toBe("OVR-exam"); // override gana
    expect(out["content.guia_docente"]).toBe("GLB-guia");
    expect(out["content.taller_practico"]).toBe("GLB-taller");
    expect(out["content.ejercicio"]).toBe("GLB-ejer");
  });

  it("cae a fallback cuando override y global están ausentes", () => {
    const fallbacks: Partial<Record<ContentPromptUseCase, string>> = {
      content_generation: "FB-orch",
      "content.examen": "FB-exam",
    };
    const out = resolveAllContentPrompts(null, {}, fallbacks);
    expect(out.content_generation).toBe("FB-orch");
    expect(out["content.examen"]).toBe("FB-exam");
  });

  it("devuelve string vacío cuando las tres fuentes están ausentes", () => {
    const out = resolveAllContentPrompts(null, {}, {});
    for (const k of CONTENT_PROMPT_USE_CASES) {
      expect(out[k]).toBe("");
    }
  });

  it("acepta overrides null sin romper", () => {
    const out = resolveAllContentPrompts(
      null,
      { content_generation: "GLB" },
      { content_generation: "FB" },
    );
    expect(out.content_generation).toBe("GLB");
  });

  it("acepta overrides undefined sin romper", () => {
    const out = resolveAllContentPrompts(
      undefined,
      { content_generation: "GLB" },
      { content_generation: "FB" },
    );
    expect(out.content_generation).toBe("GLB");
  });

  it("override whitespace-only NO gana — cae al global", () => {
    const out = resolveAllContentPrompts(
      { content_generation: "   " },
      { content_generation: "GLB" },
      { content_generation: "FB" },
    );
    expect(out.content_generation).toBe("GLB");
  });
});
