-- ═══════════════════════════════════════════════════════════════════════
-- Lista de SUPRESIÓN de correos (rebotes / bandeja llena).
--
-- Problema reportado (tenant Camacho): cuando ExamLab manda una notificación a
-- una dirección cuyo buzón está lleno (Gmail "452 4.2.2 ... out of storage" /
-- "5.2.2 mailbox full"), Gmail ACEPTA el envío (250) y luego rebota un NDR de
-- vuelta a la cuenta remitente (SMTP_USER). Ese rebote es ASÍNCRONO — el edge
-- `send-email` nunca lo ve y no puede reaccionar en el momento del envío. Como
-- cada nueva notificación a esa dirección genera un rebote nuevo, el remitente
-- recibe "Mail Delivery Subsystem" todo el tiempo.
--
-- Solución: una lista de supresión. ExamLab NO envía correos a las direcciones
-- de esta tabla (las notificaciones in-app / push siguen funcionando). Las
-- alimenta:
--   • El Admin/SuperAdmin a mano (pega la dirección del NDR que le llegó).
--   • El propio edge, al detectar un rebote PERMANENTE (5.x.x de buzón/usuario)
--     en el handshake SMTP síncrono — auto-supresión best-effort.
--
-- Enforcement GLOBAL por email: un buzón lleno lo está para cualquier tenant,
-- así que el edge consulta por dirección sin filtrar por tenant. `tenant_id` es
-- sólo atribución/visibilidad para la RLS (qué Admin gestiona qué filas).
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.email_suppressions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  -- 'manual' | 'mailbox_full' | 'hard_bounce' | 'complaint'
  reason     TEXT NOT NULL DEFAULT 'manual',
  note       TEXT,
  tenant_id  UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Normaliza el email a minúsculas + sin espacios SIEMPRE — así el edge puede
-- consultar con `.in("email", [...lowercased])` y el índice único dedup bien.
CREATE OR REPLACE FUNCTION public.tg_email_suppressions_normalize()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.email := lower(trim(NEW.email));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS email_suppressions_normalize ON public.email_suppressions;
CREATE TRIGGER email_suppressions_normalize
  BEFORE INSERT OR UPDATE ON public.email_suppressions
  FOR EACH ROW EXECUTE FUNCTION public.tg_email_suppressions_normalize();

-- Una dirección suprimida UNA vez por scope (tenant concreto o global=NULL).
-- El sentinel evita que COALESCE(NULL) rompa la unicidad de los globales.
CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_email_tenant_uidx
  ON public.email_suppressions (
    lower(email),
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX IF NOT EXISTS email_suppressions_email_idx
  ON public.email_suppressions (lower(email));

ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;

-- SELECT: SuperAdmin (todo) o Admin (su tenant + las globales sembradas por SA).
DROP POLICY IF EXISTS email_suppressions_select ON public.email_suppressions;
CREATE POLICY email_suppressions_select
  ON public.email_suppressions FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin')
        AND (tenant_id = public.current_tenant_id() OR tenant_id IS NULL))
  );

-- INSERT: SA todo; Admin sólo para su propio tenant (no globales).
DROP POLICY IF EXISTS email_suppressions_insert ON public.email_suppressions;
CREATE POLICY email_suppressions_insert
  ON public.email_suppressions FOR INSERT TO authenticated
  WITH CHECK (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  );

-- UPDATE: idem.
DROP POLICY IF EXISTS email_suppressions_update ON public.email_suppressions;
CREATE POLICY email_suppressions_update
  ON public.email_suppressions FOR UPDATE TO authenticated
  USING (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  )
  WITH CHECK (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  );

-- DELETE: SA todo; Admin sólo su tenant (para "reactivar" cuando el buzón se
-- libera). Una global la quita el SA.
DROP POLICY IF EXISTS email_suppressions_delete ON public.email_suppressions;
CREATE POLICY email_suppressions_delete
  ON public.email_suppressions FOR DELETE TO authenticated
  USING (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  );

-- Alivio inmediato del caso reportado: suprimir la dirección que rebota todo el
-- tiempo. Global (tenant_id NULL) → el edge la salta en cualquier tenant. El SA
-- la puede quitar desde el panel cuando el alumno libere su buzón.
INSERT INTO public.email_suppressions (email, reason, note, tenant_id)
VALUES (
  'sebasegar2006@gmail.com',
  'mailbox_full',
  'Auto-sembrado: rebota "452 4.2.2 out of storage / mailbox full" (reportado 2026-06-16). Quitar cuando el buzón se libere.',
  NULL
)
ON CONFLICT DO NOTHING;

NOTIFY pgrst, 'reload schema';
