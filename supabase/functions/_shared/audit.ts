// Helper compartido para escribir a `audit_logs` desde edge functions.
//
// Las edge functions corren con service_role o sin auth — no pueden usar
// el RPC `log_audit_event` (que depende de auth.uid()). Acá insertamos
// directo a la tabla con el adminClient, recreando los campos que la
// RPC autocompletaría (actor_email, actor_role).
//
// Best-effort: nunca lanza. Si la inserción falla, lo logueamos y
// seguimos — la auditoría no debe romper el flujo principal.

import { createClient } from "npm:@supabase/supabase-js@2.45.0";

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
  /** Tenant al que pertenece este evento. Si no se pasa, intentamos
   *  resolverlo desde el actorId (`profiles.tenant_id`). Si tampoco, va
   *  NULL — y SOLO el SuperAdmin podrá verlo (mig 20260528010000
   *  endureció la RLS para que `tenant_id IS NULL` NO sea visible al
   *  Admin del tenant). Pasarlo explícito cuando la edge opera sobre un
   *  tenant distinto al del actor — caso típico: SuperAdmin haciendo
   *  bulk import a un tenant específico. */
  tenantId?: string | null;
}

export async function auditFromEdge(admin: AdminClient, p: AuditFromEdgeParams): Promise<void> {
  try {
    let actor_email: string | null = p.actorEmailFallback ?? null;
    let actor_role: string | null = null;
    let resolved_tenant_id: string | null = p.tenantId ?? null;
    if (p.actorId) {
      const { data: u } = await admin.auth.admin.getUserById(p.actorId);
      actor_email = u?.user?.email ?? actor_email;
      const { data: r } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", p.actorId)
        .maybeSingle();
      actor_role = (r as { role?: string } | null)?.role ?? null;
      // Fallback de tenant: si no llegó explícito, lo resolvemos desde
      // el profile del actor. Esto es lo que el trigger DB hacía antes
      // pero falla cuando la edge corre como service_role (auth.uid()
      // es NULL en ese contexto).
      if (resolved_tenant_id == null) {
        const { data: prof } = await admin
          .from("profiles")
          .select("tenant_id")
          .eq("id", p.actorId)
          .maybeSingle();
        resolved_tenant_id = (prof as { tenant_id?: string | null } | null)?.tenant_id ?? null;
      }
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
      tenant_id: resolved_tenant_id,
    });
  } catch (e) {
    console.warn("[audit] insert failed", (e as Error).message);
  }
}
