import { describe, expect, it } from "vitest";
import { needsTeacherScope } from "./course-scope";

/**
 * El bug que estos tests fijan: "desde el rol docente puede ver cursos de los que
 * no es docente".
 *
 * La causa raíz es que los roles de la RLS son POSEÍDOS, no activos: un usuario
 * con Docente + Admin pasa la rama Admin de la policy aunque en la UI esté
 * actuando como Docente. Así que el gate tiene que decidirse por el rol ACTIVO —
 * y eso es justo lo que se testea acá.
 */
describe("needsTeacherScope", () => {
  it("Docente puro → SÍ se acota", () => {
    expect(needsTeacherScope("Docente", ["Docente"])).toBe(true);
  });

  it("Docente + Admin actuando como DOCENTE → SÍ se acota (el caso del reporte)", () => {
    // Es el corazón del bug: posee Admin, así que la RLS lo deja ver todo el
    // tenant. Lo que manda es el rol con el que está actuando.
    expect(needsTeacherScope("Docente", ["Docente", "Admin"])).toBe(true);
  });

  it("Docente + Admin actuando como ADMIN → NO se acota", () => {
    // Mismo usuario, misma pantalla, otra intención: gestionar la institución.
    expect(needsTeacherScope("Admin", ["Docente", "Admin"])).toBe(false);
  });

  it("Admin puro → NO se acota", () => {
    expect(needsTeacherScope("Admin", ["Admin"])).toBe(false);
  });

  it("SuperAdmin NO se acota ni siquiera con rol activo Docente", () => {
    // Opera cross-tenant para soporte; acotarlo lo dejaría sin ver nada útil.
    expect(needsTeacherScope("Docente", ["Docente", "SuperAdmin"])).toBe(false);
    expect(needsTeacherScope("Docente", ["SuperAdmin"])).toBe(false);
  });

  it("Estudiante → NO se acota por esta vía (su alcance sale de la matrícula)", () => {
    expect(needsTeacherScope("Estudiante", ["Estudiante"])).toBe(false);
  });

  it("rol activo nulo (primer render antes de resolver) → NO se acota", () => {
    // Devolver `true` acá haría que la pantalla parpadee vacía mientras el
    // switcher resuelve; la RLS sigue acotando al tenant, así que es seguro.
    expect(needsTeacherScope(null, ["Docente"])).toBe(false);
    expect(needsTeacherScope(undefined, ["Docente"])).toBe(false);
  });

  it("roles nulo o vacío no revienta", () => {
    expect(needsTeacherScope("Docente", null)).toBe(true);
    expect(needsTeacherScope("Docente", undefined)).toBe(true);
    expect(needsTeacherScope("Docente", [])).toBe(true);
  });

  it("es sensible a mayúsculas: 'docente' en minúscula NO es el rol", () => {
    // Los roles del proyecto son 'Docente' / 'Admin' / 'Estudiante' /
    // 'SuperAdmin' con mayúscula inicial. Un match laxo escondería un bug de
    // origen del dato en vez de exponerlo.
    expect(needsTeacherScope("docente", ["Docente"])).toBe(false);
  });
});
