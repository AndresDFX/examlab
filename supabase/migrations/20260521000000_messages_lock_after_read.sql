-- ──────────────────────────────────────────────────────────────────────
-- Bloquear edit/delete de mensajes una vez que el destinatario los leyó.
--
-- Antes:
--   - `messages update sender`: cualquier mensaje propio se podía editar.
--   - `messages delete own`: cualquier mensaje propio se podía borrar.
--
-- Ahora: el sender PUEDE editar/borrar SOLO mientras el otro usuario
-- de la conversación NO haya leído el mensaje. Una vez que el receptor
-- abrió la conversación (= se llamó `mark_conversation_read` y el
-- timestamp registrado es ≥ created_at del mensaje), el mensaje queda
-- "congelado" — el sender no puede modificar ni borrar.
--
-- Razón: si el destinatario ya leyó "te debo $50" y el sender lo borra
-- después, queda registro asimétrico (uno lo recuerda, el otro no).
-- WhatsApp/Telegram tienen ventana de tiempo para esto; aquí usamos el
-- evento "leído" que ya trackeábamos como límite natural.
--
-- Implementación: función IMMUTABLE-like (en realidad STABLE porque
-- consulta tablas, pero el predicado vive del UPDATE/DELETE row → es
-- aceptable). PostgreSQL no permite subqueries en CHECK constraints
-- pero SÍ en RLS policies, así que el predicado puede ser inline.
-- ──────────────────────────────────────────────────────────────────────

-- Helper consultable: ¿este mensaje YA fue leído por el otro lado?
-- Devuelve true si el receptor (el user_a/b distinto al sender) tiene
-- last_read_at >= created_at del mensaje. False en cualquier otro
-- caso (incluye "nunca leyó" o "leyó algo previo pero no este").
CREATE OR REPLACE FUNCTION public._message_was_read_by_other(_message_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.messages m
    JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.id = _message_id
      AND (
        -- Sender es user_a → "otro" es user_b → comparar user_b_last_read_at
        (m.sender_id = c.user_a
          AND c.user_b_last_read_at IS NOT NULL
          AND c.user_b_last_read_at >= m.created_at)
        OR
        -- Sender es user_b → "otro" es user_a → comparar user_a_last_read_at
        (m.sender_id = c.user_b
          AND c.user_a_last_read_at IS NOT NULL
          AND c.user_a_last_read_at >= m.created_at)
      )
  );
$$;

-- Reemplazar policy UPDATE de messages. El sender solo edita mientras
-- el otro NO haya leído el mensaje. NOTE: aplicamos USING (lectura de
-- la fila para el UPDATE) Y WITH CHECK (la fila nueva tras el UPDATE).
DROP POLICY IF EXISTS "messages update sender" ON public.messages;
CREATE POLICY "messages update sender"
ON public.messages FOR UPDATE TO authenticated
USING (
  sender_id = auth.uid()
  AND NOT public._message_was_read_by_other(id)
)
WITH CHECK (
  sender_id = auth.uid()
);

-- Reemplazar policy DELETE — misma regla.
DROP POLICY IF EXISTS "messages delete own" ON public.messages;
CREATE POLICY "messages delete own"
ON public.messages FOR DELETE TO authenticated
USING (
  sender_id = auth.uid()
  AND NOT public._message_was_read_by_other(id)
);

NOTIFY pgrst, 'reload schema';
