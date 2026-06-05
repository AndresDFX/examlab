/**
 * Edge function: admin-impersonate
 *
 * Permite "iniciar sesión como" otro usuario sin conocer su contraseña
 * — útil para diagnosticar problemas reportados desde la perspectiva
 * del usuario afectado. Tres roles autorizados con scopes distintos:
 *
 *   - SuperAdmin: puede impersonar a CUALQUIER usuario (Admin, Docente
 *     o Estudiante) de CUALQUIER tenant. Es el único rol cross-tenant
 *     en la plataforma. NO puede impersonar a otro SuperAdmin.
 *   - Admin: puede impersonar a usuarios no-Admin DE SU MISMO TENANT.
 *   - Docente: solo puede impersonar a ESTUDIANTES de su mismo tenant
 *     que estén matriculados en al menos uno de sus cursos
 *     (course_teachers). Esto evita que un Docente espíe a colegas o a
 *     estudiantes de cursos ajenos.
 *
 * Flujo:
 *   1. Valida que el caller esté autenticado y tenga rol SuperAdmin,
 *      Admin o Docente.
 *   2. Valida que el target NO sea SuperAdmin (nunca impersonable) y
 *      que respete las reglas de jerarquía de roles del caller.
 *   3. Si el caller NO es SuperAdmin, valida que caller y target estén
 *      en el MISMO tenant (defensa-en-profundidad sobre la RLS).
 *   4. Si el caller es Docente: chequea overlap de cursos (target
 *      enrollado en al menos un curso que el caller enseña).
 *   5. Genera un magic link `type=magiclink` con la Admin API de
 *      Supabase y devuelve el `hashed_token` al cliente. El cliente
 *      llama `auth.verifyOtp({ token_hash, type: 'email' })` para
 *      cambiar de sesión sin redirect.
 *   6. Registra el evento en audit_logs con severidad warning.
 *
 * El cliente es responsable de guardar la sesión original en
 * localStorage ANTES de cambiar de cuenta — para poder restaurarla con
 * `auth.setSession` al "volver".
 *
 * Body: { userId: string }
 * Response: { ok, hashed_token, email, target: { id, full_name, email } }
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

  try {
    const userClient = userClientFromRequest(req);
    if (!userClient) return jsonError("No autenticado", 401);

    const { data: u } = await userClient.auth.getUser();
    const caller = u?.user;
    if (!caller) return jsonError("No autenticado", 401);

    // Verificar rol del caller — Admin, Docente o SuperAdmin.
    const { data: callerRoles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id);
    const callerRoleSet = new Set(((callerRoles ?? []) as { role: string }[]).map((r) => r.role));
    const callerIsAdmin = callerRoleSet.has("Admin");
    const callerIsDocente = callerRoleSet.has("Docente");
    const callerIsSuperAdmin = callerRoleSet.has("SuperAdmin");
    if (!callerIsAdmin && !callerIsDocente && !callerIsSuperAdmin) {
      return jsonError("Solo SuperAdmin, Admin o Docente pueden impersonar usuarios", 403);
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
    const targetRoleSet = new Set(((targetRoles ?? []) as { role: string }[]).map((r) => r.role));
    // Reglas de impersonación:
    //   - SuperAdmin: puede impersonar Admin/Docente/Estudiante de
    //     cualquier tenant (su rol es cross-tenant; debe poder entrar
    //     "como" cualquier usuario para soporte). NO puede impersonar a
    //     otro SuperAdmin.
    //   - Admin: puede impersonar a no-Admins (y no-SuperAdmins).
    //   - Docente: solo a estudiantes en sus cursos.
    if (targetRoleSet.has("SuperAdmin")) {
      return jsonError("No se puede impersonar a un SuperAdmin", 403);
    }
    if (!callerIsSuperAdmin && targetRoleSet.has("Admin")) {
      return jsonError("No se puede impersonar a otro administrador", 403);
    }
    if (!callerIsAdmin && !callerIsSuperAdmin && targetRoleSet.has("Docente")) {
      return jsonError("Como Docente solo puedes impersonar estudiantes", 403);
    }

    // Aislamiento por tenant: SOLO SuperAdmin opera cross-tenant. Para
    // Admin y Docente exigimos explícitamente que caller y target
    // pertenezcan al mismo tenant. La RLS de course_enrollments / users
    // ya filtra intra-tenant, pero acá agregamos defensa-en-profundidad
    // — fail-closed con error claro en vez de devolver 403 difuso por
    // RLS empty result.
    if (!callerIsSuperAdmin) {
      const [callerProf, targetProf] = await Promise.all([
        admin.from("profiles").select("tenant_id").eq("id", caller.id).maybeSingle(),
        admin.from("profiles").select("tenant_id").eq("id", targetId).maybeSingle(),
      ]);
      const callerTenant =
        (callerProf.data as { tenant_id?: string | null } | null)?.tenant_id ?? null;
      const targetTenant =
        (targetProf.data as { tenant_id?: string | null } | null)?.tenant_id ?? null;
      if (!callerTenant || !targetTenant || callerTenant !== targetTenant) {
        return jsonError("El usuario pertenece a otra institución", 403);
      }
    }

    // Si el caller es SOLO Docente (no también Admin ni SuperAdmin),
    // validar overlap de cursos: el target debe estar matriculado en al
    // menos un curso donde el caller esté asignado como course_teachers.
    // Esto evita que un docente impersone a estudiantes de cursos ajenos.
    if (!callerIsAdmin && !callerIsSuperAdmin && callerIsDocente) {
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
        return jsonError("El estudiante no está matriculado en ninguno de tus cursos", 403);
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
    //
    // Envolvemos en try/catch propio para distinguir tres casos del
    // SDK auth-js que el caller no podía discriminar antes:
    //   1. `linkErr` poblado → Auth devolvió respuesta con error
    //      estructurado (ej. "User not found", "Email rate limit
    //      exceeded"). Devolvemos 502 con el mensaje específico.
    //   2. `generateLink` THROW (no captura como linkErr) → SDK
    //      perdió el detalle. Pasa cuando el rate-limit de Supabase
    //      Auth /admin/generate_link (default ~30/hora por proyecto)
    //      se agota, o cuando el SMTP del proyecto está mal y el
    //      fetch interno hace timeout. Caemos al catch local con
    //      mensaje accionable ("Auth API no respondió: ...").
    //   3. Respuesta vacía sin hash → defensa por si el SDK cambia
    //      contrato. 502 con mensaje "respuesta vacía".
    // Sin este wrapping, el throw burbujeaba al catch global y se
    // mostraba como "Internal server error" plano (caso real
    // reportado por andres_dfx@hotmail.com intentando impersonar a
    // samuel — el usuario veía 500 genérico sin acción posible).
    let linkData: Awaited<ReturnType<typeof admin.auth.admin.generateLink>>["data"] | null = null;
    let linkErr: unknown = null;
    try {
      const result = await admin.auth.admin.generateLink({
        type: "magiclink",
        email: targetEmail,
      });
      linkData = result.data;
      linkErr = result.error;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Auth API no respondió";
      return jsonError(
        `Auth API no respondió: ${msg}. Posibles causas: límite de rate de Auth (≤30 magic-links/hora), ` +
          `cuenta del usuario en estado inválido (no confirmada, baneada o eliminada), o problema temporal de Supabase. ` +
          `Reintentar en unos minutos.`,
        502,
      );
    }
    const hashedToken = linkData?.properties?.hashed_token;
    if (linkErr) {
      const msg = (linkErr as { message?: string })?.message ?? "Error desconocido";
      return jsonError(
        `Auth rechazó generar el link: ${msg}. Verificá que el usuario esté activo y con email confirmado.`,
        502,
      );
    }
    if (!hashedToken) {
      return jsonError("Auth devolvió respuesta sin token (link malformado).", 502);
    }

    // Cargar el nombre + tenant del target para devolverlo. El tenant
    // slug lo devolvemos al cliente para que pueda navegar directo a
    // `/t/<targetSlug>/app` post-verifyOtp — evita que el
    // `TenantUrlGuard` tenga que hacer un segundo hard reload tras la
    // impersonación (causa raíz del "infinite reload" observado).
    const { data: targetProfile } = await admin
      .from("profiles")
      .select("full_name, tenant_id")
      .eq("id", targetId)
      .maybeSingle();
    const fullName = (targetProfile as { full_name?: string } | null)?.full_name ?? null;
    const targetTenantId =
      (targetProfile as { tenant_id?: string | null } | null)?.tenant_id ?? null;
    let targetTenantSlug: string | null = null;
    if (targetTenantId) {
      const { data: tenantRow } = await admin
        .from("tenants")
        .select("slug")
        .eq("id", targetTenantId)
        .maybeSingle();
      targetTenantSlug = (tenantRow as { slug?: string } | null)?.slug ?? null;
    }

    // Audit log via RPC (preserva actor_id = caller via auth.uid()).
    // Acción separada por rol del caller para que el log refleje el
    // scope real — SuperAdmin (cross-tenant), Admin (sin restricción
    // intra-tenant) o Docente (acotado a sus cursos). El metadata
    // incluye el rol efectivo usado.
    const actorRole = callerIsSuperAdmin ? "superadmin" : callerIsAdmin ? "admin" : "teacher";
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
        // Slug del tenant del target (null si es SuperAdmin sin
        // institución). El cliente lo usa para navegar directo a
        // `/t/<slug>/app` post-verifyOtp y evitar el dance de
        // redirects del TenantUrlGuard que causaba el reload loop.
        tenant_slug: targetTenantSlug,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return jsonError(msg, 500);
  }
});
