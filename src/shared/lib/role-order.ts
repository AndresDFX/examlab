import type { AppRole } from "@/hooks/use-auth";

/**
 * Orden de presentación de los roles en el selector de rol (sidebar).
 * De mayor a menor alcance: SuperAdmin → Admin → Docente → Estudiante.
 *
 * El array `roles` que devuelve useAuth NO garantiza orden (viene del
 * orden de inserción en `user_roles`), así que ordenamos por este índice
 * antes de renderizar — jerárquico, no alfabético.
 */
export const ROLE_ORDER: AppRole[] = ["SuperAdmin", "Admin", "Docente", "Estudiante"];

/**
 * Ordena una lista de roles por ROLE_ORDER. No muta el input. Los roles
 * desconocidos (índice -1) quedan al frente — defensivo, pero la UI los
 * filtra igual al no tener config asociada.
 */
export function sortRolesByDisplay(roles: AppRole[]): AppRole[] {
  return [...roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
}
