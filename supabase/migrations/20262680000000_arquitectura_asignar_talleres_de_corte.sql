-- ══════════════════════════════════════════════════════════════════════
-- Arquitectura de Sistemas Computacionales 6303C (UNIAJ): asignar los
-- talleres de corte a los matriculados.
--
-- Los tres estaban PUBLICADOS sin ninguna fila en `workshop_assignments`, y la
-- RLS le muestra al estudiante solo lo asignado: nadie los veía. El de Corte 1
-- («Modelos de servicio, virtualización y contenedores») cierra el 1 de
-- octubre. Decisión del docente (2026-09-30): un solo taller por corte, el de
-- Corte 1 al 10 % — el peso ya se corrigió por REST y «Taller Corte 1 (Clases
-- 1 a 4)», que solo tenía asignada la cuenta de prueba del dueño, quedó en 0 %.
--
-- Va por migración porque la RLS de escritura de `workshop_assignments` es solo
-- de Docente/Admin del tenant, y el SuperAdmin no puede insertar por REST. Es lo
-- mismo que hace la pantalla de talleres al guardar (`autoAssignWorkshop`):
-- todos los matriculados del curso, sin duplicar. No hay triggers de aviso en
-- `workshop_assignments`. Si el curso o un taller no existen (otro entorno), no
-- inserta nada.
-- ══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_n int;
BEGIN
  IF to_regclass('public.workshop_assignments') IS NULL OR to_regclass('public.course_enrollments') IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.workshop_assignments (workshop_id, user_id)
  SELECT w.id, ce.user_id
    FROM public.workshops w
    JOIN public.course_enrollments ce ON ce.course_id = 'b5499e08-0d90-4d4e-a8cb-944d2ba05013'::uuid
   WHERE w.id IN (
           '6721a9b3-a113-4669-97d6-854df3ddd8c4'::uuid,  -- Taller Corte 1 — Modelos de servicio…
           'eda4a37f-7bd0-4e68-a679-09a88f168fb2'::uuid,  -- Taller Corte 2 (Clases 6 a 10)
           '66c96ee5-126d-4633-b6a9-3a3c5dcea0a5'::uuid   -- Taller Corte 3 (Clases 11 a 15), formativo
         )
     AND w.course_id = 'b5499e08-0d90-4d4e-a8cb-944d2ba05013'::uuid
     AND w.deleted_at IS NULL
     AND NOT EXISTS (
           SELECT 1 FROM public.workshop_assignments wa
            WHERE wa.workshop_id = w.id AND wa.user_id = ce.user_id
         );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Arquitectura 6303C: % asignaciones de talleres de corte creadas', v_n;
END
$$;
