-- ──────────────────────────────────────────────────────────────────────
-- Realtime para `ai_grading_queue` — habilita que `AiGradingQueueWidget`
-- en el dashboard del docente (y del admin) refresque automáticamente
-- cuando:
--   - Un estudiante entrega y se encola un job (INSERT, pending).
--   - El worker hourly reclama un job (UPDATE, pending → processing).
--   - El worker termina un job (UPDATE, processing → done|failed).
--
-- Sin esto, el widget muestra datos estáticos hasta que el usuario
-- pulse "refrescar". Con realtime, el docente ve aparecer la fila del
-- estudiante apenas entrega.
--
-- REPLICA IDENTITY FULL es necesario para que las filas UPDATE/DELETE
-- traigan el payload completo en realtime (no solo PK). El RLS de la
-- tabla sigue aplicando — el cliente solo recibe eventos de filas que
-- puede ver (docente: cursos que enseña, admin: todas).
--
-- Idempotente: si la tabla ya está en la publicación o ya tiene FULL,
-- el bloque se vuelve no-op.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  -- 1) REPLICA IDENTITY FULL
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'ai_grading_queue'
      AND c.relreplident = 'f'  -- 'f' = FULL
  ) THEN
    ALTER TABLE public.ai_grading_queue REPLICA IDENTITY FULL;
  END IF;

  -- 2) ADD TABLE a la publicación realtime. Se hace en otro try/catch
  --    porque ALTER PUBLICATION ADD TABLE no es idempotente — falla si
  --    la tabla ya está agregada.
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_grading_queue;
  EXCEPTION
    WHEN duplicate_object THEN
      -- Ya estaba en la publicación, no-op.
      NULL;
  END;
END $$;
