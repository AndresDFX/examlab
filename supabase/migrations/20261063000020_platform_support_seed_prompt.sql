-- ──────────────────────────────────────────────────────────────────────
-- Seed del system prompt del Asistente IA de plataforma
-- (ai_prompts.use_case = 'platform_support') como PLATFORM DEFAULT
-- (tenant_id NULL, course_id NULL) + BACKFILL per-tenant.
--
-- Jerarquía de resolución (idéntica al Tutor IA, pero SIN course override —
-- este asistente no cuelga de un curso):
--   1. tenant global    (course_id IS NULL, tenant_id=<tenant>) ← Admin
--   2. PLATFORM DEFAULT  (course_id IS NULL, tenant_id IS NULL)  ← SuperAdmin
--   3. fallback hardcodeado en el edge `platform-support-chat`
--
-- El texto DEBE quedar BYTE-IDÉNTICO con:
--   - PLATFORM_SUPPORT_FALLBACK del edge (support-prompt.ts, copia Deno).
--   - PLATFORM_SUPPORT_FALLBACK de src/modules/support-assistant/support-prompt.ts.
--   - el defaultPrompt del use_case 'platform_support' en AdminPromptsPanel.tsx.
--
-- Placeholders: {{admin_name}} {{tenant_name}} {{current_datetime}} {{platform_kb}}.
--
-- Idempotente vía los unique parciales existentes:
--   idx_ai_prompts_platform_default(use_case)  WHERE course_id IS NULL AND tenant_id IS NULL
--   idx_ai_prompts_global_per_tenant(tenant_id, use_case)  WHERE course_id IS NULL
-- ──────────────────────────────────────────────────────────────────────

-- A) PLATFORM DEFAULT (tenant_id IS NULL, course_id IS NULL). UPSERT con
--    DO UPDATE: es el baseline de plataforma del SuperAdmin, no un
--    override que un Admin haya editado (esos viven en tenant_id != NULL
--    y NO se tocan acá).
DO $$
BEGIN
  IF to_regclass('public.ai_prompts') IS NOT NULL THEN
    INSERT INTO public.ai_prompts (use_case, course_id, tenant_id, system_prompt)
    VALUES (
      'platform_support',
      NULL::uuid,
      NULL::uuid,
      $prompt$Eres el Asistente de Plataforma de ExamLab, experto en administrar y configurar la plataforma educativa ExamLab. Ayudas a {{admin_name}}, administrador de la institución {{tenant_name}}, a resolver dudas sobre cómo usar y configurar la plataforma: usuarios y roles, cursos con cortes y pesos de evaluación, exámenes, talleres, proyectos, encuestas y retos en vivo, asistencia y check-in por QR, contenidos, inteligencia artificial (calificación, generación, prompts, modelo y cola), certificados, reportes, auditoría, papelera, mensajería y soporte.

Reglas:
- Responde en español (es-CO), claro y conciso. Cuando expliques un flujo, usa pasos numerados y accionables.
- Básate ESTRICTAMENTE en la documentación de la plataforma que aparece más abajo. Si algo no está en la documentación, dilo con honestidad y sugiere abrir un ticket en el módulo Soporte al equipo de plataforma, en lugar de inventar.
- No inventes rutas, botones ni nombres de módulos que no aparezcan en la documentación.
- Cuando menciones una acción, indica en qué módulo del menú lateral se encuentra.
- Nunca pidas ni manejes contraseñas, tokens ni secretos.

Fecha y hora actual: {{current_datetime}}.

Documentación de la plataforma:
{{platform_kb}}$prompt$
    )
    ON CONFLICT (use_case) WHERE course_id IS NULL AND tenant_id IS NULL
      DO UPDATE SET system_prompt = EXCLUDED.system_prompt;
  END IF;
END $$;

-- C) Backfill per-tenant: sembrar el tenant-global para TODOS los tenants
--    existentes que no lo tengan (DO NOTHING — no pisamos overrides del
--    Admin). Fuente = el platform-default recién sembrado en (A).
DO $$
DECLARE
  r RECORD;
  v_tpl TEXT;
BEGIN
  IF to_regclass('public.ai_prompts') IS NOT NULL
     AND to_regclass('public.tenants') IS NOT NULL THEN

    SELECT system_prompt INTO v_tpl
      FROM public.ai_prompts
     WHERE use_case = 'platform_support'
       AND course_id IS NULL
       AND tenant_id IS NULL
     LIMIT 1;

    IF v_tpl IS NOT NULL THEN
      FOR r IN SELECT id FROM public.tenants WHERE deleted_at IS NULL LOOP
        INSERT INTO public.ai_prompts (use_case, course_id, system_prompt, tenant_id)
        VALUES ('platform_support', NULL::uuid, v_tpl, r.id)
        ON CONFLICT (tenant_id, use_case) WHERE course_id IS NULL
          DO NOTHING;
      END LOOP;
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
