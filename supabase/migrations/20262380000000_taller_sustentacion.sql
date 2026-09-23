-- ═══════════════════════════════════════════════════════════════════════
-- Sustentación en TALLERES, homologada con la de proyectos
-- ═══════════════════════════════════════════════════════════════════════
-- Los proyectos separan la nota de la ENTREGA de la nota FINAL desde la mig
-- 20260507170000: `final_grade = submission_grade × defense_factor`, y mientras
-- no haya sustentación la final queda en NULL («Falta sustentación»). Los
-- talleres no tenían nada de eso, aunque un taller de EXPOSICIÓN se califica
-- exactamente igual: hay un trabajo entregado y hay una sustentación en clase.
--
-- ── La diferencia que NO se podía copiar: acá es OPT-IN ────────────────
-- En proyectos la sustentación es obligatoria para todos. Hacer lo mismo en
-- talleres sería catastrófico: `computeWeightedGrade` cuenta un ítem sin nota
-- como CERO con su peso completo, así que el día del despliegue **todos los
-- talleres ya calificados de todas las instituciones** pasarían a «falta
-- sustentación» y la nota de cada estudiante se desplomaría, sin que nadie haya
-- tocado nada. Por eso hay `workshops.requires_defense`, apagado por defecto:
-- con el interruptor en falso el comportamiento es IDÉNTICO al de hoy.
--
-- ── Dónde vive la regla: en el servidor, no en las diez pantallas ─────
-- `final_grade` de un taller se escribe hoy desde ~diez lugares del cliente
-- (calificar a mano, calificar con IA, el lote, el re-grade, reabrir…). Repartir
-- la fórmula por todos ellos garantiza que alguno quede afuera y produzca una
-- fila inconsistente: el interruptor encendido y una nota final que no sale de
-- ninguna sustentación. Por eso la impone un trigger BEFORE sobre la tabla: con
-- la sustentación activa, `final_grade` es SIEMPRE `submission_grade × factor`,
-- lo escriba quien lo escriba. Con la sustentación apagada el trigger no toca
-- nada — cero cambio de comportamiento para lo que ya existe.
--
-- ── Y el interruptor reconcilia en los DOS sentidos ───────────────────
-- Encenderlo sobre un taller ya calificado recalcula sus entregas (quedan en
-- «falta sustentación»); apagarlo las restaura. Sin esto, prender el
-- interruptor dejaba filas viejas con una nota final que el propio modelo ya no
-- explicaba, y el docente no tendría forma de volver atrás.
--
-- ── Lo que NO se hace: rellenar `defense_factor = 1` en lo viejo ──────
-- La mig de proyectos sí lo hizo, y estuvo bien: allá la sustentación pasaba a
-- ser obligatoria de golpe y era la única forma de no destruir las notas. Acá
-- `requires_defense = false` ya protege lo existente, así que marcar cada
-- entrega histórica como «sustentada al 100 %» sería escribir en la base un
-- hecho que no ocurrió — y el docente que encienda el interruptor vería que no
-- pasa nada y lo leería como que está roto.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) Las columnas ───────────────────────────────────────────────────
DO $mig$ BEGIN
  IF to_regclass('public.workshops') IS NOT NULL THEN
    ALTER TABLE public.workshops
      ADD COLUMN IF NOT EXISTS requires_defense BOOLEAN NOT NULL DEFAULT false;
  END IF;
END $mig$;

DO $mig$ BEGIN
  IF to_regclass('public.workshop_submissions') IS NOT NULL THEN
    ALTER TABLE public.workshop_submissions
      ADD COLUMN IF NOT EXISTS submission_grade NUMERIC,
      ADD COLUMN IF NOT EXISTS defense_factor NUMERIC,
      ADD COLUMN IF NOT EXISTS defense_notes TEXT,
      ADD COLUMN IF NOT EXISTS defense_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS defense_video_url TEXT;
  END IF;
END $mig$;

-- El rango del factor, igual que en proyectos. Va aparte y con guard porque
-- `ADD CONSTRAINT` no tiene `IF NOT EXISTS`.
DO $mig$ BEGIN
  IF to_regclass('public.workshop_submissions') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_workshop_submissions_defense_factor'
     ) THEN
    ALTER TABLE public.workshop_submissions
      ADD CONSTRAINT chk_workshop_submissions_defense_factor
      CHECK (defense_factor IS NULL OR (defense_factor >= 0 AND defense_factor <= 1));
  END IF;
END $mig$;

-- ── 2) Backfill de `submission_grade` ─────────────────────────────────
-- Para que encender el interruptor mañana tenga una base de la que partir. No
-- toca `final_grade` ni `defense_factor`: con `requires_defense = false` nada
-- cambia para nadie.
DO $mig$ BEGIN
  IF to_regclass('public.workshop_submissions') IS NOT NULL THEN
    UPDATE public.workshop_submissions
       SET submission_grade = COALESCE(final_grade, ai_grade)
     WHERE submission_grade IS NULL
       AND COALESCE(final_grade, ai_grade) IS NOT NULL;
  END IF;
END $mig$;

-- ── 3) La regla, en un trigger BEFORE ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_workshop_defense_final_grade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_requiere boolean;
BEGIN
  SELECT requires_defense INTO v_requiere
    FROM public.workshops WHERE id = NEW.workshop_id;

  -- Taller sin sustentación: no se toca NADA. Es el camino de todos los
  -- talleres que existen hoy.
  IF COALESCE(v_requiere, false) IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- ── Por qué un `final_grade` escrito «a pelo» se DESCARTA ─────────────
  -- La primera versión hacía lo contrario: si alguien escribía `final_grade`
  -- sin tocar `submission_grade`, lo reinterpretaba como la nota del TRABAJO,
  -- para no perder lo que hubiera querido decir un camino del cliente que no
  -- sabe de sustentación. Es un heurístico y su peor caso destruye datos en
  -- silencio: el botón «Guardar calificación» del taller manda
  -- `sub.final_grade ?? 0`, y con sustentación pendiente `final_grade` es NULL
  -- justamente en el estado NORMAL después de calificar con IA. O sea que un
  -- clic mandaba 0, el heurístico lo tomaba como nota del trabajo y una entrega
  -- de 85 quedaba en 0 — sin error, sin aviso y sin verse hasta reabrir el
  -- diálogo. Lo encontró la revisión de consistencia.
  --
  -- Descartarlo falla del lado seguro: el peor caso es que una escritura
  -- ingenua no tenga efecto, y eso SE VE (la nota no cambia). El camino real de
  -- la IA no se entera: escribe las dos columnas en el mismo UPDATE.

  -- La fórmula. `submission_grade` en NULL significa «todavía no hay nota del
  -- trabajo», que NO es lo mismo que cero: la final queda vacía.
  NEW.final_grade := CASE
    WHEN NEW.defense_factor IS NULL OR NEW.submission_grade IS NULL THEN NULL
    ELSE round(NEW.submission_grade * NEW.defense_factor, 2)
  END;

  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.tg_workshop_defense_final_grade() FROM PUBLIC;

-- El nombre importa: dentro de un mismo momento (BEFORE), Postgres corre los
-- triggers en orden ALFABÉTICO, y `trg_guard_workshop_submission_grade` tiene
-- que correr ANTES que este para que el candado de notas juzgue lo que el
-- cliente pidió y no lo que este trigger dejó. 'trg_g' < 'trg_w'.
DO $mig$ BEGIN
  IF to_regclass('public.workshop_submissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_workshop_defense_final_grade ON public.workshop_submissions;
    CREATE TRIGGER trg_workshop_defense_final_grade
      BEFORE INSERT OR UPDATE ON public.workshop_submissions
      FOR EACH ROW EXECUTE FUNCTION public.tg_workshop_defense_final_grade();
  END IF;
END $mig$;

-- ── 4) Encender o apagar el interruptor reconcilia las entregas ───────
CREATE OR REPLACE FUNCTION public.tg_workshop_requires_defense_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.requires_defense IS TRUE THEN
    UPDATE public.workshop_submissions
       SET final_grade = CASE
             WHEN defense_factor IS NULL OR submission_grade IS NULL THEN NULL
             ELSE round(submission_grade * defense_factor, 2)
           END
     WHERE workshop_id = NEW.id;
  ELSE
    -- Se apaga: la nota final vuelve a ser la del trabajo. Sin esto, apagar el
    -- interruptor dejaba en NULL las notas que él mismo había vaciado, o sea
    -- que la acción no era reversible.
    UPDATE public.workshop_submissions
       SET final_grade = COALESCE(submission_grade, final_grade)
     WHERE workshop_id = NEW.id;
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.tg_workshop_requires_defense_changed() FROM PUBLIC;

DO $mig$ BEGIN
  IF to_regclass('public.workshops') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_workshop_requires_defense_changed ON public.workshops;
    CREATE TRIGGER trg_workshop_requires_defense_changed
      AFTER UPDATE OF requires_defense ON public.workshops
      FOR EACH ROW
      WHEN (NEW.requires_defense IS DISTINCT FROM OLD.requires_defense)
      EXECUTE FUNCTION public.tg_workshop_requires_defense_changed();
  END IF;
END $mig$;

-- ── 5) El recompute de la IA escribe la nota del TRABAJO ──────────────
-- Misma función de la mig 20260956000000, con un solo cambio: además de
-- `ai_grade` y `final_grade` ahora setea `submission_grade`. El `final_grade`
-- que calcula acá lo corrige el trigger BEFORE de arriba cuando el taller se
-- sustenta; cuando no, queda tal cual y el comportamiento no cambia.
CREATE OR REPLACE FUNCTION public.tg_workshop_answer_graded_recompute()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _sub_id   UUID := NEW.submission_id;
  _ws_id    UUID;
  _max      NUMERIC;
  _total    NUMERIC;
  _earned   NUMERIC;
  _pending  INT;
  _final    NUMERIC;
BEGIN
  SELECT ws.workshop_id INTO _ws_id
    FROM public.workshop_submissions ws WHERE ws.id = _sub_id;
  IF _ws_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- ¿Quedan respuestas que la IA DEBE calificar todavía sin nota? Las
  -- preguntas cerradas (scoring local) NO cuentan — si no, bloquearían
  -- el cierre indefinidamente.
  SELECT count(*) INTO _pending
    FROM public.workshop_submission_answers a
    JOIN public.workshop_questions q ON q.id = a.question_id
   WHERE a.submission_id = _sub_id
     AND q.type NOT IN ('cerrada', 'cerrada_multi')
     AND a.ai_grade IS NULL;
  IF _pending > 0 THEN
    RETURN NEW; -- aún faltan preguntas abiertas/código por calificar
  END IF;

  SELECT w.max_score INTO _max FROM public.workshops w WHERE w.id = _ws_id;
  SELECT COALESCE(SUM(points), 0) INTO _total
    FROM public.workshop_questions WHERE workshop_id = _ws_id;
  SELECT COALESCE(SUM(ai_grade), 0) INTO _earned
    FROM public.workshop_submission_answers WHERE submission_id = _sub_id;

  IF _total <= 0 THEN
    _final := 0;
  ELSE
    _final := round((_earned / _total) * COALESCE(_max, 100), 2);
  END IF;

  -- Refrescamos ai_grade y la nota final. final_grade se respeta SOLO si el
  -- docente lo sobreescribió manualmente (≠ del ai_grade previo); si era el
  -- auto previo (o NULL), se actualiza al nuevo valor — así regenerar también
  -- corrige la nota.
  UPDATE public.workshop_submissions
     SET ai_grade         = _final,
         -- La nota del TRABAJO. Con sustentación apagada queda igual a la
         -- final; con sustentación encendida es la base que el factor pondera.
         submission_grade = _final,
         final_grade = CASE
                         WHEN final_grade IS NULL THEN _final
                         WHEN final_grade = ai_grade THEN _final
                         ELSE final_grade
                       END,
         status      = CASE WHEN status IN ('entregado', 'ai_revisado') THEN 'calificado' ELSE status END,
         ai_feedback = COALESCE(ai_feedback, 'Calificación automática (procesada en segundo plano).')
   WHERE id = _sub_id;

  RETURN NEW;
END
$fn$;

-- ── 6) El candado de notas cubre las columnas nuevas ──────────────────
-- Sin esto un estudiante se pone su propio `defense_factor` por REST: la RLS de
-- UPDATE de `workshop_submissions` es por FILA («el dueño de la entrega»), no
-- por columna. Es exactamente el vector que cerró la mig 20261034000000, y
-- agregar columnas de nota sin sumarlas a esta lista lo vuelve a abrir.
CREATE OR REPLACE FUNCTION public.tg_guard_workshop_submission_grade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_touch boolean;
  v_is_staff boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;

  v_touch :=
       NEW.final_grade         IS DISTINCT FROM OLD.final_grade
    OR NEW.submission_grade    IS DISTINCT FROM OLD.submission_grade
    OR NEW.defense_factor      IS DISTINCT FROM OLD.defense_factor
    OR NEW.defense_notes       IS DISTINCT FROM OLD.defense_notes
    OR NEW.defense_at          IS DISTINCT FROM OLD.defense_at
    OR NEW.defense_video_url   IS DISTINCT FROM OLD.defense_video_url
    OR NEW.ai_grade            IS DISTINCT FROM OLD.ai_grade
    OR NEW.ai_feedback         IS DISTINCT FROM OLD.ai_feedback
    OR NEW.ai_detected         IS DISTINCT FROM OLD.ai_detected
    OR NEW.ai_detected_score   IS DISTINCT FROM OLD.ai_detected_score
    OR NEW.ai_detected_reasons IS DISTINCT FROM OLD.ai_detected_reasons
    OR NEW.ai_review_at        IS DISTINCT FROM OLD.ai_review_at
    OR NEW.ai_review_by        IS DISTINCT FROM OLD.ai_review_by
    OR NEW.teacher_feedback    IS DISTINCT FROM OLD.teacher_feedback
    OR NEW.status = 'calificado'
    OR (OLD.status = 'calificado' AND NEW.status IS DISTINCT FROM OLD.status);

  IF NOT v_touch THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.workshops w
    JOIN public.course_teachers ct ON ct.course_id = w.course_id
    WHERE w.id = NEW.workshop_id AND ct.user_id = v_uid
  ) OR EXISTS (
    SELECT 1 FROM public.workshops w
    WHERE w.id = NEW.workshop_id AND public.is_admin_of_course_tenant(w.course_id)
  ) INTO v_is_staff;

  IF v_is_staff THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'No autorizado: solo el docente del curso o un administrador pueden modificar la calificación o los metadatos de revisión de una entrega';
END
$fn$;

REVOKE ALL ON FUNCTION public.tg_guard_workshop_submission_grade() FROM PUBLIC;

-- El trigger ya existe desde la 20261034000000, así que reemplazar la función
-- «debería» alcanzar. Se re-crea igual porque esa suposición ya falló antes en
-- este proyecto: Lovable marcó migraciones como aplicadas sin haberlas corrido,
-- y en ese entorno quedaría la función nueva SIN nada que la llame — o sea el
-- candado de notas apagado, en silencio y sin error. Es idempotente y gratis.
DO $mig$ BEGIN
  IF to_regclass('public.workshop_submissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_guard_workshop_submission_grade ON public.workshop_submissions;
    CREATE TRIGGER trg_guard_workshop_submission_grade
      BEFORE UPDATE ON public.workshop_submissions
      FOR EACH ROW EXECUTE FUNCTION public.tg_guard_workshop_submission_grade();
  END IF;
END $mig$;

COMMENT ON COLUMN public.workshops.requires_defense IS
  'Si el taller se sustenta. Apagado por defecto: encenderlo hace que la nota final sea submission_grade x defense_factor y que quede sin nota hasta que el docente registre la sustentacion.';
COMMENT ON COLUMN public.workshop_submissions.submission_grade IS
  'Nota del TRABAJO entregado, antes de la sustentacion. Con requires_defense apagado vale lo mismo que final_grade.';
COMMENT ON COLUMN public.workshop_submissions.defense_factor IS
  'Factor 0..1 que el docente pone tras la sustentacion. NULL = todavia no se sustento.';

-- ── 7) `clone_workshop` copia el interruptor ──────────────────────────
-- Sin esto, duplicar un taller que se sustenta produce una copia que NO se
-- sustenta, y en silencio: no hay error, el docente ve el taller creado y el
-- interruptor apagado solo se descubre al calificar. `is_external` ya se copiaba
-- directo por el mismo criterio (es parte de qué ES el taller, no una opción de
-- la copia), así que tampoco lleva casilla en el diálogo de duplicar.
--
-- Se reproduce la función entera porque la mig 20260918000000 ya está aplicada y
-- una migración aplicada es inmutable. Lo único que cambia respecto de ahí es la
-- columna nueva en el INSERT y en el SELECT.
CREATE OR REPLACE FUNCTION public.clone_workshop(
  _source_id        UUID,
  _target_course_id UUID,
  _new_title        TEXT DEFAULT NULL,
  _new_start_date   TIMESTAMPTZ DEFAULT NULL,
  _new_due_date     TIMESTAMPTZ DEFAULT NULL,
  _copy_questions   BOOLEAN DEFAULT true,
  _copy_groups      BOOLEAN DEFAULT true
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_id UUID;
  _final_title TEXT;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'Admin')
    OR (
      EXISTS (
        SELECT 1 FROM public.workshops w
        JOIN public.course_teachers ct ON ct.course_id = w.course_id
        WHERE w.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este taller al curso destino';
  END IF;

  SELECT COALESCE(_new_title, 'Copia de ' || w.title)
    INTO _final_title
    FROM public.workshops w WHERE w.id = _source_id;

  INSERT INTO public.workshops (
    course_id, title, description, instructions, start_date, due_date,
    status, weight, is_external, group_mode, group_size_min, group_size_max,
    max_score, cut_id, requires_defense
  )
  SELECT
    _target_course_id, _final_title, w.description, w.instructions,
    COALESCE(_new_start_date, w.start_date),
    COALESCE(_new_due_date, w.due_date),
    'draft', w.weight, w.is_external,
    CASE WHEN _copy_groups THEN w.group_mode ELSE 'individual' END,
    CASE WHEN _copy_groups THEN w.group_size_min ELSE NULL END,
    CASE WHEN _copy_groups THEN w.group_size_max ELSE NULL END,
    w.max_score,
    CASE WHEN _target_course_id = w.course_id THEN w.cut_id ELSE NULL END,
    w.requires_defense
  FROM public.workshops w WHERE w.id = _source_id
  RETURNING id INTO _new_id;

  IF _copy_questions THEN
    INSERT INTO public.workshop_questions (
      workshop_id, type, content, options, expected_rubric, language, starter_code,
      points, position
    )
    SELECT
      _new_id, q.type, q.content, q.options, q.expected_rubric, q.language, q.starter_code,
      q.points, q.position
    FROM public.workshop_questions q
    WHERE q.workshop_id = _source_id;
  END IF;

  RETURN _new_id;
END
$$;
