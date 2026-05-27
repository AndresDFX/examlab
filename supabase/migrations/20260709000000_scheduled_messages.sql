-- ──────────────────────────────────────────────────────────────────────
-- Mensajes programados (scheduled messages) — Docente/Admin
--
-- Permite programar el envío de un mensaje para una fecha/hora futura,
-- en dos modos:
--   - direct:    mensaje 1-a-1 a un destinatario (recipient_id).
--   - broadcast: difusión a TODOS los alumnos de uno o más cursos.
--
-- Dispatch 100% en SQL vía pg_cron (sin edge function): cada minuto la
-- función `dispatch_scheduled_messages()` toma las filas pending vencidas
-- y las envía:
--   - direct → inserta el mensaje en la conversación; el trigger
--     `tg_notify_new_message` dispara notif + correo al destinatario.
--   - broadcast → replica EXACTAMENTE la lógica de la edge
--     `broadcast-course-message` pero en SQL: 1 notif kind='broadcast'
--     por alumno (humanizando los tokens de tag a `#label`, dispara correo
--     por destinatario) + replica como mensaje 1-a-1 con tokens crudos
--     (chips) saltándose el trigger de notif vía el GUC `app.skip_message_notif`.
--
-- Autorización RE-VALIDADA en dispatch (no confía en lo agendado):
--   - direct → `can_message(creator, recipient)`.
--   - broadcast → Admin, o el creator dicta TODOS los course_ids.
-- Una fila no autorizada se marca 'failed' (no aborta el resto del batch).
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'broadcast')),
  -- direct: destinatario. broadcast: cursos. Validados por kind en la app
  -- y re-chequeados en dispatch.
  recipient_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  course_ids UUID[],
  subject TEXT,
  body TEXT NOT NULL CHECK (length(body) > 0 AND length(body) <= 10000),
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice para el barrido del cron: pending ordenadas por send_at.
CREATE INDEX IF NOT EXISTS scheduled_messages_due_idx
  ON public.scheduled_messages (send_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS scheduled_messages_creator_idx
  ON public.scheduled_messages (creator_id, created_at DESC);

ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;

-- SELECT: el creador ve los suyos; SuperAdmin ve todos.
DROP POLICY IF EXISTS "scheduled_messages select own" ON public.scheduled_messages;
CREATE POLICY "scheduled_messages select own"
  ON public.scheduled_messages FOR SELECT TO authenticated
  USING (creator_id = auth.uid() OR public.is_super_admin());

-- INSERT: solo como creador, y solo Docente o Admin (los Estudiantes no
-- programan difusiones ni mensajes masivos). La autorización fina (a quién
-- / a qué cursos) se re-valida en dispatch.
DROP POLICY IF EXISTS "scheduled_messages insert own" ON public.scheduled_messages;
CREATE POLICY "scheduled_messages insert own"
  ON public.scheduled_messages FOR INSERT TO authenticated
  WITH CHECK (
    creator_id = auth.uid()
    AND (
      public.has_role(auth.uid(), 'Docente'::public.app_role)
      OR public.has_role(auth.uid(), 'Admin'::public.app_role)
      OR public.is_super_admin()
    )
  );

-- UPDATE: el creador puede cancelar los suyos (solo cambia status). No
-- restringimos columnas a nivel policy; la app solo manda status='cancelled'.
DROP POLICY IF EXISTS "scheduled_messages update own" ON public.scheduled_messages;
CREATE POLICY "scheduled_messages update own"
  ON public.scheduled_messages FOR UPDATE TO authenticated
  USING (creator_id = auth.uid() OR public.is_super_admin())
  WITH CHECK (creator_id = auth.uid() OR public.is_super_admin());

-- DELETE: el creador borra los suyos (limpieza).
DROP POLICY IF EXISTS "scheduled_messages delete own" ON public.scheduled_messages;
CREATE POLICY "scheduled_messages delete own"
  ON public.scheduled_messages FOR DELETE TO authenticated
  USING (creator_id = auth.uid() OR public.is_super_admin());

-- ─────────────────────────────────────────── Función de dispatch
CREATE OR REPLACE FUNCTION public.dispatch_scheduled_messages()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_count INT := 0;
  v_conv_id UUID;
  v_msg_body TEXT;
  v_notif_body TEXT;
  v_student UUID;
  v_user_a UUID;
  v_user_b UUID;
BEGIN
  FOR r IN
    SELECT * FROM public.scheduled_messages
    WHERE status = 'pending' AND send_at <= now()
    ORDER BY send_at ASC
    LIMIT 200
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      -- Reset defensivo: las filas direct NO deben saltarse el trigger
      -- de notif (el destinatario debe enterarse). Solo broadcast lo
      -- activa alrededor de sus inserts de mensaje.
      PERFORM set_config('app.skip_message_notif', 'false', true);

      IF r.kind = 'direct' THEN
        IF r.recipient_id IS NULL OR NOT public.can_message(r.creator_id, r.recipient_id) THEN
          RAISE EXCEPTION 'No autorizado a mensajear al destinatario';
        END IF;
        v_user_a := LEAST(r.creator_id, r.recipient_id);
        v_user_b := GREATEST(r.creator_id, r.recipient_id);
        INSERT INTO public.conversations (user_a, user_b)
          VALUES (v_user_a, v_user_b)
          ON CONFLICT (user_a, user_b) DO NOTHING;
        SELECT id INTO v_conv_id FROM public.conversations
          WHERE user_a = v_user_a AND user_b = v_user_b;
        INSERT INTO public.messages (conversation_id, sender_id, body)
          VALUES (v_conv_id, r.creator_id, left(r.body, 4000));

      ELSIF r.kind = 'broadcast' THEN
        IF r.course_ids IS NULL OR cardinality(r.course_ids) = 0 THEN
          RAISE EXCEPTION 'broadcast sin cursos';
        END IF;
        -- Authz: Admin O dicta todos los cursos.
        IF NOT public.has_role(r.creator_id, 'Admin'::public.app_role) THEN
          IF EXISTS (
            SELECT 1 FROM unnest(r.course_ids) AS cid
            WHERE NOT EXISTS (
              SELECT 1 FROM public.course_teachers ct
              WHERE ct.course_id = cid AND ct.user_id = r.creator_id
            )
          ) THEN
            RAISE EXCEPTION 'No autorizado en uno o más cursos';
          END IF;
        END IF;

        -- Body humanizado (#label) para notif/correo; body con 📢 + tokens
        -- crudos para el mensaje replicado (chips en /app/messages).
        v_notif_body := regexp_replace(
          r.body,
          '\[\[T:(?:workshop|exam|project|content|video):[0-9a-f-]+:([^\]]+)\]\]',
          '#\1',
          'g'
        );
        v_msg_body := left('📢 ' || COALESCE(r.subject, '') || E'\n\n' || r.body, 4000);

        -- 1) Notificación por alumno único (dispara correo via trigger).
        INSERT INTO public.notifications (user_id, title, body, kind, link, related_user_id)
          SELECT DISTINCT e.user_id,
                 '📢 ' || COALESCE(r.subject, ''),
                 v_notif_body,
                 'broadcast',
                 '/app/messages',
                 r.creator_id
          FROM public.course_enrollments e
          WHERE e.course_id = ANY (r.course_ids)
            AND e.user_id <> r.creator_id;

        -- 2) Replica como mensaje 1-a-1 (skip del trigger de notif via GUC).
        PERFORM set_config('app.skip_message_notif', 'true', true);
        FOR v_student IN
          SELECT DISTINCT e.user_id
          FROM public.course_enrollments e
          WHERE e.course_id = ANY (r.course_ids)
            AND e.user_id <> r.creator_id
        LOOP
          v_user_a := LEAST(r.creator_id, v_student);
          v_user_b := GREATEST(r.creator_id, v_student);
          INSERT INTO public.conversations (user_a, user_b)
            VALUES (v_user_a, v_user_b)
            ON CONFLICT (user_a, user_b) DO NOTHING;
          SELECT id INTO v_conv_id FROM public.conversations
            WHERE user_a = v_user_a AND user_b = v_user_b;
          INSERT INTO public.messages (conversation_id, sender_id, body)
            VALUES (v_conv_id, r.creator_id, v_msg_body);
        END LOOP;
        PERFORM set_config('app.skip_message_notif', 'false', true);
      END IF;

      UPDATE public.scheduled_messages
        SET status = 'sent', sent_at = now(), error = NULL
        WHERE id = r.id;
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Una fila mala no tumba el batch: la marcamos failed con el motivo.
      UPDATE public.scheduled_messages
        SET status = 'failed', error = left(SQLERRM, 500)
        WHERE id = r.id;
    END;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ─────────────────────────────────────────── Cron cada minuto
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron no disponible; los mensajes programados deberán dispararse manualmente con SELECT public.dispatch_scheduled_messages().';
    RETURN;
  END;

  PERFORM extensions.cron.unschedule('dispatch-scheduled-messages')
  WHERE EXISTS (
    SELECT 1 FROM extensions.cron.job WHERE jobname = 'dispatch-scheduled-messages'
  );

  PERFORM extensions.cron.schedule(
    'dispatch-scheduled-messages',
    '* * * * *',
    $$ SELECT public.dispatch_scheduled_messages(); $$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Setup del cron de mensajes programados falló: %', SQLERRM;
END
$$;

-- Descripción para el panel admin de Cron (si la tabla existe).
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'dispatch-scheduled-messages',
  'Envía los mensajes programados (directos y de difusión) cuya fecha de envío ya pasó. Corre cada minuto.'
)
ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description;

NOTIFY pgrst, 'reload schema';
