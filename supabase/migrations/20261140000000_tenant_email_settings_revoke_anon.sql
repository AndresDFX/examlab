-- Endurecimiento de la tabla de secretos SMTP por institución.
--
-- tenant_email_settings guarda smtp_password (credencial de correo institucional).
-- Su RLS ya está bien acotada (SELECT/INSERT/UPDATE = SuperAdmin o Admin del propio
-- tenant; DELETE solo SA; el edge lee por service_role). PERO los GRANTs de tabla
-- estaban abiertos a `anon` con TODOS los privilegios — exactamente el anti-patrón
-- rls-self-tamper-class: la ÚNICA barrera al secreto es la RLS. Un cambio futuro de
-- policy o un rol mal configurado dejaría la contraseña SMTP legible por el rol
-- público. anon NUNCA debe tocar esta tabla (es config de administración).
--
-- Fix: revocar TODO a anon. Sin impacto funcional (anon no tiene policy → ya estaba
-- denegado por RLS); solo elimina el privilegio latente. Reversible.

DO $$
BEGIN
  IF to_regclass('public.tenant_email_settings') IS NOT NULL THEN
    REVOKE ALL ON public.tenant_email_settings FROM anon;
    -- authenticated conserva SELECT/INSERT/UPDATE/DELETE (la RLS los gatea a
    -- Admin/SA); se revocan los privilegios que un cliente nunca necesita.
    REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.tenant_email_settings FROM authenticated;
  END IF;
END $$;
