-- ══════════════════════════════════════════════════════════════════════
-- RLS hardening (workflow validación) — 2 hallazgos.
--
-- #9/#10 (cross-tenant leak): las policies SELECT de
--   project_submission_video_views y workshop_submission_video_views abrían con
--   `has_role(auth.uid(),'Admin')` GLOBAL como primera rama → un Admin de tenant A
--   podía leer las vistas de video de entregas de tenant B. Fix: quitar esa rama
--   suelta y mover el acceso de staff DENTRO del EXISTS de la entrega, scopeado al
--   tenant del curso vía is_admin_of_course_tenant(course_id) (= SuperAdmin OR
--   Admin del MISMO tenant). El docente del curso ya estaba scopeado (course_teachers).
--
-- #17 (column tamper): la policy UPDATE de support_tickets es row-level (deja al
--   Admin dueño modificar CUALQUIER columna de su ticket). Contra el diseño
--   documentado (el Admin gestiona status/priority; NO resolution_notes ni
--   assigned_to — eso es del SuperAdmin). Postgres no expresa RLS por columna, así
--   que un trigger BEFORE UPDATE congela las columnas sensibles a su valor previo
--   para cualquier caller que NO sea SuperAdmin.
--
-- Idempotente + guards to_regclass (Lovable puede no tener la tabla en su entorno).
-- ══════════════════════════════════════════════════════════════════════

-- ─── #9  project_submission_video_views ───────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.project_submission_video_views') IS NOT NULL THEN
    DROP POLICY IF EXISTS project_submission_video_views_select_owner_or_staff
      ON public.project_submission_video_views;
    CREATE POLICY project_submission_video_views_select_owner_or_staff
      ON public.project_submission_video_views
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.project_submissions s
          WHERE s.id = project_submission_video_views.submission_id
            AND (
              s.user_id = auth.uid()
              OR (
                s.group_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.project_group_members
                  WHERE group_id = s.group_id AND user_id = auth.uid()
                )
              )
              OR EXISTS (
                SELECT 1 FROM public.projects p
                JOIN public.course_teachers ct ON ct.course_id = p.course_id
                WHERE p.id = s.project_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.projects p
                WHERE p.id = s.project_id
                  AND public.is_admin_of_course_tenant(p.course_id)
              )
            )
        )
      );
  END IF;
END $$;

-- ─── #10  workshop_submission_video_views ─────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.workshop_submission_video_views') IS NOT NULL THEN
    DROP POLICY IF EXISTS workshop_submission_video_views_select_owner_or_staff
      ON public.workshop_submission_video_views;
    CREATE POLICY workshop_submission_video_views_select_owner_or_staff
      ON public.workshop_submission_video_views
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM public.workshop_submissions s
          WHERE s.id = workshop_submission_video_views.submission_id
            AND (
              s.user_id = auth.uid()
              OR (
                s.group_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.workshop_group_members
                  WHERE group_id = s.group_id AND user_id = auth.uid()
                )
              )
              OR EXISTS (
                SELECT 1 FROM public.workshops w
                JOIN public.course_teachers ct ON ct.course_id = w.course_id
                WHERE w.id = s.workshop_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.workshops w
                WHERE w.id = s.workshop_id
                  AND public.is_admin_of_course_tenant(w.course_id)
              )
            )
        )
      );
  END IF;
END $$;

-- ─── #17  support_tickets: columnas de resolución/asignación read-only p/ no-SA ──
CREATE OR REPLACE FUNCTION public.tg_support_tickets_guard_admin_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- El SuperAdmin gestiona todo el ciclo (asignación, notas de resolución).
  IF public.is_super_admin() THEN
    RETURN NEW;
  END IF;
  -- El resto de callers que la RLS deja pasar es el Admin DUEÑO del ticket:
  -- puede tocar status/priority/subject/body, pero NO las columnas que son
  -- prerrogativa del SuperAdmin ni las de identidad/soft-delete. Congelamos a
  -- su valor previo (en vez de RAISE) para no romper un UPDATE legítimo que
  -- reenvíe la fila completa desde el cliente.
  NEW.resolution_notes := OLD.resolution_notes;
  NEW.assigned_to      := OLD.assigned_to;
  NEW.tenant_id        := OLD.tenant_id;
  NEW.created_by       := OLD.created_by;
  NEW.deleted_at       := OLD.deleted_at;
  NEW.deleted_by       := OLD.deleted_by;
  RETURN NEW;
END
$function$;

DO $$
BEGIN
  IF to_regclass('public.support_tickets') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tg_support_tickets_guard_admin_columns ON public.support_tickets;
    -- Nombre con prefijo 'a_' NO: el touch trigger (resolved_at) debe correr DESPUÉS
    -- para recomputar resolved_at según el status nuevo. 'guard' (g) < 'touch' (t)
    -- alfabéticamente → guard corre primero, touch tiene la última palabra. OK.
    CREATE TRIGGER tg_support_tickets_guard_admin_columns
      BEFORE UPDATE ON public.support_tickets
      FOR EACH ROW EXECUTE FUNCTION public.tg_support_tickets_guard_admin_columns();
  END IF;
END $$;
