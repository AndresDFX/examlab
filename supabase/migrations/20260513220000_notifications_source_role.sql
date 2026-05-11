-- ──────────────────────────────────────────────────────────────────────
-- Notifications: registrar el rol del actor que la generó (`source_role`).
--
-- Bug original: el docente recibe notificaciones de eventos disparados
-- por OTROS docentes (p.ej. cuando un compañero docente del mismo curso
-- califica una entrega, el evento llega también al docente "viewer").
-- Producto del query existente que filtra solo por `user_id` sin saber
-- quién originó el evento.
--
-- Diseño:
--   - `source_role` text — Admin | Docente | Estudiante | Sistema.
--     Lo poblan los call-sites (RPC notify_*, INSERTs directos, hooks de
--     edge functions). Sin valor → 'Sistema' (eventos del trigger DB
--     que no tienen un actor humano claro).
--   - El frontend (use-notifications.ts) FILTRA en client-side todas
--     las notificaciones donde `source_role = mi rol activo` — así un
--     docente no se ve a sí mismo ni a otros docentes; sí ve estudiantes
--     y admins. Estudiantes y admins NO se filtran (el usuario espera ver
--     "mis cosas" + las del docente).
--   - Backfill: filas existentes quedan con NULL y se tratan como
--     'Sistema' en la UI (no se filtran). Aceptable porque el usuario
--     ya las leyó o el evento ya pasó.
--
-- Por qué client-side y no RLS: cambiar las policies obligaría a tocar
-- el JWT custom claim del rol activo, lo cual rompe el setup actual.
-- El filtro en JS es suficiente para una UX bug — los rows siguen
-- accesibles si alguna vista futura los necesita.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS source_role TEXT;

-- Índice combinado para que el filtro client-side
-- `.eq('user_id', uid).neq('source_role', 'Docente')` no escanee la
-- tabla completa cuando el docente lista sus notificaciones.
CREATE INDEX IF NOT EXISTS idx_notifications_user_source_role
  ON public.notifications(user_id, source_role);

-- ── notify_course_students con source_role ───────────────────────────
-- Mantenemos la signatura legacy con DEFAULT NULL para que call-sites
-- antiguos (RPC sin pasar el campo) sigan funcionando — quedarán como
-- 'Sistema' en la UI.

CREATE OR REPLACE FUNCTION public.notify_course_students(
  _course_id   UUID,
  _title       TEXT,
  _body        TEXT,
  _kind        TEXT DEFAULT 'info',
  _link        TEXT DEFAULT NULL,
  _source_role TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _count INTEGER;
  _detected_role TEXT;
  _role  TEXT;
BEGIN
  -- Si el caller pasó `_source_role`, lo respetamos. Si no, lo
  -- inferimos del `auth.uid()` actual: buscamos el rol más
  -- "privilegiado" del actor (Admin > Docente > Estudiante) para
  -- estampar la notificación.  `auth.uid()` sigue disponible aunque
  -- la función sea SECURITY DEFINER — Postgres no lo reescribe.
  IF _source_role IS NOT NULL THEN
    _role := _source_role;
  ELSE
    SELECT role::text INTO _detected_role
      FROM public.user_roles
      WHERE user_id = auth.uid()
      ORDER BY CASE role::text
        WHEN 'Admin' THEN 1
        WHEN 'Docente' THEN 2
        WHEN 'Estudiante' THEN 3
        ELSE 9
      END
      LIMIT 1;
    _role := COALESCE(_detected_role, 'Sistema');
  END IF;

  INSERT INTO public.notifications (user_id, title, body, kind, link, source_role)
  SELECT ce.user_id, _title, _body, _kind, _link, _role
  FROM public.course_enrollments ce
  WHERE ce.course_id = _course_id;

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$$;

-- ── Trigger BEFORE INSERT para INSERTs directos ─────────────────────
-- Cuando el frontend hace `from("notifications").insert(...)` (sin
-- pasar por la RPC), aplicamos la misma detección automática del
-- rol del actor. Solo si el caller no lo proveyó explícitamente.
CREATE OR REPLACE FUNCTION public._fill_notification_source_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _detected_role TEXT;
BEGIN
  IF NEW.source_role IS NULL AND auth.uid() IS NOT NULL THEN
    SELECT role::text INTO _detected_role
      FROM public.user_roles
      WHERE user_id = auth.uid()
      ORDER BY CASE role::text
        WHEN 'Admin' THEN 1
        WHEN 'Docente' THEN 2
        WHEN 'Estudiante' THEN 3
        ELSE 9
      END
      LIMIT 1;
    NEW.source_role := COALESCE(_detected_role, 'Sistema');
  ELSIF NEW.source_role IS NULL THEN
    NEW.source_role := 'Sistema';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fill_notification_source_role ON public.notifications;
CREATE TRIGGER trg_fill_notification_source_role
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public._fill_notification_source_role();

NOTIFY pgrst, 'reload schema';
