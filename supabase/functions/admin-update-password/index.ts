/**
 * Edge Function: admin-update-password
 * Allows admins to change a user's password via the service role.
 */
import { adminClient, corsHeaders, userClientFromRequest } from "../_shared/admin.ts";

/**
 * Inserta directo en audit_logs porque la RPC `log_audit_event` usa
 * auth.uid() del request actual — pero al hablar como admin queremos
 * registrar al docente/admin caller, NO al target del reset. Capturamos
 * email del caller y el target_user_id va en metadata.
 */
async function auditAdminReset(
  caller: { id: string; email?: string | null },
  targetUserId: string,
  severity: "info" | "error",
  reason: string | null,
) {
  try {
    const { data: r } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .maybeSingle();
    const { data: target } = await adminClient.auth.admin.getUserById(targetUserId);
    await adminClient.from("audit_logs").insert({
      actor_id: caller.id,
      actor_email: caller.email ?? null,
      actor_role: r?.role ?? "Admin",
      action: severity === "info" ? "user.password_reset_by_admin" : "user.password_reset_failed",
      category: "user",
      severity: severity === "info" ? "warning" : "error",
      entity_type: "user",
      entity_id: targetUserId,
      entity_name: target?.user?.email ?? null,
      metadata: reason ? { reason } : {},
    });
  } catch (_) {
    /* best-effort */
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { userId, newPassword } = await req.json();
    if (!userId || !newPassword) {
      return new Response(JSON.stringify({ error: "userId y newPassword requeridos" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (newPassword.length < 8) {
      return new Response(
        JSON.stringify({ error: "La contraseña debe tener al menos 8 caracteres" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Verify the caller is an admin
    const userClient = userClientFromRequest(req);
    if (!userClient) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: caller } = await userClient.auth.getUser();
    if (!caller.user) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check admin role
    const { data: roleCheck } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.user.id)
      .eq("role", "Admin");
    if (!roleCheck?.length) {
      return new Response(
        JSON.stringify({ error: "Solo administradores pueden cambiar contraseñas" }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Update the password
    const { error } = await adminClient.auth.admin.updateUserById(userId, {
      password: newPassword,
    });
    if (error) {
      await auditAdminReset(caller.user, userId, "error", error.message);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await auditAdminReset(caller.user, userId, "info", null);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message ?? "Error interno" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
