-- ──────────────────────────────────────────────────────────────────────
-- Teardown de pg_cron jobs — desprograma todos los jobs de ExamLab.
--
-- Útil para:
--  - Pausar todos los recordatorios durante vacaciones / pruebas
--  - Migrar a otro proveedor de email y querer apagar el flujo
--    temporal antes de re-configurar
--  - Limpiar antes de re-correr setup.sql con cambios
--
-- NO borra las funciones SQL (esas están en migraciones / schema).
-- Solo remueve las entradas de cron.job. Para volver a programar,
-- correr `setup.sql`.
--
-- Idempotente: si algún job no existe, el WHERE EXISTS lo silencia.
-- ──────────────────────────────────────────────────────────────────────

SELECT cron.unschedule('exam-reminders-1h')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'exam-reminders-1h');

SELECT cron.unschedule('workshop-due-24h')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'workshop-due-24h');

SELECT cron.unschedule('project-due-24h')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'project-due-24h');

SELECT cron.unschedule('teacher-exam-prep-1h')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'teacher-exam-prep-1h');

SELECT cron.unschedule('teacher-daily-summary')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'teacher-daily-summary');

SELECT cron.unschedule('admin-storage-threshold')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'admin-storage-threshold');

SELECT cron.unschedule('exam-window-opens')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'exam-window-opens');

SELECT cron.unschedule('audit-logs-purge')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'audit-logs-purge');

-- Confirmar — la lista debería estar vacía (o solo con jobs externos
-- que no son de ExamLab).
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
