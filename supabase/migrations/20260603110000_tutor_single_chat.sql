-- ──────────────────────────────────────────────────────────────────────
-- Tutor IA → una sola conversación por (estudiante, curso).
--
-- Antes: cada alumno podía crear N sesiones por curso (sidebar "Nueva
-- conversación"). Ahora el chat es persistente y único — el alumno
-- continúa siempre donde quedó, el docente puede limpiar la conversación
-- pero no genera múltiples hilos. Simplifica la UX y evita que el
-- contexto del tutor se fragmente entre conversaciones que el alumno
-- abre por accidente.
--
-- Migración:
--   1) Para cada (user_id, course_id), conservar la sesión con
--      `updated_at` más reciente y borrar el resto (sus mensajes caen
--      por CASCADE definido en tutor_chat_messages.session_id).
--   2) Crear UNIQUE INDEX (user_id, course_id) para impedir duplicados
--      futuros a nivel DB. La app NO debería intentar crear duplicados,
--      pero el índice es defensa en profundidad.
-- ──────────────────────────────────────────────────────────────────────

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, course_id
           ORDER BY updated_at DESC, created_at DESC
         ) AS rn
    FROM public.tutor_chat_sessions
)
DELETE FROM public.tutor_chat_sessions
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS tutor_chat_sessions_user_course_uidx
  ON public.tutor_chat_sessions(user_id, course_id);

NOTIFY pgrst, 'reload schema';
