/**
 * Helpers PUROS de permisos para tickets de soporte.
 *
 * La autorización REAL la enforza la RPC `soft_delete_support_ticket`
 * server-side (SECURITY DEFINER, valida creator O is_super_admin) — ver
 * mig 20260913000000. Estos predicados son solo para mostrar/ocultar
 * controles en el UI; nunca son el único gate de seguridad.
 */

export type SupportMode = "admin" | "superadmin";

/**
 * ¿Puede el caller eliminar (soft-delete) este ticket desde el UI?
 *
 * Regla: SuperAdmin puede eliminar cualquiera; el Admin solo el que
 * CREÓ (created_by === currentUserId). Si no hay ticket o no hay
 * usuario logueado, no se muestra el control.
 */
export function canDeleteSupportTicket(params: {
  mode: SupportMode;
  ticketCreatedBy: string | null | undefined;
  currentUserId: string | null | undefined;
}): boolean {
  const { mode, ticketCreatedBy, currentUserId } = params;
  if (mode === "superadmin") return true;
  if (!currentUserId || !ticketCreatedBy) return false;
  return ticketCreatedBy === currentUserId;
}
