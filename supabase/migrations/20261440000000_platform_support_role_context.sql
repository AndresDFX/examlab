-- ══════════════════════════════════════════════════════════════════════
-- Asistente IA de plataforma: scope de mensajes por ROL.
--
-- Problema: `platform_support_sessions` es UNA sola conversación por usuario
-- (UNIQUE user_id). Un usuario MULTI-ROL (ej. Docente + Estudiante) comparte el
-- mismo hilo entre roles → al actuar como Estudiante veía/continuaba las Q&A que
-- había hecho como Docente (respuestas admin-céntricas, "tus estudiantes",
-- Gradebook…). Bug reportado.
--
-- Fix: cada mensaje guarda el ROL en el que se hizo (`role_context`). El edge
-- filtra el historial que manda al modelo por el rol ACTIVO, y el cliente
-- muestra solo los mensajes de ese rol. Así, dentro de la misma sesión, cada
-- rol tiene su propio hilo limpio — sin fuga entre roles.
--
-- Mensajes legacy (role_context NULL, previos a este cambio) NO se borran; solo
-- dejan de mostrarse/enviarse (evita seguir contaminando). Defensiva con
-- to_regclass por si la tabla no existe en el entorno.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.platform_support_messages') IS NOT NULL THEN
    ALTER TABLE public.platform_support_messages
      ADD COLUMN IF NOT EXISTS role_context TEXT;
    -- Índice para el filtro por (sesión, rol) del edge y del cliente.
    CREATE INDEX IF NOT EXISTS idx_platform_support_messages_session_role
      ON public.platform_support_messages(session_id, role_context);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
