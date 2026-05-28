/**
 * Control de acceso del estudiante según su `estado` académico.
 *
 * El campo `profiles.estado` (activo / retirado / graduado / aplazado /
 * null) era SOLO metadato para actas/reportes. Acá lo convertimos en una
 * regla de acceso:
 *   - retirado | aplazado → `blocked`: no puede usar la plataforma
 *     (AppLayout muestra una pantalla bloqueante + cierra sesión).
 *   - graduado            → `readonly`: puede ver (certificados, notas)
 *     pero no crear nuevas entregas/exámenes (gate server-side por RLS
 *     `student_can_write`).
 *   - activo | null       → `full`: acceso normal.
 *
 * SOLO aplica a estudiantes "puros". Cualquier rol de staff
 * (Admin/Docente/SuperAdmin) nunca se bloquea por estado académico —
 * esos perfiles tienen `estado = null` de todos modos, pero el guard de
 * rol es explícito para evitar sorpresas si alguien combina roles.
 *
 * El enforcement REAL de escritura vive en RLS (migración
 * 20260711000000: `is_student_blocked` / `student_can_write` + policies
 * RESTRICTIVE en las tablas de submissions). Este helper es la cara de
 * cliente (UX) — mantener ambas reglas en sync.
 */
import type { AppRole } from "@/hooks/use-auth";

export type StudentAccessLevel = "full" | "readonly" | "blocked";

const STAFF_ROLES: AppRole[] = ["Admin", "Docente", "SuperAdmin"];

export function studentAccessLevel(
  estado: string | null | undefined,
  roles: AppRole[],
): StudentAccessLevel {
  if (roles.some((r) => STAFF_ROLES.includes(r))) return "full";
  if (estado === "retirado" || estado === "aplazado") return "blocked";
  if (estado === "graduado") return "readonly";
  return "full";
}
