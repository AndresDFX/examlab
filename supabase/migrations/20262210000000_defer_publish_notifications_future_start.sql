-- ══════════════════════════════════════════════════════════════════════════
-- Diferir "Nuevo taller/examen/proyecto publicado" hasta que esté cerca de
-- su fecha de inicio.
--
-- ── El problema reportado ────────────────────────────────────────────────
-- UNIAJ, curso Introducción a la Ingeniería-SB141C: el docente publicó los
-- 16 talleres del semestre de una sola vez y la plataforma disparó, EN EL
-- ACTO, una notificación "Nuevo taller publicado" por cada uno — incluidos
-- los de octubre/noviembre estando el curso recién en semana 1. Queja del
-- estudiante (WhatsApp): "me aparecen notificaciones que la verdad no son
-- para mi... la idea es que nos llegue información personalizada a lo que
-- nos corresponde". No es un bug de datos (cada alumno ve solo lo de SU
-- curso) — es un problema de TIMING: notificar de más, demasiado temprano.
--
-- ── Alcance: talleres + exámenes + proyectos ─────────────────────────────
-- Las tres tablas comparten LITERALMENTE el mismo trigger (mismo
-- condicional is_publish_event / is_edit_published, mismo criterio de
-- "campo significativo") porque nacieron en la misma migración
-- (20260603050000_publish_notifications.sql). Dejar el fix solo en
-- talleres habría dejado el mismo bug de UX vivo en dos de cada tres
-- tipos — exams.start_time y projects.start_date son el mismo "disponible
-- desde" que workshops.start_date, y ya se ve en producción: "Evaluación
-- de Corte 1 — disponible desde 29/09/2026 19:30" es exactamente el mismo
-- patrón.
-- Polls (que también tiene una fecha de apertura, `opens_at`) queda AFUERA
-- a propósito: es una tabla de forma distinta (`is_published` boolean,
-- fan-out multi-curso vía poll_courses, mensaje "Nueva encuesta
-- publicada") y no fue parte del reporte — se evalúa aparte si se repite
-- la queja ahí. `generated_contents` no tiene un campo de inicio análogo.
--
-- ── Mecanismo: una columna, no una cola ──────────────────────────────────
-- `publish_notified_at` (NULL = el aviso de "recién publicado" sigue
-- pendiente). Se prefirió a una tabla-cola porque el dato que de verdad
-- decide CUÁNDO avisar ya vive en la propia fila (start_date/start_time):
-- si el docente lo edita mientras sigue pendiente, el cron lee el valor
-- VIGENTE en su próxima pasada sin que haga falta mantener sincronizada
-- una segunda tabla.
--
-- Al publicar (trigger, sin cambios de firma ni de trigger — solo el
-- body de la función):
--   · referencia (start_date/start_time) NULL o a ≤1 día → notifica YA,
--     igual que hoy, y dentro del mismo trigger marca
--     `publish_notified_at`.
--   · referencia a >1 día → NO notifica todavía; `publish_notified_at`
--     queda NULL. El cron horario `dispatch-deferred-publish-notifications`
--     la dispara sola cuando falta ≤1 día (o si ya pasó) y recién ahí
--     marca `publish_notified_at`.
-- Marcar `publish_notified_at` desde DENTRO del propio trigger AFTER
-- requiere un UPDATE a la misma fila, que re-dispara el trigger — es
-- inofensivo: ni la transición de estado ni un campo significativo
-- cambiaron en esa segunda pasada (solo `publish_notified_at`), así que
-- corta en el primer IF y no hay recursión real ni doble aviso.
--
-- ── Efecto colateral bueno: "X actualizado" también espera ──────────────
-- Antes, editar CUALQUIER campo importante de un ítem publicado (p.ej.
-- corregir un typo del título) disparaba "Taller actualizado" a TODOS los
-- matriculados aunque el "Nuevo taller publicado" original siguiera
-- diferido — el mismo problema con otro nombre: un aviso sobre algo que
-- el alumno todavía no sabe que existe. Ahora "X actualizado" también
-- exige `publish_notified_at IS NOT NULL`: sin el primer aviso, tampoco
-- sale el de "cambió".
--
-- ── Backfill: no se toca lo ya enviado, pero SÍ hay que sellarlo ─────────
-- Las notificaciones de los 16 talleres de SB141C ya salieron — eran el
-- comportamiento vigente en el momento de publicar — y no hay forma de
-- "desenviarlas" sin generar más ruido (marcarlas leídas de oficio sería
-- alterar el buzón del alumno sin que lo haya pedido). Se corrige el
-- comportamiento HACIA ADELANTE únicamente: no se tocan notificaciones
-- históricas.
-- Pero sellar `publish_notified_at = now()` en TODO lo que ya está
-- publicado hoy no es opcional, es lo que evita un bug peor: sin el
-- backfill, cuando octubre se acerque, el cron nuevo encontraría esos
-- mismos talleres con `publish_notified_at IS NULL` (porque nunca se
-- pobló) y `start_date <= now()+1 día` → true, y mandaría un SEGUNDO
-- "Nuevo taller publicado" a todo el curso, duplicando el aviso que ya
-- salió en septiembre. El backfill solo alcanza a `status='published'`
-- porque el cron y el guard de "actualizado" solo miran esa misma
-- condición — un ítem que se publicó y después se cerró no vuelve a
-- entrar en ninguno de los dos caminos, backfilleado o no.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 0) Threshold compartido ───────────────────────────────────────────────
-- Una sola fuente para "qué tan cerca es cerca", usada por los 3 triggers
-- (chequeo al publicar) y por el cron (chequeo periódico) — repetir el
-- literal en 6 lugares es la clase de invariante que este repo ya pagó
-- caro cuando diverge.
CREATE OR REPLACE FUNCTION public._publish_notify_lead_interval()
RETURNS INTERVAL
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT INTERVAL '1 day';
$$;

-- ── 1) Columna + backfill ─────────────────────────────────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.workshops') IS NOT NULL THEN
    ALTER TABLE public.workshops
      ADD COLUMN IF NOT EXISTS publish_notified_at TIMESTAMPTZ;

    UPDATE public.workshops
       SET publish_notified_at = now()
     WHERE status = 'published'
       AND publish_notified_at IS NULL;
  END IF;

  IF to_regclass('public.exams') IS NOT NULL THEN
    ALTER TABLE public.exams
      ADD COLUMN IF NOT EXISTS publish_notified_at TIMESTAMPTZ;

    UPDATE public.exams
       SET publish_notified_at = now()
     WHERE status = 'published'
       AND publish_notified_at IS NULL;
  END IF;

  IF to_regclass('public.projects') IS NOT NULL THEN
    ALTER TABLE public.projects
      ADD COLUMN IF NOT EXISTS publish_notified_at TIMESTAMPTZ;

    UPDATE public.projects
       SET publish_notified_at = now()
     WHERE status = 'published'
       AND publish_notified_at IS NULL;
  END IF;
END
$mig$;

COMMENT ON COLUMN public.workshops.publish_notified_at IS
  'Cuándo salió (o salió ya) el aviso "Nuevo taller publicado". NULL = pendiente, diferido porque start_date está a más de un día — lo dispara el cron dispatch-deferred-publish-notifications.';
COMMENT ON COLUMN public.exams.publish_notified_at IS
  'Cuándo salió (o salió ya) el aviso "Nuevo examen publicado". NULL = pendiente, diferido porque start_time está a más de un día — lo dispara el cron dispatch-deferred-publish-notifications.';
COMMENT ON COLUMN public.projects.publish_notified_at IS
  'Cuándo salió (o salió ya) el aviso "Nuevo proyecto publicado". NULL = pendiente, diferido porque start_date está a más de un día — lo dispara el cron dispatch-deferred-publish-notifications.';

-- ── 2) Triggers: mismas firmas, mismos triggers ya creados en
--      20260603050000 — solo cambia el BODY de la función (CREATE OR
--      REPLACE con firma idéntica no exige recrear el CREATE TRIGGER).

-- ---------- WORKSHOPS ----------
CREATE OR REPLACE FUNCTION public._tg_workshop_publish_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _is_publish_event BOOLEAN := false;
  _is_edit_published BOOLEAN := false;
  _defer BOOLEAN := false;
  _title TEXT;
  _body TEXT;
BEGIN
  -- Caso publicación: INSERT con status='published' O UPDATE de
  -- !='published' a 'published'.
  IF TG_OP = 'INSERT' AND NEW.status = 'published' THEN
    _is_publish_event := true;
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
    _is_publish_event := true;
  END IF;

  -- Caso edición post-publicación: solo tiene sentido avisar "actualizado"
  -- si el alumno YA se enteró de que el ítem existe. Si el aviso de
  -- publicación sigue diferido (publish_notified_at IS NULL), este UPDATE
  -- no dispara nada — el cron todavía no mandó ni el primer aviso.
  IF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status = 'published'
     AND OLD.publish_notified_at IS NOT NULL THEN
    IF OLD.title IS DISTINCT FROM NEW.title
       OR OLD.instructions IS DISTINCT FROM NEW.instructions
       OR OLD.due_date IS DISTINCT FROM NEW.due_date
       OR OLD.start_date IS DISTINCT FROM NEW.start_date
       OR OLD.max_score IS DISTINCT FROM NEW.max_score
       OR OLD.max_attempts IS DISTINCT FROM NEW.max_attempts
    THEN
      _is_edit_published := true;
    END IF;
  END IF;

  IF NOT _is_publish_event AND NOT _is_edit_published THEN
    RETURN NULL;
  END IF;

  IF _is_publish_event THEN
    -- Diferir si "disponible desde" está a más de un día: notificar en el
    -- acto sería el mismo bug reportado (16 talleres del semestre
    -- publicados juntos, avisos de octubre/noviembre en la semana 1). Sin
    -- fecha de inicio no hay nada que diferir — se avisa ya, como siempre.
    _defer := NEW.start_date IS NOT NULL
              AND NEW.start_date > now() + public._publish_notify_lead_interval();

    IF _defer THEN
      RETURN NULL;
    END IF;

    _title := 'Nuevo taller publicado';
    _body := COALESCE(NEW.title, 'Taller sin título') ||
             CASE WHEN NEW.due_date IS NOT NULL
                  THEN ' — entrega hasta ' || to_char(NEW.due_date, 'DD/MM/YYYY HH24:MI')
                  ELSE '' END;
  ELSE
    _title := 'Taller actualizado';
    _body := COALESCE(NEW.title, 'Taller') || ' fue modificado por el docente. Revisa los cambios.';
  END IF;

  PERFORM public.notify_course_students(
    NEW.course_id, _title, _body, 'workshop',
    '/app/student/workshops', 'Docente'
  );

  IF _is_publish_event THEN
    -- Marca "ya se avisó" para que el cron de diferidos no lo repita y
    -- para que una edición futura pueda avisar "actualizado". Re-dispara
    -- este mismo trigger (AFTER UPDATE) pero corta en el primer IF de
    -- arriba: ni transición de estado ni campo significativo cambiaron.
    UPDATE public.workshops SET publish_notified_at = now()
     WHERE id = NEW.id AND publish_notified_at IS NULL;
  END IF;

  RETURN NULL;
END
$$;

-- ---------- EXAMS ----------
CREATE OR REPLACE FUNCTION public._tg_exam_publish_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _is_publish_event BOOLEAN := false;
  _is_edit_published BOOLEAN := false;
  _defer BOOLEAN := false;
  _title TEXT;
  _body TEXT;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'published' THEN
    _is_publish_event := true;
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
    _is_publish_event := true;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status = 'published'
     AND OLD.publish_notified_at IS NOT NULL THEN
    IF OLD.title IS DISTINCT FROM NEW.title
       OR OLD.description IS DISTINCT FROM NEW.description
       OR OLD.start_time IS DISTINCT FROM NEW.start_time
       OR OLD.end_time IS DISTINCT FROM NEW.end_time
       OR OLD.time_limit_minutes IS DISTINCT FROM NEW.time_limit_minutes
       OR OLD.max_attempts IS DISTINCT FROM NEW.max_attempts
    THEN
      _is_edit_published := true;
    END IF;
  END IF;

  IF NOT _is_publish_event AND NOT _is_edit_published THEN
    RETURN NULL;
  END IF;

  IF _is_publish_event THEN
    -- exams.start_time es NOT NULL en el schema, pero se deja el guard
    -- IS NOT NULL por simetría con taller/proyecto y por si algún día se
    -- relaja la constraint.
    _defer := NEW.start_time IS NOT NULL
              AND NEW.start_time > now() + public._publish_notify_lead_interval();

    IF _defer THEN
      RETURN NULL;
    END IF;

    _title := 'Nuevo examen publicado';
    _body := COALESCE(NEW.title, 'Examen sin título') ||
             CASE WHEN NEW.start_time IS NOT NULL
                  THEN ' — disponible desde ' || to_char(NEW.start_time, 'DD/MM/YYYY HH24:MI')
                  ELSE '' END;
  ELSE
    _title := 'Examen actualizado';
    _body := COALESCE(NEW.title, 'Examen') || ' fue modificado por el docente. Revisa los cambios.';
  END IF;

  PERFORM public.notify_course_students(
    NEW.course_id, _title, _body, 'exam',
    '/app/student/exams', 'Docente'
  );

  IF _is_publish_event THEN
    UPDATE public.exams SET publish_notified_at = now()
     WHERE id = NEW.id AND publish_notified_at IS NULL;
  END IF;

  RETURN NULL;
END
$$;

-- ---------- PROJECTS ----------
CREATE OR REPLACE FUNCTION public._tg_project_publish_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _is_publish_event BOOLEAN := false;
  _is_edit_published BOOLEAN := false;
  _defer BOOLEAN := false;
  _title TEXT;
  _body TEXT;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'published' THEN
    _is_publish_event := true;
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
    _is_publish_event := true;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status = 'published'
     AND OLD.publish_notified_at IS NOT NULL THEN
    IF OLD.title IS DISTINCT FROM NEW.title
       OR OLD.instructions IS DISTINCT FROM NEW.instructions
       OR OLD.due_date IS DISTINCT FROM NEW.due_date
       OR OLD.start_date IS DISTINCT FROM NEW.start_date
       OR OLD.max_score IS DISTINCT FROM NEW.max_score
       OR OLD.max_attempts IS DISTINCT FROM NEW.max_attempts
    THEN
      _is_edit_published := true;
    END IF;
  END IF;

  IF NOT _is_publish_event AND NOT _is_edit_published THEN
    RETURN NULL;
  END IF;

  IF _is_publish_event THEN
    _defer := NEW.start_date IS NOT NULL
              AND NEW.start_date > now() + public._publish_notify_lead_interval();

    IF _defer THEN
      RETURN NULL;
    END IF;

    _title := 'Nuevo proyecto publicado';
    _body := COALESCE(NEW.title, 'Proyecto sin título') ||
             CASE WHEN NEW.due_date IS NOT NULL
                  THEN ' — entrega hasta ' || to_char(NEW.due_date, 'DD/MM/YYYY HH24:MI')
                  ELSE '' END;
  ELSE
    _title := 'Proyecto actualizado';
    _body := COALESCE(NEW.title, 'Proyecto') || ' fue modificado por el docente. Revisa los cambios.';
  END IF;

  PERFORM public.notify_course_students(
    NEW.course_id, _title, _body, 'project',
    '/app/student/projects', 'Docente'
  );

  IF _is_publish_event THEN
    UPDATE public.projects SET publish_notified_at = now()
     WHERE id = NEW.id AND publish_notified_at IS NULL;
  END IF;

  RETURN NULL;
END
$$;

-- ── 3) El cron: dispara los avisos que quedaron diferidos ─────────────────
-- Recorre las tres tablas buscando `status='published' AND
-- publish_notified_at IS NULL AND <inicio> <= now() + 1 día`. No hace
-- falta una tabla-cola: la condición se evalúa contra el estado VIGENTE de
-- cada fila, así que una edición de start_date mientras sigue pendiente ya
-- queda cubierta sin sincronizar nada aparte.
CREATE OR REPLACE FUNCTION public.dispatch_deferred_publish_notifications()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _row RECORD;
  _title TEXT;
  _body TEXT;
  _count INTEGER := 0;
BEGIN
  IF to_regclass('public.workshops') IS NOT NULL THEN
    FOR _row IN
      SELECT id, course_id, title, due_date
        FROM public.workshops
       WHERE status = 'published'
         AND deleted_at IS NULL
         AND publish_notified_at IS NULL
         AND start_date IS NOT NULL
         AND start_date <= now() + public._publish_notify_lead_interval()
    LOOP
      _title := 'Nuevo taller publicado';
      _body := COALESCE(_row.title, 'Taller sin título') ||
               CASE WHEN _row.due_date IS NOT NULL
                    THEN ' — entrega hasta ' || to_char(_row.due_date, 'DD/MM/YYYY HH24:MI')
                    ELSE '' END;

      PERFORM public.notify_course_students(
        _row.course_id, _title, _body, 'workshop',
        '/app/student/workshops', 'Docente'
      );

      UPDATE public.workshops SET publish_notified_at = now()
       WHERE id = _row.id AND publish_notified_at IS NULL;

      _count := _count + 1;
    END LOOP;
  END IF;

  IF to_regclass('public.exams') IS NOT NULL THEN
    FOR _row IN
      SELECT id, course_id, title, start_time
        FROM public.exams
       WHERE status = 'published'
         AND deleted_at IS NULL
         AND publish_notified_at IS NULL
         AND start_time IS NOT NULL
         AND start_time <= now() + public._publish_notify_lead_interval()
    LOOP
      _title := 'Nuevo examen publicado';
      _body := COALESCE(_row.title, 'Examen sin título') ||
               CASE WHEN _row.start_time IS NOT NULL
                    THEN ' — disponible desde ' || to_char(_row.start_time, 'DD/MM/YYYY HH24:MI')
                    ELSE '' END;

      PERFORM public.notify_course_students(
        _row.course_id, _title, _body, 'exam',
        '/app/student/exams', 'Docente'
      );

      UPDATE public.exams SET publish_notified_at = now()
       WHERE id = _row.id AND publish_notified_at IS NULL;

      _count := _count + 1;
    END LOOP;
  END IF;

  IF to_regclass('public.projects') IS NOT NULL THEN
    FOR _row IN
      SELECT id, course_id, title, due_date
        FROM public.projects
       WHERE status = 'published'
         AND deleted_at IS NULL
         AND publish_notified_at IS NULL
         AND start_date IS NOT NULL
         AND start_date <= now() + public._publish_notify_lead_interval()
    LOOP
      _title := 'Nuevo proyecto publicado';
      _body := COALESCE(_row.title, 'Proyecto sin título') ||
               CASE WHEN _row.due_date IS NOT NULL
                    THEN ' — entrega hasta ' || to_char(_row.due_date, 'DD/MM/YYYY HH24:MI')
                    ELSE '' END;

      PERFORM public.notify_course_students(
        _row.course_id, _title, _body, 'project',
        '/app/student/projects', 'Docente'
      );

      UPDATE public.projects SET publish_notified_at = now()
       WHERE id = _row.id AND publish_notified_at IS NULL;

      _count := _count + 1;
    END LOOP;
  END IF;

  RETURN _count;
END
$$;

COMMENT ON FUNCTION public.dispatch_deferred_publish_notifications() IS
  'Cada hora: dispara "Nuevo taller/examen/proyecto publicado" para los ítems que se publicaron con fecha de inicio lejana y ya están a un día o menos (o ya la pasaron). Idempotente via publish_notified_at.';

-- Solo el cron (que corre con privilegio de superusuario) la invoca. El
-- REVOKE a anon/authenticated es explícito a propósito: Supabase otorga
-- EXECUTE por ALTER DEFAULT PRIVILEGES y el REVOKE ... FROM PUBLIC no
-- borra esa entrada del ACL (medido en el proyecto: 256 de 305 SECURITY
-- DEFINER tenían anon=X). Sin esto, cualquier autenticado podría forzar
-- el envío masivo de estos avisos antes de tiempo.
REVOKE ALL ON FUNCTION public.dispatch_deferred_publish_notifications() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_deferred_publish_notifications() FROM anon;
REVOKE ALL ON FUNCTION public.dispatch_deferred_publish_notifications() FROM authenticated;

-- ── 4) El job de cron ───────────────────────────────────────────────────
-- Patrón confirmado por 20262170000000 (ai-grading-worker-hourly): se
-- pregunta si `cron.schedule` es INVOCABLE (`to_regprocedure`), no si la
-- extensión figura en `pg_namespace` — y se hace unschedule-then-schedule
-- para que una migración futura que cambie el comando/horario no quede
-- pisada por un `IF NOT EXISTS` que la salte. Es una función SQL directa
-- (sin `net.http_post`, sin credenciales que resolver), así que no aplica
-- ninguna de las cuatro trampas que documenta esa migración.
DO $do$
BEGIN
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE NOTICE 'pg_cron no disponible — los avisos diferidos de publicación quedan sin disparo automático';
    RETURN;
  END IF;

  PERFORM cron.unschedule('dispatch-deferred-publish-notifications')
   WHERE EXISTS (
     SELECT 1 FROM cron.job WHERE jobname = 'dispatch-deferred-publish-notifications'
   );

  PERFORM cron.schedule(
    'dispatch-deferred-publish-notifications',
    '25 * * * *',  -- cada hora en :25 — libre de :05 (grading) y :15 (generación)
    'SELECT public.dispatch_deferred_publish_notifications();'
  );
END
$do$;

DO $desc$
BEGIN
  IF to_regclass('public.cron_job_descriptions') IS NULL THEN RETURN; END IF;

  INSERT INTO public.cron_job_descriptions (jobname, description)
  VALUES (
    'dispatch-deferred-publish-notifications',
    'Cada hora: si un taller, examen o proyecto se publicó con fecha de inicio lejana, manda el aviso "recién publicado" cuando ya falta un día o menos (o si la fecha ya pasó). Evita avisar de clases de dentro de meses el mismo día que se publica todo el semestre junto.'
  )
  ON CONFLICT (jobname) DO UPDATE SET
    description = EXCLUDED.description,
    updated_at = now();
END
$desc$;

NOTIFY pgrst, 'reload schema';
