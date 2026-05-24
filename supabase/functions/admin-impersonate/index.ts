/**
 * Edge function: admin-impersonate
 *
 * Permite "iniciar sesión como" otro usuario sin conocer su contraseña
 * — útil para diagnosticar problemas reportados desde la perspectiva
 * del usuario afectado. Dos roles autorizados con scopes distintos:
 *
 *   - Admin: puede impersonar a CUALQUIER usuario no-Admin.
 *   - Docente: solo puede impersonar a ESTUDIANTES matriculados en un
 *     curso donde el Docente esté asignado (course_teachers). Esto
 *     evita que un Docente espíe a colegas o a estudiantes de cursos
 *     ajenos.
 *
 * Flujo:
 *   1. Valida que el caller esté autenticado y tenga rol Admin o Docente.
 *   2. Valida que el target NO sea Admin (no se permite impersonar a
 *      otros administradores — evita escalación lateral). Para Docente
 *      también se rechaza si el target es otro Docente.
 *   3. Si el caller es Docente: chequea overlap de cursos (target
 *      enrollado en al menos un curso que el caller enseña).
 *   4. Genera un magic link `type=magiclink` con la Admin API de
 *      Supabase y devuelve el `hashed_token` al cliente. El cliente
 *      llama `auth.verifyOtp({ token_hash, type: 'email' })` para
 *      cambiar de sesión sin redirect.
 *   5. Registra el evento en audit_logs con severidad warning.
 *
 * El cliente es responsable de guardar la sesión original en
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

    // Verificar rol del caller — Admin o Docente.
    const { data: callerRoles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id);
    const callerRoleSet = new Set(
      ((callerRoles ?? []) as { role: string }[]).map((r) => r.role),
    );
    const callerIsAdmin = callerRoleSet.has("Admin");
    const callerIsDocente = callerRoleSet.has("Docente");
    if (!callerIsAdmin && !callerIsDocente) {
      return jsonError("Solo Admin o Docente pueden impersonar usuarios", 403);
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

    // Verificar roles del target.
    const { data: targetRoles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", targetId);
    const targetRoleSet = new Set(
      ((targetRoles ?? []) as { role: string }[]).map((r) => r.role),
    );
    if (targetRoleSet.has("Admin")) {
      return jsonError("No se puede impersonar a otro administrador", 403);
    }
    // Docente solo puede impersonar a ESTUDIANTES — bloqueamos otros
    // Docentes para evitar que un Docente espíe a colegas. Admin sí
    // puede impersonar Docentes (típico para debug).
    if (!callerIsAdmin && targetRoleSet.has("Docente")) {
      return jsonError("Como Docente solo puedes impersonar estudiantes", 403);
    }

    // Si el caller es SOLO Docente (no también Admin), validar overlap
    // de cursos: el target debe estar matriculado en al menos un curso
    // donde el caller esté asignado como course_teachers. Esto evita
    // que un docente impersonar a estudiantes de cursos ajenos.
    if (!callerIsAdmin && callerIsDocente) {
      const { data: callerCourses } = await admin
        .from("course_teachers")
        .select("course_id")
        .eq("user_id", caller.id);
      const callerCourseIds = ((callerCourses ?? []) as { course_id: string }[]).map(
        (r) => r.course_id,
      );
      if (callerCourseIds.length === 0) {
        return jsonError("No tienes cursos asignados", 403);
      }
      const { data: targetEnroll } = await admin
        .from("course_enrollments")
        .select("course_id")
        .eq("user_id", targetId)
        .in("course_id", callerCourseIds);
      const overlapped = (targetEnroll ?? []).length > 0;
      if (!overlapped) {
        return jsonError(
          "El estudiante no está matriculado en ninguno de tus cursos",
          403,
        );
      }
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
    // Acción separada por rol del caller para que el log refleje el
    // scope real — Admin (sin restricción) vs Docente (acotado a sus
    // cursos). El metadata incluye el rol efectivo usado.
    const actorRole = callerIsAdmin ? "admin" : "teacher";
    try {
      await userClient.rpc("log_audit_event", {
        p_action: `${actorRole}.impersonation.start`,
        p_category: "user",
        p_severity: "warning",
        p_entity_type: "user",
        p_entity_id: targetId,
        p_entity_name: fullName ?? targetEmail,
        p_course_id: null,
        p_course_name: null,
        p_metadata: { target_email: targetEmail, actor_role: actorRole },
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
