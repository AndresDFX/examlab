-- ──────────────────────────────────────────────────────────────────────
-- Whiteboards (pizarras)
--
-- Dos casos de uso cubiertos por dos lugares de persistencia:
--
--   1. STANDALONE: el docente abre `/app/teacher/whiteboards`, ve la
--      lista de sus pizarras, las edita libremente, las nombra, las
--      borra. No están atadas a sesión ni curso necesariamente — son
--      su espacio de pensamiento. Tabla nueva `whiteboards`.
--
--   2. POR SESIÓN: cuando el docente está en una sesión presencial
--      (attendance_session) y necesita una pizarra "del momento" para
--      explicar algo. Se persiste como JSON dentro de
--      `attendance_sessions.whiteboard_scene` (1:1 con la sesión).
--      Cuando el docente reabre la sesión, su pizarra reaparece.
--
-- Formato del JSON: Excalidraw scene format (elements + appState).
-- Documentado en https://docs.excalidraw.com/docs/codebase/json-schema.
-- Usamos JSONB para permitir indexing por path si en el futuro
-- queremos buscar dentro (ej. "todas las pizarras con un círculo
-- rojo" — no aplica hoy pero JSONB es estándar para escenas).
--
-- Compartir con el curso: V1 mantiene `is_shared_with_course` como
-- toggle simple. Si true, los alumnos del curso ven la pizarra en
-- modo solo-lectura. V2 podría exponer permisos más finos.
-- ──────────────────────────────────────────────────────────────────────

-- ── Tabla whiteboards (standalone) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.whiteboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- tenant_id derivado del owner para acotar visibility cross-tenant
  -- (un SuperAdmin sin override puede ver todas; con override, solo
  -- las del tenant).
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT,
  -- Excalidraw scene JSON. Default: escena vacía con appState mínimo.
  scene_json JSONB NOT NULL DEFAULT '{"elements":[],"appState":{}}'::jsonb,
  -- Curso opcional (si quiere atarla a uno) + flag para compartir con
  -- los alumnos del curso. Sin curso, is_shared_with_course no aplica.
  course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL,
  is_shared_with_course BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whiteboards_owner ON public.whiteboards(owner_id);
CREATE INDEX IF NOT EXISTS idx_whiteboards_course ON public.whiteboards(course_id);
CREATE INDEX IF NOT EXISTS idx_whiteboards_tenant ON public.whiteboards(tenant_id);

-- Trigger updated_at — usa el helper existente.
DROP TRIGGER IF EXISTS trg_whiteboards_updated_at ON public.whiteboards;
CREATE TRIGGER trg_whiteboards_updated_at
  BEFORE UPDATE ON public.whiteboards
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Tenant_id auto-set desde el owner al INSERT, para que el docente
-- no tenga que pasarlo manualmente. Si el owner cambia (raro), se
-- recalcula.
CREATE OR REPLACE FUNCTION public._tg_whiteboard_set_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS NULL OR (TG_OP = 'UPDATE' AND OLD.owner_id IS DISTINCT FROM NEW.owner_id) THEN
    SELECT tenant_id INTO NEW.tenant_id
      FROM public.profiles
     WHERE id = NEW.owner_id;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_whiteboard_set_tenant ON public.whiteboards;
CREATE TRIGGER trg_whiteboard_set_tenant
  BEFORE INSERT OR UPDATE ON public.whiteboards
  FOR EACH ROW EXECUTE FUNCTION public._tg_whiteboard_set_tenant();

-- RLS
ALTER TABLE public.whiteboards ENABLE ROW LEVEL SECURITY;

-- SELECT: dueño, Admin del tenant, SuperAdmin, o alumno matriculado
-- en el curso si is_shared_with_course=true.
DROP POLICY IF EXISTS whiteboards_select ON public.whiteboards;
CREATE POLICY whiteboards_select
  ON public.whiteboards FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin()
    OR (
      is_shared_with_course = true
      AND course_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.course_enrollments ce
         WHERE ce.course_id = whiteboards.course_id AND ce.user_id = auth.uid()
      )
    )
  );

-- INSERT/UPDATE/DELETE: solo dueño o Admin/SA. No abrimos a alumnos
-- por error: en compartido solo leen.
DROP POLICY IF EXISTS whiteboards_owner_write ON public.whiteboards;
CREATE POLICY whiteboards_owner_write
  ON public.whiteboards FOR ALL TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin()
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
    OR public.is_super_admin()
  );

-- ── Columna whiteboard_scene en attendance_sessions ───────────────
ALTER TABLE public.attendance_sessions
  ADD COLUMN IF NOT EXISTS whiteboard_scene JSONB;

COMMENT ON COLUMN public.attendance_sessions.whiteboard_scene IS
  'Excalidraw scene de la pizarra de esta sesión. NULL = sesión sin pizarra usada todavía (el docente nunca la abrió). Cuando el docente abre la pizarra desde la vista de sesión, se inicializa con escena vacía y se autoguarda cada cambio. Compartida con los alumnos de la sesión vía RLS de attendance_sessions.';

NOTIFY pgrst, 'reload schema';
