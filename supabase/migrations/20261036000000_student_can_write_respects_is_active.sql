-- ══════════════════════════════════════════════════════════════════════
-- Endurecer la DESACTIVACIÓN: bloquear la escritura de entregas de un usuario
-- inactivo a nivel RLS, no solo en el gate de UI.
--
-- Contexto (ciclo 5): el ban de GoTrue rechaza el LOGIN/refresh del usuario
-- desactivado, pero su access token vivo dura ~1h; el gate de AppLayout
-- (is_active=false) es cliente. En esa ventana, un usuario desactivado con su
-- token aún podía escribir vía REST. Las columnas de nota ya quedaron protegidas
-- (20261034) y el auto-reactivarse (20261035), pero un desactivado todavía podía
-- INSERTAR/actualizar answers de una entrega en esa ventana.
--
-- `student_can_write(_uid)` ya es el guard RESTRICTIVE de INSERT/UPDATE de
-- submissions / workshop_submissions / project_submissions (y de nadie más).
-- Le agregamos `is_active = false` a la condición de bloqueo: un usuario
-- desactivado (o con estado académico retirado/aplazado/graduado) NO puede
-- crear ni modificar entregas — enforcement inmediato a nivel DB, dentro de la
-- ventana del JWT. service_role (calificación con IA) bypassa RLS → no afectado.
-- is_active es NOT NULL DEFAULT true → los usuarios normales pasan igual.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.student_can_write(_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = _uid
      AND (p.estado IN ('retirado', 'aplazado', 'graduado') OR p.is_active = false)
  );
$function$;

NOTIFY pgrst, 'reload schema';
