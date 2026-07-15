-- Reply-To por institución (enfoque "From verificado + Reply-To" — sin spoofear).
--
-- En vez de mandar "como" el correo de la institución (rompe SPF/DKIM/DMARC), el
-- correo sale desde el remitente VERIFICADO de la plataforma (o el SMTP propio de
-- la institución si lo configuró) y se pone el correo de la institución/docente
-- como Reply-To, para que las respuestas de los alumnos lleguen a quien deben.
--
-- Esta columna se usa INDEPENDIENTE de use_custom_smtp: una institución puede
-- definir su Reply-To aunque siga usando el SMTP global de la plataforma.

DO $$
BEGIN
  IF to_regclass('public.tenant_email_settings') IS NOT NULL THEN
    ALTER TABLE public.tenant_email_settings
      ADD COLUMN IF NOT EXISTS reply_to TEXT;
    COMMENT ON COLUMN public.tenant_email_settings.reply_to IS
      'Correo de respuesta (Reply-To) de la institución. Se aplica aunque no use SMTP propio. NULL = sin override (cae al docente emisor o al remitente).';
  END IF;
END $$;
