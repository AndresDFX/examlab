/**
 * Edge Function: admin-set-user-active
 *
 * Desactiva / reactiva un usuario.
 *   - Desactivar: ban nativo GoTrue (ban_duration) → rechaza el login
 *     (password Y SSO/OAuth) server-side + espeja profiles.is_active=false.
 *     El usuario deja de consumir licencia (tenant_role_count excluye inactivos).
 *   - Reactivar: quita el ban + is_active=true, pero RE-CHEQUEA la cuota de
 *     cada rol del target (la reactivación no pasa por el trigger de user_roles).
 *
 * RLS no alcanza auth.users → service_role (adminClient) + revalidación manual.
 *
 * Autorización (decisiones de producto):
 *   - Caller: Admin (de su tenant) o SuperAdmin.
 *   - No auto-desactivarse (evita lockout).
 *   - Nunca desactivar a un SuperAdmin.
 *   - A un Admin solo lo puede desactivar un SuperAdmin (no otro Admin).
 *   - Admin solo opera sobre usuarios de SU MISMO tenant.
 *
 * Body: { userId: string, active: boolean }
 * Response: { ok: true } | { error: string }
 *
 * Nota de latencia: el ban bloquea login nuevo y refresh de token; el access
 * token vivo del target expira solo (~1h). El gate de AppLayout (is_active=false)
 * bloquea la UI de inmediato en el próximo load/poll del perfil.
 */
import {
  adminClient as admin,
  userClientFromRequest,
  corsHeaders,
  jsonError,
  jsonResponse,
} from "../_shared/admin.ts";

const BAN_DURATION = "876000h"; // ≈100 años
const ROLE_QUOTA_COL: Record<string, string> = {
  Admin: "max_admins",
  Docente: "max_teachers",
  Estudiante: "max_students",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method_not_allowed", 405);

  try {
    const userClient = userClientFromRequest(req);
    if (!userClient) return jsonError("No autenticado", 401);
    const { data: u } = await userClient.auth.getUser();
    const caller = u?.user;
    if (!caller) return jsonError("No autenticado", 401);

    const { data: callerRoles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id);
    const callerRoleSet = new Set(((callerRoles ?? []) as { role: string }[]).map((r) => r.role));
    const callerIsAdmin = callerRoleSet.has("Admin");
    const callerIsSuperAdmin = callerRoleSet.has("SuperAdmin");
    if (!callerIsAdmin && !callerIsSuperAdmin) {
      return jsonError("Solo Admin o SuperAdmin pueden activar/desactivar usuarios", 403);
    }

    let body: { userId?: string; active?: boolean };
    try {
      body = await req.json();
    } catch {
      return jsonError("Body inválido", 400);
    }
    const targetId = body.userId;
    const active = body.active;
    if (!targetId || typeof targetId !== "string") return jsonError("userId requerido", 400);
    if (typeof active !== "boolean") return jsonError("active (boolean) requerido", 400);
    if (targetId === caller.id) {
      return jsonError("No puedes desactivar tu propia cuenta", 400);
    }

    const [{ data: targetRoleRows }, { data: targetProfile }] = await Promise.all([
      admin.from("user_roles").select("role").eq("user_id", targetId),
      admin
        .from("profiles")
        .select("tenant_id, full_name, institutional_email")
        .eq("id", targetId)
        .maybeSingle(),
    ]);
    const targetRoleSet = new Set(((targetRoleRows ?? []) as { role: string }[]).map((r) => r.role));
    const targetTenant = (targetProfile as { tenant_id?: string | null } | null)?.tenant_id ?? null;

    // Nunca tocar a un SuperAdmin.
    if (targetRoleSet.has("SuperAdmin")) {
      return jsonError("No se puede desactivar a un SuperAdmin", 403);
    }
    // A un Admin solo lo desactiva un SuperAdmin.
    if (targetRoleSet.has("Admin") && !callerIsSuperAdmin) {
      return jsonError("Solo un SuperAdmin puede desactivar a un administrador", 403);
    }
    // Admin (no-SA): solo su mismo tenant.
    if (callerIsAdmin && !callerIsSuperAdmin) {
      const { data: callerProf } = await admin
        .from("profiles")
        .select("tenant_id")
        .eq("id", caller.id)
        .maybeSingle();
      const callerTenant = (callerProf as { tenant_id?: string | null } | null)?.tenant_id ?? null;
      if (!callerTenant || !targetTenant || callerTenant !== targetTenant) {
        return jsonError("El usuario pertenece a otra institución", 403);
      }
    }

    if (active) {
      // ── REACTIVAR ── re-chequear cuota por cada rol del target (la
      // reactivación no dispara el trigger de user_roles).
      if (targetTenant) {
        const { data: tenant } = await admin
          .from("tenants")
          .select("max_admins, max_teachers, max_students")
          .eq("id", targetTenant)
          .maybeSingle();
        const t = (tenant ?? {}) as Record<string, number | null>;
        for (const role of targetRoleSet) {
          const col = ROLE_QUOTA_COL[role];
          if (!col) continue;
          const max = t[col];
          if (max == null) continue; // ilimitado
          const { data: cnt } = await admin.rpc("tenant_role_count", {
            _tenant: targetTenant,
            _role: role,
          });
          // El target está inactivo → tenant_role_count NO lo cuenta; reactivar suma 1.
          if (typeof cnt === "number" && cnt >= max) {
            const label =
              role === "Admin" ? "administradores" : role === "Docente" ? "docentes" : "estudiantes";
            return jsonError(
              `No hay cupo de ${label} (${cnt}/${max}). Aumenta el plan o desactiva a otro usuario antes de reactivar.`,
              409,
            );
          }
        }
      }
      const { error: banErr } = await admin.auth.admin.updateUserById(targetId, {
        ban_duration: "none",
      });
      if (banErr) return jsonError(`No se pudo reactivar: ${banErr.message ?? "error"}`, 500);
      await admin
        .from("profiles")
        .update({ is_active: true, deactivated_at: null, deactivated_by: null })
        .eq("id", targetId);
    } else {
      // ── DESACTIVAR ── ban GoTrue (rechaza login/refresh) + espejo profiles.
      const { error: banErr } = await admin.auth.admin.updateUserById(targetId, {
        ban_duration: BAN_DURATION,
      });
      if (banErr) return jsonError(`No se pudo desactivar: ${banErr.message ?? "error"}`, 500);
      await admin
        .from("profiles")
        .update({ is_active: false, deactivated_at: new Date().toISOString(), deactivated_by: caller.id })
        .eq("id", targetId);
    }

    // Auditoría — actor = caller; tenant del DESTINO para que el Admin correcto
    // lo vea bajo la RLS endurecida de audit_logs.
    try {
      await admin.from("audit_logs").insert({
        actor_id: caller.id,
        actor_email: caller.email ?? null,
        actor_role: callerIsSuperAdmin ? "SuperAdmin" : "Admin",
        action: active ? "user.reactivated" : "user.deactivated",
        category: "user",
        severity: "warning",
        entity_type: "user",
        entity_id: targetId,
        entity_name:
          (targetProfile as { full_name?: string | null } | null)?.full_name ??
          (targetProfile as { institutional_email?: string | null } | null)?.institutional_email ??
          null,
        tenant_id: targetTenant,
        metadata: { active, target_roles: Array.from(targetRoleSet) },
      });
    } catch (_) {
      // no bloqueamos por audit fallido
    }

    return jsonResponse({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return jsonError(msg, 500);
  }
});
