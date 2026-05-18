-- ──────────────────────────────────────────────────────────────────────
-- Setup de pg_cron jobs — idempotente.
--
-- Patrón: por cada job, llamamos UNSCHEDULE primero (silencia si no
-- existía) y luego SCHEDULE. Eso permite re-correr este archivo cuando
-- cambia algún schedule sin manejar errores manualmente.
--
-- Ejecutar UNA SOLA VEZ por entorno (dev / staging / prod) después de
-- aplicar las migraciones que definen las funciones SQL.
-- ──────────────────────────────────────────────────────────────────────

-- Pre-req: pg_cron habilitado. Si falla esto, hay que prenderlo en
-- Dashboard → Database → Extensions.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- ────────────────────────── 1) Recordatorios para estudiante
-- 1.a Examen que arranca en próx 1h
SELECT cron.unschedule('exam-reminders-1h')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'exam-reminders-1h');
SELECT cron.schedule(
  'exam-reminders-1h',
  '*/10 * * * *',
  $$ SELECT public.notify_students_exam_starting_soon(1); $$
);

-- 1.b Taller que vence en próx 24h
SELECT cron.unschedule('workshop-due-24h')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'workshop-due-24h');
SELECT cron.schedule(
  'workshop-due-24h',
  '0 */2 * * *',
  $$ SELECT public.notify_students_workshop_due_soon(24); $$
);

-- 1.c Proyecto que vence en próx 24h
SELECT cron.unschedule('project-due-24h')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'project-due-24h');
SELECT cron.schedule(
  'project-due-24h',
  '0 */2 * * *',
  $$ SELECT public.notify_students_project_due_soon(24); $$
);

-- ────────────────────────── 2) Recordatorios para docente
-- 2.a 1h antes del examen si hay notas de apoyo pendientes
SELECT cron.unschedule('teacher-exam-prep-1h')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'teacher-exam-prep-1h');
SELECT cron.schedule(
  'teacher-exam-prep-1h',
  '*/10 * * * *',
  $$ SELECT public.notify_teachers_pending_exam_notes_before_exam(1); $$
);

-- 2.b Resumen diario al final del día.
-- 04:00 UTC = 23:00 Colombia (UTC-5, sin DST).
SELECT cron.unschedule('teacher-daily-summary')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'teacher-daily-summary');
SELECT cron.schedule(
  'teacher-daily-summary',
  '0 4 * * *',
  $$ SELECT public.notify_teachers_daily_summary(); $$
);

-- ────────────────────────── 3) Alertas de sistema (admin)
-- 3.a Espacio en DB/storage bajo umbral. Cada 6 horas — frecuente para
-- detectar antes de que se llene; idempotencia 1/día por admin evita spam.
SELECT cron.unschedule('admin-storage-threshold')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'admin-storage-threshold');
SELECT cron.schedule(
  'admin-storage-threshold',
  '0 */6 * * *',
  $$ SELECT public.notify_admins_storage_threshold(); $$
);

-- ────────────────────────── 4) Apertura de ventana de examen
-- Notifica a los estudiantes cuando llega el start_time del examen.
-- Idempotencia 12h en la función — el cron cada 15 min cubre la latencia
-- sin duplicar avisos.
SELECT cron.unschedule('exam-window-opens')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'exam-window-opens');
SELECT cron.schedule(
  'exam-window-opens',
  '*/15 * * * *',
  $$ SELECT public.notify_students_exam_window_opens(30); $$
);

-- ────────────────────────── 5) Purga de audit_logs
-- 03:00 UTC del día 1 de cada mes. La función respeta el setting
-- `audit_retention_settings` (días por severidad, 0 = no purgar).
-- Default DB es 0/0/0 — hasta que el admin configure desde la UI,
-- este job corre pero no borra nada.
SELECT cron.unschedule('audit-logs-purge')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'audit-logs-purge');
SELECT cron.schedule(
  'audit-logs-purge',
  '0 3 1 * *',
  $$ SELECT public.purge_audit_logs(); $$
);

-- ────────────────────────── 6) Email alert threshold
-- Cada 30 min revisa si emails de últimas 24h exceden el umbral
-- configurado en app_settings (0 = desactivado). Notifica a admins.
SELECT cron.unschedule('email-alert-threshold')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-alert-threshold');
SELECT cron.schedule(
  'email-alert-threshold',
  '*/30 * * * *',
  $$ SELECT public.check_email_alert_threshold(); $$
);

-- ────────────────────────── 7) Reintento de AI gradings fallidos
-- Cada 30 min: busca submissions con `ai_error` en el breakdown (Gemini
-- 429 o error transitorio) y las recalifica. El cooldown de 30 min en
-- `list_failed_ai_gradings` evita que una submission se reintente más
-- de una vez por hora.
--
-- IMPORTANTE: requiere setear los siguientes parámetros de DB (una vez):
--   ALTER DATABASE postgres SET app.settings.retry_grading_url
--     = 'https://<PROJECT_REF>.supabase.co/functions/v1/retry-failed-ai-gradings';
--   ALTER DATABASE postgres SET app.settings.retry_grading_secret
--     = '<RETRY_TRIGGER_SECRET>';
-- Y `RETRY_TRIGGER_SECRET` debe existir como env var del edge (Lovable
-- → Settings → Edge Function Secrets) con el MISMO valor.
SELECT cron.unschedule('retry-failed-ai-gradings')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'retry-failed-ai-gradings');
SELECT cron.schedule(
  'retry-failed-ai-gradings',
  '*/30 * * * *',
  $$ SELECT public.trigger_retry_failed_ai_gradings(); $$
);

-- ────────────────────────── Verificación
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
