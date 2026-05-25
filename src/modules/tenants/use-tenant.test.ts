/**
 * Tests para los helpers de localStorage del hook useTenant.
 *
 * El hook completo es difícil de testear sin pintar un componente
 * (depende de useAuth, Supabase y efectos). Pero los dos helpers
 * `readTenantOverride` / `setTenantOverride` son puros + un side-effect
 * controlado sobre `window.localStorage`, así que los testeamos en
 * jsdom (configurado global en vitest.config.ts).
 *
 * Cubrimos:
 *   - set + read round-trip.
 *   - rechazo de slug inválido al escribir (no se persiste basura).
 *   - rechazo de slug inválido al leer (defense in depth: si alguien
 *     metió un valor inválido directamente en localStorage, devolvemos
 *     null).
 *   - limpieza con null.
 *   - aislamiento entre tests (beforeEach limpia el storage).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readTenantOverride, setTenantOverride } from "./use-tenant";

const OVERRIDE_KEY = "examlab_tenant_override";

describe("setTenantOverride / readTenantOverride", () => {
  beforeEach(() => {
    // Aislamos entre tests — sin esto las assertions dependerían del
    // orden de ejecución.
    window.localStorage.removeItem(OVERRIDE_KEY);
  });

  it("round-trip: set válido → read devuelve el mismo slug", () => {
    setTenantOverride("acme");
    expect(readTenantOverride()).toBe("acme");
  });

  it("round-trip: slug con guion + dígitos", () => {
    setTenantOverride("sena-bogota-2");
    expect(readTenantOverride()).toBe("sena-bogota-2");
  });

  it("setTenantOverride(null) limpia el override", () => {
    setTenantOverride("acme");
    expect(readTenantOverride()).toBe("acme");
    setTenantOverride(null);
    expect(readTenantOverride()).toBeNull();
  });

  it("escribir un slug inválido limpia el override (no persiste basura)", () => {
    setTenantOverride("acme");
    expect(readTenantOverride()).toBe("acme");
    setTenantOverride("INVALID-CAPS");
    expect(readTenantOverride()).toBeNull();
    expect(window.localStorage.getItem(OVERRIDE_KEY)).toBeNull();
  });

  it("escribir slug vacío limpia el override", () => {
    setTenantOverride("acme");
    setTenantOverride("");
    expect(readTenantOverride()).toBeNull();
  });

  it("escribir slug muy corto (< 3) limpia el override", () => {
    setTenantOverride("ab");
    expect(readTenantOverride()).toBeNull();
  });

  it("readTenantOverride rechaza valores inválidos puestos manualmente", () => {
    // Defense in depth: alguien (test, devtools, código viejo) puso un
    // valor inválido directamente. read() lo rechaza.
    window.localStorage.setItem(OVERRIDE_KEY, "InvalidWithCaps");
    expect(readTenantOverride()).toBeNull();
  });

  it("readTenantOverride devuelve null cuando no hay key", () => {
    expect(readTenantOverride()).toBeNull();
  });

  it("readTenantOverride rechaza unicode en el valor stored", () => {
    window.localStorage.setItem(OVERRIDE_KEY, "uniandés");
    expect(readTenantOverride()).toBeNull();
  });

  it("sobreescribir un slug previamente válido con otro válido reemplaza", () => {
    setTenantOverride("acme");
    setTenantOverride("bravo");
    expect(readTenantOverride()).toBe("bravo");
  });
});
