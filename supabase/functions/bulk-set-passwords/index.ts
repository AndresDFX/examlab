/**
 * Edge Function: bulk-set-passwords
 *
 * Cambia la MISMA contraseña a VARIOS estudiantes de una sola vez, desde el
 * rol Docente o Administrador (o SuperAdmin). Pensado para repartir una
 * contraseña común en un grupo (ej. al inicio del semestre) con la opción de
 * forzar el cambio en el próximo login.
 *
 * Body: { userIds: string[], newPassword: string, requireChange?: boolean }
 *   - requireChange (default true): si true, cada estudiante deberá cambiar la
 *     contraseña al iniciar sesión (must_change_password=true); si false, la
 *     contraseña queda definitiva (el operador eligió una conocida).
 *
 * Autorización (por destinatario, defensa en profundidad — el insert va por
 * service role, así que validamos a mano):
 *   - SuperAdmin: cualquier usuario.
 *   - Admin: usuarios de SU mismo tenant.
 *   - Docente: solo estudiantes MATRICULADOS en alguno de SUS cursos
 *     (course_teachers ∩ course_enrollments).
 * Los destinatarios no autorizados se SALTAN y se reportan en `failed` (no
 * abortan el lote). Nunca se cambia la contraseña del propio caller.
 *
 * NO guarda en admin_visible_passwords (a diferencia del reset single): acá el
 * operador ELIGE y CONOCE la contraseña (es la misma para todos), así que no
 * hay nada que "re-ver". Auditamos un resumen + cada fallo.
 */
import { adminClient, corsHeaders, userClientFromRequest } from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";

const MAX_TARGETS = 500;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { userIds, newPassword, requireChange } = await req.json();

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return json({ error: "userIds requerido (array no vacío)" }, 400);
    }
    if (userIds.length > MAX_TARGETS) {
      return json({ error: `Demasiados usuarios (máximo ${MAX_TARGETS})` }, 400);
    }
    if (!newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
      return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);
    }

    // ── Caller ──
    const userClient = userClientFromRequest(req);
    if (!userClient) return json({ error: "No autenticado" }, 401);
    const { data: caller } = await userClient.auth.getUser();
    if (!caller.user) return json({ error: "No autenticado" }, 401);
    const callerId = caller.user.id;

    const { data: roleRows } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", callerId);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    const isSA = roles.includes("SuperAdmin");
    const isAdmin = roles.includes("Admin");
    const isDocente = roles.includes("Docente");
    if (!isSA && !isAdmin && !isDocente) {
      return json({ error: "Solo docentes y administradores pueden cambiar contraseñas" }, 403);
    }

    // Dedup + nunca tocar la propia contraseña por esta vía.
    const targets = [
      ...new Set(
        (userIds as unknown[]).filter(
          (id): id is string => typeof id === "string" && id.length > 0 && id !== callerId,
        ),
      ),
    ];
    if (targets.length === 0) {
      return json({ error: "Sin destinatarios válidos" }, 400);
    }

    // ── Conjunto de autorización ──
    const allowAll = isSA;
    let adminTenant: string | null = null;
    if (!allowAll && isAdmin) {
      const { data: cp } = await adminClient
        .from("profiles")
        .select("tenant_id")
        .eq("id", callerId)
        .maybeSingle();
      adminTenant = (cp as { tenant_id?: string | null } | null)?.tenant_id ?? null;
    }
    const docenteStudents = new Set<string>();
    if (!allowAll && isDocente) {
      const { data: ct } = await adminClient
        .from("course_teachers")
        .select("course_id")
        .eq("user_id", callerId);
      const courseIds = (ct ?? []).map((r: { course_id: string }) => r.course_id);
      if (courseIds.length > 0) {
        const { data: enr } = await adminClient
          .from("course_enrollments")
          .select("user_id")
          .in("course_id", courseIds);
        for (const e of enr ?? []) docenteStudents.add((e as { user_id: string }).user_id);
      }
    }
    // Tenant de cada target (solo si hay scope de Admin que validar).
    const targetTenant = new Map<string, string | null>();
    if (!allowAll && adminTenant !== null) {
      const { data: tps } = await adminClient
        .from("profiles")
        .select("id, tenant_id")
        .in("id", targets);
      for (const p of tps ?? []) {
        const row = p as { id: string; tenant_id?: string | null };
        targetTenant.set(row.id, row.tenant_id ?? null);
      }
    }
    const isAllowed = (id: string): boolean =>
      allowAll ||
      (adminTenant !== null && targetTenant.get(id) === adminTenant) ||
      docenteStudents.has(id);

    // ── Aplicar ──
    const force = requireChange !== false; // default true
    const failed: Array<{ userId: string; error: string }> = [];
    let updated = 0;

    for (const id of targets) {
      if (!isAllowed(id)) {
        failed.push({ userId: id, error: "No autorizado para este usuario" });
        continue;
      }
      // Cuenta SSO-only (sin identidad 'email'/password): el login real es por
      // el proveedor externo (OAuth/SAML), así que setear una contraseña sería
      // un no-op confuso o un backdoor de password. Se salta y se reporta.
      const { data: full } = await adminClient.auth.admin.getUserById(id);
      const identities = (full?.user?.identities ?? []) as Array<{ provider?: string }>;
      if (identities.length > 0 && !identities.some((i) => i.provider === "email")) {
        failed.push({ userId: id, error: "Cuenta SSO: el cambio de contraseña no aplica" });
        continue;
      }
      const { error: upErr } = await adminClient.auth.admin.updateUserById(id, {
        password: newPassword,
      });
      if (upErr) {
        failed.push({ userId: id, error: upErr.message });
        await auditFromEdge(adminClient, {
          actorId: callerId,
          actorEmailFallback: caller.user.email ?? null,
          action: "user.bulk_password_reset_failed",
          category: "user",
          severity: "error",
          entityType: "user",
          entityId: id,
          metadata: { reason: upErr.message },
        });
        continue;
      }
      // Forzar (o no) el cambio en el próximo login.
      await adminClient.from("profiles").update({ must_change_password: force }).eq("id", id);
      updated++;
    }

    await auditFromEdge(adminClient, {
      actorId: callerId,
      actorEmailFallback: caller.user.email ?? null,
      action: "user.bulk_password_reset",
      category: "user",
      severity: failed.length > 0 ? "warning" : "info",
      metadata: {
        requested: targets.length,
        updated,
        failed: failed.length,
        require_change: force,
      },
    });

    return json({ ok: true, updated, failed });
  } catch (e) {
    return json({ error: (e as Error).message ?? "Error interno" }, 500);
  }
});
