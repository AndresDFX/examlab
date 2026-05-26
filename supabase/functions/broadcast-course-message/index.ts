// ──────────────────────────────────────────────────────────────────────
// broadcast-course-message — envía un anuncio a TODOS los estudiantes
// inscritos en UNO O MÁS cursos. Admin (cualquier curso) o Docente (solo
// cursos que dicta — debe dictar TODOS los seleccionados).
//
// Multi-curso: un alumno matriculado en >1 curso seleccionado recibe UNA
// sola notif/correo/mensaje (dedup por user_id).
//
// Efecto:
//   1. Bulk-insert de notificaciones (1 por estudiante único) con
//      kind='broadcast'. Desde la mig 20260708000000, 'broadcast' SÍ
//      está en `_notification_kind_emails`, así que el trigger SQL
//      `notify_send_email` dispara correo POR DESTINATARIO (camino
//      estándar: edge send-email, respetando preferencias/toggles).
//      Ya NO mandamos un BCC desde acá (no llegaba confiable + duplicaría).
//   2. Replicación como mensaje 1-a-1 en /app/messages: para cada alumno
//      se asegura la conversación canónica con el sender y se inserta UN
//      mensaje via RPC `insert_broadcast_messages` (que se salta el
//      trigger de notif de mensajes con un GUC para no duplicar).
//
// Body:
//   { courseIds: string[], subject, body }  — `courseId: string` legacy
//   también se acepta (normalizeCourseIds lo une a courseIds).
//
// Response:
//   { notified: number, email_sent: boolean, recipients_with_email: number }
//
// Errores:
//   401  No autenticado.
//   403  No es Admin ni Docente de uno o más cursos seleccionados.
//   404  Uno o más cursos no existen.
//   400  Body inválido o cursos sin alumnos.
//   500  DB error.
//
// Auditoría: log `broadcast.sent` con metadata { notified,
// recipients_with_email, subject_len, body_len }. La entrega real de
// cada correo se audita aparte por el flujo send-email (email.delivered
// / email.skipped / email.failed por usuario).
// ──────────────────────────────────────────────────────────────────────
import {
  adminClient as admin,
  corsHeaders,
  jsonError,
  jsonResponse,
  userClientFromRequest,
} from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";

interface BroadcastBody {
  /** Legacy single-course. Se acepta por compat; preferir `courseIds`. */
  courseId?: string;
  /** Multi-curso: difunde a varios cursos a la vez (dedup de alumnos). */
  courseIds?: string[];
  subject: string;
  body: string;
}

interface StudentProfile {
  id: string;
  full_name: string | null;
  institutional_email: string | null;
  personal_email: string | null;
}

/**
 * Normaliza `courseId` (legacy) / `courseIds` (nuevo) a IDs únicos no
 * vacíos. Réplica de `src/modules/messaging/broadcast.ts#normalizeCourseIds`
 * (Deno no puede importar de src/). Si cambia uno, actualizar el otro.
 */
function normalizeCourseIds(input: { courseId?: unknown; courseIds?: unknown }): string[] {
  const raw: unknown[] = Array.isArray(input.courseIds)
    ? input.courseIds
    : input.courseId != null
      ? [input.courseId]
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let actorId: string | undefined;
  let courseIds: string[] = [];

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
    courseIds = normalizeCourseIds(body);

    if (courseIds.length === 0) return jsonError("Selecciona al menos un curso", 400);
    if (!subject) return jsonError("subject requerido", 400);
    if (!message) return jsonError("body requerido", 400);
    // Topes defensivos. 200 chars en asunto cabe en clientes de correo
    // sin truncar; 10K en body es generoso para anuncios.
    if (subject.length > 200) return jsonError("subject demasiado largo (máx 200)", 400);
    if (message.length > 10000) return jsonError("body demasiado largo (máx 10K)", 400);

    // ── Roles del caller ──
    const { data: roleRows } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", actorId);
    const isAdmin = (roleRows ?? []).some((r: { role: string }) => r.role === "Admin");
    const isDocenteRole = (roleRows ?? []).some((r: { role: string }) => r.role === "Docente");

    // ── Cursos: existencia + autorización por cada uno ──
    // El Admin bypassa; el Docente debe dictar CADA curso seleccionado
    // (un solo curso no autorizado aborta todo — evita difusiones
    // parciales silenciosas).
    const { data: courseRows, error: courseErr } = await admin
      .from("courses")
      .select("id, name")
      .in("id", courseIds);
    if (courseErr) return jsonError(`No se pudieron leer cursos: ${courseErr.message}`, 500);
    const courses = (courseRows ?? []) as Array<{ id: string; name: string }>;
    if (courses.length !== courseIds.length) {
      return jsonError("Uno o más cursos no existen", 404);
    }

    if (!isAdmin) {
      const { data: taught } = await admin
        .from("course_teachers")
        .select("course_id")
        .eq("user_id", actorId)
        .in("course_id", courseIds);
      const taughtIds = new Set(
        ((taught ?? []) as Array<{ course_id: string }>).map((r) => r.course_id),
      );
      const unauthorized = courseIds.filter((id) => !taughtIds.has(id));
      if (unauthorized.length > 0) {
        return jsonError("No tienes permiso para enviar mensajes en uno o más cursos", 403);
      }
    }

    // ── Estudiantes inscritos (dedup a través de todos los cursos) ──
    // Un alumno en >1 curso seleccionado recibe UNA sola notif/correo/
    // mensaje. Dos queries (matrículas → perfiles) para no depender del
    // schema cache de PostgREST (no hay FK declarada course_enrollments→
    // profiles). El dedup réplica `dedupeRecipients` de
    // src/modules/messaging/broadcast.ts.
    const { data: enrollRows, error: enrollErr } = await admin
      .from("course_enrollments")
      .select("user_id")
      .in("course_id", courseIds);
    if (enrollErr) return jsonError(`No se pudo leer matrículas: ${enrollErr.message}`, 500);

    const seenIds = new Set<string>();
    const userIds: string[] = [];
    for (const r of (enrollRows ?? []) as Array<{ user_id?: string | null }>) {
      const id = r.user_id;
      if (typeof id !== "string" || !id || id === actorId || seenIds.has(id)) continue;
      seenIds.add(id);
      userIds.push(id);
    }

    if (userIds.length === 0) {
      return jsonError("Los cursos seleccionados no tienen estudiantes inscritos", 400);
    }

    const { data: profileRows, error: profileErr } = await admin
      .from("profiles")
      .select("id, full_name, institutional_email, personal_email")
      .in("id", userIds);
    if (profileErr) {
      return jsonError(`No se pudieron leer perfiles: ${profileErr.message}`, 500);
    }
    const students: StudentProfile[] = (profileRows ?? []) as StudentProfile[];

    if (students.length === 0) {
      return jsonError("Los cursos no tienen estudiantes con perfil válido", 400);
    }

    // ── Bulk-insert de notificaciones ──
    // `kind='broadcast'` AHORA SÍ dispara correo por destinatario (mig
    // 20260708000000 lo añadió a `_notification_kind_emails`). El trigger
    // `notify_send_email` se encarga, uno por alumno, respetando sus
    // preferencias. Acá solo insertamos las notifs.
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

    // ── Replicar como mensaje en cada conversación 1-a-1 ──
    // El bell + correo BCC ya cubren la difusión, pero el usuario espera
    // que el broadcast también aparezca en /app/messages → conversación
    // con el docente/admin. Para cada alumno: asegurar conversación
    // canónica (user_a < user_b) e insertar UN mensaje con el contenido
    // del broadcast.
    //
    // No bloqueamos en errores acá: si falla, las notifs in-app ya
    // están y el correo todavía puede salir. Auditamos el fallo y
    // seguimos.
    try {
      // 1) Filtrar self-conversation (poco probable: el sender no debería
      //    estar inscrito como alumno del curso que dicta, pero defensivo).
      const studentIdsForMessages = students
        .map((s) => s.id)
        .filter((id) => id !== actorId);

      if (studentIdsForMessages.length > 0) {
        // 2) Calcular pares canónicos (user_a < user_b por orden lexicográfico).
        const convPairs = studentIdsForMessages.map((sid) => {
          const [user_a, user_b] = actorId! < sid ? [actorId!, sid] : [sid, actorId!];
          return { user_a, user_b };
        });

        // 3) Insertar conversaciones que falten. ON CONFLICT DO NOTHING
        //    contra el UNIQUE (user_a, user_b) — las existentes quedan
        //    intactas (no perdemos cleared_at / last_read_at).
        const { error: convInsErr } = await admin
          .from("conversations")
          .upsert(convPairs, { onConflict: "user_a,user_b", ignoreDuplicates: true });
        if (convInsErr) {
          throw new Error(`upsert conversations: ${convInsErr.message}`);
        }

        // 4) Releer los IDs (necesitamos el conversation_id para insertar
        //    el mensaje). Filtrado server-side a conversaciones donde el
        //    sender es UNO de los participantes — la otra parte queda en
        //    el set de alumnos del curso. Evita traer conversaciones
        //    ajenas (estudiante-estudiante) que comparten user_id.
        const otherIds = studentIdsForMessages.join(",");
        const { data: convRows, error: convFetchErr } = await admin
          .from("conversations")
          .select("id, user_a, user_b")
          .or(
            `and(user_a.eq.${actorId},user_b.in.(${otherIds})),and(user_b.eq.${actorId},user_a.in.(${otherIds}))`,
          );
        if (convFetchErr) {
          throw new Error(`fetch conversations: ${convFetchErr.message}`);
        }

        // 5) Map student_id → conversation_id (escogemos la conv donde
        //    el otro participante es el sender actual).
        const convByStudent = new Map<string, string>();
        for (const row of (convRows ?? []) as Array<{
          id: string;
          user_a: string;
          user_b: string;
        }>) {
          const other = row.user_a === actorId ? row.user_b : row.user_a;
          if (other !== actorId && studentIdsForMessages.includes(other)) {
            convByStudent.set(other, row.id);
          }
        }

        // 6) Bulk-insert de mensajes via RPC `insert_broadcast_messages`.
        //    La RPC setea un GUC para que el trigger `tg_notify_new_message`
        //    se salte la creación automática de notificaciones — sin esto
        //    cada mensaje dispararía una notif kind='info' + email
        //    individual al alumno, duplicando el bell y rompiendo el BCC
        //    único del broadcast.
        //
        //    Body = "📢 subject\n\nmessage" para que el mensaje se
        //    distinga visualmente de los mensajes 1-a-1 normales.
        //    La RPC trunca a 4000 chars (CHECK de messages.body).
        const broadcastBody = `📢 ${subject}\n\n${message}`;
        const convIds: string[] = [];
        for (const sid of studentIdsForMessages) {
          const cid = convByStudent.get(sid);
          if (cid) convIds.push(cid);
        }

        if (convIds.length > 0) {
          // La RPC corre con la sesión del caller (no admin) para que
          // auth.uid() = actorId al checkear permisos. Usamos
          // userClient en vez del admin client.
          const { error: msgInsErr } = await userClient.rpc("insert_broadcast_messages", {
            _sender_id: actorId,
            _conv_ids: convIds,
            _body: broadcastBody,
          });
          if (msgInsErr) throw new Error(`insert_broadcast_messages: ${msgInsErr.message}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void auditFromEdge(admin, {
        actorId,
        action: "broadcast.messages_replication_failed",
        category: "system",
        severity: "warning",
        entityType: "course",
        entityId: courseIds[0] ?? null,
        metadata: { error: msg.slice(0, 500), notified: students.length, course_ids: courseIds },
      });
    }

    // ── Correo por destinatario (vía notificaciones) ──
    // Las notifs `kind='broadcast'` insertadas arriba disparan el trigger
    // `notify_send_email`, que ahora SÍ emaila broadcast (mig
    // 20260708000000) por el camino estándar: send-email edge, uno por
    // alumno, respetando preferencias + toggles del usuario. Ya NO
    // mandamos un BCC desde acá — eso (a) no llegaba confiablemente y
    // (b) duplicaría el correo con el camino por-destinatario.
    //
    // `count_with_email` es informativo para el toast del cliente: cuántos
    // alumnos tienen correo (el resto recibe solo la notif in-app).
    const countWithEmail = students.filter(
      (s) =>
        (s.institutional_email && s.institutional_email.trim()) ||
        (s.personal_email && s.personal_email.trim()),
    ).length;

    void auditFromEdge(admin, {
      actorId,
      action: "broadcast.sent",
      category: "system",
      severity: "info",
      entityType: "course",
      entityId: courseIds[0] ?? null,
      metadata: {
        notified: students.length,
        recipients_with_email: countWithEmail,
        course_ids: courseIds,
        course_count: courseIds.length,
        subject_len: subject.length,
        body_len: message.length,
      },
    });

    return jsonResponse({
      notified: students.length,
      email_sent: countWithEmail > 0,
      recipients_with_email: countWithEmail,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void auditFromEdge(admin, {
      actorId,
      action: "broadcast.error",
      category: "system",
      severity: "error",
      entityType: "course",
      entityId: courseIds[0] ?? null,
      metadata: { error: msg, course_ids: courseIds },
    });
    return jsonError(msg, 500);
  }
});
