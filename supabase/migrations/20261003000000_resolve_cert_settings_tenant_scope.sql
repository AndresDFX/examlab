-- ============================================================================
-- resolve_certificate_settings: scope del override por-curso al tenant (round 13).
--
-- La función (SECURITY DEFINER, EXECUTE a authenticated) recibe un _course_id y
-- devuelve el branding del certificado (institución, logo, firma, mensaje). El
-- override POR CURSO (course_certificate_settings) se leía SIN verificar que el
-- caller pueda ver el curso → un Admin/Docente de otro tenant que pasara un
-- course_id ajeno obtenía el branding de cert de ESE curso (fuga cross-tenant de
-- baja severidad: settings de plantilla, pero igual ajenos).
--
-- Fix: el override por-curso solo se aplica si course_in_my_tenant(_course_id)
-- (mismo tenant del caller, o SuperAdmin). Se hace con un AND en el WHERE (NO
-- con un IF) a propósito: `SELECT INTO` SIEMPRE asigna `_course` (a NULLs si el
-- WHERE no matchea) — un IF que saltara el SELECT dejaría `_course` SIN asignar
-- y `_course.institution_name` tiraría "record not assigned". Un probe cross-
-- tenant recibe solo el global/legacy; el caller legítimo, el override completo.
-- Firma + RETURNS idénticos → CREATE OR REPLACE sin DROP.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.resolve_certificate_settings(_course_id uuid)
 RETURNS TABLE(institution_name text, institution_logo_url text, signature_name text, signature_title text, signature_image_url text, certificate_message text, footer_text text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _global  RECORD;
  _course  RECORD;
  _legacy  RECORD;
BEGIN
  SELECT * INTO _global FROM public.certificate_settings LIMIT 1;
  -- Override por-curso SOLO si el caller puede ver el curso (su tenant o SA).
  -- El AND en el WHERE mantiene el SELECT INTO siempre ejecutado → `_course`
  -- queda asignado (a NULLs cuando no autorizado / no hay override).
  SELECT * INTO _course
    FROM public.course_certificate_settings
   WHERE course_id = _course_id
     AND public.course_in_my_tenant(_course_id);
  SELECT university_name, logo_url INTO _legacy FROM public.content_brand_config LIMIT 1;

  RETURN QUERY SELECT
    COALESCE(_course.institution_name,     _global.institution_name,     _legacy.university_name),
    COALESCE(_course.institution_logo_url, _global.institution_logo_url, _legacy.logo_url),
    COALESCE(_course.signature_name,       _global.signature_name),
    COALESCE(_course.signature_title,      _global.signature_title),
    COALESCE(_course.signature_image_url,  _global.signature_image_url),
    COALESCE(_course.certificate_message,  _global.certificate_message),
    COALESCE(_course.footer_text,          _global.footer_text);
END
$function$;
