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
