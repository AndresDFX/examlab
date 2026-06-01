/**
 * Edge Function: admin-delete-user
 *
 * Borra COMPLETAMENTE a un usuario:
 *   1. Auth (`auth.users`) — via Admin API.
 *   2. Profile + user_roles + tablas asociadas — cascadean automáticamente
 *      por las FKs `REFERENCES auth.users(id) ON DELETE CASCADE`.
 *
 * Por qué se necesita: antes el frontend hacía `delete from profiles`
 * directo, lo que dejaba la fila huérfana en `auth.users`. Al re-crear
 * un usuario con el mismo email, `check_email_taken` (que también mira
 * `auth.users.email`) reportaba "ya está en uso" aunque el profile no
 * existiera. La única forma de borrar de `auth.users` es con
 * `service_role` — de ahí esta edge.
 *
 * Autorización:
 *   - Admin: puede borrar usuarios de SU MISMO tenant.
 *   - SuperAdmin: puede borrar cualquier usuario excepto otro SuperAdmin
 *     (evita escalación lateral de privilegios — un SA solo puede
 *     destruirse a sí mismo, no a otros SAs).
 *   - Self-delete bloqueado: el caller no puede borrarse a sí mismo
 *     desde esta edge para evitar dejar la institución sin Admin.
 *
 * Body: { userId: string }
 * Response: { ok: true } | { error: string }
 */
import {
  adminClient as admin,
  userClientFromRequest,
  corsHeaders,
  jsonError,
  jsonResponse,
} from "../_shared/admin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method_not_allowed", 405);

  try {
    const userClient = userClientFromRequest(req);
    if (!userClient) return jsonError("No autenticado", 401);
    const { data: u } = await userClient.auth.getUser();
    const caller = u?.user;
    if (!caller) return jsonError("No autenticado", 401);

    // Roles del caller — Admin o SuperAdmin habilitados.
    const { data: callerRoles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id);
    const callerRoleSet = new Set(((callerRoles ?? []) as { role: string }[]).map((r) => r.role));
    const callerIsAdmin = callerRoleSet.has("Admin");
    const callerIsSuperAdmin = callerRoleSet.has("SuperAdmin");
    if (!callerIsAdmin && !callerIsSuperAdmin) {
      return jsonError("Solo Admin o SuperAdmin pueden eliminar usuarios", 403);
    }

    let body: { userId?: string };
    try {
      body = await req.json();
    } catch {
      return jsonError("Body inválido", 400);
    }
    const targetId = body.userId;
    if (!targetId || typeof targetId !== "string") {
      return jsonError("userId requerido", 400);
    }
    if (targetId === caller.id) {
      return jsonError("No puedes eliminar tu propia cuenta desde acá", 400);
    }

    // Roles + tenant del target — para validar autorización.
    const [{ data: targetRoleRows }, { data: targetProfile }] = await Promise.all([
      admin.from("user_roles").select("role").eq("user_id", targetId),
      admin
        .from("profiles")
        .select("tenant_id, full_name, institutional_email")
        .eq("id", targetId)
        .maybeSingle(),
    ]);
    const targetRoleSet = new Set(
      ((targetRoleRows ?? []) as { role: string }[]).map((r) => r.role),
    );

    // SuperAdmin no puede borrar a otro SuperAdmin (escalación lateral).
    if (targetRoleSet.has("SuperAdmin") && !callerIsSuperAdmin) {
      return jsonError("No se puede eliminar a un SuperAdmin", 403);
    }
    if (targetRoleSet.has("SuperAdmin") && callerIsSuperAdmin) {
      return jsonError(
        "No se puede eliminar a otro SuperAdmin desde la UI. Pedile que se elimine a sí mismo o hacelo manualmente desde la DB.",
        403,
      );
    }

    // Admin (no-SA) solo puede borrar usuarios de SU MISMO tenant.
    if (callerIsAdmin && !callerIsSuperAdmin) {
      const { data: callerProf } = await admin
        .from("profiles")
        .select("tenant_id")
        .eq("id", caller.id)
        .maybeSingle();
      const callerTenant = (callerProf as { tenant_id?: string | null } | null)?.tenant_id ?? null;
      const targetTenant =
        (targetProfile as { tenant_id?: string | null } | null)?.tenant_id ?? null;
      if (!callerTenant || !targetTenant || callerTenant !== targetTenant) {
        return jsonError("El usuario pertenece a otra institución", 403);
      }
    }

    // Capturamos el email ANTES de borrar para el audit log final.
    const targetEmail =
      (targetProfile as { institutional_email?: string | null } | null)?.institutional_email ??
      null;
    const targetName = (targetProfile as { full_name?: string | null } | null)?.full_name ?? null;

    // Delete auth.users — cascadea profile + user_roles + todas las
    // tablas con FK `ON DELETE CASCADE` a auth.users(id).
    const { error: delErr } = await admin.auth.admin.deleteUser(targetId);
    if (delErr) {
      console.error("[admin-delete-user] deleteUser failed", delErr);
      return jsonError(`No se pudo eliminar: ${delErr.message ?? "error interno"}`, 500);
    }

    // Audit log — actor = caller, target = el user borrado. Inserta
    // directo (no usa log_audit_event RPC) porque queremos el actor
    // del caller, no auth.uid() del servicio.
    try {
      const actorRole = callerIsSuperAdmin ? "SuperAdmin" : "Admin";
      await admin.from("audit_logs").insert({
        actor_id: caller.id,
        actor_email: caller.email ?? null,
        actor_role: actorRole,
        action: "user.deleted_by_admin",
        category: "user",
        severity: "warning",
        entity_type: "user",
        entity_id: targetId,
        entity_name: targetName ?? targetEmail,
        metadata: {
          target_email: targetEmail,
          target_roles: Array.from(targetRoleSet),
        },
      });
    } catch (_) {
      // No bloqueamos por audit log fallido.
    }

    return jsonResponse({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return jsonError(msg, 500);
  }
});
