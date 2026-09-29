-- Pendientes para la próxima sesión.
--
-- Al abrir el check-in de una sesión, el docente anota lo que queda pendiente
-- para la siguiente («traigan el taller impreso», «lean el capítulo 3»,
-- «retomamos JOINs»). Los pendientes aparecen en el tablero del curso para el
-- docente y para los estudiantes, y en la columna de esa clase en Asistencia.
-- Se activa POR INSTITUCIÓN desde Configuración → General
-- (`app_settings.session_pending_enabled`, apagado por defecto).
--
-- Por qué una TABLA y no una columna en `attendance_sessions`: esa tabla tiene
-- sus propias reglas de lectura para el estudiante, pensadas para la sesión (el
-- enlace a la sala, la grabación). Los pendientes necesitan otra: solo se
-- muestran si la institución activó la función. Con una tabla aparte, esa
-- regla vive en su propia política y no condiciona a lo demás.
--
-- El pendiente se guarda en la sesión donde se ANOTÓ, no en la que se va a
-- tratar. "La próxima sesión" se resuelve en el cliente contra la lista de
-- sesiones del curso (`src/modules/attendance/pendientes-sesion.ts`): así uno
-- anotado en la última sesión creada no queda sin lugar.
--
-- Idempotente.

-- ── El interruptor de la institución ─────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.app_settings') IS NOT NULL THEN
    ALTER TABLE public.app_settings
      ADD COLUMN IF NOT EXISTS session_pending_enabled boolean NOT NULL DEFAULT false;
    COMMENT ON COLUMN public.app_settings.session_pending_enabled IS
      'Pendientes para la próxima sesión: el check-in los pide y el tablero del curso los muestra a docentes y estudiantes. Apagado por defecto.';
  END IF;
END
$$;

-- ── La tabla ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.session_pending_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES public.attendance_sessions(id) ON DELETE CASCADE,
  body        text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 500),
  -- NULL = abierto. Una marca de tiempo y no un booleano: permite mostrar
  -- cuándo se resolvió sin otra columna.
  done_at     timestamptz,
  position    integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_pending_items_session
  ON public.session_pending_items (session_id, position);

-- ── Quién gestiona: el staff del curso ───────────────────────────────────
-- Docente del curso, Admin de la institución del curso (con scope de tenant,
-- no un `has_role` suelto) o SuperAdmin. Una sesión en la papelera no expone
-- sus pendientes: al restaurarla vuelven.
CREATE OR REPLACE FUNCTION public.session_pending_manageable(_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.attendance_sessions s
     WHERE s.id = _session_id
       AND s.deleted_at IS NULL
       AND (
         public.is_super_admin()
         OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(s.course_id))
         OR EXISTS (
           SELECT 1 FROM public.course_teachers ct
            WHERE ct.course_id = s.course_id AND ct.user_id = auth.uid()
         )
       )
  );
$$;

REVOKE ALL ON FUNCTION public.session_pending_manageable(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_pending_manageable(uuid) TO authenticated;

-- ── Quién lee además: el estudiante matriculado, si la institución lo activó ──
-- Solo LEE. El interruptor se mira acá y no solo en la pantalla: apagar la
-- función tiene que apagarla también para quien consulte por REST. Ni sesión
-- ni curso en la papelera (regla universal de la papelera).
CREATE OR REPLACE FUNCTION public.session_pending_visible_to_student(_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.attendance_sessions s
      JOIN public.courses c ON c.id = s.course_id
      JOIN public.course_enrollments ce ON ce.course_id = s.course_id AND ce.user_id = auth.uid()
      JOIN public.app_settings a ON a.tenant_id = c.tenant_id
     WHERE s.id = _session_id
       AND s.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND a.session_pending_enabled
  );
$$;

REVOKE ALL ON FUNCTION public.session_pending_visible_to_student(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_pending_visible_to_student(uuid) TO authenticated;

-- ── Políticas ────────────────────────────────────────────────────────────
ALTER TABLE public.session_pending_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS session_pending_items_staff ON public.session_pending_items;
CREATE POLICY session_pending_items_staff ON public.session_pending_items
  FOR ALL TO authenticated
  USING (public.session_pending_manageable(session_id))
  WITH CHECK (public.session_pending_manageable(session_id));

DROP POLICY IF EXISTS session_pending_items_student_read ON public.session_pending_items;
CREATE POLICY session_pending_items_student_read ON public.session_pending_items
  FOR SELECT TO authenticated
  USING (public.session_pending_visible_to_student(session_id));

REVOKE ALL ON public.session_pending_items FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.session_pending_items TO authenticated;

DROP TRIGGER IF EXISTS trg_session_pending_items_touch ON public.session_pending_items;
CREATE TRIGGER trg_session_pending_items_touch
  BEFORE UPDATE ON public.session_pending_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
