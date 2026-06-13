-- ──────────────────────────────────────────────────────────────────────
-- Sincronización de encuestas de CUPO (poll_type='slot') con el calendario
--
-- Feature: "Sincronizar con calendario" en encuestas de cupo. Al crear o
-- editar una encuesta de cupo, el docente puede crear UN evento de
-- calendario POR CADA estudiante matriculado en los cursos de la encuesta,
-- con el correo del docente como invitado. El nombre del evento es
-- "NombreCurso - NombreEncuesta". Re-sincronizar ACTUALIZA los eventos ya
-- creados (no duplica).
--
-- Esta tabla es el registro de idempotencia: mapea (poll_id, user_id) →
-- event_id del proveedor (Google/Microsoft). El edge `calendar`
-- (acción `sync_poll_to_calendar`) lee esta tabla para decidir si CREA un
-- evento nuevo (no hay fila) o ACTUALIZA (PATCH) el existente. La escritura
-- real la hace la edge con `service_role` (bypass RLS); la RLS de abajo
-- existe para que la UI del docente pueda LEER el estado de sincronización
-- sin exponer eventos de otros cursos.
--
-- Semántica de fecha/hora del evento (decisión documentada):
--   Los labels de los slots ("lun, 10 jun · 9:00 AM", generados por
--   src/modules/polls/slot-generation.ts) NO contienen el AÑO, por lo que
--   parsearlos a un timestamp exacto es ambiguo y frágil. Por eso el evento
--   usa `polls.closes_at` (TIMESTAMPTZ robusto) como ancla de fecha/hora
--   para TODOS los estudiantes; si `closes_at` es NULL, la edge cae a
--   NOW() + 7 días. Duración por defecto 90 min, zona America/Bogota. El
--   evento funciona como recordatorio del cierre/sustentación de la cupo.
-- ──────────────────────────────────────────────────────────────────────

-- Defensiva (CLAUDE.md): la migración debe ser tolerante a entornos donde
-- la tabla `polls` aún no exista (Lovable a veces marca migraciones como
-- aplicadas aunque el CREATE TABLE no haya corrido). Sin este guard, un
-- entorno sin `polls` aborta TODO el deploy.
DO $$
BEGIN
  IF to_regclass('public.polls') IS NULL THEN
    RAISE NOTICE 'public.polls no existe — se omite poll_calendar_events';
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS public.poll_calendar_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    poll_id UUID NOT NULL REFERENCES public.polls(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- Proveedor del calendario donde vive el evento ('google' | 'microsoft').
    -- TEXT (no enum) para evitar acoplar a un tipo nuevo; el edge valida.
    provider TEXT NOT NULL DEFAULT 'google',
    -- ID del evento en Google Calendar / Microsoft Graph. Lo devuelve el
    -- POST de creación; el PATCH de actualización lo reutiliza.
    event_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Idempotencia: un solo evento por (encuesta, estudiante). Re-sync hace
    -- UPSERT sobre este par y PATCHea el event_id existente.
    UNIQUE (poll_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_poll_calendar_events_poll
    ON public.poll_calendar_events(poll_id);
  CREATE INDEX IF NOT EXISTS idx_poll_calendar_events_user
    ON public.poll_calendar_events(user_id);
END $$;

-- Trigger updated_at (idempotente). `update_updated_at_column` ya existe en
-- la base (lo usan polls, etc.). Solo lo creamos si la tabla existe.
DO $$
BEGIN
  IF to_regclass('public.poll_calendar_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_poll_calendar_events_updated_at
      ON public.poll_calendar_events;
    CREATE TRIGGER trg_poll_calendar_events_updated_at
      BEFORE UPDATE ON public.poll_calendar_events
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;

-- ── RLS ─────────────────────────────────────────────────────────────
-- SELECT: el dueño del evento (estudiante) o el docente de cualquiera de
-- los cursos linkeados a la encuesta (vía poll_courses) o Admin/SA. La
-- escritura efectiva la hace el edge con service_role (bypass RLS); las
-- policies de WRITE acotan por si alguna vez se escribe desde el cliente.
DO $$
BEGIN
  IF to_regclass('public.poll_calendar_events') IS NOT NULL THEN
    ALTER TABLE public.poll_calendar_events ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS poll_calendar_events_select ON public.poll_calendar_events;
    CREATE POLICY poll_calendar_events_select
      ON public.poll_calendar_events FOR SELECT TO authenticated
      USING (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1
            FROM public.poll_courses pc
            JOIN public.course_teachers ct ON ct.course_id = pc.course_id
           WHERE pc.poll_id = poll_calendar_events.poll_id
             AND ct.user_id = auth.uid()
        )
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      );

    -- WRITE (INSERT/UPDATE/DELETE): solo docente de algún curso linkeado o
    -- Admin/SA. El edge usa service_role y no pasa por estas policies, pero
    -- las dejamos coherentes con la autorización del feature.
    DROP POLICY IF EXISTS poll_calendar_events_write ON public.poll_calendar_events;
    CREATE POLICY poll_calendar_events_write
      ON public.poll_calendar_events FOR ALL TO authenticated
      USING (
        EXISTS (
          SELECT 1
            FROM public.poll_courses pc
            JOIN public.course_teachers ct ON ct.course_id = pc.course_id
           WHERE pc.poll_id = poll_calendar_events.poll_id
             AND ct.user_id = auth.uid()
        )
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
            FROM public.poll_courses pc
            JOIN public.course_teachers ct ON ct.course_id = pc.course_id
           WHERE pc.poll_id = poll_calendar_events.poll_id
             AND ct.user_id = auth.uid()
        )
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
