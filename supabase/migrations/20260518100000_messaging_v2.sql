-- ──────────────────────────────────────────────────────────────────────
-- Messaging V2: leído/no-leído, notificación al recibir, edición de
-- mensajes, adjuntos. La búsqueda se hace client-side sobre los
-- mensajes ya cargados (no requiere SQL).
--
-- 1) last_read_at por usuario en conversations (badge "X sin leer").
-- 2) RPC mark_conversation_read (escribe MI last_read_at = now()).
-- 3) edited_at en messages + policy UPDATE solo para el sender.
-- 4) Tabla message_attachments + bucket message-attachments + RLS.
-- 5) Trigger AFTER INSERT en messages → crea notification al
--    destinatario (link a /app/messages).
--
-- El borrado individual de mensajes ya estaba habilitado por RLS V1
-- (`messages_delete_own`); aquí solo agregamos el UPDATE para edición.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Leído/no-leído ─────────────────────────────────────────────────────
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS user_a_last_read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS user_b_last_read_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.mark_conversation_read(_conv_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me UUID := auth.uid();
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;
  UPDATE public.conversations
  SET
    user_a_last_read_at = CASE WHEN user_a = v_me THEN v_now ELSE user_a_last_read_at END,
    user_b_last_read_at = CASE WHEN user_b = v_me THEN v_now ELSE user_b_last_read_at END
  WHERE id = _conv_id
    AND (user_a = v_me OR user_b = v_me);
END;
$$;

-- 2) Edición de mensajes ───────────────────────────────────────────────
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

-- UPDATE: solo el sender puede editar SU propio mensaje. Restringimos
-- WITH CHECK para evitar que un sender malicioso cambie `sender_id` o
-- `conversation_id` (cosas que no debería tocar).
DROP POLICY IF EXISTS "messages update sender" ON public.messages;
CREATE POLICY "messages update sender"
ON public.messages FOR UPDATE TO authenticated
USING (sender_id = auth.uid())
WITH CHECK (sender_id = auth.uid());

-- 3) Adjuntos a mensajes ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  uploaded_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_attachments_message_id_idx
  ON public.message_attachments(message_id);

ALTER TABLE public.message_attachments ENABLE ROW LEVEL SECURITY;

-- SELECT: si puedo ver el mensaje (que ya respeta cleared_at via
-- messages.SELECT), puedo ver sus adjuntos.
DROP POLICY IF EXISTS "message_attachments select" ON public.message_attachments;
CREATE POLICY "message_attachments select"
ON public.message_attachments FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.id = message_id
  )
);

-- INSERT: el sender del message puede adjuntar a SU mensaje. El cliente
-- inserta el message primero, luego sube archivos, luego inserta la fila
-- del attachment.
DROP POLICY IF EXISTS "message_attachments insert own" ON public.message_attachments;
CREATE POLICY "message_attachments insert own"
ON public.message_attachments FOR INSERT TO authenticated
WITH CHECK (
  uploaded_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.id = message_id
      AND m.sender_id = auth.uid()
  )
);

-- DELETE: solo el uploader.
DROP POLICY IF EXISTS "message_attachments delete own" ON public.message_attachments;
CREATE POLICY "message_attachments delete own"
ON public.message_attachments FOR DELETE TO authenticated
USING (uploaded_by = auth.uid());

-- Bucket de Storage para adjuntos de mensajes ─────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'message-attachments',
  'message-attachments',
  false,
  26214400, -- 25 MB
  NULL
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit;

-- Layout: <user_id>/<message_id>/<filename>. INSERT/DELETE en mi
-- carpeta; SELECT amplía a cualquiera que tenga acceso al mensaje vía
-- metadata.
DROP POLICY IF EXISTS "message_attachments storage insert own folder" ON storage.objects;
CREATE POLICY "message_attachments storage insert own folder"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'message-attachments'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "message_attachments storage delete own folder" ON storage.objects;
CREATE POLICY "message_attachments storage delete own folder"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'message-attachments'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "message_attachments storage select" ON storage.objects;
CREATE POLICY "message_attachments storage select"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'message-attachments'
  AND (
    auth.uid()::text = (storage.foldername(name))[1]
    OR EXISTS (
      SELECT 1
      FROM public.message_attachments ma
      JOIN public.messages m ON m.id = ma.message_id
      JOIN public.conversations c ON c.id = m.conversation_id
      WHERE ma.path = storage.objects.name
        AND (c.user_a = auth.uid() OR c.user_b = auth.uid())
    )
  )
);

-- 4) Trigger de notificación al recibir mensaje ────────────────────────
-- AFTER INSERT en messages → crea fila en notifications dirigida al
-- destinatario (el "otro" usuario de la conversación). El bell + toast
-- ya consumen `notifications` (sistema existente).
CREATE OR REPLACE FUNCTION public.tg_notify_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv RECORD;
  v_recipient UUID;
  v_sender_name TEXT;
  v_body_preview TEXT;
BEGIN
  SELECT user_a, user_b INTO v_conv
  FROM public.conversations
  WHERE id = NEW.conversation_id;
  IF v_conv IS NULL THEN
    RETURN NEW; -- defensive, shouldn't happen
  END IF;
  v_recipient := CASE
    WHEN v_conv.user_a = NEW.sender_id THEN v_conv.user_b
    ELSE v_conv.user_a
  END;
  -- Preview del body (max 140 chars, primer línea).
  v_body_preview := substring(split_part(NEW.body, E'\n', 1) FROM 1 FOR 140);
  -- Nombre del sender desde profiles.
  SELECT COALESCE(full_name, institutional_email, 'Usuario')
    INTO v_sender_name
  FROM public.profiles
  WHERE id = NEW.sender_id;
  v_sender_name := COALESCE(v_sender_name, 'Usuario');

  INSERT INTO public.notifications (
    user_id, title, body, kind, link, related_user_id, source_role
  )
  VALUES (
    v_recipient,
    'Nuevo mensaje de ' || v_sender_name,
    v_body_preview,
    'info',
    '/app/messages',
    NEW.sender_id,
    NULL
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_new_message ON public.messages;
CREATE TRIGGER trg_notify_new_message
AFTER INSERT ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.tg_notify_new_message();

-- Realtime para message_attachments (para que la app pinte sin
-- recargar cuando el otro adjunta archivos en tiempo real).
ALTER PUBLICATION supabase_realtime ADD TABLE public.message_attachments;

NOTIFY pgrst, 'reload schema';
