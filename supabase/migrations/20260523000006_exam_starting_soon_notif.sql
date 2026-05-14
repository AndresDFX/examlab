-- ──────────────────────────────────────────────────────────────────────
-- Recordatorio "Tu examen inicia pronto" — notificación + correo a
-- cada estudiante asignado a un examen que arranca dentro de la
-- ventana indicada (default 1 hora).
--
-- Diseño:
--   - SQL function llamable desde:
--     · pg_cron (si está disponible — preferido, sin dependencias externas)
--     · Edge function + scheduler externo (GitHub Actions, Cloudflare Cron)
--     · Manualmente desde el SQL editor para forzar el envío
--   - Idempotente: no duplica si ya se envió en las últimas 2h al mismo
--     usuario para el mismo examen. Así podés correrla cada 10 min sin
--     spammear al alumno.
--   - Excluye exámenes que el alumno ya entregó (status completado /
--     sospechoso) — no tiene sentido recordarle algo que ya hizo, p.ej.
--     en un intento de re-take antes del cierre.
--   - kind='exam' (CRITICAL_KIND) → el pipeline existente
--     (`notify_send_email` trigger) dispara correo automáticamente.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.notify_students_exam_starting_soon(
  _hours INTEGER DEFAULT 1
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count INTEGER;
BEGIN
  IF _hours IS NULL OR _hours < 1 OR _hours > 24 THEN
    -- Cordura: la ventana razonable para "starting soon" es 1-24h.
    -- Fuera de eso devolvemos 0 sin error.
    RETURN 0;
  END IF;

  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    ea.user_id,
    'Tu examen "' || e.title || '" inicia pronto',
    -- Body: incluye el curso (contexto) + cuánto falta. No hardcodeamos
    -- "1 hora" porque el _hours param es configurable; lo interpolamos.
    'El examen del curso "' || COALESCE(c.name, 'sin curso') ||
      '" inicia en menos de ' || _hours || ' hora(s). Prepárate.',
    'exam',
    '/app/student/exams'
  FROM public.exams e
  LEFT JOIN public.courses c ON c.id = e.course_id
  JOIN public.exam_assignments ea ON ea.exam_id = e.id
  WHERE e.start_time > NOW()
    AND e.start_time <= NOW() + make_interval(hours => _hours)
    -- Exclusión 1: alumno ya entregó → no le recordamos
    AND NOT EXISTS (
      SELECT 1 FROM public.submissions s
       WHERE s.exam_id = e.id
         AND s.user_id = ea.user_id
         AND s.status IN ('completado', 'sospechoso')
    )
    -- Exclusión 2: idempotencia — ya le mandamos un aviso de ESTE
    -- mismo examen en las últimas 2h. La ventana de 2h permite correr
    -- el cron cada 10 min sin duplicados ni perder eventos si el cron
    -- se atrasa.
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
       WHERE n.user_id = ea.user_id
         AND n.title = 'Tu examen "' || e.title || '" inicia pronto'
         AND n.created_at > NOW() - INTERVAL '2 hours'
    );

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END
$$;

REVOKE ALL ON FUNCTION public.notify_students_exam_starting_soon(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_students_exam_starting_soon(INTEGER) TO service_role;

-- ─────────────────────────────────────────────── Programación
-- Opción A — pg_cron (si está disponible en este Supabase):
--
--   CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
--   SELECT cron.schedule(
--     'exam-reminders-1h',
--     '*/10 * * * *',  -- cada 10 min
--     $$ SELECT public.notify_students_exam_starting_soon(1); $$
--   );
--
-- Opción B — sin pg_cron: invocar la RPC desde un scheduler externo:
--
--   curl -X POST 'https://<PROJECT_REF>.supabase.co/rest/v1/rpc/notify_students_exam_starting_soon' \
--     -H 'Authorization: Bearer <SERVICE_ROLE_KEY>' \
--     -H 'apikey: <SERVICE_ROLE_KEY>' \
--     -H 'Content-Type: application/json' \
--     -d '{"_hours": 1}'
--
-- Recomendado correrlo cada 10 minutos. Con la ventana de idempotencia
-- de 2h, no hay riesgo de duplicar correos.

NOTIFY pgrst, 'reload schema';
