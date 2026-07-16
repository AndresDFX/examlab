-- Catálogo de VIDEOS DE AYUDA de la plataforma para el Asistente IA de plataforma.
-- El edge platform-support-chat inyecta estos videos en la KB del prompt para que
-- el asistente REFERENCIE el video tutorial del módulo que el usuario consulta.
-- Las URLs (video_url) se rellenan con los enlaces públicos de Supabase Storage (bucket help-videos) una vez subidos los
-- videos: UPDATE public.platform_help_videos SET video_url='https://<proj>.supabase.co/storage/v1/object/public/help-videos/modulo-t03.mp4' WHERE module_id='modulo-t03';
-- Seed derivado de docs/demos/admin/pipeline/modules/module-*.json (título + ruta + rol).
DO $$
BEGIN
  IF to_regclass('public.platform_help_videos') IS NULL THEN
    CREATE TABLE public.platform_help_videos (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      module_id   text UNIQUE,
      title       text NOT NULL,
      route       text,
      role        text,          -- 'Estudiante' | 'Docente' | 'Admin' | NULL (todos)
      video_url   text,          -- URL pública de Supabase Storage (NULL = "video en preparación")
      position    integer NOT NULL DEFAULT 0,
      is_active   boolean NOT NULL DEFAULT true,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE public.platform_help_videos ENABLE ROW LEVEL SECURITY;
    -- SELECT: cualquier autenticado (contenido de ayuda, no sensible; el edge lee por service_role).
    CREATE POLICY phv_select ON public.platform_help_videos
      FOR SELECT TO authenticated USING (true);
    -- WRITE: solo SuperAdmin (los videos son de la plataforma, no del tenant).
    CREATE POLICY phv_write ON public.platform_help_videos
      FOR ALL TO authenticated
        USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

    INSERT INTO public.platform_help_videos (module_id, title, route, role, position) VALUES
  ('modulo-01', 'Panel de administración y Dashboard', '/app', 'Admin', 1),
  ('modulo-02', 'Gestión de Usuarios y Roles', '/app/admin/users', 'Admin', 2),
  ('modulo-03', 'Estructura Académica', '/app/admin/academic', 'Admin', 3),
  ('modulo-04', 'Gestión de Cursos', '/app/admin/courses', 'Admin', 4),
  ('modulo-05', 'Contenidos', '/app/teacher/contents', 'Admin', 5),
  ('modulo-06', 'Biblioteca de Videos', '/app/videos', 'Admin', 6),
  ('modulo-07', 'Configuración de IA', '/app/admin/ai-prompts', 'Admin', 7),
  ('modulo-08', 'Configuración del Tenant', '/app/admin/settings', 'Admin', 8),
  ('modulo-09', 'Certificados', '/app/certificates', 'Admin', 9),
  ('modulo-10', 'Estadísticas', '/app/admin/statistics', 'Admin', 10),
  ('modulo-11', 'Informes', '/app/admin/report-templates', 'Admin', 11),
  ('modulo-12', 'Auditoría', '/app/admin/audit-logs', 'Admin', 12),
  ('modulo-13', 'Soporte', '/app/admin/support', 'Admin', 13),
  ('modulo-14', 'Papelera', '/app/trash', 'Admin', 14),
  ('modulo-15', 'Cuenta y Sesión', '/app', 'Admin', 15),
  ('modulo-16', 'Cola de IA', '/app/admin/ai-cron', 'Admin', 16),
  ('modulo-t01', 'Panel del Docente', '/app', 'Docente', 1),
  ('modulo-t02', 'Gestión de Cursos (Docente)', '/app/teacher/courses', 'Docente', 2),
  ('modulo-t03', 'Exámenes (Docente)', '/app/teacher/exams', 'Docente', 3),
  ('modulo-t04', 'Talleres (Docente)', '/app/teacher/workshops', 'Docente', 4),
  ('modulo-t05', 'Proyectos (Docente)', '/app/teacher/projects', 'Docente', 5),
  ('modulo-t06', 'Banco de Preguntas (Docente)', '/app/teacher/question-bank', 'Docente', 6),
  ('modulo-t07', 'Calificaciones (Docente)', '/app/teacher/gradebook', 'Docente', 7),
  ('modulo-t08', 'Asistencia (Docente)', '/app/teacher/attendance', 'Docente', 8),
  ('modulo-t09', 'Contenidos (Docente)', '/app/teacher/contents', 'Docente', 9),
  ('modulo-t10', 'Biblioteca de Videos (Docente)', '/app/videos', 'Docente', 10),
  ('modulo-t11', 'Pizarras (Docente)', '/app/teacher/whiteboards', 'Docente', 11),
  ('modulo-t12', 'Encuestas (Docente)', '/app/teacher/polls', 'Docente', 12),
  ('modulo-t13', 'Mensajes (Docente)', '/app/messages', 'Docente', 13),
  ('modulo-t14', 'Calendario (Docente)', '/app/teacher/calendar', 'Docente', 14),
  ('modulo-s01', 'Panel del Estudiante', '/app', 'Estudiante', 1),
  ('modulo-s02', 'Mis Cursos (Estudiante)', '/app/student/courses', 'Estudiante', 2),
  ('modulo-s03', 'Exámenes (Estudiante)', '/app/student/exams', 'Estudiante', 3),
  ('modulo-s04', 'Talleres (Estudiante)', '/app/student/workshops', 'Estudiante', 4),
  ('modulo-s05', 'Proyectos (Estudiante)', '/app/student/projects', 'Estudiante', 5),
  ('modulo-s06', 'Mis Notas (Estudiante)', '/app/student/grades', 'Estudiante', 6),
  ('modulo-s07', 'Asistencia (Estudiante)', '/app/student/attendance', 'Estudiante', 7),
  ('modulo-s08', 'Encuestas (Estudiante)', '/app/student/polls', 'Estudiante', 8),
  ('modulo-s09', 'Pizarras (Estudiante)', '/app/student/whiteboards', 'Estudiante', 9),
  ('modulo-s10', 'Tutor IA (Estudiante)', '/app/student/tutor', 'Estudiante', 10),
  ('modulo-s11', 'Certificados (Estudiante)', '/app/student/certificates', 'Estudiante', 11),
  ('modulo-s12', 'Calendario (Estudiante)', '/app/student/calendar', 'Estudiante', 12),
  ('modulo-s13', 'Cuenta y Sesión (Estudiante)', '/app/student/courses', 'Estudiante', 13);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
