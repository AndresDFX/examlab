-- ════════════════════════════════════════════════════════════════════════
-- Módulo comercial de Instituciones — Fase 3: ciclo de facturación automático.
--
-- Activa/desactiva un tenant COMPLETO automáticamente según su ciclo de pago:
--   - Vence billing_end → pasa a 'past_due' (dentro de la gracia).
--   - Pasa la gracia (en DÍAS HÁBILES, parametrizable por tenant) → 'suspended'
--     (solo si auto_suspend=true).
--   - El SA extiende billing_end a futuro → 'active' de nuevo (reactivación).
--
-- Un tenant 'suspended' (o pausado is_active=false) BLOQUEA a TODOS sus usuarios
-- vía current_tenant_id() → NULL → la RLS tenant-scoped les corta todo. No se
-- banea usuario por usuario (reversible: extender billing_end reactiva a todos).
--
-- SEGURO por defecto: auto_suspend=false y billing_end=NULL en todos los tenants
-- actuales (cortesía) → el cron NO toca a nadie hasta que el SA active un ciclo.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. Festivos (para días hábiles). SA-only write; lectura authenticated ───
CREATE TABLE IF NOT EXISTS public.platform_holidays (
  holiday_date DATE PRIMARY KEY,
  label        TEXT
);
ALTER TABLE public.platform_holidays ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_holidays_read ON public.platform_holidays;
CREATE POLICY platform_holidays_read ON public.platform_holidays
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS platform_holidays_write_sa ON public.platform_holidays;
CREATE POLICY platform_holidays_write_sa ON public.platform_holidays
  FOR ALL TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());

-- ── 2. Suma _n días HÁBILES a _start (excluye sáb/dom y festivos) ───────────
CREATE OR REPLACE FUNCTION public.add_business_days(_start date, _n int)
RETURNS date LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d date := _start; rem int := GREATEST(COALESCE(_n, 0), 0);
BEGIN
  IF _start IS NULL THEN RETURN NULL; END IF;
  WHILE rem > 0 LOOP
    d := d + 1;
    IF EXTRACT(ISODOW FROM d) < 6                                   -- 1..5 = lun..vie
       AND NOT EXISTS (SELECT 1 FROM public.platform_holidays h WHERE h.holiday_date = d)
    THEN rem := rem - 1;
    END IF;
  END LOOP;
  RETURN d;
END $$;
GRANT EXECUTE ON FUNCTION public.add_business_days(date, int) TO authenticated;

-- ── 3. Bloqueo por tenant suspendido/pausado en current_tenant_id() ─────────
-- Extiende el bloqueo por-usuario (Fase 0/1) para cubrir el tenant COMPLETO:
-- si el tenant está pausado (is_active=false) o su suscripción está
-- suspended/expired/cancelled, TODOS sus usuarios pierden el tenant → RLS los
-- corta. El SuperAdmin (tenant_id NULL) no entra al JOIN → sigue operando por
-- is_super_admin(). Verificado contra prod: tenants activos no se afectan.
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.tenant_id
    FROM public.profiles p
    JOIN public.tenants t ON t.id = p.tenant_id
   WHERE p.id = auth.uid()
     AND COALESCE(p.is_active, true) = true
     AND p.deleted_at IS NULL
     AND COALESCE(t.is_active, true) = true
     AND COALESCE(t.subscription_status, 'active') NOT IN ('suspended','expired','cancelled');
$$;

-- ── 4. Motor de ciclo de facturación (state machine) ────────────────────────
CREATE OR REPLACE FUNCTION public.process_tenant_subscriptions()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t RECORD; v_cutoff date;
BEGIN
  FOR t IN
    SELECT * FROM public.tenants WHERE deleted_at IS NULL AND billing_end IS NOT NULL
  LOOP
    BEGIN
      v_cutoff := public.add_business_days(t.billing_end, COALESCE(t.grace_business_days, 0));
      -- 1) Reactivación: el SA extendió billing_end a futuro.
      IF t.subscription_status IN ('past_due','suspended','expired')
         AND current_date <= t.billing_end THEN
        UPDATE public.tenants
           SET subscription_status='active', suspended_at=NULL, suspended_reason=NULL
         WHERE id = t.id;
      -- 2) Suspender: pasó la gracia (días hábiles) y el tenant opta por auto_suspend.
      ELSIF current_date > v_cutoff AND t.auto_suspend
            AND t.subscription_status <> 'suspended' THEN
        UPDATE public.tenants
           SET subscription_status='suspended', suspended_at=now(),
               suspended_reason='subscription_expired'
         WHERE id = t.id;
      -- 3) A gracia (past_due): venció pero dentro de la ventana.
      ELSIF current_date > t.billing_end AND current_date <= v_cutoff
            AND t.subscription_status = 'active' THEN
        UPDATE public.tenants SET subscription_status='past_due' WHERE id = t.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Una institución no aborta el batch.
      RAISE NOTICE 'process_tenant_subscriptions: tenant % → %', t.id, SQLERRM;
    END;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.process_tenant_subscriptions() FROM PUBLIC;

-- ── 5. Cron diario (06:00 UTC) + descripción para el panel Supabase Cron ────
DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    RAISE NOTICE 'pg_cron no instalado, salida limpia.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tenant-subscription-check-daily') THEN
    PERFORM cron.schedule(
      'tenant-subscription-check-daily',
      '0 6 * * *',
      $$ SELECT public.process_tenant_subscriptions(); $$
    );
  END IF;
END
$cron$;

INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'tenant-subscription-check-daily',
  'Diario 06:00 UTC: recalcula el estado de suscripción de cada institución con ciclo de facturación (billing_end no nulo). Marca past_due al vencer, suspende al pasar la gracia en DÍAS HÁBILES (solo si auto_suspend=true), y reactiva si el SuperAdmin extendió billing_end. Un tenant suspendido bloquea a todos sus usuarios vía current_tenant_id(). Las instituciones cortesía (billing_end nulo) no se tocan.'
)
ON CONFLICT (jobname) DO UPDATE SET
  description = EXCLUDED.description,
  updated_at = now();

NOTIFY pgrst, 'reload schema';
