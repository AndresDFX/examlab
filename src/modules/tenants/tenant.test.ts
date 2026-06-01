/**
 * Tests para helpers de tenant.
 *
 * (Los tests de `extractTenantSlugFromPath`, `withTenantPrefix` y
 * `decideTenantUrlAction` se removieron junto con esas funciones tras
 * el rollback del enfoque URL-prefix `/t/<slug>/...` — ver historia en
 * `src/modules/tenants/url.ts`.)
 */
import { describe, it, expect } from "vitest";
import { isValidTenantSlug, slugifyTenantName } from "./tenant";

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

describe("slugifyTenantName", () => {
  it("transforma nombre a slug válido", () => {
    expect(slugifyTenantName("Universidad Antonio Jose Camacho")).toBe(
      "universidad-antonio-jose-camacho",
    );
  });

  it("quita acentos y diacríticos", () => {
    expect(slugifyTenantName("Universidad Bogotá")).toBe("universidad-bogota");
    expect(slugifyTenantName("Antonio Núñez")).toBe("antonio-nunez");
  });

  it("colapsa caracteres no-alfanuméricos a un solo guión", () => {
    expect(slugifyTenantName("hola!!! mundo___xx")).toBe("hola-mundo-xx");
  });

  it("trim de guiones en bordes", () => {
    expect(slugifyTenantName("---hola---")).toBe("hola");
  });

  it("fallback a 'institution' si queda vacío", () => {
    expect(slugifyTenantName("")).toBe("institution");
    expect(slugifyTenantName("!!!")).toBe("institution");
    expect(slugifyTenantName(null)).toBe("institution");
    expect(slugifyTenantName(undefined)).toBe("institution");
  });

  it("cap a 60 chars", () => {
    const long = "a".repeat(100);
    expect(slugifyTenantName(long).length).toBe(60);
  });
});
