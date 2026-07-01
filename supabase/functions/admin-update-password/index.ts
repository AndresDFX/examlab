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

    // Check admin role — Admin del tenant o SuperAdmin de plataforma
    const { data: roleCheck } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.user.id)
      .in("role", ["Admin", "SuperAdmin"]);
    if (!roleCheck?.length) {
      return new Response(
        JSON.stringify({ error: "Solo administradores pueden cambiar contraseñas" }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ── Scope de tenant (defensa server-side) ──────────────────────────
    // has_role es GLOBAL: sin este chequeo, un Admin de CUALQUIER institución
    // podía resetear la contraseña de un usuario de OTRA (escalación
    // cross-tenant). El SuperAdmin opera cross-tenant; un Admin solo sobre SU
    // tenant y NUNCA sobre un SuperAdmin. El self-reset (caller === target)
    // pasa trivialmente (mismo perfil/tenant). Mismo patrón que
    // admin-set-user-active / bulk-set-passwords.
    const callerIsSA = roleCheck.some((r: { role: string }) => r.role === "SuperAdmin");
    if (!callerIsSA && caller.user.id !== userId) {
      const [{ data: callerProf }, { data: targetProf }, { data: targetRoles }] =
        await Promise.all([
          adminClient.from("profiles").select("tenant_id").eq("id", caller.user.id).maybeSingle(),
          adminClient.from("profiles").select("tenant_id").eq("id", userId).maybeSingle(),
          adminClient.from("user_roles").select("role").eq("user_id", userId),
        ]);
      const targetIsSA = (targetRoles ?? []).some((r: { role: string }) => r.role === "SuperAdmin");
      if (targetIsSA) {
        return new Response(
          JSON.stringify({ error: "No puedes cambiar la contraseña de un SuperAdmin" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const callerTenant = (callerProf as { tenant_id?: string | null } | null)?.tenant_id ?? null;
      const targetTenant = (targetProf as { tenant_id?: string | null } | null)?.tenant_id ?? null;
      if (!callerTenant || !targetTenant || callerTenant !== targetTenant) {
        return new Response(
          JSON.stringify({ error: "El usuario pertenece a otra institución" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
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

    // Si un Admin reseteó la contraseña de OTRO usuario (no la suya
    // propia), ese usuario debe cambiarla en su próximo inicio de sesión.
    // Cuando el caller resetea SU propia contraseña (self-service desde
    // el perfil) NO forzamos el cambio.
    if (caller.user.id !== userId) {
      await adminClient
        .from("profiles")
        .update({ must_change_password: true })
        .eq("id", userId);

      // Guardar la nueva contraseña temporal en claro para que el Admin/SA
      // pueda re-verla y comunicarla (tabla admin_visible_passwords). RLS
      // acota la lectura a SA / Admin del mismo tenant; la fila se autoborra
      // cuando el usuario cambia su contraseña. Best-effort: no rompemos el
      // reset si falla el guardado.
      const { data: targetProfile } = await adminClient
        .from("profiles")
        .select("tenant_id")
        .eq("id", userId)
        .maybeSingle();
      const { error: avpErr } = await adminClient
        .from("admin_visible_passwords")
        .upsert(
          {
            user_id: userId,
            tenant_id:
              (targetProfile as { tenant_id?: string | null } | null)?.tenant_id ?? null,
            password: newPassword,
            set_by: caller.user.id,
          },
          { onConflict: "user_id" },
        );
      if (avpErr) {
        console.warn("[admin-update-password] store visible password failed:", avpErr.message);
      }
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
