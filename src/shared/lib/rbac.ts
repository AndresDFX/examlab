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
  { prefix: "/app/teacher", roles: ["Docente"] },
  { prefix: "/app/student", roles: ["Estudiante"] },
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
