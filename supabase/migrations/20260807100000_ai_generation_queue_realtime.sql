-- ──────────────────────────────────────────────────────────────────────
-- ai_generation_queue: agregar a la publicación supabase_realtime.
--
-- Sin esto, los clientes que se suscriben con `supabase.channel(...).on('postgres_changes', ...)`
-- no reciben eventos cuando el worker drena jobs (status pending → done).
-- El panel `AiGenerationQueuePanel` muestra cambios solo al refrescar
-- manualmente, dándole al usuario la sensación de que "no pasó nada"
-- mientras el worker procesa.
--
-- Idempotente: chequea pg_publication_tables antes de agregar.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'ai_generation_queue'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_generation_queue;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
