/**
 * Tests para el signal compartido `active-role-signal` que actúa como
 * bridge entre AppLayout (escribe) y TenantThemeProvider (lee/escucha)
 * — viven en distintas ramas del árbol React, por eso usamos un
 * módulo-level signal en lugar de Context.
 *
 * Foco:
 *   - Idempotencia: setear el MISMO valor no notifica.
 *   - Notificación: cambio real notifica a todos los suscriptores.
 *   - Cleanup: el unsubscribe efectivamente remueve el listener.
 *   - Estado inicial: getActiveRoleSignal() devuelve null.
 *   - Persistencia entre llamadas: el último setActiveRoleSignal queda
 *     legible aunque no haya suscriptores activos (importante porque
 *     TenantThemeProvider lee al montar antes de suscribir).
 *   - Múltiples suscriptores reciben la misma notificación.
 *
 * Test isolation: cada test resetea el signal a null al final para no
 * filtrar estado entre tests (los módulos son singletons en Vitest).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  setActiveRoleSignal,
  getActiveRoleSignal,
  subscribeActiveRole,
} from "./active-role-signal";

afterEach(() => {
  // El signal vive a nivel módulo; los tests podrían dejarlo en cualquier
  // estado. Reset a null garantiza independencia entre tests.
  setActiveRoleSignal(null);
});

describe("getActiveRoleSignal", () => {
  it("devuelve null por defecto (antes de cualquier set)", () => {
    expect(getActiveRoleSignal()).toBeNull();
  });

  it("refleja el último valor seteado", () => {
    setActiveRoleSignal("Admin");
    expect(getActiveRoleSignal()).toBe("Admin");
    setActiveRoleSignal("Docente");
    expect(getActiveRoleSignal()).toBe("Docente");
  });
});

describe("setActiveRoleSignal", () => {
  it("notifica al suscriptor cuando cambia el valor", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActiveRole(listener);
    setActiveRoleSignal("Admin");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("Admin");
    unsubscribe();
  });

  it("NO notifica si el valor no cambió (idempotencia)", () => {
    setActiveRoleSignal("Admin");
    const listener = vi.fn();
    const unsubscribe = subscribeActiveRole(listener);
    setActiveRoleSignal("Admin"); // mismo valor
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("notifica en múltiples cambios sucesivos", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActiveRole(listener);
    setActiveRoleSignal("Admin");
    setActiveRoleSignal("Docente");
    setActiveRoleSignal("Estudiante");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenNthCalledWith(1, "Admin");
    expect(listener).toHaveBeenNthCalledWith(2, "Docente");
    expect(listener).toHaveBeenNthCalledWith(3, "Estudiante");
    unsubscribe();
  });

  it("notifica al setear null desde un valor no-null (logout, etc.)", () => {
    setActiveRoleSignal("Admin");
    const listener = vi.fn();
    const unsubscribe = subscribeActiveRole(listener);
    setActiveRoleSignal(null);
    expect(listener).toHaveBeenCalledWith(null);
    unsubscribe();
  });
});

describe("subscribeActiveRole", () => {
  it("devuelve una función de cleanup que remueve el listener", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActiveRole(listener);
    unsubscribe();
    setActiveRoleSignal("Admin");
    expect(listener).not.toHaveBeenCalled();
  });

  it("permite múltiples suscriptores simultáneos", () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const unsubA = subscribeActiveRole(a);
    const unsubB = subscribeActiveRole(b);
    const unsubC = subscribeActiveRole(c);
    setActiveRoleSignal("Admin");
    expect(a).toHaveBeenCalledWith("Admin");
    expect(b).toHaveBeenCalledWith("Admin");
    expect(c).toHaveBeenCalledWith("Admin");
    unsubA();
    unsubB();
    unsubC();
  });

  it("un unsubscribe NO afecta a otros suscriptores", () => {
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = subscribeActiveRole(a);
    const unsubB = subscribeActiveRole(b);
    unsubA();
    setActiveRoleSignal("Docente");
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith("Docente");
    unsubB();
  });

  it("doble unsubscribe es idempotente (no tira)", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActiveRole(listener);
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe("escenario integración: TenantThemeProvider lee + escucha", () => {
  // Simulamos el patrón real: el provider lee el valor inicial con
  // getActiveRoleSignal() y luego suscribe para recibir actualizaciones.
  // Sirve como sanity-check de que el orden lectura→suscripción no pierde
  // eventos.
  it("el provider que monta DESPUÉS de un set ve el último valor", () => {
    setActiveRoleSignal("Admin");
    // Provider monta acá:
    const initial = getActiveRoleSignal();
    expect(initial).toBe("Admin");
    // Y se suscribe para cambios futuros:
    const listener = vi.fn();
    const unsubscribe = subscribeActiveRole(listener);
    setActiveRoleSignal("Docente");
    expect(listener).toHaveBeenCalledWith("Docente");
    unsubscribe();
  });

  it("dos providers diferentes reciben el mismo cambio (caso multi-mount)", () => {
    const provider1 = vi.fn();
    const provider2 = vi.fn();
    const u1 = subscribeActiveRole(provider1);
    const u2 = subscribeActiveRole(provider2);
    setActiveRoleSignal("SuperAdmin");
    expect(provider1).toHaveBeenCalledWith("SuperAdmin");
    expect(provider2).toHaveBeenCalledWith("SuperAdmin");
    u1();
    u2();
  });
});
