/**
 * Edge function: admin-impersonate
 *
 * Permite a un Admin "iniciar sesión como" otro usuario (no-Admin) sin
 * conocer su contraseña — útil para diagnosticar problemas reportados
 * desde la perspectiva del usuario afectado.
 *
 * Flujo:
 *   1. Valida que el caller esté autenticado y tenga rol Admin.
 *   2. Valida que el target NO sea Admin (no se permite impersonar a
 *      otros administradores — evita escalación lateral).
 *   3. Genera un magic link `type=magiclink` con la Admin API de
 *      Supabase y devuelve el `hashed_token` al cliente. El cliente
 *      llama `auth.verifyOtp({ token_hash, type: 'email' })` para
 *      cambiar de sesión sin redirect.
 *   4. Registra el evento en audit_logs con severidad warning.
 *
 * El cliente es responsable de guardar la sesión del admin en
 * localStorage ANTES de cambiar de cuenta — para poder restaurarla con
 * `auth.setSession` al "volver".
 *
 * Body: { userId: string }
 * Response: { ok, hashed_token, email, target: { id, full_name, email } }
 */
import { adminClient as admin, userClientFromRequest, corsHeaders, jsonError, jsonResponse } from "../_shared/admin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const userClient = userClientFromRequest(req);
    if (!userClient) return jsonError("No autenticado", 401);

    const { data: u } = await userClient.auth.getUser();
    const caller = u?.user;
    if (!caller) return jsonError("No autenticado", 401);

    // Verificar rol Admin del caller.
    const { data: callerRoles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id);
    const callerIsAdmin = (callerRoles ?? []).some(
      (r: { role: string }) => r.role === "Admin",
    );
    if (!callerIsAdmin) {
      return jsonError("Solo administradores pueden impersonar usuarios", 403);
    }

    // Parsear body.
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
      return jsonError("No puedes impersonarte a ti mismo", 400);
    }

    // Verificar que el target NO sea Admin.
    const { data: targetRoles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", targetId);
    const targetIsAdmin = (targetRoles ?? []).some(
      (r: { role: string }) => r.role === "Admin",
    );
    if (targetIsAdmin) {
      return jsonError("No se puede impersonar a otro administrador", 403);
    }

    // Obtener email del target.
    const { data: targetData, error: targetErr } = await admin.auth.admin.getUserById(targetId);
    if (targetErr || !targetData?.user) {
      return jsonError("Usuario no encontrado", 404);
    }
    const targetEmail = targetData.user.email;
    if (!targetEmail) {
      return jsonError("El usuario no tiene email asociado", 400);
    }

    // Generar magic link. La Admin API devuelve `hashed_token` que el
    // cliente puede consumir con verifyOtp sin necesidad de seguir el
    // redirect (auth UI nunca aparece).
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: targetEmail,
    });
    const hashedToken = linkData?.properties?.hashed_token;
    if (linkErr || !hashedToken) {
      return jsonError(
        `No se pudo generar el link: ${linkErr?.message ?? "respuesta vacía"}`,
        500,
      );
    }

    // Cargar el nombre del target para devolverlo y mostrar en el banner.
    const { data: targetProfile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", targetId)
      .maybeSingle();
    const fullName = (targetProfile as { full_name?: string } | null)?.full_name ?? null;

    // Audit log via RPC (preserva actor_id = caller via auth.uid()).
    try {
      await userClient.rpc("log_audit_event", {
        p_action: "admin.impersonation.start",
        p_category: "user",
        p_severity: "warning",
        p_entity_type: "user",
        p_entity_id: targetId,
        p_entity_name: fullName ?? targetEmail,
        p_course_id: null,
        p_course_name: null,
        p_metadata: { target_email: targetEmail },
      });
    } catch {
      // No bloqueamos el flow por un fallo de audit — log de Lovable lo capturará.
    }

    return jsonResponse({
      ok: true,
      hashed_token: hashedToken,
      email: targetEmail,
      target: {
        id: targetId,
        full_name: fullName,
        email: targetEmail,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return jsonError(msg, 500);
  }
});
