-- ══════════════════════════════════════════════════════════════════════
-- Recordatorio recurrente al docente: "cerrá tu curso desde la plataforma".
--
-- CONTEXTO / auditoría:
--   • Un curso cuya fecha de fin ya pasó pero que sigue en_curso NO se cierra
--     solo. El cron auto-finalize (04:00 UTC) finaliza únicamente los cursos
--     "limpios" (sin pendientes de calificación); los que tienen entregas sin
--     calificar quedan vivos hasta que el docente los cierra a mano. Un curso
--     reabierto manualmente con end_date pasada también queda en_curso.
--   • Ese aviso vivía ACOPLADO dentro de auto_finalize_courses (bloque ELSE,
--     grading-céntrico, in-app). Acá se DESACOPLA a una función/cron dedicados
--     con texto orientado al CIERRE del curso, y se elimina el bloque ELSE de
--     auto_finalize_courses para que haya UNA sola voz (sin doble notif).
--
-- DECISIÓN DE CORREO: NO emaila. Se usa kind='system' + link='/app/teacher/courses'
--   que NO matchea el predicado public._notification_kind_emails → queda SOLO en
--   la campana. Coherente con la decisión de 20260705100000 (los digests al
--   docente van solo in-app; el docente solo quiere correo de cosas que exigen
--   respuesta inmediata). Recordatorio in-app únicamente.
--
-- El recordatorio NO cierra nada por sí mismo: EMPUJA al docente a usar el flujo
--   existente (grid de cursos → acción "Finalizar curso" → RPC set_course_status,
--   que dispara la cascada de cierre de exámenes/talleres/proyectos/pizarras/
--   encuestas/foros/check-in). Notas y certificados se conservan por diseño.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) Función dedicada del recordatorio + consolidación de auto_finalize ──
DO $mig$
BEGIN
  IF to_regclass('public.courses') IS NULL
     OR to_regclass('public.notifications') IS NULL
     OR to_regclass('public.course_teachers') IS NULL THEN
    RAISE NOTICE 'skip course close reminder: tabla(s) ausente(s)';
    RETURN;
  END IF;

  -- 1a) notify_teachers_course_pending_close(): una notif por docente por curso
  --     vivo vencido. Anti-spam por (curso, docente) con ventana de 3 días
  --     (≥2× la cadencia diaria → recuerda ~cada 3 días, persistente sin spam).
  CREATE OR REPLACE FUNCTION public.notify_teachers_course_pending_close()
  RETURNS INTEGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  DECLARE
    rec       RECORD;
    v_count   INTEGER := 0;
    v_batch   INTEGER;
    v_pending INTEGER;
    v_title   TEXT;
    v_body    TEXT;
  BEGIN
    FOR rec IN
      SELECT id, name, end_date
        FROM public.courses
       WHERE status = 'en_curso'
         AND end_date IS NOT NULL
         AND end_date < CURRENT_DATE
         AND deleted_at IS NULL
    LOOP
      v_pending := public.course_pending_grading_count(rec.id);

      -- Título estable por curso → sirve de clave de dedupe del anti-spam.
      v_title := '⏰ Cierra tu curso: ' || rec.name;

      IF v_pending > 0 THEN
        v_body := 'El curso «' || rec.name || '» terminó el '
          || to_char(rec.end_date, 'DD/MM/YYYY')
          || ' y sigue activo. Tiene ' || v_pending
          || ' entrega(s) pendiente(s) de calificación: revisá el Diagnóstico del '
          || 'curso, calificá y luego ciérralo desde la plataforma. Al cerrarlo se '
          || 'archivan exámenes, talleres, proyectos, pizarras, encuestas y foros; '
          || 'las notas y certificados se conservan.';
      ELSE
        -- Defensivo: normalmente auto_finalize ya cerró estos (0 pendientes).
        -- Cubre el caso de curso reabierto manualmente con end_date pasada.
        v_body := 'El curso «' || rec.name || '» terminó el '
          || to_char(rec.end_date, 'DD/MM/YYYY')
          || ' y sigue activo. Ciérralo desde la plataforma para archivar su contenido.';
      END IF;

      INSERT INTO public.notifications (user_id, title, body, kind, link)
      SELECT ct.user_id, v_title, v_body, 'system', '/app/teacher/courses'
        FROM public.course_teachers ct
       WHERE ct.course_id = rec.id
         AND NOT EXISTS (
           SELECT 1 FROM public.notifications n
            WHERE n.user_id = ct.user_id
              AND n.title = v_title
              AND n.created_at > now() - INTERVAL '3 days'
         );

      GET DIAGNOSTICS v_batch = ROW_COUNT;
      v_count := v_count + v_batch;
    END LOOP;

    RETURN v_count;
  END
  $fn$;

  -- Solo el cron (service_role) la invoca. Sin GRANT a anon/authenticated.
  REVOKE ALL ON FUNCTION public.notify_teachers_course_pending_close() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.notify_teachers_course_pending_close() TO service_role;

  -- 1b) Consolidación: auto_finalize_courses() pierde su bloque ELSE de notif.
  --     El recordatorio pasa a ser responsabilidad EXCLUSIVA de la función de
  --     arriba → una sola voz, sin doble aviso al docente.
  CREATE OR REPLACE FUNCTION public.auto_finalize_courses()
  RETURNS INT
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  DECLARE
    rec RECORD;
    v_count INT := 0;
    v_pending INT;
  BEGIN
    FOR rec IN
      SELECT id, name FROM public.courses
       WHERE status = 'en_curso'
         AND end_date IS NOT NULL
         AND end_date < CURRENT_DATE
         AND deleted_at IS NULL
    LOOP
      v_pending := public.course_pending_grading_count(rec.id);

      -- Sin pendientes → finalizar automáticamente (dispara la cascada de cierre).
      -- Con pendientes → NO finalizar; el recordatorio dedicado
      -- (notify_teachers_course_pending_close) avisa al docente. Ya NO se
      -- notifica desde acá para no duplicar.
      IF v_pending = 0 THEN
        UPDATE public.courses
          SET status = 'finalizado', finalized_at = now(), finalized_by = NULL
          WHERE id = rec.id;
        v_count := v_count + 1;
      END IF;
    END LOOP;

    RETURN v_count;
  END
  $fn$;

  GRANT EXECUTE ON FUNCTION public.auto_finalize_courses() TO authenticated;
END
$mig$;

-- ── 2) Cron diario 05:00 UTC (offset +1h vs auto-finalize 04:00, para correr
--       DESPUÉS y no avisar de cursos que ese mismo pase acaba de finalizar) ──
DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    RAISE NOTICE 'pg_cron no instalado, salida limpia.';
    RETURN;
  END IF;

  -- OJO: cron.schedule (schema cron), NUNCA extensions.cron.schedule
  -- (Postgres lo interpreta como referencia cross-database y el EXCEPTION del
  -- DO se lo traga en silencio → el job jamás se registra).
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notify-teacher-course-pending-close') THEN
    PERFORM cron.schedule(
      'notify-teacher-course-pending-close',
      '0 5 * * *',
      $job$ SELECT public.notify_teachers_course_pending_close(); $job$
    );
  END IF;
END
$cron$;

-- ── 3) Descripción humana (módulo Cron del Admin) ──
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'notify-teacher-course-pending-close',
  'Diario 05:00 UTC: recuerda a los docentes cerrar desde la plataforma los cursos cuya fecha de fin ya pasó y siguen en curso (típicamente por entregas pendientes de calificación, o cursos reabiertos manualmente). Anti-spam: máx. 1 notif por docente/curso cada 3 días. Solo campana (kind=system), sin correo.'
)
ON CONFLICT (jobname) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = now();

NOTIFY pgrst, 'reload schema';
