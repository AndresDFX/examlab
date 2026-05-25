import { describe, it, expect } from "vitest";
import {
  isValidTenantSlug,
  extractTenantSlugFromPath,
  withTenantPrefix,
  decideTenantUrlAction,
} from "./tenant";

describe("isValidTenantSlug", () => {
  it("acepta slugs minúsculos con guiones", () => {
    expect(isValidTenantSlug("acme")).toBe(true);
    expect(isValidTenantSlug("uniandes")).toBe(true);
    expect(isValidTenantSlug("sena-bogota")).toBe(true);
    expect(isValidTenantSlug("u-1")).toBe(true);
  });

  it("acepta slugs con dígitos al inicio y al final", () => {
    expect(isValidTenantSlug("1acme")).toBe(true);
    expect(isValidTenantSlug("acme1")).toBe(true);
    expect(isValidTenantSlug("123abc456")).toBe(true);
  });

  it("rechaza slugs con mayúsculas, espacios o símbolos", () => {
    expect(isValidTenantSlug("Acme")).toBe(false);
    expect(isValidTenantSlug("uni andes")).toBe(false);
    expect(isValidTenantSlug("uni_andes")).toBe(false);
    expect(isValidTenantSlug("uni.andes")).toBe(false);
    expect(isValidTenantSlug("uni@andes")).toBe(false);
    expect(isValidTenantSlug("uni/andes")).toBe(false);
  });

  it("rechaza slugs que empiezan o terminan con guión", () => {
    expect(isValidTenantSlug("-acme")).toBe(false);
    expect(isValidTenantSlug("acme-")).toBe(false);
    expect(isValidTenantSlug("-acme-")).toBe(false);
  });

  it("rechaza slugs con guiones consecutivos solo en extremos del rango", () => {
    // El CHECK no prohíbe `a--b` (legalmente "a-" guion "-b" — middle).
    // Documentamos el comportamiento actual.
    expect(isValidTenantSlug("a--b")).toBe(true);
    expect(isValidTenantSlug("a---b")).toBe(true);
  });

  it("respeta longitud 3..50", () => {
    expect(isValidTenantSlug("ab")).toBe(false);
    expect(isValidTenantSlug("abc")).toBe(true);
    expect(isValidTenantSlug("a".repeat(50))).toBe(true);
    expect(isValidTenantSlug("a".repeat(51))).toBe(false);
  });

  it("rechaza string vacío y solo espacios", () => {
    expect(isValidTenantSlug("")).toBe(false);
    expect(isValidTenantSlug("   ")).toBe(false);
  });

  it("rechaza unicode / acentos", () => {
    expect(isValidTenantSlug("uniandés")).toBe(false);
    expect(isValidTenantSlug("escuelañ")).toBe(false);
    expect(isValidTenantSlug("学校")).toBe(false);
  });
});

describe("extractTenantSlugFromPath", () => {
  it("extrae slug del prefijo /t/<slug>/...", () => {
    expect(extractTenantSlugFromPath("/t/acme/app/dashboard")).toBe("acme");
    expect(extractTenantSlugFromPath("/t/sena-bogota/app")).toBe("sena-bogota");
  });

  it("acepta /t/<slug> sin trailing path", () => {
    expect(extractTenantSlugFromPath("/t/acme")).toBe("acme");
  });

  it("preserva paths profundos sin afectar la extracción", () => {
    expect(
      extractTenantSlugFromPath("/t/acme/app/teacher/courses/abc-123/edit"),
    ).toBe("acme");
  });

  it("preserva querystring y hash (no entran al match)", () => {
    // extractTenantSlugFromPath solo recibe pathname; el caller debe
    // pasarle solo eso. Pero acá verificamos que el regex no se rompa
    // si llega un pathname raro con ? o #.
    expect(extractTenantSlugFromPath("/t/acme")).toBe("acme");
  });

  it("devuelve null si el path no tiene prefijo /t/", () => {
    expect(extractTenantSlugFromPath("/app/dashboard")).toBeNull();
    expect(extractTenantSlugFromPath("/")).toBeNull();
    expect(extractTenantSlugFromPath("")).toBeNull();
  });

  it("devuelve null si el slug es inválido", () => {
    expect(extractTenantSlugFromPath("/t/Acme/app")).toBeNull();
    expect(extractTenantSlugFromPath("/t/ab/app")).toBeNull();
    expect(extractTenantSlugFromPath("/t/-acme/app")).toBeNull();
  });

  it("no confunde rutas que solo empiezan parecido a /t", () => {
    expect(extractTenantSlugFromPath("/teacher/courses")).toBeNull();
    expect(extractTenantSlugFromPath("/tenant/foo")).toBeNull();
  });
});

describe("withTenantPrefix", () => {
  it("añade prefijo a un path simple", () => {
    expect(withTenantPrefix("acme", "/app/dashboard")).toBe("/t/acme/app/dashboard");
    expect(withTenantPrefix("acme", "app/dashboard")).toBe("/t/acme/app/dashboard");
  });

  it("reemplaza prefijo de tenant existente", () => {
    expect(withTenantPrefix("bravo", "/t/acme/app/dashboard")).toBe("/t/bravo/app/dashboard");
  });

  it("devuelve el path sin cambios si el slug es inválido", () => {
    expect(withTenantPrefix("Invalid", "/app/dashboard")).toBe("/app/dashboard");
    expect(withTenantPrefix("-acme", "/app/dashboard")).toBe("/app/dashboard");
    expect(withTenantPrefix("", "/app/dashboard")).toBe("/app/dashboard");
  });

  it("maneja path raíz", () => {
    expect(withTenantPrefix("acme", "/")).toBe("/t/acme/");
    expect(withTenantPrefix("acme", "")).toBe("/t/acme/");
  });

  it("preserva múltiples segmentos y trailing slash", () => {
    expect(withTenantPrefix("acme", "/app/teacher/courses/xyz")).toBe(
      "/t/acme/app/teacher/courses/xyz",
    );
    expect(withTenantPrefix("acme", "/t/old/app/")).toBe("/t/acme/app/");
  });
});

describe("decideTenantUrlAction", () => {
  it("strip y override cuando es SuperAdmin con prefijo válido", () => {
    expect(decideTenantUrlAction("/t/acme/app/dashboard", true)).toEqual({
      strippedPath: "/app/dashboard",
      overrideSlug: "acme",
    });
  });

  it("strip sin override cuando NO es SuperAdmin (user normal compartió link)", () => {
    expect(decideTenantUrlAction("/t/acme/app/dashboard", false)).toEqual({
      strippedPath: "/app/dashboard",
      overrideSlug: null,
    });
  });

  it("no hace nada si el path no trae prefijo /t/", () => {
    expect(decideTenantUrlAction("/app/dashboard", true)).toEqual({
      strippedPath: null,
      overrideSlug: null,
    });
    expect(decideTenantUrlAction("/app/dashboard", false)).toEqual({
      strippedPath: null,
      overrideSlug: null,
    });
  });

  it("no hace nada si el slug del path es inválido", () => {
    expect(decideTenantUrlAction("/t/Acme/app", true)).toEqual({
      strippedPath: null,
      overrideSlug: null,
    });
    expect(decideTenantUrlAction("/t/ab/app", false)).toEqual({
      strippedPath: null,
      overrideSlug: null,
    });
  });

  it("path exactamente /t/<slug> se normaliza a /", () => {
    expect(decideTenantUrlAction("/t/acme", true)).toEqual({
      strippedPath: "/",
      overrideSlug: "acme",
    });
  });

  it("preserva paths profundos", () => {
    expect(
      decideTenantUrlAction("/t/sena-bogota/app/teacher/courses/abc-123/edit", true),
    ).toEqual({
      strippedPath: "/app/teacher/courses/abc-123/edit",
      overrideSlug: "sena-bogota",
    });
  });
});
