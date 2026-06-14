-- ═══════════════════════════════════════════════════════════════════════
-- RPC para que Admin/SuperAdmin liberen MANUALMENTE jobs colgados en
-- `processing` desde la UI (botón "Liberar atascados" del panel de Cola IA).
--
-- Contexto: `release_stuck_processing_jobs` existe pero está GRANTeada solo a
-- service_role (la llama el pg_cron y el worker al inicio del drenado). La UI
-- corre con el JWT del usuario, así que necesita un wrapper autorizado.
--
-- Threshold por defecto 5 min (más corto que el cron de 30) para que el
-- usuario pueda rescatar un atasco reciente sin esperar. Clampeado 1..120.
--
-- Solo Admin o SuperAdmin: la función `release_stuck_processing_jobs` es
-- GLOBAL (toca TODOS los jobs en processing, sin scope de tenant), así que NO
-- se expone a Docente para no permitir que un docente toque jobs de otros.
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.admin_release_stuck_ai_jobs(_threshold_minutes INT DEFAULT 5)
RETURNS TABLE (released_to_pending INT, released_to_failed INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Solo Admin o SuperAdmin pueden liberar jobs atascados';
  END IF;

  _threshold_minutes := GREATEST(1, LEAST(120, COALESCE(_threshold_minutes, 5)));

  RETURN QUERY
    SELECT r.released_to_pending, r.released_to_failed
      FROM public.release_stuck_processing_jobs(_threshold_minutes, 3) AS r;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_release_stuck_ai_jobs(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_release_stuck_ai_jobs(INT) TO authenticated;

NOTIFY pgrst, 'reload schema';
