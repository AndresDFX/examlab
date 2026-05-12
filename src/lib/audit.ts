import { supabase } from "@/integrations/supabase/client";

export type AuditCategory =
  | "exam"
  | "workshop"
  | "project"
  | "course"
  | "user"
  | "grading"
  | "fraud"
  | "system";

export type AuditSeverity = "info" | "warning" | "error" | "critical";

export interface LogEventParams {
  action: string;
  category: AuditCategory | string;
  /** Rol del actor — informativo, el servidor lo re-captura del JWT. */
  actorRole?: string;
  severity?: AuditSeverity | string;
  entityType?: string;
  entityId?: string;
  entityName?: string | null;
  courseId?: string | null;
  courseName?: string | null;
  /** Contexto adicional libre, equivalente a `details` en la tabla. */
  metadata?: Record<string, unknown>;
}

/** Registra un evento de auditoría. Fire-and-forget: no await, nunca lanza.
 *  El parámetro de la RPC se llama `p_metadata` (ver migration
 *  20260509150000_audit_logs.sql). Antes este wrapper enviaba `p_details`
 *  por un typo histórico y daba 404 en Supabase publicos (Lovable lo
 *  parcheaba internamente). */
export function logEvent(params: LogEventParams): Promise<void> {
  return (supabase as any)
    .rpc("log_audit_event", {
      p_action:      params.action,
      p_category:    params.category,
      p_severity:    params.severity ?? "info",
      p_entity_type: params.entityType ?? null,
      p_entity_id:   params.entityId  ?? null,
      p_entity_name: params.entityName ?? null,
      p_course_id:   params.courseId  ?? null,
      p_course_name: params.courseName ?? null,
      p_metadata:    params.metadata  ?? {},
    })
    .then(() => {})
    .catch(() => {});
}
