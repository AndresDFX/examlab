-- ══════════════════════════════════════════════════════════════════════
-- resolve_certificate_settings: la lectura del branding GLOBAL usaba
-- `SELECT * FROM certificate_settings LIMIT 1` SIN filtro. Desde la mig
-- 20260625000000, certificate_settings es PER-TENANT (una fila por tenant,
-- RLS tenant_id = current_tenant_id()). Esta función es SECURITY DEFINER →
-- BYPASSA RLS → el LIMIT 1 sin ORDER BY devolvía el branding de OTRO tenant
-- (en la práctica el "default"/físicamente-primero). Resultado: cada certificado
-- emitido por un tenant NO-default snapshotea nombre/logo/firma/mensaje de la
-- institución equivocada (visible en el PDF y en la página pública /verify),
-- silenciosamente, cuando el curso no tiene override por-curso (el caso común).
--
-- Fix: derivar el tenant DEL CURSO y scopear SOLO la lectura `_global` a ese
-- tenant. `_legacy` (content_brand_config) queda igual: es global-by-design (sin
-- columna tenant_id). Derivar del curso (no de current_tenant_id()) mantiene
-- correcta la emisión por parte del SuperAdmin (cuyo current_tenant_id() es NULL).
-- El SELECT INTO se ejecuta siempre → `_global` queda en NULLs si el tenant no
-- tiene fila (mismo patrón que `_course`). Migración forward (las migs son inmutables).
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.resolve_certificate_settings(_course_id uuid)
 RETURNS TABLE(institution_name text, institution_logo_url text, signature_name text, signature_title text, signature_image_url text, certificate_message text, footer_text text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _global    RECORD;
  _course    RECORD;
  _legacy    RECORD;
  _tenant_id uuid;
BEGIN
  SELECT tenant_id INTO _tenant_id FROM public.courses WHERE id = _course_id;
  -- Global del TENANT DEL CURSO (no un LIMIT 1 sin filtro que devolvía otro tenant).
  SELECT * INTO _global
    FROM public.certificate_settings
   WHERE tenant_id = _tenant_id
   LIMIT 1;
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

NOTIFY pgrst, 'reload schema';
