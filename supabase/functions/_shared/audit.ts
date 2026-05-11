// Helper compartido para escribir a `audit_logs` desde edge functions.
//
// Las edge functions corren con service_role o sin auth — no pueden usar
// el RPC `log_audit_event` (que depende de auth.uid()). Acá insertamos
// directo a la tabla con el adminClient, recreando los campos que la
// RPC autocompletaría (actor_email, actor_role).
//
// Best-effort: nunca lanza. Si la inserción falla, lo logueamos y
// seguimos — la auditoría no debe romper el flujo principal.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

type AdminClient = ReturnType<typeof createClient>;

export interface AuditFromEdgeParams {
  actorId: string | null;
  /** Para login fallido u otros casos sin user_id. */
  actorEmailFallback?: string | null;
  action: string;
  category:
    | "exam"
    | "workshop"
    | "project"
    | "course"
    | "user"
    | "grading"
    | "fraud"
    | "system"
    | string;
  severity?: "info" | "warning" | "error" | "critical";
  entityType?: string | null;
  entityId?: string | null;
  entityName?: string | null;
  courseId?: string | null;
  courseName?: string | null;
  metadata?: Record<string, unknown>;
}

export async function auditFromEdge(admin: AdminClient, p: AuditFromEdgeParams): Promise<void> {
  try {
    let actor_email: string | null = p.actorEmailFallback ?? null;
    let actor_role: string | null = null;
    if (p.actorId) {
      const { data: u } = await admin.auth.admin.getUserById(p.actorId);
      actor_email = u?.user?.email ?? actor_email;
      const { data: r } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", p.actorId)
        .maybeSingle();
      actor_role = (r as { role?: string } | null)?.role ?? null;
    }
    await admin.from("audit_logs").insert({
      actor_id: p.actorId,
      actor_email,
      actor_role: actor_role ?? "Sistema",
      action: p.action,
      category: p.category,
      severity: p.severity ?? "info",
      entity_type: p.entityType ?? null,
      entity_id: p.entityId ?? null,
      entity_name: p.entityName ?? null,
      course_id: p.courseId ?? null,
      course_name: p.courseName ?? null,
      metadata: p.metadata ?? {},
    });
  } catch (e) {
    console.warn("[audit] insert failed", (e as Error).message);
  }
}
