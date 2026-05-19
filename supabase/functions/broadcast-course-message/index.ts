// ──────────────────────────────────────────────────────────────────────
// broadcast-course-message — envía un mensaje a TODOS los estudiantes
// inscritos en un curso. Solo Docente del curso o Admin.
//
// Efecto:
//   1. Bulk-insert de notificaciones (1 por estudiante) con
//      kind='broadcast'. Como 'broadcast' NO está en
//      `_notification_kind_emails`, el trigger SQL `notify_send_email`
//      saltea el envío automático — evita N correos individuales que es
//      lo opuesto a lo que queremos.
//   2. UN solo correo SMTP enviado desde acá con TODOS los estudiantes
//      en BCC. Privacidad: ningún alumno ve la lista del resto.
//
// Body:
//   { courseId: string, subject: string, body: string }
//
// Response:
//   { notified: number, email_sent: boolean, bcc_count: number }
//
// Errores:
//   401  No autenticado.
//   403  No es Admin ni Docente del curso.
//   400  Body inválido o curso sin alumnos.
//   500  SMTP/DB error.
//
// Auditoría: logs `broadcast.sent` y `broadcast.email_failed` con
// metadata { course_id, recipients, subject_len, bcc_count }.
// ──────────────────────────────────────────────────────────────────────
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import {
  adminClient as admin,
  corsHeaders,
  jsonError,
  jsonResponse,
  userClientFromRequest,
} from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";

interface BroadcastBody {
  courseId: string;
  subject: string;
  body: string;
}

interface StudentProfile {
  id: string;
  full_name: string | null;
  institutional_email: string | null;
  personal_email: string | null;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBroadcastHtml(params: {
  courseName: string;
  senderName: string;
  subject: string;
  body: string;
  appUrl: string;
  brandName: string;
}): string {
  const subject = escapeHtml(params.subject);
  const courseName = escapeHtml(params.courseName);
  const senderName = escapeHtml(params.senderName);
  const brand = escapeHtml(params.brandName);
  const bodyHtml = escapeHtml(params.body).replace(/\n/g, "<br>");
  const link = params.appUrl.replace(/\/+$/, "") + "/app/messages";
  const cta = `
    <tr>
      <td style="padding: 24px 0 8px 0; text-align: center;">
        <a href="${escapeHtml(link)}"
           style="display:inline-block; background-color:#2563eb; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:6px; font-weight:500; font-size:14px;">
          Abrir ${brand}
        </a>
      </td>
    </tr>`;
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="margin:0; padding:24px; background:#f1f5f9; font-family:Arial,sans-serif;">
  <table role="presentation" width="100%" style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; padding:24px;">
    <tr>
      <td style="font-size:11px; color:#64748b; text-transform:uppercase; letter-spacing:0.05em;">
        📢 Mensaje del curso · ${courseName}
      </td>
    </tr>
    <tr>
      <td style="padding-top:8px; font-size:20px; font-weight:600; color:#0f172a;">
        ${subject}
      </td>
    </tr>
    <tr>
      <td style="padding-top:16px; font-size:14px; color:#334155; line-height:1.6;">
        ${bodyHtml}
      </td>
    </tr>
    ${cta}
    <tr>
      <td style="padding-top:24px; font-size:11px; color:#94a3b8;">
        Enviado por <strong>${senderName}</strong> a través de ${brand}.
        Si necesitas responder, hazlo directamente al docente — este correo
        es un anuncio masivo y no recibirá respuestas.
      </td>
    </tr>
  </table>
</body>
</html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let actorId: string | undefined;
  let courseId: string | undefined;

  try {
    // ── Auth ──
    const userClient = userClientFromRequest(req);
    if (!userClient) return jsonError("No autenticado", 401);
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return jsonError("Token inválido", 401);
    actorId = u.user.id;

    const body = (await req.json()) as BroadcastBody;
    const subject = String(body.subject ?? "").trim();
    const message = String(body.body ?? "").trim();
    courseId = String(body.courseId ?? "").trim();

    if (!courseId) return jsonError("courseId requerido", 400);
    if (!subject) return jsonError("subject requerido", 400);
    if (!message) return jsonError("body requerido", 400);
    // Topes defensivos. 200 chars en asunto cabe en clientes de correo
    // sin truncar; 10K en body es generoso para anuncios.
    if (subject.length > 200) return jsonError("subject demasiado largo (máx 200)", 400);
    if (message.length > 10000) return jsonError("body demasiado largo (máx 10K)", 400);

    // ── Autorización: Admin o Docente del curso ──
    const { data: roleRows } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", actorId);
    const isAdmin = (roleRows ?? []).some((r: { role: string }) => r.role === "Admin");
    const isDocenteRole = (roleRows ?? []).some((r: { role: string }) => r.role === "Docente");

    let isCourseTeacher = false;
    if (!isAdmin) {
      const { data: ct } = await admin
        .from("course_teachers")
        .select("id")
        .eq("course_id", courseId)
        .eq("user_id", actorId)
        .maybeSingle();
      isCourseTeacher = !!ct;
    }
    if (!isAdmin && !isCourseTeacher) {
      return jsonError("No tienes permiso para enviar mensajes en este curso", 403);
    }

    // ── Curso (para subject y para validar existencia) ──
    const { data: course } = await admin
      .from("courses")
      .select("id, name")
      .eq("id", courseId)
      .maybeSingle();
    if (!course) return jsonError("Curso no encontrado", 404);

    // ── Estudiantes inscritos ──
    // Hacemos JOIN explícito porque queremos contacto del profile, no
    // solo el user_id. El profile guarda institutional + personal email.
    const { data: enrollRows, error: enrollErr } = await admin
      .from("course_enrollments")
      .select("user_id, profile:profiles!course_enrollments_user_id_fkey(id, full_name, institutional_email, personal_email)")
      .eq("course_id", courseId);
    if (enrollErr) return jsonError(`No se pudo leer matrículas: ${enrollErr.message}`, 500);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const students: StudentProfile[] = (enrollRows ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((row: any) => row.profile as StudentProfile | null)
      .filter((p: StudentProfile | null): p is StudentProfile => p != null);

    if (students.length === 0) {
      return jsonError("El curso no tiene estudiantes inscritos", 400);
    }

    // ── Bulk-insert de notificaciones (kind='broadcast' evita auto-email) ──
    const senderProfile = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", actorId)
      .maybeSingle();
    const senderName =
      (senderProfile.data?.full_name as string | null) ?? (isAdmin ? "Administración" : "Docente");

    const notifTitle = `📢 ${subject}`;
    const notifRows = students.map((s) => ({
      user_id: s.id,
      title: notifTitle,
      body: message,
      kind: "broadcast",
      // Link al inbox de mensajes — desde ahí el alumno puede iniciar
      // conversación con el docente si quiere responder. El mensaje en
      // sí ya viaja en `body` y se ve en el bell + toast.
      link: "/app/messages",
      related_user_id: actorId,
      source_role: isAdmin ? "Admin" : isDocenteRole ? "Docente" : null,
    }));

    const { error: insErr } = await admin.from("notifications").insert(notifRows);
    if (insErr) return jsonError(`Error al insertar notificaciones: ${insErr.message}`, 500);

    // ── Construir lista BCC ──
    // Prioridad institucional → personal. Si un alumno no tiene ningún
    // correo, lo saltamos (la notificación in-app sí le llegó).
    const bccEmails: string[] = [];
    for (const s of students) {
      const email =
        (s.institutional_email && s.institutional_email.trim()) ||
        (s.personal_email && s.personal_email.trim());
      if (email) bccEmails.push(email);
    }

    // ── SMTP ──
    const host = Deno.env.get("SMTP_HOST");
    const portRaw = Deno.env.get("SMTP_PORT");
    const smtpUser = Deno.env.get("SMTP_USER");
    const smtpPass = Deno.env.get("SMTP_PASSWORD");
    const from = Deno.env.get("EMAIL_FROM");
    const fromName = Deno.env.get("EMAIL_FROM_NAME") ?? "ExamLab";
    const appUrl = Deno.env.get("APP_PUBLIC_URL") ?? "";

    if (!host || !portRaw || !smtpUser || !smtpPass || !from) {
      // Las notificaciones in-app ya se crearon. Retornamos parcial: el
      // mensaje llegó al bell de todos, pero el email no salió por
      // falta de config. Auditamos y avisamos al cliente.
      void auditFromEdge(admin, {
        actorId,
        action: "broadcast.email_skipped",
        category: "system",
        severity: "warning",
        entityType: "course",
        entityId: courseId,
        metadata: {
          reason: "smtp_env_missing",
          notified: students.length,
        },
      });
      return jsonResponse({
        notified: students.length,
        email_sent: false,
        bcc_count: 0,
        warning: "Notificaciones in-app enviadas, pero SMTP no está configurado.",
      });
    }
    const port = Number(portRaw);
    if (!Number.isFinite(port)) {
      return jsonError("SMTP_PORT inválido", 500);
    }

    if (bccEmails.length === 0) {
      // Mismo caso parcial: in-app sí, email no porque nadie tiene correo.
      void auditFromEdge(admin, {
        actorId,
        action: "broadcast.email_skipped",
        category: "system",
        severity: "info",
        entityType: "course",
        entityId: courseId,
        metadata: { reason: "no_emails_found", notified: students.length },
      });
      return jsonResponse({
        notified: students.length,
        email_sent: false,
        bcc_count: 0,
        warning: "Ningún estudiante tiene correo configurado.",
      });
    }

    // UN solo correo. El destinatario "to" es el remitente (la cuenta
    // institucional que envía); los alumnos van todos en BCC para que
    // ninguno vea la lista del resto. denomailer manda 1 transacción
    // SMTP con N RCPT TO — Gmail/Outlook contabilizan cada uno contra
    // el rate-limit diario, pero la VISIBILIDAD es solo del propio
    // destinatario en BCC.
    const html = renderBroadcastHtml({
      courseName: course.name as string,
      senderName,
      subject,
      body: message,
      appUrl,
      brandName: fromName,
    });
    const plain = `📢 ${course.name} — ${subject}\n\n${message}\n\n— Enviado por ${senderName} via ${fromName}`;

    const smtpStartMs = Date.now();
    try {
      const client = new SMTPClient({
        connection: {
          hostname: host,
          port,
          tls: port === 465,
          auth: { username: smtpUser, password: smtpPass },
        },
      });
      await client.send({
        from: `${fromName} <${from}>`,
        // 'to' = self para que el correo tenga un destinatario visible
        // válido. Si dejamos 'to' vacío con solo BCC algunos providers
        // (Gmail) marcan como spam por header "Undisclosed-recipients".
        to: from,
        bcc: bccEmails,
        replyTo: from,
        subject: `[${course.name}] ${subject}`,
        content: plain,
        html,
        headers: {
          "X-Entity-Ref-ID": `broadcast-${courseId}-${Date.now()}`,
        },
      });
      await client.close();

      void auditFromEdge(admin, {
        actorId,
        action: "broadcast.sent",
        category: "system",
        severity: "info",
        entityType: "course",
        entityId: courseId,
        metadata: {
          notified: students.length,
          bcc_count: bccEmails.length,
          smtp_ms: Date.now() - smtpStartMs,
          subject_len: subject.length,
          body_len: message.length,
        },
      });

      return jsonResponse({
        notified: students.length,
        email_sent: true,
        bcc_count: bccEmails.length,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void auditFromEdge(admin, {
        actorId,
        action: "broadcast.email_failed",
        category: "system",
        severity: "error",
        entityType: "course",
        entityId: courseId,
        metadata: {
          error: msg.slice(0, 500),
          notified: students.length,
          bcc_count: bccEmails.length,
        },
      });
      // Las notifs in-app SÍ salieron; el correo falló. Es un éxito
      // parcial — devolvemos 200 con warning para que el cliente no
      // muestre toast destructivo (sería confuso: el alumno sí recibe
      // la notif).
      return jsonResponse({
        notified: students.length,
        email_sent: false,
        bcc_count: bccEmails.length,
        warning: `Notificaciones in-app enviadas, pero el correo falló: ${msg}`,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void auditFromEdge(admin, {
      actorId,
      action: "broadcast.error",
      category: "system",
      severity: "error",
      entityType: "course",
      entityId: courseId ?? null,
      metadata: { error: msg },
    });
    return jsonError(msg, 500);
  }
});
