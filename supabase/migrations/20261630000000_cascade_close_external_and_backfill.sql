-- ──────────────────────────────────────────────────────────────────────
-- Cerrar un curso debe cerrar TODO lo suyo — incluidas las actividades
-- EXTERNAS — y arreglar los cursos que ya estaban finalizados.
--
-- Reporte: en el tenant uniaj, exámenes de cursos del periodo 2026-1 (ya
-- `finalizado`) seguían apareciendo como **Publicado** en el grid del docente,
-- mezclados con los borradores del periodo nuevo. Dos causas distintas, las dos
-- reales:
--
--   1) El trigger `trg_cascade_close_on_course_finalized` (mig 20260991000000)
--      dispara SOLO en la TRANSICIÓN `<> finalizado → finalizado`. Los cursos que
--      ya estaban finalizados ANTES de esa migración nunca ejecutaron la cascada,
--      así que sus ítems quedaron publicados para siempre. Falta el backfill.
--
--   2) Las tres funciones `close_{exams,workshops,projects}_for_course` EXCLUÍAN
--      las actividades externas (`AND COALESCE(is_external,false) = false`, con
--      el comentario "externos solo registran nota"). Por eso, incluso con el
--      trigger corriendo, un `Parcial I` externo se quedaba `published` para
--      siempre. Era el caso EXACTO de la captura del reporte.
--
-- ── Por qué quitar la exclusión de externos es seguro ─────────────────
-- `status` de un examen/taller/proyecto es su CICLO DE VIDA (aparece como
-- abierto en los listados), no un permiso de calificación. Verificado antes de
-- tocarlo:
--   · `ExternalGradesEditor` NO lee `exams.status` — escribe el status de la
--     ENTREGA (`completado`/`calificado`) y la nota en las columnas de la
--     submission. Cerrar el examen no le quita al docente la capacidad de
--     registrar o corregir notas.
--   · El alumno NUNCA ve actividades externas: `app.student.exams.tsx` las
--     filtra de plano (`!e.is_external`), así que cerrarlas no le cambia nada.
--   · Y un curso solo llega a `finalizado` SIN pendientes de calificación
--     (mig 20260972), así que al momento del cierre las notas externas ya están.
-- O sea: la exclusión no protegía nada y sí producía el ruido reportado.
--
-- Defensiva: cada bloque va con guard `to_regclass` — si una tabla no existe en
-- el entorno, se omite en vez de abortar el deploy completo.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Las 3 funciones dejan de excluir las actividades externas ──────
-- Se recrean COMPLETAS (no se puede editar un cuerpo in-place). El resto de la
-- lógica se preserva textual respecto de 20260991000000, incluido el caveat M:N
-- de talleres/proyectos: solo se cierran si NINGÚN otro curso ligado sigue activo.

CREATE OR REPLACE FUNCTION public.close_exams_for_course(_course_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_count int := 0;
BEGIN
  IF to_regclass('public.exams') IS NULL THEN RETURN 0; END IF;
  WITH upd AS (
    UPDATE public.exams
       SET status = 'closed', updated_at = now()
     WHERE course_id = _course_id
       AND status <> 'closed'
       AND deleted_at IS NULL
       -- Los EXTERNOS también se cierran: ver el encabezado de esta migración.
    RETURNING id
  ) SELECT count(*) INTO v_count FROM upd;
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.close_exams_for_course(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.close_workshops_for_course(_course_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_count int := 0;
BEGIN
  IF to_regclass('public.workshops') IS NULL THEN RETURN 0; END IF;
  WITH upd AS (
    UPDATE public.workshops w
       SET status = 'closed', updated_at = now()
     WHERE w.deleted_at IS NULL
       AND w.status <> 'closed'
       AND ( w.id IN (SELECT workshop_id FROM public.workshop_courses WHERE course_id = _course_id)
             OR w.id IN (SELECT id FROM public.workshops WHERE course_id = _course_id) )
       -- caveat M:N: ningún OTRO curso ligado sigue activo
       AND NOT EXISTS (
         SELECT 1 FROM public.workshop_courses wc
           JOIN public.courses c ON c.id = wc.course_id
          WHERE wc.workshop_id = w.id AND wc.course_id <> _course_id
            AND c.deleted_at IS NULL AND c.status <> 'finalizado')
       AND NOT EXISTS (
         SELECT 1 FROM public.courses c
          WHERE c.id = w.course_id AND c.id <> _course_id
            AND c.deleted_at IS NULL AND c.status <> 'finalizado')
    RETURNING w.id
  ) SELECT count(*) INTO v_count FROM upd;
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.close_workshops_for_course(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.close_projects_for_course(_course_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_count int := 0; rec record;
BEGIN
  IF to_regclass('public.projects') IS NULL THEN RETURN 0; END IF;
  FOR rec IN
    SELECT DISTINCT p.id
      FROM public.projects p
      LEFT JOIN public.project_courses pc ON pc.project_id = p.id
     WHERE (pc.course_id = _course_id OR p.course_id = _course_id)
       AND p.deleted_at IS NULL
       AND p.status <> 'closed'
  LOOP
    -- caveat M:N: ningún OTRO curso ligado sigue activo
    IF EXISTS (
      SELECT 1 FROM public.project_courses pc2
        JOIN public.courses c ON c.id = pc2.course_id
       WHERE pc2.project_id = rec.id AND pc2.course_id <> _course_id
         AND c.deleted_at IS NULL AND c.status <> 'finalizado'
    ) OR EXISTS (
      SELECT 1 FROM public.projects p2
        JOIN public.courses c ON c.id = p2.course_id
       WHERE p2.id = rec.id AND p2.course_id <> _course_id
         AND c.deleted_at IS NULL AND c.status <> 'finalizado'
    ) THEN
      CONTINUE;
    END IF;
    UPDATE public.projects SET status = 'closed', updated_at = now()
     WHERE id = rec.id AND status <> 'closed';
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.close_projects_for_course(uuid) FROM PUBLIC;

-- ── 2) BACKFILL: cursos que YA estaban finalizados ───────────────────
-- Recorre TODOS los cursos `finalizado` no borrados y ejecuta la misma cascada
-- que habría corrido el trigger. Es idempotente (cada `close_*` filtra por
-- `status <> 'closed'`), así que volver a aplicarla no hace nada.
--
-- Se hace para TODOS los tenants a propósito, no solo para el que reportó: la
-- invariante "lo de un curso finalizado está cerrado" es global, y un tenant con
-- el mismo síntoma no tendría por qué esperar otro reporte.
--
-- Por curso va en su propio BEGIN/EXCEPTION: un fallo en uno no aborta el resto
-- ni la migración (mismo criterio que el trigger, que ya envuelve cada helper).
DO $$
DECLARE
  rec record;
  v_cursos int := 0;
  v_ex int := 0; v_wk int := 0; v_pj int := 0; v_wb int := 0; v_po int := 0; v_fo int := 0;
BEGIN
  IF to_regclass('public.courses') IS NULL THEN
    RAISE NOTICE 'public.courses no existe — se omite el backfill';
    RETURN;
  END IF;

  FOR rec IN
    SELECT id FROM public.courses
     WHERE status = 'finalizado' AND deleted_at IS NULL
  LOOP
    v_cursos := v_cursos + 1;
    BEGIN v_ex := v_ex + COALESCE(public.close_exams_for_course(rec.id), 0);
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'backfill exams curso %: %', rec.id, SQLERRM; END;
    BEGIN v_wk := v_wk + COALESCE(public.close_workshops_for_course(rec.id), 0);
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'backfill workshops curso %: %', rec.id, SQLERRM; END;
    BEGIN v_pj := v_pj + COALESCE(public.close_projects_for_course(rec.id), 0);
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'backfill projects curso %: %', rec.id, SQLERRM; END;
    BEGIN v_wb := v_wb + COALESCE(public.close_whiteboards_for_course(rec.id), 0);
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'backfill whiteboards curso %: %', rec.id, SQLERRM; END;
    BEGIN v_po := v_po + COALESCE(public.close_polls_for_course(rec.id), 0);
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'backfill polls curso %: %', rec.id, SQLERRM; END;
    BEGIN v_fo := v_fo + COALESCE(public.close_forums_for_course(rec.id), 0);
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'backfill forums curso %: %', rec.id, SQLERRM; END;
    BEGIN PERFORM public.close_checkin_for_course(rec.id);
    EXCEPTION WHEN OTHERS THEN RAISE WARNING 'backfill checkin curso %: %', rec.id, SQLERRM; END;
  END LOOP;

  RAISE NOTICE 'Backfill de cierre en cascada: % cursos finalizados revisados — exámenes=%, talleres=%, proyectos=%, pizarras=%, encuestas=%, foros=%',
    v_cursos, v_ex, v_wk, v_pj, v_wb, v_po, v_fo;
END $$;

NOTIFY pgrst, 'reload schema';
