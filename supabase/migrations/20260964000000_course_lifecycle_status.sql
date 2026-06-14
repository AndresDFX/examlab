-- ──────────────────────────────────────────────────────────────────────
-- Estado de ciclo de vida del curso: borrador → en_curso → finalizado.
--
-- Hasta ahora el grid de cursos derivaba "Activo/Próximo/Terminado"
-- puramente de las fechas (start_date/end_date vs hoy). Eso tenía dos
-- problemas:
--   - Un curso recién creado y aún sin configurar igual aparecía como
--     "activo" o "terminado" según sus fechas.
--   - Un curso cuya fecha de fin ya pasó SIEMPRE se mostraba "terminado",
--     sin posibilidad de mantenerlo abierto ni de que el docente
--     controlara el cierre.
--
-- Modelo nuevo: una columna `status` EXPLÍCITA es la fuente de verdad del
-- ciclo de vida. Los 3 valores reflejan el ciclo nombrado por el usuario:
--   - borrador:   el docente lo está armando (pesos/cortes/fechas). Default
--                 para cursos NUEVOS — el cron de auto-finalización NO lo
--                 toca antes de publicarse.
--   - en_curso:   publicado y operativo. La distinción Próximo/En curso
--                 (derivada de la fecha de inicio) vive DENTRO de este
--                 estado, en el cliente.
--   - finalizado: estado terminal. Solo se alcanza EXPLÍCITAMENTE: manual
--                 (docente/admin) o automático (cron diario por fecha de fin).
--
-- `finalized_at` / `finalized_by` registran CUÁNDO y QUIÉN finalizó. El cron
-- pone `finalized_by = NULL` (cierre automático); la acción manual pone el
-- uid del actor. Eso distingue cierre por fecha de cierre deliberado.
--
-- Decisión NO tomada: un 4º valor 'archivado'. El proyecto ya tiene Papelera
-- (soft-delete) para retirar cursos, así que 'finalizado' es el estado
-- terminal del ciclo y el archivado queda fuera de alcance.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Columna status + finalized_at/by + CHECK + índice + backfill ──
-- Todo dentro del guard to_regclass: Lovable a veces marca una migración
-- de CREATE TABLE como aplicada aunque la tabla NO exista en el entorno
-- del usuario; sin el guard el ALTER falla y aborta todo el deploy.
DO $$
BEGIN
  IF to_regclass('public.courses') IS NOT NULL THEN
    -- status: agregar idempotente (la columna puede existir si la migración
    -- se re-corre o si Lovable la marcó parcialmente aplicada).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'courses' AND column_name = 'status'
    ) THEN
      ALTER TABLE public.courses ADD COLUMN status TEXT NOT NULL DEFAULT 'borrador';
    END IF;

    -- finalized_at: cuándo se finalizó (manual o automático).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'courses' AND column_name = 'finalized_at'
    ) THEN
      ALTER TABLE public.courses ADD COLUMN finalized_at TIMESTAMPTZ NULL;
    END IF;

    -- finalized_by: quién finalizó. NULL = cierre automático (cron) o
    -- backfill por fecha. uid = cierre manual.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'courses' AND column_name = 'finalized_by'
    ) THEN
      ALTER TABLE public.courses ADD COLUMN finalized_by UUID NULL REFERENCES auth.users(id);
    END IF;

    -- CHECK del set de valores válidos (guardado por separado por si la
    -- columna ya existía sin constraint).
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'courses_status_check'
    ) THEN
      ALTER TABLE public.courses
        ADD CONSTRAINT courses_status_check
        CHECK (status IN ('borrador', 'en_curso', 'finalizado'));
    END IF;

    -- Índice parcial: el cron diario escanea solo los 'en_curso' vivos.
    CREATE INDEX IF NOT EXISTS idx_courses_status_en_curso
      ON public.courses (status)
      WHERE status = 'en_curso' AND deleted_at IS NULL;

    -- ── Backfill derivado de fechas (solo cursos NO en papelera) ──
    -- Los cursos existentes ya son operativos (tienen matrículas, exámenes,
    -- notas), así que NO los marcamos 'borrador' (los ocultaría/relabelaría).
    -- Reproducimos exactamente el comportamiento por fechas de hoy:
    --   - end_date ya pasó → 'finalizado' (y registramos finalized_at =
    --     end_date, finalized_by = NULL para que el rastro muestre que fue
    --     derivado por fecha, no cierre manual).
    --   - todo lo demás → 'en_curso'.
    -- Los cursos en papelera (deleted_at IS NOT NULL) quedan en el DEFAULT
    -- ('borrador') — no se ven en ningún lado hasta restaurarse.
    UPDATE public.courses
      SET status = 'finalizado',
          finalized_at = (end_date::timestamptz),
          finalized_by = NULL
      WHERE deleted_at IS NULL
        AND status = 'borrador'  -- solo filas recién defaulteadas por esta migración
        AND end_date IS NOT NULL
        AND end_date < CURRENT_DATE;

    UPDATE public.courses
      SET status = 'en_curso'
      WHERE deleted_at IS NULL
        AND status = 'borrador'  -- el resto de las operativas
        AND NOT (end_date IS NOT NULL AND end_date < CURRENT_DATE);
  END IF;
END $$;

-- ── 2) RPC set_course_status — transición manual de ciclo de vida ──
-- Las escrituras de status van SIEMPRE por este RPC, no por el UPDATE
-- genérico de courses del form. Así el camino de edición del form nunca
-- cambia el estado silenciosamente.
CREATE OR REPLACE FUNCTION public.set_course_status(_course_id UUID, _status TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 1) Validar el valor.
  IF _status NOT IN ('borrador', 'en_curso', 'finalizado') THEN
    RAISE EXCEPTION 'Estado de curso inválido: %', _status;
  END IF;

  -- 2) Autorización: docente del curso, o Admin del tenant del curso, o
  -- SuperAdmin. has_role() solo NO basta (rol global = leak cross-tenant),
  -- por eso el AND con course_in_my_tenant (que ya cubre is_super_admin()).
  IF NOT (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(_course_id))
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = _course_id AND ct.user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para cambiar el estado de este curso';
  END IF;

  -- 3) Rechazar si el curso está en papelera.
  IF EXISTS (
    SELECT 1 FROM public.courses WHERE id = _course_id AND deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'No se puede cambiar el estado de un curso en la papelera';
  END IF;

  -- 4) Aplicar. Al salir de 'finalizado' limpiamos finalized_at/by (marca
  -- la reapertura para el rastro/display).
  UPDATE public.courses
    SET status = _status,
        finalized_at = CASE WHEN _status = 'finalizado' THEN now() ELSE NULL END,
        finalized_by = CASE WHEN _status = 'finalizado' THEN auth.uid() ELSE NULL END
    WHERE id = _course_id;
END $$;

GRANT EXECUTE ON FUNCTION public.set_course_status(UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.set_course_status(UUID, TEXT) IS
  'Transición manual del ciclo de vida del curso (borrador/en_curso/finalizado). Autoriza docente del curso o Admin/SuperAdmin del tenant. Al finalizar registra finalized_at/by; al reabrir los limpia.';

-- ── 3) Auto-finalización diaria (función SQL pura, sin edge) ──
-- Marca 'finalizado' los cursos 'en_curso' cuya fecha de fin ya pasó. Un
-- curso finalizado o reabierto manualmente lo respeta:
--   - finalizado manual → ya es 'finalizado', el WHERE status='en_curso' lo
--     excluye.
--   - reabierto manual → vuelve a 'en_curso'; el cron lo re-finalizará al
--     día siguiente SOLO si su end_date sigue en el pasado. Para mantenerlo
--     abierto, el docente debe actualizar la fecha de fin (ver nota arriba
--     y el hint en el form).
CREATE OR REPLACE FUNCTION public.auto_finalize_courses()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  WITH updated AS (
    UPDATE public.courses
      SET status = 'finalizado',
          finalized_at = now(),
          finalized_by = NULL
      WHERE status = 'en_curso'
        AND end_date IS NOT NULL
        AND end_date < CURRENT_DATE
        AND deleted_at IS NULL
      RETURNING id
  )
  SELECT count(*) INTO v_count FROM updated;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.auto_finalize_courses() TO authenticated;

COMMENT ON FUNCTION public.auto_finalize_courses() IS
  'Marca como finalizado los cursos en_curso cuya fecha de fin ya pasó. Invocada por el cron diario auto-finalize-courses-daily.';

-- ── 4) Cron diario (04:00 UTC, offset de otros jobs) ──
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron no disponible; la auto-finalización deberá dispararse manualmente con SELECT public.auto_finalize_courses().';
    RETURN;
  END;

  -- Idempotencia: borrar schedule previo si existe.
  PERFORM extensions.cron.unschedule('auto-finalize-courses-daily')
  WHERE EXISTS (
    SELECT 1 FROM extensions.cron.job WHERE jobname = 'auto-finalize-courses-daily'
  );

  PERFORM extensions.cron.schedule(
    'auto-finalize-courses-daily',
    '0 4 * * *',
    -- Tag de dollar-quote DISTINTO ($cron$) para no colisionar con el
    -- bloque DO externo. Mismo patrón que las otras migraciones de cron.
    $cron$ SELECT public.auto_finalize_courses(); $cron$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Setup del cron de auto-finalización de cursos falló: %', SQLERRM;
END
$$;

-- Descripción humana para el panel SuperAdmin → Tareas programadas.
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'auto-finalize-courses-daily',
  'Cada día a las 04:00 UTC: marca como Finalizado los cursos En curso cuya fecha de fin ya pasó. Un curso finalizado o reabierto manualmente respeta la acción del docente/admin.'
)
ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description, updated_at = now();

NOTIFY pgrst, 'reload schema';
