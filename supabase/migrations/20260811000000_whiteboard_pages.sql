-- ──────────────────────────────────────────────────────────────────────
-- Whiteboard multi-page (hojas) — soporte para múltiples páginas por
-- pizarra standalone.
--
-- Antes: `whiteboards.scene_json` guardaba una sola escena Excalidraw
-- por pizarra. Una pizarra = una hoja en blanco.
-- Ahora: cada pizarra puede tener N hojas. Cada hoja es un row en
-- `whiteboard_pages` con su propia escena JSONB + posición + nombre
-- opcional. El editor renderiza tabs para navegar entre hojas y permite
-- agregar/eliminar/renombrar.
--
-- Las pizarras de sesión (`attendance_sessions.whiteboard_scene`) NO
-- adoptan este modelo — son pizarras "del momento" 1:1 con la sesión,
-- multi-page sería sobre-ingeniería.
--
-- Backfill: cada pizarra existente recibe UNA hoja en position=0 con
-- el contenido actual de `scene_json`. Mantenemos `whiteboards.scene_json`
-- como respaldo histórico (no se borra en esta migración para evitar
-- pérdida de datos en caso de rollback de la app). El editor lee/escribe
-- vía `whiteboard_pages` exclusivamente; `scene_json` queda fosilizado.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.whiteboard_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whiteboard_id UUID NOT NULL REFERENCES public.whiteboards(id) ON DELETE CASCADE,
  -- Posición ordinal dentro de la pizarra. 0-indexed, gaps permitidos
  -- (al borrar una hoja del medio, el resto se renumera client-side
  -- antes del siguiente save — o se deja con gap, no afecta render).
  position INT NOT NULL,
  -- Nombre opcional de la hoja. Si NULL la UI muestra "Hoja N". El
  -- docente puede renombrarla a "Diagrama", "Ejercicio 2", etc.
  name TEXT,
  -- Misma forma de escena Excalidraw que la columna heredada
  -- `whiteboards.scene_json`. Default = escena vacía.
  scene_json JSONB NOT NULL DEFAULT '{"elements":[],"appState":{}}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Una hoja por (pizarra, posición). Sin esto dos hojas podrían
  -- chocar en la misma posición y el orden quedaría indefinido.
  CONSTRAINT whiteboard_pages_position_unique UNIQUE (whiteboard_id, position)
);

CREATE INDEX IF NOT EXISTS idx_whiteboard_pages_whiteboard
  ON public.whiteboard_pages(whiteboard_id, position);

-- Trigger updated_at — reusa el helper estándar.
DROP TRIGGER IF EXISTS trg_whiteboard_pages_updated_at ON public.whiteboard_pages;
CREATE TRIGGER trg_whiteboard_pages_updated_at
  BEFORE UPDATE ON public.whiteboard_pages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Backfill: por cada pizarra existente, crear UNA hoja en position=0
-- con el contenido actual. Idempotente vía NOT EXISTS (si la pizarra
-- ya tiene al menos una hoja, no hacemos nada).
INSERT INTO public.whiteboard_pages (whiteboard_id, position, scene_json)
SELECT w.id, 0, w.scene_json
FROM public.whiteboards w
WHERE NOT EXISTS (
  SELECT 1 FROM public.whiteboard_pages p WHERE p.whiteboard_id = w.id
);

-- ── RLS ───────────────────────────────────────────────────────────
-- Misma política que whiteboards: el dueño escribe; Admin/SA escriben;
-- alumno enrolled en el course_id puede LEER si is_shared_with_course=true.
-- En lugar de duplicar las reglas, hacemos sub-query a whiteboards y
-- delegamos. Costo de la sub-query es bajo (índice por id).
ALTER TABLE public.whiteboard_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whiteboard_pages_select ON public.whiteboard_pages;
CREATE POLICY whiteboard_pages_select
  ON public.whiteboard_pages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.whiteboards w
      WHERE w.id = whiteboard_pages.whiteboard_id
        AND (
          w.owner_id = auth.uid()
          OR public.has_role(auth.uid(), 'Admin'::public.app_role)
          OR public.is_super_admin()
          OR (
            w.is_shared_with_course = true
            AND w.course_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.course_enrollments ce
              WHERE ce.course_id = w.course_id AND ce.user_id = auth.uid()
            )
          )
        )
    )
  );

DROP POLICY IF EXISTS whiteboard_pages_owner_write ON public.whiteboard_pages;
CREATE POLICY whiteboard_pages_owner_write
  ON public.whiteboard_pages FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.whiteboards w
      WHERE w.id = whiteboard_pages.whiteboard_id
        AND (
          w.owner_id = auth.uid()
          OR public.has_role(auth.uid(), 'Admin'::public.app_role)
          OR public.is_super_admin()
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.whiteboards w
      WHERE w.id = whiteboard_pages.whiteboard_id
        AND (
          w.owner_id = auth.uid()
          OR public.has_role(auth.uid(), 'Admin'::public.app_role)
          OR public.is_super_admin()
        )
    )
  );

NOTIFY pgrst, 'reload schema';
