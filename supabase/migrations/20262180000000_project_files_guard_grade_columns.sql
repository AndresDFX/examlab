-- ══════════════════════════════════════════════════════════════════════
-- CRÍTICO — el mismo hueco que la mig 20262130000000 cerró en TALLER
-- (candado en la cabecera, sin candado en la tabla hija) seguía abierto en
-- PROYECTO, y acá además rompía la entrega entera, no solo dejaba una
-- puerta sin cerrar.
--
-- ── El hueco de auto-asignación ─────────────────────────────────────────
-- Las notas por archivo de un proyecto viven en `project_submission_files`.
-- Esa tabla NUNCA tuvo trigger guard, y su RLS de UPDATE es "el dueño de la
-- entrega o staff del curso" — a nivel FILA, no columna, con GRANT sobre
-- TODAS las columnas. Así que:
--
--   PATCH /rest/v1/project_submission_files?id=eq.<la_suya>
--   { "ai_grade": 999 }
--
-- lo escribía el alumno con su propio JWT. Y no era un vector teórico: hasta
-- hoy ESE upsert directo era el camino normal del producto para preguntas
-- vacías, cerradas/red (calificación determinista) y ZIP con fallback — el
-- navegador escribía `ai_grade` en cada uno de esos casos.
--
-- ── Por qué esto además ROMPÍA la entrega (no solo la exponía) ─────────
-- `project_submission_files` tiene un trigger `AFTER UPDATE`
-- (`_trg_project_submission_file_recompute`, mig 20260955000000) que en
-- CASCADA actualiza `project_submissions.submission_grade`. Y esa tabla SÍ
-- tiene candado desde el 30 de junio (`tg_guard_project_submission_grade`,
-- mig 20261034000000). `auth.uid()` es el mismo durante TODA la transacción
-- de una request — no cambia entre un trigger y otro solo porque el trigger
-- del medio es SECURITY DEFINER —, así que cuando el ALUMNO era quien
-- escribía `ai_grade` en el archivo, la cascada hacia la cabecera corría con
-- SU `auth.uid()`, el candado de la cabecera la rechazaba, y ese rechazo
-- abortaba la transacción ENTERA: el UPDATE original al archivo tampoco
-- quedaba. Verificado contra los datos reales: no hay una sola entrega de
-- proyecto en producción posterior al 2026-06-30 — todas son de antes.
--
-- ── Por qué la solución es la MISMA que ya funciona ─────────────────────
-- Cuando quien escribe `ai_grade` es el edge `ai-grade-submission` (llamado
-- con `service_role`), `auth.uid()` es NULL en TODA la cadena —incluida la
-- cascada hacia la cabecera—, y los dos candados (`IF v_uid IS NULL THEN
-- RETURN NEW`) la dejan pasar sin tocar nada más. Por eso el fix real no es
-- este trigger solo: es que el edge (ver el commit que acompaña esta
-- migración) pasó a ser el ÚNICO que escribe `ai_grade` de un proyecto, para
-- TODOS sus tipos de pregunta — no solo las que necesitan IA. Este trigger es
-- lo que hace ese cambio real y no teatro: sin él, el navegador seguiría
-- pudiendo escribir la columna aunque el flujo normal ya no lo haga.
--
-- ── Qué se protege y qué NO ─────────────────────────────────────────────
-- PROTEGIDO: ai_grade, ai_feedback, ai_likelihood, ai_reasons, zip_truncated,
--   zip_chars_used.
-- LIBRE (es la respuesta del alumno; bloquearla lo dejaría sin poder
--   contestar): content, selected_option, code_paths, zip_path.
-- Fast-path: si el INSERT/UPDATE no toca ninguna columna protegida, retorna
--   sin consultar roles — el guardado normal de una respuesta no paga el join.
--
-- ── La misma trampa del INSERT que el taller ya documentó ───────────────
-- `zip_truncated` es **boolean NOT NULL DEFAULT false** (mig
-- 20260517100000 / backfill 20260942000000): en un INSERT normal llega en
-- `false`, NO en NULL. Un chequeo `IS NOT NULL` daría verdadero para
-- CUALQUIER fila y bloquearía a todos los alumnos al guardar su respuesta.
-- Por eso esa columna se compara con `IS TRUE` en el INSERT y las demás
-- —todas nullable sin default— con `IS NOT NULL`.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_guard_project_file_grade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_touch boolean;
  v_is_staff boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;  -- service_role / sistema (el edge de IA)

  IF TG_OP = 'INSERT' THEN
    v_touch :=
         NEW.ai_grade      IS NOT NULL
      OR NEW.ai_feedback   IS NOT NULL
      OR NEW.ai_likelihood IS NOT NULL
      OR NEW.ai_reasons    IS NOT NULL
      OR NEW.zip_truncated IS TRUE
      OR NEW.zip_chars_used IS NOT NULL;
  ELSE
    v_touch :=
         NEW.ai_grade      IS DISTINCT FROM OLD.ai_grade
      OR NEW.ai_feedback   IS DISTINCT FROM OLD.ai_feedback
      OR NEW.ai_likelihood IS DISTINCT FROM OLD.ai_likelihood
      OR NEW.ai_reasons    IS DISTINCT FROM OLD.ai_reasons
      OR NEW.zip_truncated IS DISTINCT FROM OLD.zip_truncated
      OR NEW.zip_chars_used IS DISTINCT FROM OLD.zip_chars_used;
  END IF;

  IF NOT v_touch THEN RETURN NEW; END IF;

  -- Staff = docente del curso del proyecto, o Admin/SuperAdmin del tenant de
  -- ese curso. Se llega por la FK: file → project_submissions → projects →
  -- courses. `is_admin_of_course_tenant` ya cubre a SuperAdmin.
  SELECT EXISTS (
    SELECT 1
      FROM public.project_submissions ps
      JOIN public.projects p ON p.id = ps.project_id
      JOIN public.course_teachers ct ON ct.course_id = p.course_id
     WHERE ps.id = NEW.submission_id
       AND ct.user_id = v_uid
  ) OR EXISTS (
    SELECT 1
      FROM public.project_submissions ps
      JOIN public.projects p ON p.id = ps.project_id
     WHERE ps.id = NEW.submission_id
       AND public.is_admin_of_course_tenant(p.course_id)
  ) INTO v_is_staff;

  IF v_is_staff THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'No autorizado: solo el docente del curso o un administrador pueden modificar la calificación de un archivo del proyecto';
END
$$;

REVOKE ALL ON FUNCTION public.tg_guard_project_file_grade() FROM PUBLIC;

-- Trigger idempotente, guardado por to_regclass por si la tabla no existe en
-- un entorno a medio migrar (misma defensiva que 20262130000000).
DO $$ BEGIN
  IF to_regclass('public.project_submission_files') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_guard_project_file_grade ON public.project_submission_files;
    CREATE TRIGGER trg_guard_project_file_grade
      BEFORE INSERT OR UPDATE ON public.project_submission_files
      FOR EACH ROW EXECUTE FUNCTION public.tg_guard_project_file_grade();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
