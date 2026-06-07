/**
 * Edge function: auth-sso-verify
 *
 * Se invoca DESPUÉS de un login con Google/Microsoft (OAuth de Supabase).
 * Su rol: validar que el email autenticado corresponde a una cuenta YA
 * pre-aprovisionada en la plataforma (creada por un Admin vía bulk-import
 * o el dialog de "Nuevo usuario"). Si NO existe, eliminamos la auth.users
 * recién creada por el flow de OAuth y devolvemos `not_provisioned` — el
 * cliente cierra sesión y muestra el error.
 *
 * Política:
 *  - NUNCA crear cuentas automáticamente desde SSO.
 *  - El admin debe pre-crear al usuario; el SSO solo permite el primer
 *    login si el `institutional_email` ya existe en `profiles`.
 *
 * Casos:
 *  1. profiles.id === auth.user.id → match perfecto, login OK.
 *  2. profiles existe pero con OTRO id (colisión de identidades) →
 *     borrar el auth.user nuevo + responder `duplicate_email`. El usuario
 *     debe entrar con password (la fila vieja sigue intacta) o contactar
 *     al admin para que linkee las identidades.
 *  3. No hay profile para ese email → borrar auth.user + responder
 *     `not_provisioned`.
 *
 * Body: {} (vacío — la identidad sale del JWT en el header Authorization).
 * Response: { ok, profile_id?, tenant_slug?, reason? }
 */
import { adminClient, corsHeaders, userClientFromRequest } from "../_shared/admin.ts";

interface VerifyResponse {
  ok: boolean;
  profile_id?: string;
  tenant_slug?: string | null;
  reason?: "not_provisioned" | "duplicate_email" | "no_email" | "internal";
  message?: string;
}

function jsonRes(payload: VerifyResponse, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Borra el auth.user "huérfano" creado por el flow OAuth cuando no
 * corresponde a un profile pre-aprovisionado. Best-effort: si el delete
 * falla, igual respondemos `ok:false` para que el cliente cierre sesión.
 * El auth.user queda hasta que un admin lo limpie manualmente, pero NO
 * tiene profile → la RLS lo bloquea de cualquier dato.
 */
async function deleteOrphanAuthUser(userId: string): Promise<void> {
  try {
    await adminClient.auth.admin.deleteUser(userId);
  } catch (e) {
    console.warn("[auth-sso-verify] deleteOrphanAuthUser failed:", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const userClient = userClientFromRequest(req);
    if (!userClient) {
      return jsonRes({ ok: false, reason: "internal", message: "No autenticado" }, 401);
    }
    const { data: u } = await userClient.auth.getUser();
    const authUser = u?.user;
    if (!authUser) {
      return jsonRes({ ok: false, reason: "internal", message: "Sesión inválida" }, 401);
    }

    const email = (authUser.email ?? "").trim().toLowerCase();
    if (!email) {
      // SSO sin email no debería pasar (Google/Microsoft siempre lo
      // mandan), pero defensiva: sin email no podemos verificar.
      await deleteOrphanAuthUser(authUser.id);
      return jsonRes({ ok: false, reason: "no_email" });
    }

    // 1) Buscamos un profile con ese email institucional (case-insensitive).
    //    No restringimos por id — primero queremos saber si existe la
    //    cuenta, luego validamos id.
    const { data: profile, error: profErr } = await adminClient
      .from("profiles")
      .select("id, tenant_id, institutional_email")
      .ilike("institutional_email", email)
      .maybeSingle();
    if (profErr && profErr.code !== "PGRST116") {
      // PGRST116 = no rows; el resto es error real.
      return jsonRes(
        { ok: false, reason: "internal", message: `db: ${profErr.message}` },
        500,
      );
    }

    if (!profile) {
      // Caso 3: el SSO trajo un email que NUNCA fue pre-aprovisionado.
      // Borramos la auth.users huérfana para que un retry quede limpio.
      await deleteOrphanAuthUser(authUser.id);
      return jsonRes({
        ok: false,
        reason: "not_provisioned",
        message:
          "Tu cuenta no está registrada en la plataforma. Pídele a un administrador que te cree primero.",
      });
    }

    if (profile.id !== authUser.id) {
      // Caso 2: el email existe en profiles pero con OTRO auth id —
      // el bulk-import creó la fila con auth.id=ABC y ahora OAuth
      // intenta autenticar como auth.id=XYZ. Supabase debería haber
      // linkeado las identidades; si no lo hizo (Identity Linking
      // apagado en el proyecto), borramos la auth nueva.
      await deleteOrphanAuthUser(authUser.id);
      return jsonRes({
        ok: false,
        reason: "duplicate_email",
        message:
          "Tu correo ya tiene una cuenta con contraseña. Entra con tu contraseña o pídele a un admin que vincule el SSO.",
      });
    }

    // Caso 1: match perfecto. Resolvemos el slug del tenant para que
    // el cliente pueda hacer el redirect a /t/<slug>/app si aplica.
    let tenantSlug: string | null = null;
    if (profile.tenant_id) {
      const { data: ten } = await adminClient
        .from("tenants")
        .select("slug")
        .eq("id", profile.tenant_id)
        .maybeSingle();
      tenantSlug = (ten as { slug?: string } | null)?.slug ?? null;
    }
    return jsonRes({ ok: true, profile_id: profile.id, tenant_slug: tenantSlug });
  } catch (e) {
    return jsonRes(
      { ok: false, reason: "internal", message: (e as Error).message },
      500,
    );
  }
});
