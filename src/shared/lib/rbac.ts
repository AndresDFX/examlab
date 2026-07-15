/**
 * Role-based access control mapping for frontend routes.
 *
 * This is a client-side guard layered on top of Supabase RLS: RLS remains the
 * authoritative source of truth (API calls from a forbidden role will be
 * rejected regardless). The guard here gives us a UX redirect rather than
 * showing broken pages.
 *
 * Longest-prefix match wins. Rules are declared in order from most specific
 * to least specific. A rule with `null` roles means "any authenticated user".
 */
import type { AppRole } from "@/hooks/use-auth";

export interface RouteRule {
  prefix: string;
  roles: AppRole[] | null;
}

export const ROUTE_RULES: RouteRule[] = [
  // SuperAdmin tiene acceso a TODO lo de Admin (es dueño de la plataforma,
  // necesita poder hacer soporte cross-tenant) + rutas /app/superadmin.
  { prefix: "/app/superadmin", roles: ["SuperAdmin"] },
  { prefix: "/app/admin", roles: ["Admin", "SuperAdmin"] },
  // `/app/teacher/contents` se relaja a Admin/SuperAdmin además de
  // Docente — el módulo de Contenidos genera material pedagógico
  // (PPTX/MD) que el Admin de la institución también necesita gestionar
  // (revisar lo que producen sus docentes, ajustar prompts/branding,
  // crear contenidos templated propios). Longest-prefix match: esta
  // regla gana sobre `/app/teacher`. La ruta vive bajo
  // /app/teacher/* solo por historia; mover el path implicaría
  // routeTree.gen.ts + breaking links externos.
  { prefix: "/app/teacher/contents", roles: ["Docente", "Admin", "SuperAdmin"] },
  // Tablero del curso (página, ex-modal CourseBoardDialog): se abre desde el
  // grid de cursos tanto del Docente como del Admin/SA — los tres pasan.
  { prefix: "/app/teacher/board", roles: ["Docente", "Admin", "SuperAdmin"] },
  // `/app/teacher/whiteboards` y `/app/teacher/polls` también relajados
  // a SuperAdmin para que pueda revisarlos cross-tenant (paridad con
  // contents). RLS filtra por owner_id / course visibility — el SA solo
  // ve lo que la RLS le permite. Sin esto el SA navegaba al módulo
  // (porque el NAV lo muestra) pero el guard de ruta lo mandaba a
  // /app/unauthorized.
  { prefix: "/app/teacher/whiteboards", roles: ["Docente", "SuperAdmin"] },
  { prefix: "/app/teacher/polls", roles: ["Docente", "SuperAdmin"] },
  // Resto de módulos /app/teacher/* expuestos al SuperAdmin via NAV
  // (roles incluyen "SuperAdmin" en src/shared/components/AppLayout.tsx).
  // Sin estas reglas el sidebar muestra el ítem pero el guard redirige a
  // /app/unauthorized — bug HIGH detectado en auditoría 2026-09. La RLS
  // de cada tabla filtra qué ve el SA cross-tenant; acá solo abrimos el
  // path. `/teacher/monitor` y `/teacher/grading` son subrutas de exams
  // y gradebook respectivamente — acompañan al padre.
  // Banco de preguntas: Docente + Admin + SuperAdmin (homologado con
  // /app/teacher/contents). La página tiene branch `isAdminLike` y la RLS de
  // question_bank admite Admin; sin Admin acá el guard lo mandaba a
  // /app/unauthorized pese a estar el código preparado para él.
  { prefix: "/app/teacher/question-bank", roles: ["Docente", "Admin", "SuperAdmin"] },
  // Admin homologado (evaluación + seguimiento): supervisa exámenes,
  // talleres, proyectos, calificaciones y asistencia de su institución +
  // los sub-flujos (monitor en vivo, calificación de entregas). Las páginas
  // ya usan isStaffRole y la RLS scopea por tenant. Calendario y kahoot
  // quedan fuera del alcance elegido.
  { prefix: "/app/teacher/exams", roles: ["Docente", "Admin", "SuperAdmin"] },
  { prefix: "/app/teacher/monitor", roles: ["Docente", "Admin", "SuperAdmin"] },
  { prefix: "/app/teacher/workshops", roles: ["Docente", "Admin", "SuperAdmin"] },
  { prefix: "/app/teacher/projects", roles: ["Docente", "Admin", "SuperAdmin"] },
  { prefix: "/app/teacher/gradebook", roles: ["Docente", "Admin", "SuperAdmin"] },
  { prefix: "/app/teacher/grading", roles: ["Docente", "Admin", "SuperAdmin"] },
  { prefix: "/app/teacher/attendance", roles: ["Docente", "Admin", "SuperAdmin"] },
  { prefix: "/app/teacher/calendar", roles: ["Docente", "SuperAdmin"] },
  { prefix: "/app/teacher/kahoot", roles: ["Docente", "SuperAdmin"] },
  { prefix: "/app/teacher", roles: ["Docente"] },
  { prefix: "/app/student", roles: ["Estudiante"] },
  // Rutas comunes que NO deben ser accesibles por Estudiante (el alumno
  // tiene su propia versión bajo /app/student/*). Sin estas reglas, el
  // fallback `/app` (null = any auth) deja entrar al alumno por URL
  // directa. La RLS recortaría datos pero defensa-en-profundidad es lo
  // correcto. ModuleGuard también frena por `module=videos|certificates`
  // si el toggle del Estudiante está apagado, pero el rule explícito gana.
  { prefix: "/app/videos", roles: ["Docente", "Admin", "SuperAdmin"] },
  { prefix: "/app/certificates", roles: ["Docente", "Admin", "SuperAdmin"] },
  // Papelera: solo staff. El alumno no tiene capacidad de borrar las
  // entidades soft-deletadas, así que la UI no le aplica. SuperAdmin la
  // ve heredada de Admin (mismo patrón que /app/admin).
  { prefix: "/app/trash", roles: ["Docente", "Admin", "SuperAdmin"] },
  // Soporte (PQRS): canal Admin↔SuperAdmin. La ruta del Admin vive
  // bajo /app/admin/support (cubierta por la regla genérica /app/admin
  // más arriba que ya incluye Admin+SuperAdmin). La del SuperAdmin
  // vive bajo /app/superadmin/support (cubierta por /app/superadmin
  // que ya es SA-only). No requiere reglas adicionales acá — el match
  // longest-prefix las resuelve correctamente.
  // Asistente IA de plataforma: ayuda de USO de la app, para TODOS los roles.
  { prefix: "/app/assistant", roles: null },
  { prefix: "/app/unauthorized", roles: null },
  { prefix: "/app", roles: null },
];

/** Matches the longest prefix in ROUTE_RULES. */
export function findRouteRule(pathname: string): RouteRule | null {
  let best: RouteRule | null = null;
  for (const r of ROUTE_RULES) {
    if (pathname === r.prefix || pathname.startsWith(r.prefix + "/") || pathname === r.prefix) {
      if (!best || r.prefix.length > best.prefix.length) best = r;
    }
  }
  return best;
}

/**
 * `null` → access granted.
 * string → redirect target (either `/app/unauthorized` or the user's home).
 */
export function checkAccess(
  pathname: string,
  activeRole: AppRole | null,
  allRoles: AppRole[],
): string | null {
  const rule = findRouteRule(pathname);
  if (!rule || rule.roles === null) return null;
  if (!activeRole) return "/auth";
  if (rule.roles.includes(activeRole)) return null;
  // The active role doesn't match — can the user switch to a role that would?
  const compatible = allRoles.find((r) => rule.roles!.includes(r));
  if (compatible) {
    // Their multi-role shell can still reach it; send to unauthorized with a hint.
    return "/app/unauthorized";
  }
  return "/app/unauthorized";
}

/** Default landing for a role (used after login and on unauthorized fallback). */
export function homeForRole(role: AppRole | null): string {
  switch (role) {
    case "Admin":
    case "Docente":
    case "Estudiante":
    case "SuperAdmin":
      return "/app";
    default:
      return "/auth";
  }
}
