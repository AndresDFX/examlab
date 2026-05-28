-- ──────────────────────────────────────────────────────────────────────
-- Control de acceso del estudiante por `estado` académico
--
-- `profiles.estado` (activo/retirado/graduado/aplazado/null) era SOLO
-- metadato para actas/reportes. Ahora gobierna el acceso:
--   - retirado | aplazado → bloqueado (no puede usar la plataforma).
--   - graduado            → solo lectura (ve, pero no crea entregas).
--   - activo | null       → normal.
--
-- Enforcement de cliente (UX) en src/modules/auth/access-control.ts +
-- AppLayout. Enforcement REAL (servidor) acá: policies RESTRICTIVE en las
-- tablas de submissions que ANDean con las permissive existentes SIN
-- tocarlas (las policies de submissions evolucionaron en varias
-- migraciones de grupos; una RESTRICTIVE aditiva es más segura que
-- editarlas).
--
-- Staff (Admin/Docente) tiene estado=null → `student_can_write` = true →
-- no se ve afectado (sigue insertando notas externas, calificando, etc.).
-- ──────────────────────────────────────────────────────────────────────

-- ── Helpers ──────────────────────────────────────────────────────────
-- Bloqueado: retirado o aplazado. Usado por el guard de cliente (vía la
-- columna estado) y disponible para RLS futura si hiciera falta.
CREATE OR REPLACE FUNCTION public.is_student_blocked(_uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = _uid AND p.estado IN ('retirado', 'aplazado')
  );
$$;

-- Puede escribir (crear/editar entregas): cualquiera que NO esté en un
-- estado restringido. estado NULL (staff o estudiante sin estado fijado)
-- o 'activo' → true. retirado/aplazado/graduado → false (graduado = solo
-- lectura). Sin fila de profile → true (defensivo, no rompe inserts del
-- sistema).
CREATE OR REPLACE FUNCTION public.student_can_write(_uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = _uid AND p.estado IN ('retirado', 'aplazado', 'graduado')
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_student_blocked(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.student_can_write(UUID) TO authenticated;

-- ── Policies RESTRICTIVE por tabla de submissions ────────────────────
-- INSERT + UPDATE: el actor debe poder escribir. SELECT/DELETE no se
-- restringen (un graduado puede VER sus entregas y notas).

-- submissions (exámenes)
DROP POLICY IF EXISTS "restrict_write_inactive_student_ins" ON public.submissions;
CREATE POLICY "restrict_write_inactive_student_ins"
  ON public.submissions AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.student_can_write(auth.uid()));
DROP POLICY IF EXISTS "restrict_write_inactive_student_upd" ON public.submissions;
CREATE POLICY "restrict_write_inactive_student_upd"
  ON public.submissions AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.student_can_write(auth.uid()))
  WITH CHECK (public.student_can_write(auth.uid()));

-- workshop_submissions
DROP POLICY IF EXISTS "restrict_write_inactive_student_ins" ON public.workshop_submissions;
CREATE POLICY "restrict_write_inactive_student_ins"
  ON public.workshop_submissions AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.student_can_write(auth.uid()));
DROP POLICY IF EXISTS "restrict_write_inactive_student_upd" ON public.workshop_submissions;
CREATE POLICY "restrict_write_inactive_student_upd"
  ON public.workshop_submissions AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.student_can_write(auth.uid()))
  WITH CHECK (public.student_can_write(auth.uid()));

-- project_submissions
DROP POLICY IF EXISTS "restrict_write_inactive_student_ins" ON public.project_submissions;
CREATE POLICY "restrict_write_inactive_student_ins"
  ON public.project_submissions AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (public.student_can_write(auth.uid()));
DROP POLICY IF EXISTS "restrict_write_inactive_student_upd" ON public.project_submissions;
CREATE POLICY "restrict_write_inactive_student_upd"
  ON public.project_submissions AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (public.student_can_write(auth.uid()))
  WITH CHECK (public.student_can_write(auth.uid()));

NOTIFY pgrst, 'reload schema';
