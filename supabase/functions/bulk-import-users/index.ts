// Bulk import users via CSV (admin only)
import { adminClient, corsHeaders, userClientFromRequest } from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";

// Token URL-safe de 32 bytes (~43 chars base64url). Mismo formato que
// genera `request-password-reset`. Reusamos la tabla `password_reset_tokens`
// y la ruta `/auth/reset-password?token=X` para que el usuario nuevo
// defina su primera contraseña — el predicado `_notification_kind_emails`
// ya dispara email automático para `system + /auth/reset-password%`.
function generateWelcomeToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// Ventana del link de bienvenida. Los password resets viven 1h porque
// asumen al usuario YA logueado o atento; un alumno recién creado
// puede tardar días en abrir el correo (admin importa al inicio del
// semestre, alumnos lo ven cuando empieza el curso). 7 días es el
// balance entre UX y seguridad: si caduca, el admin reimporta o el
// alumno pide reset normal desde /auth.
const WELCOME_TOKEN_TTL_HOURS = 24 * 7;

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
      return new Response(JSON.stringify({ error: "Solo Admin o SuperAdmin pueden importar" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
        // Opcional, default true: si true, al crear se marca
        // `must_change_password=true` para que el primer login pida
        // cambio. El admin puede pasar false para cuentas de sistema /
        // integraciones que no son humanas, o cuando ya estableció la
        // contraseña con el usuario y no quiere forzar el cambio.
        force_password_change,
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
          // Usuario nuevo: por default le exigimos cambiar la contraseña
          // en el primer login (la contraseña inicial la conoció el
          // admin que lo creó). Si el caller pasó `force_password_change:
          // false` explícitamente en la row, respetamos esa intención
          // — útil para cuentas de sistema/integraciones donde la
          // contraseña inicial es la definitiva. `undefined` → true por
          // backward-compat con el CSV importer y callers viejos.
          const mustChange = force_password_change !== false;
          if (mustChange) {
            await adminClient
              .from("profiles")
              .update({ must_change_password: true })
              .eq("id", userId);
          }

          // Correo de bienvenida con link para que el usuario defina
          // su contraseña sin necesidad de conocer la temporal. Reusa
          // la infra de password reset:
          //   1) Token URL-safe en `password_reset_tokens` (7 días).
          //   2) Notificación `kind='system'` + link `/auth/reset-password?token=X`
          //      → el trigger `notify_send_email` dispara el correo
          //      automáticamente (el predicado SQL ya acepta este path).
          // Best-effort: si algo falla, el usuario queda creado y el
          // admin puede mandar reset manual desde /auth. NO bloqueamos
          // la creación por un fallo de correo.
          //
          // Si `force_password_change=false`, OMITIMOS el welcome email
          // — el admin gestiona la entrega de la contraseña directamente
          // (cuentas de sistema, integraciones, o casos donde el admin
          // coordina la contraseña offline con el usuario).
          if (mustChange)
            try {
              const welcomeToken = generateWelcomeToken();
              const expiresAt = new Date(
                Date.now() + WELCOME_TOKEN_TTL_HOURS * 60 * 60 * 1000,
              ).toISOString();
              const { error: tokErr } = await adminClient.from("password_reset_tokens").insert({
                user_id: userId,
                token: welcomeToken,
                expires_at: expiresAt,
              });
              if (tokErr) throw tokErr;

              const firstName = (full_name as string).split(" ")[0] ?? "";
              const greeting = firstName ? `Hola ${firstName}, ` : "";
              const { error: notifErr } = await adminClient.from("notifications").insert({
                user_id: userId,
                title: "Bienvenido a ExamLab — Define tu contraseña",
                body:
                  `${greeting}se creó una cuenta para ti en ExamLab. ` +
                  "Haz click en el botón abajo para definir tu contraseña e ingresar a la plataforma.\n\n" +
                  "El enlace es válido por 7 días y solo puede usarse una vez. " +
                  "Si el enlace expira, puedes pedir uno nuevo desde la pantalla de inicio de sesión usando " +
                  'la opción "¿Olvidaste tu contraseña?".',
                kind: "system",
                link: `/auth/reset-password?token=${encodeURIComponent(welcomeToken)}`,
              });
              if (notifErr) throw notifErr;
            } catch (welcomeErr) {
              console.warn(
                "[bulk-import-users] welcome email failed for",
                institutional_email,
                welcomeErr,
              );
            }
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
