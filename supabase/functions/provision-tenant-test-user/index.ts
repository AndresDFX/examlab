// Provisiona un usuario de prueba para un tenant recién creado.
//
// Cuando el SuperAdmin crea una institución nueva, queremos darle de
// inmediato un usuario "todo-en-uno" (Admin + Docente + Estudiante, NO
// SuperAdmin) para que pueda probar el flujo sin tener que armar a mano
// la primera cuenta. La función:
//
//   1. Valida que el caller es SuperAdmin (defense in depth — el front
//      ya lo restringe, pero la edge no confía en el front).
//   2. Genera un email predecible en el dominio reservado `.test`
//      (RFC 6761 — nunca colisiona con un dominio real).
//   3. Genera una contraseña aleatoria de 14 chars de un alfabeto sin
//      caracteres ambiguos (0/O, 1/l/I).
//   4. Crea el user vía `auth.admin.createUser` con email_confirm=true.
//   5. UPSERT en profiles con tenant_id, full_name ("Test {institución}")
//      y must_change_password=false (queremos que el SuperAdmin pueda
//      usar la temp inmediatamente).
//   6. Asigna roles Admin, Docente, Estudiante (intencionalmente NO
//      SuperAdmin — eso es cross-tenant y este user es per-tenant).
//   7. Audit log + return de credenciales para que la UI las muestre.
//
// El SuperAdmin ve las credenciales UNA SOLA VEZ (la password no se
// guarda en plaintext). Si las pierde, puede reset normal desde /auth.
import { adminClient, corsHeaders, userClientFromRequest, jsonError, jsonResponse } from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";

// Alfabeto sin caracteres ambiguos (0/O, 1/l/I). 14 chars de este
// alfabeto da ~83 bits de entropía — más que suficiente para una
// password temporal.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
function generatePassword(len = 14): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    // ─── Auth: SuperAdmin only ─────────────────────────────────────────
    const userClient = userClientFromRequest(req);
    if (!userClient) return jsonError("No autenticado", 401);
    const { data: u, error: uErr } = await userClient.auth.getUser();
    if (uErr || !u.user) return jsonError("Token inválido", 401);

    const { data: rolesRows } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", u.user.id);
    const isSuperAdmin = (rolesRows ?? []).some(
      (r: { role: string }) => r.role === "SuperAdmin",
    );
    if (!isSuperAdmin) {
      return jsonError(
        "Solo SuperAdmin puede provisionar usuarios de prueba para una institución",
        403,
      );
    }

    // ─── Input ─────────────────────────────────────────────────────────
    const { tenant_id, tenant_name, tenant_slug } = await req.json();
    if (!tenant_id || !tenant_name || !tenant_slug) {
      return jsonError("tenant_id, tenant_name y tenant_slug son requeridos", 400);
    }
    if (typeof tenant_slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(tenant_slug)) {
      // Defensa: el CHECK de tenants.slug ya valida esto, pero como el
      // slug entra en el email, validamos de nuevo para no construir
      // emails malformados si alguien llama directo a la edge.
      return jsonError("tenant_slug inválido", 400);
    }

    // Email en dominio .test (RFC 6761 — reservado para testing, nunca
    // resolverá a un servidor real, lo que es exactamente lo que queremos
    // para una cuenta dummy).
    const email = `test-${tenant_slug}@examlab.test`;
    const password = generatePassword(14);
    const fullName = `Test ${tenant_name}`;

    // ─── Crear el user ─────────────────────────────────────────────────
    const { data: createData, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        institutional_email: email,
        is_tenant_test_user: true,
      },
    });
    if (createErr) {
      const msg = createErr.message || "";
      // Si re-crean el tenant con mismo slug tras borrarlo, el email
      // puede seguir existiendo en auth.users (la limpieza es manual
      // desde /app/admin/users). Devolvemos 409 con instrucción.
      if (/already.+registered|email.+exist|duplicate/i.test(msg)) {
        return jsonError(
          `Ya existe un usuario con email ${email}. Bórralo desde /app/admin/users o desactiva esta opción para esta institución.`,
          409,
        );
      }
      throw createErr;
    }

    const userId = createData.user!.id;

    // ─── Profile: tenant_id + nombre ───────────────────────────────────
    // UPSERT en lugar de UPDATE — handle_new_user trigger puede o no
    // existir según el proyecto, así que defensivos.
    const { error: profErr } = await adminClient
      .from("profiles")
      .upsert(
        {
          id: userId,
          tenant_id,
          full_name: fullName,
          institutional_email: email,
          // El SuperAdmin se da la temp directamente; no forzamos cambio
          // en el primer login (la idea es que pueda probar sin fricción).
          must_change_password: false,
        },
        { onConflict: "id" },
      );
    if (profErr) {
      // No abortamos — el user existe, falta completar perfil. El admin
      // puede arreglarlo desde /app/admin/users si hace falta.
      console.warn("[provision-tenant-test-user] profile upsert failed", profErr);
    }

    // ─── Roles ─────────────────────────────────────────────────────────
    // NUNCA asignamos SuperAdmin (cross-tenant — sería elevación lateral).
    const ROLES_TO_ASSIGN = ["Admin", "Docente", "Estudiante"];
    const assignedRoles: string[] = [];
    for (const r of ROLES_TO_ASSIGN) {
      const { error: roleErr } = await adminClient
        .from("user_roles")
        .upsert({ user_id: userId, role: r }, { onConflict: "user_id,role" });
      if (roleErr) {
        // El trigger de cuotas (tg_check_tenant_user_quota) podría rechazar
        // por max_admins/max_teachers/max_students. Lo registramos pero
        // seguimos intentando los demás roles.
        console.warn(`[provision-tenant-test-user] role ${r} assign failed`, roleErr);
      } else {
        assignedRoles.push(r);
      }
    }

    // ─── Audit ─────────────────────────────────────────────────────────
    void auditFromEdge(adminClient, {
      actorId: u.user.id,
      action: "tenant.test_user_provisioned",
      category: "tenant",
      severity: "warning",
      entityType: "tenant",
      entityId: tenant_id,
      entityName: tenant_name,
      metadata: {
        test_user_id: userId,
        test_user_email: email,
        full_name: fullName,
        roles: assignedRoles,
        // NO logueamos la password — solo se entrega al caller HTTP UNA
        // vez. Si se pierde, el admin pide reset desde la pantalla de auth.
      },
    });

    return jsonResponse({
      ok: true,
      user_id: userId,
      email,
      password,
      full_name: fullName,
      roles: assignedRoles,
    });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : String(e), 500);
  }
});
