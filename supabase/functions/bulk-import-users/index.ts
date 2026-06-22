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

    // Pre-fetch cursos del tenant del caller para resolver course_name →
    // course_id en O(1) y validar la existencia ANTES de crear el user.
    // Lookup case-insensitive. La RLS de courses limita a SU tenant
    // automáticamente para Admin; SuperAdmin ve cross-tenant pero acá
    // solo importamos al tenant del CSV (definido por la session del
    // caller).
    const { data: callerProfile } = await adminClient
      .from("profiles")
      .select("tenant_id")
      .eq("id", u.user.id)
      .maybeSingle();
    const callerTenantId = callerProfile?.tenant_id as string | null;

    const courseNameToId = new Map<string, string>();
    if (callerTenantId) {
      const { data: coursesList } = await adminClient
        .from("courses")
        .select("id, name")
        .eq("tenant_id", callerTenantId)
        .is("deleted_at", null);
      for (const c of (coursesList ?? []) as Array<{ id: string; name: string }>) {
        courseNameToId.set(c.name.trim().toLowerCase(), c.id);
      }
    }

    // Pre-fetch: setting `enabled_kinds.welcome` de email_settings (id=1).
    // Si está en false o falta, el admin desactivó los welcome emails y
    // omitimos la creación de token + notification al crear usuarios.
    // Default true (backward-compat: antes siempre se enviaba sin toggle).
    // deno-lint-ignore no-explicit-any
    const { data: emailSettingsRow } = await (adminClient as any)
      .from("email_settings")
      .select("globally_enabled, enabled_kinds")
      .eq("id", 1)
      .maybeSingle();
    const emailSettings = emailSettingsRow as
      | { globally_enabled?: boolean; enabled_kinds?: { welcome?: boolean } }
      | null;
    const sendWelcomeEmails =
      (emailSettings?.globally_enabled ?? true) &&
      (emailSettings?.enabled_kinds?.welcome ?? true);

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

    const result: {
      email: string;
      ok: boolean;
      reason?: string;
      duplicate?: boolean;
      userId?: string;
      /** El usuario ya existía y solo se lo matriculó al curso (no se creó). */
      enrolledExisting?: boolean;
    }[] = [];
    const seenInBatch = new Set<string>();
    // Contador de createUser ya intentados — usado para el throttle
    // entre creates (skipea sleep para el primero, espera 200ms para los
    // siguientes). Evita el rate limit del Supabase Auth admin API.
    let createsAttempted = 0;
    for (const row of rows) {
      const {
        full_name,
        institutional_email,
        personal_email,
        password,
        roles: rolesStr,
        course_name,
        student_code,
        // Identidad estudiantil OPCIONAL (mig 20260612000000): documento de
        // identidad (cédula/ID), cohorte (texto libre "YYYY-N"), estado
        // (activo/retirado/graduado/aplazado) y codigo (matrícula legacy).
        // Solo se persisten si el role incluye Estudiante. Vacíos → no se tocan.
        documento,
        cohorte,
        estado,
        codigo,
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

      // Pre-validación del curso ANTES de crear el user. Si llega
      // course_name pero NO matchea ningún curso del tenant, abortamos
      // la fila — no crear el user para luego dejarlo sin matricular.
      // course_name vacío/null = no matricular (válido).
      const courseNameRaw =
        typeof course_name === "string" ? course_name.trim() : "";
      let resolvedCourseId: string | null = null;
      if (courseNameRaw.length > 0) {
        const found = courseNameToId.get(courseNameRaw.toLowerCase());
        if (!found) {
          result.push({
            email: institutional_email,
            ok: false,
            reason: `El curso "${courseNameRaw}" no existe en tu institución. Créalo primero o ajusta el nombre en el CSV (debe coincidir EXACTO).`,
          });
          continue;
        }
        resolvedCourseId = found;
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
          // El usuario ya existe y NO pedimos actualizarlo (allowExisting=false,
          // el default). NO tocamos su perfil/roles, PERO matricularlo a un
          // curso es ADITIVO/no-destructivo: si la fila trae un course_name y
          // el usuario todavía NO está en ese curso, lo matriculamos en vez de
          // saltar la fila. Caso reportado: "importo un usuario que ya existe
          // pero no está matriculado en el curso → debe quedar matriculado".
          if (resolvedCourseId) {
            const { data: alreadyEnrolled } = await adminClient
              .from("course_enrollments")
              .select("course_id")
              .eq("course_id", resolvedCourseId)
              .eq("user_id", userId)
              .maybeSingle();
            if (!alreadyEnrolled) {
              const { error: enrollErr } = await adminClient
                .from("course_enrollments")
                .upsert(
                  { course_id: resolvedCourseId, user_id: userId },
                  { onConflict: "course_id,user_id" },
                );
              if (!enrollErr) {
                result.push({
                  email: institutional_email,
                  ok: true,
                  userId,
                  enrolledExisting: true,
                  reason: "Usuario ya existía; se matriculó al curso indicado.",
                });
                continue;
              }
              // Si la matrícula falla, caemos al rechazo de duplicado de abajo
              // (con el error real para que el admin lo vea).
              result.push({
                email: institutional_email,
                ok: false,
                duplicate: true,
                reason: `El usuario ya existe y no se pudo matricular al curso: ${enrollErr.message}`,
              });
              continue;
            }
            // Ya estaba matriculado: reportarlo como tal (no es un error
            // accionable, pero sí informa que no había nada que hacer).
            result.push({
              email: institutional_email,
              ok: false,
              duplicate: true,
              reason: "El usuario ya existe y ya estaba matriculado en el curso.",
            });
            continue;
          }
          // Sin course_name: nada aditivo que hacer → rechazo de duplicado.
          // Devolvemos userId para que el caller (ej. la creación individual,
          // que NO manda course_name) pueda matricular al usuario existente
          // a un curso elegido en el form si lo desea.
          result.push({
            email: institutional_email,
            ok: false,
            duplicate: true,
            userId,
            reason: "Ya existe un usuario con este email institucional",
          });
          continue;
        }
        if (!userId) {
          // Throttle entre creates: el Auth admin API de Supabase tira
          // "Database error creating new user" (genérico, sin código)
          // cuando hay presión sostenida. Empíricamente 200ms no era
          // suficiente — el user reportó "1 importado, 92 errores" dos
          // veces consecutivas con el throttle previo. Subimos a 500ms
          // (~2 req/s) que es claramente bajo del límite, y agregamos
          // retry con backoff exponencial si el error indica rate limit
          // o "database error" (genérico que típicamente esconde el
          // throttle interno de Supabase).
          //
          // Costo: 90 users × 500ms = 45s. Cabe holgado en el edge
          // timeout de 60s. Si fuera necesario más throttle, habría que
          // splittear el batch en múltiples requests del cliente.
          if (createsAttempted > 0) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          createsAttempted += 1;

          // Retry helper: hasta 3 intentos con backoff 1.5s, 3s. Solo
          // reintenta para errores transitorios (rate limit / mensaje
          // "database" genérico). Para errores claros como UNIQUE
          // violation o email inválido, falla en el primer intento.
          // deno-lint-ignore no-explicit-any
          const isRetryable = (e: any): boolean => {
            const msg = String(e?.message ?? "").toLowerCase();
            return (
              msg.includes("database error") ||
              msg.includes("rate") ||
              msg.includes("limit") ||
              msg.includes("timeout") ||
              msg.includes("503") ||
              msg.includes("502") ||
              (e?.status >= 500 && e?.status < 600)
            );
          };
          let createResult: Awaited<ReturnType<typeof adminClient.auth.admin.createUser>> | null = null;
          let lastErr: unknown = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            createResult = await adminClient.auth.admin.createUser({
              email: institutional_email,
              password: password || "Cambiar#123",
              email_confirm: true,
              user_metadata: { full_name, institutional_email, personal_email },
            });
            if (!createResult.error) {
              lastErr = null;
              break;
            }
            lastErr = createResult.error;
            if (!isRetryable(createResult.error) || attempt === 3) break;
            // Backoff 1.5s, 3s.
            const wait = attempt === 1 ? 1500 : 3000;
            console.warn(
              `[bulk-import-users] retry ${attempt}/3 for ${institutional_email} after ${wait}ms — ${createResult.error.message}`,
            );
            await new Promise((resolve) => setTimeout(resolve, wait));
          }
          if (lastErr || !createResult || createResult.error) {
            const err = lastErr ?? createResult?.error;
            console.error(
              "[bulk-import-users] createUser failed permanently for",
              institutional_email,
              JSON.stringify({
                message: (err as { message?: string })?.message,
                status: (err as { status?: number })?.status,
                code: (err as { code?: string })?.code,
                name: (err as { name?: string })?.name,
              }),
            );
            throw err;
          }
          userId = createResult.data.user!.id;
          emailToId.set(emailKey, userId);
          // Asignar tenant_id al profile recién creado. El trigger
          // handle_new_user inserta el profile SIN tenant_id (su responsabilidad
          // es solo poblar id + emails + full_name), así que la edge debe
          // setearlo aquí. Sin esto, los usuarios importados quedan con
          // tenant_id=NULL ("sin institución") aunque el Admin los haya
          // creado desde su tenant — bug reportado al importar 93 estudiantes.
          //
          // Reglas:
          //   - Admin de tenant: `callerTenantId` = su tenant_id. SIEMPRE
          //     se asigna ese.
          //   - SuperAdmin: si tiene tenant_id en su profile (caso atípico
          //     pero válido), se asigna ese. Si es cross-tenant puro
          //     (tenant_id=NULL), el profile importado también queda NULL
          //     — el SA luego puede asignarles tenant desde la UI.
          // Usuario nuevo: por default le exigimos cambiar la contraseña
          // en el primer login (la contraseña inicial la conoció el admin
          // que lo creó). `force_password_change:false` explícito respeta
          // la intención (cuentas de sistema). `undefined` → true.
          const mustChange = force_password_change !== false;
          // PERF (import masivo): tenant_id + must_change_password en UN solo
          // UPDATE al profile recién creado, en vez de dos round-trips separados
          // al MISMO row. Menos round-trips por usuario = menos presión sobre
          // Auth/DB durante lotes grandes (lo que disparaba "Database error
          // creating new user" + lentitud). Va ANTES del upsert de roles porque
          // el quota trigger de user_roles lee profiles.tenant_id.
          {
            const newUserPatch: Record<string, unknown> = {};
            if (callerTenantId) newUserPatch.tenant_id = callerTenantId;
            if (mustChange) newUserPatch.must_change_password = true;
            if (Object.keys(newUserPatch).length > 0) {
              const { error: patchErr } = await adminClient
                .from("profiles")
                .update(newUserPatch)
                .eq("id", userId);
              if (patchErr) {
                // No abortamos: el usuario ya está creado en auth.users; el
                // admin puede ajustar tenant/flag manualmente.
                console.warn(
                  "[bulk-import-users] profile patch (tenant_id/must_change) failed for",
                  institutional_email,
                  patchErr.message,
                );
              }
            }
          }

          // Guardar la contraseña temporal en claro para que el Admin/SA
          // que creó el usuario pueda re-verla y comunicarla (tabla
          // admin_visible_passwords). Tradeoff de seguridad aceptado: la RLS
          // acota la lectura a SA o Admin del mismo tenant, y la fila se
          // autoborra cuando el usuario cambia su contraseña. Best-effort:
          // no abortamos la creación si falla el guardado.
          {
            const { error: avpErr } = await adminClient
              .from("admin_visible_passwords")
              .upsert(
                {
                  user_id: userId,
                  tenant_id: callerTenantId,
                  password: password || "Cambiar#123",
                  set_by: u.user.id,
                },
                { onConflict: "user_id" },
              );
            if (avpErr) {
              console.warn(
                "[bulk-import-users] store visible password failed for",
                institutional_email,
                avpErr.message,
              );
            }
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
          // Gate del welcome email: además de `mustChange`, respetamos
          // el toggle `enabled_kinds.welcome` de email_settings (UI:
          // Admin → Configuración → Correos). Si el admin lo apagó,
          // omitimos la generación del token + notification — el admin
          // reparte la contraseña offline o usa SSO. El usuario igual
          // queda con `must_change_password=true` así el primer login le
          // exige cambio.
          if (mustChange && sendWelcomeEmails)
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
        // student_code: solo persistir si el role asignado incluye
        // Estudiante (los Docentes/Admins no tienen matrícula). Si la
        // fila lo trae pero el role no es Estudiante, lo ignoramos
        // silenciosamente — typo común del admin no debe romper el
        // import.
        const studentCodeRaw =
          typeof student_code === "string" ? student_code.trim() : "";
        if (studentCodeRaw.length > 0 && roleList.includes("Estudiante")) {
          try {
            const { error: codeErr } = await adminClient
              .from("profiles")
              .update({ student_code: studentCodeRaw })
              .eq("id", userId);
            if (codeErr) {
              // No abortamos — el user ya está creado y matriculado. El
              // admin puede corregir el código manualmente desde
              // /app/admin/users. Lo más típico: clash con otro
              // student_code (unique partial por tenant).
              console.warn(
                `[bulk-import-users] no se pudo setear student_code "${studentCodeRaw}" para ${institutional_email}:`,
                codeErr.message,
              );
            }
          } catch (codeEx) {
            console.warn(`[bulk-import-users] student_code update threw`, codeEx);
          }
        }

        // Identidad estudiantil opcional (documento/cohorte/estado). Igual que
        // student_code: solo para Estudiante; vacíos no se tocan. documento y
        // cohorte son texto libre; estado se valida contra la CHECK
        // (activo/retirado/graduado/aplazado) — un valor inválido se OMITE en
        // vez de abortar (no rompemos el import por un typo del admin).
        if (roleList.includes("Estudiante")) {
          const trim = (v: unknown) => (typeof v === "string" ? v.trim() : "");
          const documentoRaw = trim(documento);
          const cohorteRaw = trim(cohorte);
          const estadoRaw = trim(estado).toLowerCase();
          const VALID_ESTADOS = ["activo", "retirado", "graduado", "aplazado"];
          const identityPatch: Record<string, string> = {};
          if (documentoRaw.length > 0) identityPatch.documento = documentoRaw;
          if (cohorteRaw.length > 0) identityPatch.cohorte = cohorteRaw;
          if (estadoRaw.length > 0 && VALID_ESTADOS.includes(estadoRaw)) {
            identityPatch.estado = estadoRaw;
          }
          if (Object.keys(identityPatch).length > 0) {
            try {
              const { error: identErr } = await adminClient
                .from("profiles")
                .update(identityPatch)
                .eq("id", userId);
              if (identErr) {
                console.warn(
                  `[bulk-import-users] no se pudo setear identidad ${JSON.stringify(identityPatch)} para ${institutional_email}:`,
                  identErr.message,
                );
              }
            } catch (identEx) {
              console.warn(`[bulk-import-users] identity update threw`, identEx);
            }
          }

          // codigo (matrícula legacy, UNIQUE por (programa_id, lower(codigo))):
          // se actualiza aparte con su propio try/catch — un clash NO debe
          // tumbar el patch de documento/cohorte/estado de arriba.
          const codigoRaw = typeof codigo === "string" ? codigo.trim() : "";
          if (codigoRaw.length > 0) {
            try {
              const { error: codigoErr } = await adminClient
                .from("profiles")
                .update({ codigo: codigoRaw })
                .eq("id", userId);
              if (codigoErr) {
                console.warn(
                  `[bulk-import-users] no se pudo setear codigo "${codigoRaw}" para ${institutional_email}:`,
                  codigoErr.message,
                );
              }
            } catch (codigoEx) {
              console.warn(`[bulk-import-users] codigo update threw`, codigoEx);
            }
          }
        }

        // Matrícula al curso (ya validado arriba; resolvedCourseId está
        // garantizado si llegamos acá con course_name).
        if (resolvedCourseId) {
          await adminClient
            .from("course_enrollments")
            .upsert(
              { course_id: resolvedCourseId, user_id: userId },
              { onConflict: "course_id,user_id" },
            );
        }
        result.push({ email: institutional_email, ok: true, userId });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        result.push({
          email: institutional_email,
          ok: false,
          reason,
        });
        // deno-lint-ignore no-explicit-any
        const errAny = e as any;

        // Diagnóstico EXTRA cuando el error es 500 "Database error"
        // (genérico de Supabase Auth que esconde la causa real). Hacemos
        // 3 lookups en paralelo para enriquecer el audit log:
        //   a) ¿El email ya existe en auth.users? → indica duplicate de
        //      intento previo.
        //   b) ¿Hay un profile huérfano con ese email? → indica
        //      re-vinculación fallida (mig 20260906 no aplicada o bug).
        //   c) ¿Cuántos enrollments tiene ese profile huérfano? → confirma
        //      si el FK CASCADE de mig 20260909 es lo que falla.
        let diag_auth_user_exists: boolean | null = null;
        let diag_orphan_profile_id: string | null = null;
        let diag_orphan_enrollments: number | null = null;
        const looks_like_db_error =
          errAny?.status === 500 ||
          /database error|unexpected_failure/i.test(reason);
        if (looks_like_db_error) {
          try {
            const { data: existingAuth } = await adminClient
              .from("auth.users" as never)
              .select("id")
              .eq("email", institutional_email)
              .maybeSingle();
            diag_auth_user_exists = !!existingAuth;
          } catch {
            // adminClient.from("auth.users") puede no funcionar con
            // PostgREST si el schema auth no está expuesto. Fallback
            // con auth.admin.listUsers no es viable por costo. Skipear.
          }
          try {
            const { data: orphan } = await adminClient
              .from("profiles")
              .select("id")
              .ilike("institutional_email", institutional_email)
              .maybeSingle();
            if (orphan?.id) {
              diag_orphan_profile_id = orphan.id as string;
              const { count } = await adminClient
                .from("course_enrollments")
                .select("user_id", { count: "exact", head: true })
                .eq("user_id", orphan.id);
              diag_orphan_enrollments = count ?? 0;
            }
          } catch {
            // best-effort
          }
        }

        // Auditoría POR FILA fallida — antes solo había un evento de
        // resumen al final con `first_emails`, sin detalle de las 92 que
        // fallaron. Ahora cada fallo de createUser/upsert deja una fila
        // en `audit_logs` visible en `/app/admin/audit-logs?tab=errors`
        // con el mensaje del error real (rate limit, unique violation,
        // database error, etc.) + diagnóstico para identificar la causa
        // real del 500 genérico de Supabase Auth.
        void auditFromEdge(adminClient, {
          actorId: u.user.id,
          // Si el caller es el SA actuando sobre un tenant específico,
          // queremos que el audit log aparezca en /app/admin/audit-logs
          // del tenant destino, no solo en el panel del SA. Pasamos
          // explícito `tenantId: callerTenantId` (calculado al inicio
          // de la edge desde el profile o el override del SA).
          tenantId: callerTenantId,
          action: "user.bulk_import_row_failed",
          category: "user",
          severity: "error",
          entityType: "user",
          entityName: institutional_email,
          metadata: {
            email: institutional_email,
            full_name: full_name ?? null,
            error_message: reason,
            error_status: errAny?.status ?? null,
            error_code: errAny?.code ?? null,
            error_name: errAny?.name ?? null,
            // Diagnóstico: estos 3 campos identifican la causa raíz del
            // 500 sin requerir queries manuales del admin.
            diag_auth_user_exists,
            diag_orphan_profile_id,
            diag_orphan_enrollments,
            // Hipótesis derivada para que el admin sepa qué hacer:
            diag_likely_cause: !looks_like_db_error
              ? null
              : diag_auth_user_exists
                ? "auth_user_already_registered" // bug: intento previo dejó residuo en auth.users
                : diag_orphan_profile_id
                  ? diag_orphan_enrollments && diag_orphan_enrollments > 0
                    ? "orphan_profile_with_enrollments" // mig 20260909 no aplicada o FK no cascade
                    : "orphan_profile_revinculate_failed" // mig 20260906 no aplicada
                  : "unknown_trigger_failure", // otro trigger fallando — investigar pg_trigger
          },
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
      tenantId: callerTenantId,
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
