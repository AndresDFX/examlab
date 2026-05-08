-- ============================================================
-- Limpieza de RLS policies para `exam_notes`.
--
-- Problema reportado: al rechazar una nota desde el board del docente,
-- el badge volvia a aparecer como pendiente. El frontend hace
-- `update().eq('id', ...)` y la respuesta no traía error, pero el row
-- no se actualizaba: deny silencioso de RLS (devuelve [] sin error).
--
-- Causa raíz probable: la combinación de policies "Students manage own
-- exam notes" (FOR ALL) + "Teachers update exam notes" (FOR UPDATE)
-- es correcta sobre el papel (permissive policies se combinan con OR),
-- pero la coexistencia de WITH CHECK clauses contradictorias entre las
-- dos policies para el mismo UPDATE puede activar comportamientos
-- distintos según versión de Postgres / planner.
--
-- Solución: una sola policy por operación, con la condición OR'd
-- explícitamente dentro del USING/WITH CHECK. Cero ambigüedad.
--
-- Modelo:
--   SELECT  → dueño OR Docente OR Admin
--   INSERT  → solo el dueño puede crear sus notas
--   UPDATE  → dueño (re-enviar tras rechazo) OR Docente/Admin (aprobar/rechazar)
--   DELETE  → solo el dueño
-- ============================================================

DROP POLICY IF EXISTS "Students manage own exam notes" ON public.exam_notes;
DROP POLICY IF EXISTS "Teachers see all exam notes" ON public.exam_notes;
DROP POLICY IF EXISTS "Teachers update exam notes" ON public.exam_notes;

CREATE POLICY exam_notes_select
  ON public.exam_notes
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Docente'::public.app_role)
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
  );

CREATE POLICY exam_notes_insert
  ON public.exam_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY exam_notes_update
  ON public.exam_notes
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Docente'::public.app_role)
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
  )
  WITH CHECK (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Docente'::public.app_role)
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
  );

CREATE POLICY exam_notes_delete
  ON public.exam_notes
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
