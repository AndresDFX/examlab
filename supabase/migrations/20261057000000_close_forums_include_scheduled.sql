-- ══════════════════════════════════════════════════════════════════════
-- close_forums_for_course (cascade al finalizar el curso) NO cerraba los foros
-- PROGRAMADOS: el filtro `opens_at <= now` los excluía. Cuando su opens_at
-- llegaba (curso ya finalizado), is_forum_open volvía true y el alumno podía
-- postear. Fix: quitar el filtro opens_at → se estampa manually_closed_at también
-- en foros con opens_at futuro, así is_forum_open devuelve false permanentemente.
-- Se conserva el término closes_at>now (solo evita re-tocar foros ya auto-cerrados;
-- inofensivo). Migración forward. CREATE OR REPLACE resetea grants → re-REVOKE.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.close_forums_for_course(_course_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count int := 0; v_now timestamptz := now();
BEGIN
  IF to_regclass('public.forums') IS NULL THEN RETURN 0; END IF;
  WITH upd AS (
    UPDATE public.forums f
       SET manually_closed_at = v_now, updated_at = v_now
     WHERE f.course_id = _course_id
       AND f.manually_closed_at IS NULL
       AND (f.closes_at IS NULL OR f.closes_at > v_now)
    RETURNING f.id
  ) SELECT count(*) INTO v_count FROM upd;
  RETURN v_count;
END $function$;

-- La función la invoca el trigger tg_cascade_close_on_course_finalized (no el cliente).
REVOKE ALL ON FUNCTION public.close_forums_for_course(uuid) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
