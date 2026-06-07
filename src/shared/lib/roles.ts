/**
 * Helpers de chequeo de roles que centralizan el patrón
 * `roles.includes("X") || roles.includes("Y")` que aparece duplicado en
 * decenas de componentes/rutas.
 *
 * Convenciones:
 *   - `isStaffRole(roles)`     = Docente OR Admin OR SuperAdmin.
 *     Usar en páginas/componentes que el "equipo educativo" puede ver
 *     (gradebook, exámenes, talleres, proyectos, asistencia, etc.).
 *     El SA opera cross-tenant y debe poder entrar a las pantallas de
 *     Docente para soporte/diagnóstico — sin SA en el set, recibe
 *     "Necesitas rol Docente" silencioso.
 *
 *   - `isAdminLike(roles)`     = Admin OR SuperAdmin.
 *     Para pantallas de gestión de tenant: Configuración, Usuarios,
 *     Cursos del admin, Auditoría, etc. El SA hereda implícitamente
 *     todo lo del Admin (CLAUDE.md "SuperAdmin hereda nav de Admin").
 *
 *   - `isSuperAdmin(roles)`    = exclusivamente SuperAdmin.
 *     Para gates SA-only (panel `/app/superadmin/*`, RPCs cross-tenant).
 *
 *   - `isStudent(roles)`       = solo Estudiante.
 *     Para gates de la vista del estudiante. NO incluye SA (el SA no
 *     necesita ver la vista del estudiante para soporte; ya hay
 *     herramientas en el admin).
 *
 * Estos helpers son `Readonly<string[]>` -> boolean. No hacen fetch ni
 * dependen de hooks — son puros, testeables aislados.
 */
export type RoleName = string;

export function isSuperAdmin(roles: ReadonlyArray<RoleName>): boolean {
  return roles.includes("SuperAdmin");
}

export function isAdminLike(roles: ReadonlyArray<RoleName>): boolean {
  return roles.includes("Admin") || roles.includes("SuperAdmin");
}

/** Equipo educativo + SA. El SA accede para soporte/diagnóstico. */
export function isStaffRole(roles: ReadonlyArray<RoleName>): boolean {
  return (
    roles.includes("Docente") ||
    roles.includes("Admin") ||
    roles.includes("SuperAdmin")
  );
}

export function isStudent(roles: ReadonlyArray<RoleName>): boolean {
  return roles.includes("Estudiante");
}
