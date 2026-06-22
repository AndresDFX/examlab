-- ============================================================================
-- Lockdown de funciones CRON-only expuestas a anon/authenticated (round 9).
--
-- Continuación del round 8. 15 funciones que SOLO invoca pg_cron (corren como
-- postgres) estaban EXECUTE-ables por anon Y authenticated → vía PostgREST
-- cualquiera podía dispararlas. Vectores de abuso reales:
--   🔴 purge_audit_logs / purge_deleted_items: disparar PURGES (borrado de
--      audit logs / hard-delete anticipado de la papelera).
--   🔴 auto_finalize_courses: FINALIZAR en masa los cursos elegibles (cambio de
--      estado + cascade-close).
--   🟠 notify_students_* / notify_teachers_* (6): disparar notificaciones + CORREOS
--      masivos → spam + costo de email.
--   🟠 apply_pending_email_changes: forzar la aplicación de cambios de email
--      pendientes; _cron_run_weekly_db_backup: disparar un backup (recurso/costo);
--      retry_failed_email_notifications / trigger_retry_failed_ai_gradings:
--      tormentas de reintentos; check_email_alert_threshold /
--      notify_admins_storage_threshold: alertas falsas.
--
-- Ninguna tiene caller de usuario legítimo (los Admin finalizan un curso
-- puntual con set_course_status, NO con auto_finalize_courses; los recordatorios
-- y purges son agendados). REVOKE de anon+authenticated → cron (postgres) y
-- edges (service_role) conservan acceso, así que NO rompe nada. Solo grants,
-- sin cambios de lógica.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public._cron_run_weekly_db_backup() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.apply_pending_email_changes() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_finalize_courses() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_email_alert_threshold() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_admins_storage_threshold() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_students_exam_starting_soon(integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_students_exam_window_opens(integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_students_project_due_soon(integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_students_workshop_due_soon(integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_teachers_daily_summary() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.notify_teachers_pending_exam_notes_before_exam(integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_audit_logs() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.purge_deleted_items(interval) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.retry_failed_email_notifications() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trigger_retry_failed_ai_gradings() FROM anon, authenticated;
