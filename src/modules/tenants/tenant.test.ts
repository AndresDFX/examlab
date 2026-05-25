import { describe, it, expect } from "vitest";
import {
  isValidTenantSlug,
  extractTenantSlugFromPath,
  withTenantPrefix,
} from "./tenant";

describe("isValidTenantSlug", () => {
  it("acepta slugs minúsculos con guiones", () => {
    expect(isValidTenantSlug("acme")).toBe(true);
    expect(isValidTenantSlug("uniandes")).toBe(true);
    expect(isValidTenantSlug("sena-bogota")).toBe(true);
    expect(isValidTenantSlug("u-1")).toBe(true);
  });

  it("rechaza slugs con mayúsculas, espacios o símbolos", () => {
    expect(isValidTenantSlug("Acme")).toBe(false);
    expect(isValidTenantSlug("uni andes")).toBe(false);
    expect(isValidTenantSlug("uni_andes")).toBe(false);
    expect(isValidTenantSlug("uni.andes")).toBe(false);
  });

  it("rechaza slugs que empiezan o terminan con guión", () => {
    expect(isValidTenantSlug("-acme")).toBe(false);
    expect(isValidTenantSlug("acme-")).toBe(false);
  });

  it("respeta longitud 3..50", () => {
    expect(isValidTenantSlug("ab")).toBe(false);
    expect(isValidTenantSlug("abc")).toBe(true);
    expect(isValidTenantSlug("a".repeat(50))).toBe(true);
    expect(isValidTenantSlug("a".repeat(51))).toBe(false);
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

  it("devuelve null si el path no tiene prefijo /t/", () => {
    expect(extractTenantSlugFromPath("/app/dashboard")).toBeNull();
    expect(extractTenantSlugFromPath("/")).toBeNull();
    expect(extractTenantSlugFromPath("")).toBeNull();
  });

  it("devuelve null si el slug es inválido", () => {
    expect(extractTenantSlugFromPath("/t/Acme/app")).toBeNull();
    expect(extractTenantSlugFromPath("/t/ab/app")).toBeNull();
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
  });
});
