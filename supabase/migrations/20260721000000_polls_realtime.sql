-- ──────────────────────────────────────────────────────────────────────
-- Realtime para encuestas — show-of-hands en vivo
--
-- El docente lanza una encuesta durante la clase y necesita ver los
-- votos llegar al instante. Antes el alumno votaba → trigger
-- `_tg_poll_response_count_sync` actualizaba `responses_count` en
-- `poll_options`, pero el docente NO se enteraba salvo que clickeara
-- "Actualizar". Con la publicación de realtime, las UPDATEs a
-- `poll_options` (responses_count) y los INSERT/DELETE en
-- `poll_responses` llegan vía WebSocket al cliente.
--
-- Suscripciones del cliente (definidas en el TS):
--   - `poll_options`  UPDATE filter=poll_id=eq.X  → conteos cambian.
--   - `poll_responses` INSERT/DELETE filter=poll_id=eq.X  →
--                      el docente puede mostrar la lista actualizada de
--                      "quién votó qué" sin refetch manual.
-- ──────────────────────────────────────────────────────────────────────

-- Guard idempotente: solo agregamos a la publicación si la tabla todavía
-- no está. `ADD TABLE` falla con "relation is already a member" si se
-- corre dos veces, lo que rompe el migration runner — el wrapper en
-- DO bloque permite re-ejecución sin ruido.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'poll_options'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.poll_options;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'poll_responses'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.poll_responses;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'polls'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.polls;
  END IF;
END
$$;

-- REPLICA IDENTITY FULL para `poll_options`: la suscripción del cliente
-- llega con el OLD row además del NEW cuando es UPDATE, lo cual permite
-- detectar transiciones (ej. "esta opción acaba de llenarse"). Sin esto,
-- el OLD viene con solo la PK y no podemos diff los counts.
ALTER TABLE public.poll_options REPLICA IDENTITY FULL;
-- `poll_responses`: solo se hace INSERT/DELETE, no UPDATE — no es
-- estrictamente necesario FULL, pero el costo es nulo y permite ver
-- los user_ids en los eventos DELETE (sin FULL solo vendría la PK).
ALTER TABLE public.poll_responses REPLICA IDENTITY FULL;

NOTIFY pgrst, 'reload schema';
