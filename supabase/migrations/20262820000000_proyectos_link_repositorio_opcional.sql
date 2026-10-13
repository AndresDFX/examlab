-- Proyectos: el link al repositorio (GitHub o Drive) pasa a ser configurable por proyecto.
--
-- Hasta acá la ventana de entrega lo exigía SIEMPRE (validación del navegador; la columna
-- `project_submissions.repository_url` es NULLABLE desde la mig 20260507170000). En un curso sin
-- código —Introducción a la Ingeniería entrega un informe en un ZIP— el estudiante tenía que pegar
-- cualquier enlace para poder entregar.
--
-- Por defecto TRUE: todos los proyectos que ya existen siguen pidiéndolo, igual que antes. Lo apaga el
-- docente en «Editar» del proyecto. La regla del navegador vive en src/modules/projects/repositorio.ts
-- (`pideRepositorio`), que trata la columna ausente como TRUE.
DO $$
BEGIN
  IF to_regclass('public.projects') IS NOT NULL THEN
    ALTER TABLE public.projects
      ADD COLUMN IF NOT EXISTS requires_repository boolean NOT NULL DEFAULT true;
    COMMENT ON COLUMN public.projects.requires_repository IS
      'Si la entrega pide el link al repositorio (GitHub o Drive). FALSE en proyectos sin código ni carpeta que revisar.';
  END IF;
END $$;

-- ── clone_project copia la opción ──
-- Misma firma y mismo cuerpo que la mig 20261033000000, con `requires_repository` en la lista de
-- columnas. Sin esto «Duplicar» la dejaba en su default (TRUE) y la copia volvía a pedir el link que
-- el docente había apagado: justo el caso de las secciones de Introducción, que duplican el proyecto.
CREATE OR REPLACE FUNCTION public.clone_project(_source_id uuid, _target_course_id uuid, _new_title text DEFAULT NULL::text, _new_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, _new_due_date timestamp with time zone DEFAULT NULL::timestamp with time zone, _copy_files boolean DEFAULT true, _copy_groups boolean DEFAULT true)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _new_id UUID;
  _final_title TEXT;
BEGIN
  IF NOT (
    (
      public.is_admin_of_course_tenant((SELECT p.course_id FROM public.projects p WHERE p.id = _source_id))
      AND public.is_admin_of_course_tenant(_target_course_id)
    )
    OR (
      EXISTS (
        SELECT 1 FROM public.projects p
        JOIN public.course_teachers ct ON ct.course_id = p.course_id
        WHERE p.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este proyecto al curso destino';
  END IF;

  -- Papelera: no se puede clonar un proyecto origen en la papelera.
  IF (SELECT p.deleted_at FROM public.projects p WHERE p.id = _source_id) IS NOT NULL THEN
    RAISE EXCEPTION 'No se puede clonar: el proyecto origen está en la papelera';
  END IF;

  SELECT COALESCE(_new_title, 'Copia de ' || p.title)
    INTO _final_title
    FROM public.projects p WHERE p.id = _source_id;

  INSERT INTO public.projects (
    course_id, created_by, title, description, instructions, external_link,
    start_date, due_date, status, max_score, weight, is_external,
    group_mode, group_size_min, group_size_max, requires_repository
  )
  SELECT
    _target_course_id, auth.uid(), _final_title, p.description, p.instructions, p.external_link,
    COALESCE(_new_start_date, p.start_date),
    COALESCE(_new_due_date, p.due_date),
    'draft', p.max_score, p.weight, p.is_external,
    CASE WHEN _copy_groups THEN p.group_mode ELSE 'individual' END,
    CASE WHEN _copy_groups THEN p.group_size_min ELSE NULL END,
    CASE WHEN _copy_groups THEN p.group_size_max ELSE NULL END,
    p.requires_repository
  FROM public.projects p WHERE p.id = _source_id
  RETURNING id INTO _new_id;

  -- Fila M:N para el curso destino. En proyectos el peso/corte vive SOLO en
  -- project_courses (projects no tiene cut_id legacy). weight es NOT NULL → 1.
  INSERT INTO public.project_courses (project_id, course_id, weight, cut_id)
  SELECT
    _new_id,
    _target_course_id,
    COALESCE(pc.weight, p.weight, 1),
    CASE WHEN _target_course_id = p.course_id THEN pc.cut_id ELSE NULL END
  FROM public.projects p
  LEFT JOIN public.project_courses pc
    ON pc.project_id = p.id AND pc.course_id = p.course_id
  WHERE p.id = _source_id
  ON CONFLICT (project_id, course_id) DO NOTHING;

  IF _copy_files THEN
    INSERT INTO public.project_files (
      project_id, type, title, description, expected_rubric, language,
      starter_code, points, position, options
    )
    SELECT
      _new_id, f.type, f.title, f.description, f.expected_rubric, f.language,
      f.starter_code, f.points, f.position, f.options
    FROM public.project_files f
    WHERE f.project_id = _source_id;
  END IF;

  RETURN _new_id;
END
$function$;

-- ── Asistente de la plataforma ──
-- El doc que sembró la mig 20261120000000 le decía al estudiante que el link es «(obligatorio)»; en un
-- proyecto que no lo pide, el asistente lo mandaba a buscar un campo que la pantalla no muestra.
-- `replace` deja intacto cualquier otro cambio que alguien le haya hecho al texto.
DO $$
BEGIN
  IF to_regclass('public.platform_kb_docs') IS NOT NULL THEN
    UPDATE public.platform_kb_docs
       SET body = replace(body, '**enlace al repositorio** (obligatorio)', '**enlace al repositorio** (cuando el proyecto lo pide)')
     WHERE slug = 'est-entregar-taller-proyecto';
  END IF;
END $$;
