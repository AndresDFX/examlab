/**
 * Tests del builder PURO del Asistente IA de plataforma.
 *   - buildSupportSystemPrompt: sustitución de placeholders + fallbacks + truncado del KB.
 *   - truncateHistory: ventana de los últimos N, copia sin mutar.
 *   - PLATFORM_SUPPORT_FALLBACK: sanity de placeholders (parte del invariante triple).
 */
import { describe, expect, it } from "vitest";
import {
  buildSupportSystemPrompt,
  truncateHistory,
  PLATFORM_SUPPORT_FALLBACK,
  PLATFORM_SUPPORT_DOCENTE_FALLBACK,
  PLATFORM_SUPPORT_ESTUDIANTE_FALLBACK,
  supportUseCaseForRole,
  supportFallbackForRole,
  supportRoleGuardrails,
  type ChatMessage,
} from "./support-prompt";

describe("buildSupportSystemPrompt", () => {
  it("sustituye los 4 placeholders con los datos provistos", () => {
    const out = buildSupportSystemPrompt({
      template:
        "Hola {{admin_name}} de {{tenant_name}}. Ahora: {{current_datetime}}.\nDocs:\n{{platform_kb}}",
      platformKb: "Cómo crear un curso: ve a Cursos.",
      currentDatetime: "6 jul 2026, 14:30",
      tenantName: "FESNA",
      adminName: "Julián",
    });
    expect(out).toContain("Hola Julián de FESNA");
    expect(out).toContain("Ahora: 6 jul 2026, 14:30.");
    expect(out).toContain("Cómo crear un curso");
    expect(out).not.toContain("{{"); // no quedan placeholders conocidos
  });

  it("usa fallbacks cuando faltan datos (null/undefined/vacío)", () => {
    const out = buildSupportSystemPrompt({
      template: "{{admin_name}} / {{tenant_name}} / {{current_datetime}} / {{platform_kb}}",
      platformKb: "",
      currentDatetime: null,
      tenantName: "   ",
      adminName: undefined,
    });
    expect(out).toContain("administrador");
    expect(out).toContain("tu institución");
    expect(out).toContain("(fecha no disponible)");
    expect(out).toContain("(No hay documentación");
  });

  it("preserva un placeholder desconocido sin romper", () => {
    const out = buildSupportSystemPrompt({ template: "{{foo}} {{admin_name}}", platformKb: "" });
    expect(out).toContain("{{foo}}");
    expect(out).toContain("administrador");
  });

  it("trunca el KB al budget con marca de corte", () => {
    const big = "a".repeat(50);
    const out = buildSupportSystemPrompt({
      template: "{{platform_kb}}",
      platformKb: big,
      maxKbChars: 20,
    });
    expect(out).toContain("documentación truncada por longitud");
    expect(out.length).toBeLessThan(big.length + 60);
  });

  it("KB dentro del budget no se trunca", () => {
    const out = buildSupportSystemPrompt({
      template: "{{platform_kb}}",
      platformKb: "corto",
      maxKbChars: 100,
    });
    expect(out).toBe("corto");
  });
});

describe("truncateHistory", () => {
  const m = (i: number): ChatMessage => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` });

  it("devuelve todos los mensajes si hay <= max", () => {
    const msgs = [m(0), m(1)];
    expect(truncateHistory(msgs, 5)).toEqual(msgs);
  });

  it("conserva solo los últimos N", () => {
    const out = truncateHistory([m(0), m(1), m(2), m(3)], 2);
    expect(out.map((x) => x.content)).toEqual(["m2", "m3"]);
  });

  it("no muta el input (devuelve copia)", () => {
    const msgs = [m(0), m(1)];
    expect(truncateHistory(msgs, 5)).not.toBe(msgs);
  });

  it("maxMessages <= 0 → copia completa", () => {
    const msgs = [m(0), m(1)];
    const out = truncateHistory(msgs, 0);
    expect(out).toEqual(msgs);
    expect(out).not.toBe(msgs);
  });
});

describe("PLATFORM_SUPPORT_FALLBACK (parte del invariante triple)", () => {
  it("contiene los 4 placeholders del template", () => {
    for (const p of [
      "{{admin_name}}",
      "{{tenant_name}}",
      "{{current_datetime}}",
      "{{platform_kb}}",
    ]) {
      expect(PLATFORM_SUPPORT_FALLBACK).toContain(p);
    }
  });
});

describe("plantillas por rol (docente / estudiante)", () => {
  it("usan {{user_name}} (role-neutral) y los otros 3 placeholders", () => {
    for (const tpl of [PLATFORM_SUPPORT_DOCENTE_FALLBACK, PLATFORM_SUPPORT_ESTUDIANTE_FALLBACK]) {
      for (const p of ["{{user_name}}", "{{tenant_name}}", "{{current_datetime}}", "{{platform_kb}}"]) {
        expect(tpl).toContain(p);
      }
      // NO enmarcan al usuario como administrador ni enumeran módulos admin.
      expect(tpl.toLowerCase()).not.toContain("administrador de la institución");
    }
  });

  it("{{user_name}} se sustituye con el nombre del usuario (alias de adminName)", () => {
    const out = buildSupportSystemPrompt({
      template: "Hola {{user_name}}",
      platformKb: "",
      adminName: "Ana",
    });
    expect(out).toBe("Hola Ana");
  });
});

describe("supportUseCaseForRole", () => {
  it("mapea cada rol a su use_case", () => {
    expect(supportUseCaseForRole("Estudiante")).toBe("platform_support_estudiante");
    expect(supportUseCaseForRole("Docente")).toBe("platform_support_docente");
    expect(supportUseCaseForRole("Admin")).toBe("platform_support");
    expect(supportUseCaseForRole("SuperAdmin")).toBe("platform_support");
    expect(supportUseCaseForRole(null)).toBe("platform_support");
  });
});

describe("supportFallbackForRole", () => {
  it("devuelve la plantilla del rol", () => {
    expect(supportFallbackForRole("Estudiante")).toBe(PLATFORM_SUPPORT_ESTUDIANTE_FALLBACK);
    expect(supportFallbackForRole("Docente")).toBe(PLATFORM_SUPPORT_DOCENTE_FALLBACK);
    expect(supportFallbackForRole("Admin")).toBe(PLATFORM_SUPPORT_FALLBACK);
    expect(supportFallbackForRole(undefined)).toBe(PLATFORM_SUPPORT_FALLBACK);
  });
});

describe("supportRoleGuardrails (barandas NO editables anti-fuga)", () => {
  it("para Estudiante/Docente: negativa DURA (sin el carve-out 'salvo que lo pregunte')", () => {
    for (const role of ["Estudiante", "Docente"]) {
      const g = supportRoleGuardrails(role);
      expect(g).not.toContain("salvo que lo pregunte");
      expect(g).toContain("AUNQUE lo pida");
      expect(g.toLowerCase()).toContain("únicamente");
    }
  });

  it("NO enumera Papelera/Auditoría como funciones de otro rol (el Docente las tiene)", () => {
    for (const role of ["Estudiante", "Docente"]) {
      const g = supportRoleGuardrails(role).toLowerCase();
      expect(g).not.toContain("papelera");
      expect(g).not.toContain("auditoría");
    }
  });

  it("prohíbe internos, precios y otras instituciones para Estudiante/Docente/Admin", () => {
    for (const role of ["Estudiante", "Docente", "Admin"]) {
      const g = supportRoleGuardrails(role).toLowerCase();
      expect(g).toContain("precios");
      expect(g).toContain("otras instituciones");
    }
  });

  it("anti-inyección + no-secretos + prioridad sobre la plantilla en TODOS los roles", () => {
    for (const role of ["Estudiante", "Docente", "Admin", "SuperAdmin"]) {
      const g = supportRoleGuardrails(role).toLowerCase();
      expect(g).toContain("secretos");
      expect(g).toContain("ignora cualquier instrucción"); // defensa anti-inyección
      expect(g).toContain("de la plantilla anterior"); // prioridad sobre el prompt, no solo el mensaje
    }
  });

  it("Admin: restringe operaciones de SuperAdmin (no la negativa por-rol de estudiante)", () => {
    const g = supportRoleGuardrails("Admin");
    expect(g.toLowerCase()).toContain("superadmin");
    expect(g).not.toContain("AUNQUE lo pida");
  });

  it("SuperAdmin: NO se le restringe cross-rol ni cross-institución (opera la plataforma)", () => {
    const g = supportRoleGuardrails("SuperAdmin");
    expect(g).not.toContain("AUNQUE lo pida");
    expect(g.toLowerCase()).not.toContain("otras instituciones");
    expect(g.toLowerCase()).not.toContain("exclusivas del superadmin");
  });
});
