-- ──────────────────────────────────────────────────────────────────────
-- One-shot cleanup: huérfanos en auth.users sin profile.
--
-- Antes de la edge `admin-delete-user` (mig conceptual del 2026-06-01),
-- el frontend borraba con `DELETE FROM profiles` directo desde el
-- cliente. Eso dejaba `auth.users` huérfano — sin profile asociado pero
-- con email "ocupado", lo que rompía el chequeo de unicidad
-- (`check_email_taken` también mira auth.users) al intentar recrear con
-- el mismo correo.
--
-- Esta migración limpia esos huérfanos UNA SOLA VEZ. Es idempotente:
-- si no hay huérfanos (caso esperado en futuros runs), el DELETE no
-- borra nada. Las relaciones que pudieran haber quedado en otras
-- tablas (password_reset_tokens, email_change_tokens, etc.) cascadean
-- por las FKs `REFERENCES auth.users(id) ON DELETE CASCADE`.
--
-- Filtro de seguridad: solo borramos usuarios SIN profile Y SIN roles
-- activos. Si por algún caso raro hay un user con rol pero sin profile
-- (no debería pasar — el trigger handle_new_user crea profile sync),
-- lo dejamos vivo para inspección manual posterior.
--
-- Audit log: emitimos un log por cada huérfano borrado para
-- trazabilidad post-mortem.
-- ──────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  r RECORD;
  v_deleted INT := 0;
BEGIN
  FOR r IN
    SELECT u.id, u.email
    FROM auth.users u
    WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
      AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = u.id)
  LOOP
    BEGIN
      -- Audit ANTES del delete (después no podríamos leer u.email).
      INSERT INTO public.audit_logs (
        action, category, severity, entity_type, entity_id, entity_name, metadata
      ) VALUES (
        'user.orphan_cleanup',
        'user',
        'warning',
        'user',
        r.id,
        r.email,
        jsonb_build_object('reason', 'no_profile_no_roles', 'migration', '20260805000000')
      );

      DELETE FROM auth.users WHERE id = r.id;
      v_deleted := v_deleted + 1;
    EXCEPTION WHEN OTHERS THEN
      -- Si un huérfano puntual no se puede borrar (FK colgada en una
      -- tabla sin ON DELETE CASCADE), lo logueamos y seguimos con el
      -- resto. El admin puede investigarlo después desde audit_logs.
      INSERT INTO public.audit_logs (
        action, category, severity, entity_type, entity_id, entity_name, metadata
      ) VALUES (
        'user.orphan_cleanup_failed',
        'user',
        'error',
        'user',
        r.id,
        r.email,
        jsonb_build_object('sqlerrm', SQLERRM, 'migration', '20260805000000')
      );
    END;
  END LOOP;

  RAISE NOTICE 'orphan_cleanup: % rows deleted from auth.users', v_deleted;
END $$;
