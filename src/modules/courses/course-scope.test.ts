import { describe, expect, it } from "vitest";
import { needsTeacherScope, visibleForScopedCourses } from "./course-scope";

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

  // ── Rol activo sin resolver (primer render) ──
  // Acá NO alcanza con "no acotar": un docente puro vería la institución completa
  // durante ese render. Se cae a los roles poseídos, y solo se deja pasar a quien
  // PUEDE ser Admin (para él ver todo es legítimo, y el switcher corrige después).

  it("rol activo nulo + Docente puro → SÍ se acota (no mostrar de más ni un render)", () => {
    expect(needsTeacherScope(null, ["Docente"])).toBe(true);
    expect(needsTeacherScope(undefined, ["Docente"])).toBe(true);
  });

  it("rol activo nulo + Docente que TAMBIÉN es Admin → NO se acota todavía", () => {
    // No se puede saber la intención hasta que el switcher resuelva, y para un
    // Admin ver todo es correcto. Si resuelve en Docente, el caso de arriba manda.
    expect(needsTeacherScope(null, ["Docente", "Admin"])).toBe(false);
  });

  it("rol activo nulo + roles vacíos (auth cargando) → NO se acota", () => {
    // Acotar acá dejaría la pantalla vacía por no saber todavía quién es.
    expect(needsTeacherScope(null, [])).toBe(false);
    expect(needsTeacherScope(null, null)).toBe(false);
  });

  it("roles nulo o vacío con rol activo Docente no revienta y acota", () => {
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

/**
 * Acotar SOLO el Select de curso dejaba una incoherencia peor que el bug: el
 * filtro ofrecía 2 cursos y la tabla de al lado mostraba el contenido de 12. Esto
 * fija cómo se acota la lista de contenido.
 */
describe("visibleForScopedCourses", () => {
  const items = [
    { id: "w1", course_id: "c1" }, // mío por curso ancla
    { id: "w2", course_id: "c9" }, // de otro docente
    { id: "w3", course_id: "c9" }, // de otro, pero COMPARTIDO a mi curso
    { id: "w4", course_id: null }, // sin curso
  ];
  const shared = new Map<string, readonly string[]>([
    ["w2", ["c9"]],
    ["w3", ["c9", "c1"]],
  ]);

  it("scopedIds null (Admin/SA) → no filtra nada", () => {
    expect(visibleForScopedCourses(items, null, shared).map((i) => i.id)).toEqual([
      "w1",
      "w2",
      "w3",
      "w4",
    ]);
  });

  it("el docente ve lo de su curso ancla", () => {
    expect(
      visibleForScopedCourses(items, ["c1"], shared).map((i) => i.id),
    ).toContain("w1");
  });

  it("ve lo COMPARTIDO a su curso aunque el ancla sea de otro (M:N)", () => {
    // Es el caso que un filtro ingenuo por `course_id` escondería: el taller se
    // creó en c9 y se compartió a c1. Perder acceso al propio trabajo es peor
    // que el bug que se está arreglando.
    expect(
      visibleForScopedCourses(items, ["c1"], shared).map((i) => i.id),
    ).toContain("w3");
  });

  it("NO ve lo que no es suyo ni por ancla ni por compartición", () => {
    expect(
      visibleForScopedCourses(items, ["c1"], shared).map((i) => i.id),
    ).not.toContain("w2");
  });

  it("contenido sin curso queda VISIBLE (no se le puede atribuir otro curso)", () => {
    expect(
      visibleForScopedCourses(items, ["c1"], shared).map((i) => i.id),
    ).toContain("w4");
  });

  it("docente SIN cursos: solo lo que no tiene curso", () => {
    expect(visibleForScopedCourses(items, [], shared).map((i) => i.id)).toEqual([
      "w4",
    ]);
  });

  it("sin mapa de comparticiones filtra por el ancla (caso exámenes)", () => {
    expect(
      visibleForScopedCourses(items, ["c9"]).map((i) => i.id),
    ).toEqual(["w2", "w3", "w4"]);
  });

  it("no muta la lista de entrada", () => {
    const src = [{ id: "a", course_id: "c1" }];
    const out = visibleForScopedCourses(src, null);
    out.push({ id: "b", course_id: "c2" });
    expect(src).toHaveLength(1);
  });
});
