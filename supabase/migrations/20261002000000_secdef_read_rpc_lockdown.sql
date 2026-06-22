-- ============================================================================
-- Lockdown de RPCs de LECTURA SECURITY DEFINER (round 10).
--
-- Cierre del residual del round 8: estas 4 funciones de lectura quedaron con
-- EXECUTE para `authenticated` (solo se revocó anon), permitiendo que un Admin/
-- Docente de un tenant leyera metadata cross-tenant vía RPC directo:
--   - list_recent_ai_executions: audit_logs de ejecuciones IA platform-wide
--     (emails de actores, entity ids de todos los tenants).
--   - list_failed_ai_gradings: entregas con grading fallido platform-wide.
--   - course_pending_grading_count / count_ai_errors_last_hour: conteos.
--
-- Verificado: NINGUNA tiene caller real en el cliente (`.rpc(...)` = 0 usos en
-- src/). list_failed_ai_gradings solo la llama el edge retry-failed-ai-gradings
-- (service_role, conservado). Las otras son internas/no usadas. Por eso es
-- SEGURO revocar también de `authenticated` → quedan service_role+postgres.
--
-- resolve_certificate_settings NO se incluye: la usa de verdad el diálogo de
-- certificados (authenticated); su lectura cross-tenant es de baja severidad
-- (settings de plantilla de cert por curso) y scoparla requiere cambio de cuerpo
-- — queda anotado como follow-up.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.list_recent_ai_executions(integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.list_failed_ai_gradings(integer, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.course_pending_grading_count(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.count_ai_errors_last_hour(uuid) FROM authenticated;
