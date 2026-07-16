-- Tabla de supuestos de costo/precio para la calculadora del SuperAdmin
-- (/app/superadmin/pricing-calculator). Singleton: una sola fila. Solo SuperAdmin
-- lee/escribe (contiene lógica comercial sensible: costos internos y márgenes).
-- El seed debe mantenerse en sincronía con FALLBACK_ASSUMPTIONS de
-- src/modules/pricing/pricing-engine.ts (ver invariantes cross-file en CLAUDE.md).
DO $$
BEGIN
  IF to_regclass('public.pricing_assumptions') IS NULL THEN
    CREATE TABLE public.pricing_assumptions (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      singleton                boolean NOT NULL DEFAULT true,
      costo_fijo_mensual       numeric NOT NULL DEFAULT 51,
      costo_humano_admin       numeric NOT NULL DEFAULT 225,
      factor_humano_indep      numeric NOT NULL DEFAULT 0.5,
      storage_overage_usd_gb   numeric NOT NULL DEFAULT 0.0213,
      egress_overage_usd_gb    numeric NOT NULL DEFAULT 0.09,
      gb_base_por_matricula    numeric NOT NULL DEFAULT 0.016,
      margen_default           numeric NOT NULL DEFAULT 0.90,
      factor_materias_default  numeric NOT NULL DEFAULT 6,
      descuento_anual          numeric NOT NULL DEFAULT 0.10,
      scale_curve              jsonb  NOT NULL,
      plans                    jsonb  NOT NULL,
      addons                   jsonb  NOT NULL,
      updated_at               timestamptz NOT NULL DEFAULT now(),
      updated_by               uuid REFERENCES auth.users(id),
      CONSTRAINT pricing_assumptions_singleton UNIQUE (singleton)
    );

    ALTER TABLE public.pricing_assumptions ENABLE ROW LEVEL SECURITY;

    -- RLS: SuperAdmin-only en TODAS las operaciones.
    CREATE POLICY pricing_assumptions_select ON public.pricing_assumptions
      FOR SELECT TO authenticated USING (public.is_super_admin());
    CREATE POLICY pricing_assumptions_insert ON public.pricing_assumptions
      FOR INSERT TO authenticated WITH CHECK (public.is_super_admin());
    CREATE POLICY pricing_assumptions_update ON public.pricing_assumptions
      FOR UPDATE TO authenticated
        USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
    -- Sin DELETE: el singleton no se borra.

    INSERT INTO public.pricing_assumptions (scale_curve, plans, addons) VALUES (
      '[{"matr":1000,"infra":51,"usdPerMatr":0.051},
        {"matr":2500,"infra":53,"usdPerMatr":0.021},
        {"matr":5000,"infra":65,"usdPerMatr":0.013},
        {"matr":10000,"infra":90,"usdPerMatr":0.009},
        {"matr":15000,"infra":120,"usdPerMatr":0.008},
        {"matr":25000,"infra":180,"usdPerMatr":0.007},
        {"matr":50000,"infra":700,"usdPerMatr":0.014},
        {"matr":100000,"infra":900,"usdPerMatr":0.009}]'::jsonb,
      '{"Starter":{"cap":200,"gb":25,"listAuto":79,"listAdmin":null,"infraEst":10,"adminOfrecido":false},
        "Pequena":{"cap":1000,"gb":50,"listAuto":149,"listAdmin":449,"infraEst":15,"adminOfrecido":true},
        "Mediana":{"cap":3000,"gb":100,"listAuto":349,"listAdmin":749,"infraEst":30,"adminOfrecido":true},
        "Grande":{"cap":10000,"gb":200,"listAuto":799,"listAdmin":1499,"infraEst":80,"adminOfrecido":true},
        "Enterprise":{"cap":null,"gb":500,"listAuto":1499,"listAdmin":null,"infraEst":200,"adminOfrecido":true}}'::jsonb,
      '{"iaAdmin":{"list":0.10,"cost":0.062},"storageExtra":{"list":10,"cost":2.13},
        "codeRunner":{"list":49,"cost":5},"aislamiento":{"list":99,"cost":75},
        "ssoSetup":{"list":99,"cost":50},"ssoMensual":{"list":29,"cost":0},
        "certificacion":{"list":29,"cost":0}}'::jsonb
    );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
