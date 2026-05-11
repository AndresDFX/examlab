/**
 * Edge Function: admin-update-password
 * Allows admins to change a user's password via the service role.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Inserta directo en audit_logs porque la RPC `log_audit_event` usa
 * auth.uid() del request actual — pero al hablar como admin queremos
 * registrar al docente/admin caller, NO al target del reset. Capturamos
 * email del caller y el target_user_id va en metadata.
 */
async function auditAdminReset(
  admin: ReturnType<typeof createClient>,
  caller: { id: string; email?: string | null },
  targetUserId: string,
  severity: "info" | "error",
  reason: string | null,
) {
  try {
    const { data: r } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .maybeSingle();
    const { data: target } = await admin.auth.admin.getUserById(targetUserId);
    await admin.from("audit_logs").insert({
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
    const authHeader = req.headers.get("Authorization");
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
      { global: { headers: { Authorization: authHeader ?? "" } } },
    );
    const { data: caller } = await userClient.auth.getUser();
    if (!caller.user) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check admin role
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: roleCheck } = await admin
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
    const { error } = await admin.auth.admin.updateUserById(userId, { password: newPassword });
    if (error) {
      await auditAdminReset(admin, caller.user, userId, "error", error.message);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await auditAdminReset(admin, caller.user, userId, "info", null);
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
