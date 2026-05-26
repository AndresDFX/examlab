// Bulk import users via CSV (admin only)
import { adminClient, corsHeaders, userClientFromRequest } from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const userClient = userClientFromRequest(req);
    if (!userClient) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: u, error: uErr } = await userClient.auth.getUser();
    if (uErr || !u.user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: roles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", u.user.id);
    const callerRoles = (roles ?? []).map((r) => r.role as string);
    const callerIsAdmin = callerRoles.includes("Admin");
    const callerIsSuperAdmin = callerRoles.includes("SuperAdmin");
    if (!callerIsAdmin && !callerIsSuperAdmin) {
      return new Response(
        JSON.stringify({ error: "Solo Admin o SuperAdmin pueden importar" }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { rows, allowExisting } = await req.json();
    if (!Array.isArray(rows)) throw new Error("rows[] requerido");

    // Pre-fetch all auth users once for O(1) duplicate lookups
    const { data: authList } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 10000 });
    const emailToId = new Map<string, string>();
    (authList?.users ?? []).forEach((u: any) => {
      if (u.email) emailToId.set(u.email.toLowerCase(), u.id);
    });

    // Pre-fetch profiles (institutional + personal emails) — son el set
    // canónico para detectar duplicados cruzados ("este personal_email
    // ya es el institutional_email de otro estudiante" o viceversa).
    // Case-insensitive — el UNIQUE INDEX nuevo en profiles también lo es.
    const profileEmailToUserId = new Map<string, string>();
    const { data: profilesList } = await adminClient
      .from("profiles")
      .select("id, institutional_email, personal_email");
    for (const p of (profilesList ?? []) as Array<{
      id: string;
      institutional_email: string | null;
      personal_email: string | null;
    }>) {
      if (p.institutional_email) {
        profileEmailToUserId.set(p.institutional_email.trim().toLowerCase(), p.id);
      }
      if (p.personal_email) {
        profileEmailToUserId.set(p.personal_email.trim().toLowerCase(), p.id);
      }
    }

    const result: { email: string; ok: boolean; reason?: string; duplicate?: boolean }[] = [];
    const seenInBatch = new Set<string>();
    for (const row of rows) {
      const {
        full_name,
        institutional_email,
        personal_email,
        password,
        roles: rolesStr,
        course_name,
      } = row;
      if (!institutional_email || !full_name) {
        result.push({
          email: institutional_email ?? "(vacío)",
          ok: false,
          reason: "Faltan campos requeridos (nombre o email)",
        });
        continue;
      }
      const emailKey = institutional_email.toLowerCase().trim();
      const personalKey = (personal_email ?? "").toLowerCase().trim();

      // Duplicate within the same CSV batch (institucional vs institucional
      // o cruzado con personal de otra fila del mismo CSV).
      if (seenInBatch.has(emailKey) || (personalKey && seenInBatch.has(personalKey))) {
        result.push({
          email: institutional_email,
          ok: false,
          duplicate: true,
          reason: "Email duplicado dentro del archivo CSV",
        });
        continue;
      }
      seenInBatch.add(emailKey);
      if (personalKey) seenInBatch.add(personalKey);

      // Personal email no puede estar usado como institucional/personal
      // de OTRO profile ya existente. Atrapa el caso "el csv trae un
      // personal_email que es el institucional de un usuario que ya
      // existe en el sistema".
      if (personalKey) {
        const owner = profileEmailToUserId.get(personalKey);
        const existingByEmail = emailToId.get(emailKey);
        // Si el dueño del personal NO es el mismo usuario que vamos a
        // crear/actualizar via institutional, hay colisión.
        if (owner && owner !== existingByEmail) {
          result.push({
            email: institutional_email,
            ok: false,
            duplicate: true,
            reason: `El email personal "${personalKey}" ya está en uso por otro usuario`,
          });
          continue;
        }
      }

      try {
        let userId = emailToId.get(emailKey);
        if (userId && !allowExisting) {
          // Reject duplicates by default — caller must opt-in to update existing
          result.push({
            email: institutional_email,
            ok: false,
            duplicate: true,
            reason: "Ya existe un usuario con este email institucional",
          });
          continue;
        }
        if (!userId) {
          const { data, error } = await adminClient.auth.admin.createUser({
            email: institutional_email,
            password: password || "Cambiar#123",
            email_confirm: true,
            user_metadata: { full_name, institutional_email, personal_email },
          });
          if (error) throw error;
          userId = data.user!.id;
          emailToId.set(emailKey, userId);
        }
        const roleList = (rolesStr || "Estudiante")
          .split("|")
          .map((r: string) => r.trim())
          .filter(Boolean);
        for (const r of roleList) {
          // SuperAdmin sólo lo puede asignar otro SuperAdmin — escalación
          // de privilegios lateral protegida acá Y por la RLS de
          // user_roles (que valida is_super_admin()). Si un Admin manda
          // SuperAdmin en el CSV, lo ignoramos silenciosamente.
          if (r === "SuperAdmin") {
            if (!callerIsSuperAdmin) continue;
            await adminClient
              .from("user_roles")
              .upsert({ user_id: userId, role: r }, { onConflict: "user_id,role" });
          } else if (["Admin", "Docente", "Estudiante"].includes(r)) {
            await adminClient
              .from("user_roles")
              .upsert({ user_id: userId, role: r }, { onConflict: "user_id,role" });
          }
        }
        if (course_name) {
          const { data: course } = await adminClient
            .from("courses")
            .select("id")
            .eq("name", course_name)
            .maybeSingle();
          if (course) {
            await adminClient
              .from("course_enrollments")
              .upsert(
                { course_id: course.id, user_id: userId },
                { onConflict: "course_id,user_id" },
              );
          }
        }
        result.push({ email: institutional_email, ok: true, userId });
      } catch (e) {
        result.push({
          email: institutional_email,
          ok: false,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // Auditoría: un solo evento por import con resumen. Loggeamos
    // creados/actualizados/fallidos + el primer puñado de emails para
    // que el admin sepa qué entró. Severity warning porque crear usuarios
    // masivamente es operación sensible.
    const created = result.filter((r) => r.ok).length;
    const failed = result.filter((r) => !r.ok).length;
    void auditFromEdge(adminClient, {
      actorId: u.user.id,
      action: "user.bulk_imported",
      category: "user",
      severity: "warning",
      entityType: "user",
      metadata: {
        total: rows.length,
        created,
        failed,
        allow_existing: !!allowExisting,
        first_emails: result.slice(0, 10).map((r) => ({ email: r.email, ok: r.ok })),
      },
    });

    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
