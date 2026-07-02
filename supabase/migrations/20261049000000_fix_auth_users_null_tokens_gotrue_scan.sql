-- ══════════════════════════════════════════════════════════════════════
-- Reparación: auth.users con columnas de token en NULL rompen a GoTrue.
--
-- SÍNTOMA (reportado en prod):
--   - "Olvidé mi contraseña" (confirm-password-reset) → Edge non-2xx.
--   - Docente → cambio masivo de contraseñas → "0 actualizada(s), 60 con error.
--     Primero: Database error loading user".
--   - (Y además esos usuarios NO podían ni iniciar sesión: el login devolvía
--     500 "Database error querying schema".)
--
-- CAUSA RAÍZ:
--   GoTrue (Go) escanea varias columnas TEXT de auth.users hacia strings NO
--   nullables (confirmation_token, recovery_token, email_change,
--   email_change_token_new, ...). Si están en NULL, el scan falla al CARGAR el
--   usuario → cualquier operación que cargue el user (login, getUserById,
--   updateUserById) revienta. Las filas de los 60 estudiantes de
--   "Internetworking-2711V" (FESNA) se crearon por un INSERT directo a
--   auth.users que dejó esas columnas en NULL en vez de '' (cadena vacía, que
--   es lo que setea GoTrue vía admin.createUser en el flujo normal de importación).
--
-- FIX: normalizar a '' toda columna de token sensible que esté en NULL.
-- Idempotente (solo toca filas con algún NULL). Corre sobre el schema auth
-- (la migración se ejecuta con privilegios de owner).
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fixed integer;
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE NOTICE 'auth.users no existe en este entorno — skip';
    RETURN;
  END IF;

  UPDATE auth.users
  SET
    confirmation_token         = COALESCE(confirmation_token, ''),
    recovery_token             = COALESCE(recovery_token, ''),
    email_change               = COALESCE(email_change, ''),
    email_change_token_new     = COALESCE(email_change_token_new, ''),
    email_change_token_current = COALESCE(email_change_token_current, ''),
    phone_change               = COALESCE(phone_change, ''),
    phone_change_token         = COALESCE(phone_change_token, ''),
    reauthentication_token     = COALESCE(reauthentication_token, '')
  WHERE confirmation_token IS NULL
     OR recovery_token IS NULL
     OR email_change IS NULL
     OR email_change_token_new IS NULL
     OR email_change_token_current IS NULL
     OR phone_change IS NULL
     OR phone_change_token IS NULL
     OR reauthentication_token IS NULL;

  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  RAISE NOTICE 'auth.users token backfill: % fila(s) normalizada(s) a ''''.', v_fixed;
END $$;
