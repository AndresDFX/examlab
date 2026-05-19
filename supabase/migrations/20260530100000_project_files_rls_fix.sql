-- ============================================================
-- Fix RLS de storage para subida de ZIP de proyectos.
--
-- Síntoma reportado: "Error al subir ZIP: new row violates row-level
-- security policy" al intentar entregar la sección código de un
-- proyecto.
--
-- Posibles causas que esta migración cubre:
--   1) Las políticas previas se perdieron (Lovable re-publish, drop
--      manual, etc.). Las re-creamos idempotentemente.
--   2) El estudiante está en un proyecto GRUPAL — entrega como parte
--      de un grupo y la submission pertenece al group_id, no al
--      user_id. Antes la política solo dejaba subir si la primera
--      carpeta era `auth.uid()`. Ahora también acepta si el primer
--      segmento es un group_id donde el caller es miembro.
--   3) Un Docente / Admin probando el flujo (ej. soporte a un
--      estudiante) — antes la política bloqueaba; ahora les
--      permitimos subir/actualizar.
--
-- Path layout esperado por el cliente (ProjectFiles.tsx):
--   <user_id>/<submission_id>/<file_id>.zip
-- y en flujo grupal v2 (opcional):
--   <group_id>/<submission_id>/<file_id>.zip
-- ============================================================

-- Re-asegura el bucket (idempotente).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'project-files',
  'project-files',
  false,
  104857600,
  ARRAY['application/zip','application/x-zip-compressed','application/octet-stream']
) ON CONFLICT (id) DO NOTHING;

-- Limpia políticas previas para evitar duplicados con condiciones
-- distintas conviviendo (Postgres OR-evalúa policies del mismo target
-- — un permisivo accidental sobre el bucket lo abriría).
DROP POLICY IF EXISTS "project_files_student_upload" ON storage.objects;
DROP POLICY IF EXISTS "project_files_student_update" ON storage.objects;
DROP POLICY IF EXISTS "project_files_student_read_own" ON storage.objects;
DROP POLICY IF EXISTS "project_files_student_delete" ON storage.objects;
DROP POLICY IF EXISTS "project_files_teacher_read_all" ON storage.objects;
DROP POLICY IF EXISTS "project_files_teacher_admin_write" ON storage.objects;

-- ── INSERT ──
-- Acepta:
--  a) Path empieza con auth.uid() (entrega individual).
--  b) Path empieza con un group_id donde el caller es miembro
--     (entrega grupal — cualquier miembro puede subir la pieza).
--  c) Caller es Docente/Admin (soporte, pruebas).
CREATE POLICY "project_files_upload"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'project-files'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.project_group_members m
        WHERE m.group_id::text = (storage.foldername(name))[1]
          AND m.user_id = auth.uid()
      )
      OR public.has_role(auth.uid(), 'Docente')
      OR public.has_role(auth.uid(), 'Admin')
    )
  );

-- ── UPDATE ── (mismo criterio que INSERT para permitir upsert).
CREATE POLICY "project_files_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'project-files'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.project_group_members m
        WHERE m.group_id::text = (storage.foldername(name))[1]
          AND m.user_id = auth.uid()
      )
      OR public.has_role(auth.uid(), 'Docente')
      OR public.has_role(auth.uid(), 'Admin')
    )
  );

-- ── SELECT ──
-- Estudiante: su carpeta o la de un grupo donde sea miembro.
-- Docente/Admin: cualquier archivo del bucket.
CREATE POLICY "project_files_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'project-files'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.project_group_members m
        WHERE m.group_id::text = (storage.foldername(name))[1]
          AND m.user_id = auth.uid()
      )
      OR public.has_role(auth.uid(), 'Docente')
      OR public.has_role(auth.uid(), 'Admin')
    )
  );

-- ── DELETE ──
-- Mismo criterio que INSERT. Los Docentes/Admin pueden limpiar para
-- soporte; los demás solo lo suyo o de su grupo.
CREATE POLICY "project_files_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'project-files'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.project_group_members m
        WHERE m.group_id::text = (storage.foldername(name))[1]
          AND m.user_id = auth.uid()
      )
      OR public.has_role(auth.uid(), 'Docente')
      OR public.has_role(auth.uid(), 'Admin')
    )
  );

NOTIFY pgrst, 'reload schema';
