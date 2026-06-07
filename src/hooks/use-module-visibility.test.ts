/**
 * Tests del helper `isModuleEnabled` — núcleo del enforcement de
 * permisos por rol del módulo de visibilidad.
 *
 * El comportamiento es:
 *  - Sin rol resoluble → true (no bloquear durante loading).
 *  - Sin fila para el (módulo, rol) → true (default: visible).
 *  - Con fila explícita → respetar `enabled` (true/false).
 *
 * Cambio reciente (refactor "module visibility como permisos"):
 *  Antes el guard usaba `roles.some(...)` — bastaba con que UNO de los
 *  roles del usuario tuviera el módulo habilitado para que pasara. Eso
 *  convertía al panel en "filtro visual del sidebar". Ahora pasamos el
 *  ROL ACTIVO (selector del switcher) y el helper decide en función
 *  solo de ese rol. Estos tests cubren la pureza del helper —
 *  el caller (ModuleGuard) ya pasa el rol correcto.
 */
import { describe, expect, it } from "vitest";
import { isModuleEnabled, type VisibilityMap } from "./use-module-visibility";

describe("isModuleEnabled — defaults", () => {
  it("rol null → true (loading state, no bloquear)", () => {
    expect(isModuleEnabled({}, "exams", null)).toBe(true);
  });

  it("rol undefined → true", () => {
    expect(isModuleEnabled({}, "exams", undefined)).toBe(true);
  });

  it("módulo sin entry en el map → true (default visible)", () => {
    const map: VisibilityMap = {};
    expect(isModuleEnabled(map, "exams", "Estudiante")).toBe(true);
  });

  it("módulo presente pero rol sin entry → true (default per-rol)", () => {
    // El admin solo configuró Docente=true para 'exams'. Estudiante
    // hereda el default true porque no tiene fila explícita.
    const map: VisibilityMap = { exams: { Docente: true } };
    expect(isModuleEnabled(map, "exams", "Estudiante")).toBe(true);
  });
});

describe("isModuleEnabled — toggle explícito", () => {
  it("enabled=true para el rol → true", () => {
    const map: VisibilityMap = { exams: { Estudiante: true } };
    expect(isModuleEnabled(map, "exams", "Estudiante")).toBe(true);
  });

  it("enabled=false para el rol → false (gate aplica)", () => {
    const map: VisibilityMap = { exams: { Estudiante: false } };
    expect(isModuleEnabled(map, "exams", "Estudiante")).toBe(false);
  });

  it("toggle por rol es independiente: Docente=true, Estudiante=false", () => {
    const map: VisibilityMap = {
      exams: { Docente: true, Estudiante: false },
    };
    expect(isModuleEnabled(map, "exams", "Docente")).toBe(true);
    expect(isModuleEnabled(map, "exams", "Estudiante")).toBe(false);
  });

  it("apagado para Admin → Admin TAMBIÉN pierde acceso (sin bypass implícito)", () => {
    // CAMBIO IMPORTANTE: antes el ModuleGuard hacía `roles.includes(
    // 'Admin')` → return children. Ahora respeta el toggle aunque el
    // caller sea Admin. El helper acá es puro: si el admin se apaga el
    // módulo a sí mismo, la decisión queda. La vía de escape es el
    // panel "/app/admin/settings → Módulos" (no togglable).
    const map: VisibilityMap = { exams: { Admin: false } };
    expect(isModuleEnabled(map, "exams", "Admin")).toBe(false);
  });
});

describe("isModuleEnabled — multi-módulo y SuperAdmin", () => {
  it("módulos distintos no interfieren entre sí", () => {
    const map: VisibilityMap = {
      exams: { Estudiante: false },
      attendance: { Estudiante: true },
    };
    expect(isModuleEnabled(map, "exams", "Estudiante")).toBe(false);
    expect(isModuleEnabled(map, "attendance", "Estudiante")).toBe(true);
  });

  it("SuperAdmin puede apagarse su propia columna (mig 20260803000000)", () => {
    // El SuperAdmin existe como columna propia en la matriz. Apagar
    // tenants para SuperAdmin oculta el ítem cross-tenant en su menú.
    const map: VisibilityMap = { tenants: { SuperAdmin: false } };
    expect(isModuleEnabled(map, "tenants", "SuperAdmin")).toBe(false);
    // Y NO afecta a Admin (que de todos modos no tiene esa ruta por RBAC).
    expect(isModuleEnabled(map, "tenants", "Admin")).toBe(true);
  });
});

describe("isModuleEnabled — semántica del nuevo enforcement", () => {
  // Smoke test del flujo real que enforza el guard tras el refactor:
  //
  //   1. Admin desactiva 'exams' para Estudiante en el panel "Módulos".
  //   2. Estudiante intenta abrir /app/student/exams (URL directa).
  //   3. ModuleGuard llama isModuleEnabled(map, 'exams', 'Estudiante').
  //   4. Resultado: false → renderiza "Módulo no disponible".
  //
  // Antes esto solo escondía el ítem del sidebar; con el refactor se
  // cumple el contrato "no solo visual, también permiso".
  it("flujo completo: Admin apaga exams para Estudiante → student bloqueado", () => {
    const map: VisibilityMap = {
      exams: { Admin: true, Docente: true, Estudiante: false },
    };
    expect(isModuleEnabled(map, "exams", "Estudiante")).toBe(false);
    expect(isModuleEnabled(map, "exams", "Docente")).toBe(true);
    expect(isModuleEnabled(map, "exams", "Admin")).toBe(true);
  });

  it("flujo multi-rol: usuario con [Admin, Docente] actuando como Docente respeta el toggle de Docente", () => {
    // El helper en sí no conoce el activeRole — el caller (ModuleGuard)
    // resuelve el rol efectivo y se lo pasa. Este test documenta que el
    // mapeo es puro: si Docente está apagado, el helper devuelve false
    // sin importar qué OTROS roles tenga el usuario.
    const map: VisibilityMap = {
      contents: { Admin: true, Docente: false },
    };
    // Caller pasa "Docente" (activeRole) → false.
    expect(isModuleEnabled(map, "contents", "Docente")).toBe(false);
    // Si el caller pasara "Admin" (cambió el switcher), resolvería true.
    expect(isModuleEnabled(map, "contents", "Admin")).toBe(true);
  });
});
