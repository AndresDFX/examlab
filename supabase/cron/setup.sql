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

-- ────────────────────────── Verificación
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
