/**
 * Edge Function: admin-update-email
 *
 * Permite que un Admin (de su tenant) o un SuperAdmin (cross-tenant) cambie el
 * CORREO DE ACCESO (login) de OTRO usuario de forma consistente.
 *
 * Por qué una edge y no un UPDATE directo a profiles:
 *   El correo de login vive en `auth.users.email` (que solo el service_role
 *   puede tocar). El panel admin antes hacía `profiles.update({ institutional_email })`
 *   SIN tocar auth.users.email → el usuario quedaba sin poder iniciar sesión con
 *   el correo "nuevo" (seguía siendo el viejo en auth) y los flujos que matchean
 *   por correo (re-import / SSO) chocaban contra el índice único. Acá cambiamos
 *   la FUENTE DE VERDAD (auth.users.email); el trigger
 *   `tg_sync_profile_institutional_email` (mig 20260939000000) propaga el nuevo
 *   correo a `profiles.institutional_email` automáticamente, en la misma
 *   transacción. Así el cambio queda en TODOS lados sin perder datos.
 */
import { adminClient, corsHeaders, userClientFromRequest } from "../_shared/admin.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function audit(
  caller: { id: string; email?: string | null },
  callerRole: string,
  targetUserId: string,
  targetTenantId: string | null,
  severity: "info" | "error",
  metadata: Record<string, unknown>,
) {
  try {
    await adminClient.from("audit_logs").insert({
      actor_id: caller.id,
      actor_email: caller.email ?? null,
      actor_role: callerRole,
      action: severity === "info" ? "user.email_changed_by_admin" : "user.email_change_by_admin_failed",
      category: "user",
      severity: severity === "info" ? "warning" : "error",
      entity_type: "user",
      entity_id: targetUserId,
      entity_name: (metadata.newEmail as string) ?? null,
      // tenant_id del DESTINO para que el Admin del tenant vea el log (no solo el SA).
      tenant_id: targetTenantId,
      metadata,
    });
  } catch (_) {
    /* best-effort */
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { userId, newEmail } = await req.json();
    const email = typeof newEmail === "string" ? newEmail.trim() : "";
    if (!userId || !email) return json({ error: "userId y newEmail requeridos" }, 400);
    if (!EMAIL_RE.test(email)) return json({ error: "Correo con formato inválido" }, 400);

    // Caller autenticado.
    const userClient = userClientFromRequest(req);
    if (!userClient) return json({ error: "No autenticado" }, 401);
    const { data: caller } = await userClient.auth.getUser();
    if (!caller.user) return json({ error: "No autenticado" }, 401);

    // Rol del caller: Admin (de su tenant) o SuperAdmin (cross-tenant).
    const { data: roleRows } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.user.id)
      .in("role", ["Admin", "SuperAdmin"]);
    const callerRoles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!callerRoles.length) {
      return json({ error: "Solo administradores pueden cambiar el correo de acceso" }, 403);
    }
    const isSuperAdmin = callerRoles.includes("SuperAdmin");

    // Scope por tenant: un Admin solo puede cambiar el correo de usuarios de SU
    // tenant. El SuperAdmin opera cross-tenant.
    const { data: targetProfile } = await adminClient
      .from("profiles")
      .select("tenant_id, institutional_email")
      .eq("id", userId)
      .maybeSingle();
    if (!targetProfile) return json({ error: "Usuario no encontrado" }, 404);
    const targetTenantId = (targetProfile as { tenant_id: string | null }).tenant_id;

    if (!isSuperAdmin) {
      const { data: callerProfile } = await adminClient
        .from("profiles")
        .select("tenant_id")
        .eq("id", caller.user.id)
        .maybeSingle();
      const callerTenant = (callerProfile as { tenant_id: string | null } | null)?.tenant_id ?? null;
      if (!callerTenant || callerTenant !== targetTenantId) {
        return json({ error: "No puedes cambiar el correo de un usuario de otra institución" }, 403);
      }
    }

    // Unicidad: el correo no puede estar tomado por OTRO usuario (revisa
    // auth.users.email + profiles.institutional_email + personal_email).
    const { data: taken } = await adminClient.rpc("check_email_taken", {
      p_email: email,
      p_exclude_user_id: userId,
    });
    if (taken === true) {
      await audit(caller.user, callerRoles[0], userId, targetTenantId, "error", {
        newEmail: email,
        reason: "email_already_taken",
      });
      return json({ error: "Ese correo ya está en uso por otro usuario" }, 409);
    }

    // Cambiar la FUENTE DE VERDAD. `email_confirm: true` lo marca confirmado
    // (es un cambio administrativo, no requiere que el usuario reconfirme).
    // El trigger tg_sync_profile_institutional_email espeja a profiles.
    const { error } = await adminClient.auth.admin.updateUserById(userId, {
      email,
      email_confirm: true,
    });
    if (error) {
      await audit(caller.user, callerRoles[0], userId, targetTenantId, "error", {
        newEmail: email,
        reason: error.message,
      });
      return json({ error: error.message }, 400);
    }

    // Defensa en profundidad: si por cualquier razón el trigger no estuviese
    // aplicado en este entorno, garantizamos la sincronía igual.
    await adminClient
      .from("profiles")
      .update({ institutional_email: email })
      .eq("id", userId);

    await audit(caller.user, callerRoles[0], userId, targetTenantId, "info", {
      newEmail: email,
      previousEmail: (targetProfile as { institutional_email: string | null }).institutional_email ?? null,
    });
    return json({ ok: true });
  } catch (e) {
    return json({ error: (e as Error).message ?? "Error interno" }, 500);
  }
});
