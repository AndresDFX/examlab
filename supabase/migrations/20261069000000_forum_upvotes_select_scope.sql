-- ══════════════════════════════════════════════════════════════════════
-- RLS forum_upvotes: SELECT era USING (true) → cualquier autenticado leía TODOS
-- los upvotes de CUALQUIER tenant (quién votó qué reply/thread, cross-tenant) por
-- REST directo. Anti-patrón USING(true) en tabla hija de curso (foros).
--
-- FIX: SELECT scopeado a los upvotes PROPIOS (user_id = auth.uid()) — consistente
-- con las policies INSERT/DELETE (que ya son user_id = auth.uid()) y con el ÚNICO
-- uso real en el cliente (leer los upvotes del usuario actual para resaltar los
-- que marcó; el CONTEO por reply/thread está DENORMALIZADO en forum_replies.upvotes
-- / forum_threads.upvotes, no necesita leer forum_upvotes). SuperAdmin conserva
-- lectura cross-tenant para auditoría. Idempotente + guard.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.forum_upvotes') IS NOT NULL THEN
    DROP POLICY IF EXISTS forum_upvotes_select ON public.forum_upvotes;
    CREATE POLICY forum_upvotes_select ON public.forum_upvotes
      FOR SELECT USING (user_id = auth.uid() OR public.is_super_admin());
  END IF;
END $$;
