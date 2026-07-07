-- ──────────────────────────────────────────────────────────────────────
-- Feature B — Soporte automatizado con IA (advisory-only).
--
-- Seed del system prompt del asistente de TRIAGE de soporte
-- (ai_prompts.use_case = 'support_triage') como PLATFORM DEFAULT
-- (tenant_id NULL, course_id NULL) + BACKFILL per-tenant.
--
-- A diferencia del Asistente de Plataforma (use_case='platform_support',
-- que responde dudas de USO al Admin), 'support_triage' asiste al EQUIPO
-- DE SOPORTE de plataforma para atender un caso concreto: un ticket de un
-- Admin de institución, o un error registrado del sistema. La IA es
-- ADVISORY-ONLY: solo PROPONE (respuesta + diagnóstico + pasos de
-- remediación); jamás ejecuta acciones. La ejecución la dispara un clic
-- humano contra RPCs/edges ya existentes.
--
-- Jerarquía de resolución (idéntica a platform_support — SIN course
-- override, este asistente no cuelga de un curso):
--   1. tenant global    (course_id IS NULL, tenant_id=<tenant>)
--   2. PLATFORM DEFAULT  (course_id IS NULL, tenant_id IS NULL)
--   3. fallback hardcodeado en el edge `support-ai-suggest`
--
-- El texto DEBE quedar BYTE-IDÉNTICO con:
--   - SUPPORT_TRIAGE_CANONICO (FALLBACK) del edge support-ai-suggest/index.ts.
--
-- Placeholder: {{platform_kb}} (la documentación de la plataforma).
--
-- Idempotente + defensivo: guards to_regclass por si la tabla no existe
-- en el entorno (patrón Lovable).
-- ──────────────────────────────────────────────────────────────────────

-- ── A) Extender el CHECK de ai_prompts.use_case ──────────────────────
-- La lista DEBE incluir TODOS los use_cases vigentes (superset EXACTO de
-- 20261063000000, que ya trae 'platform_support') + 'support_triage'. Si
-- se omite uno, el ADD falla con "violated by some row". Se hace ANTES
-- del seed para que el INSERT con 'support_triage' pase el constraint.
DO $$
BEGIN
  IF to_regclass('public.ai_prompts') IS NULL THEN
    RAISE NOTICE 'skip ai_prompts use_case CHECK: tabla ausente';
    RETURN;
  END IF;
  ALTER TABLE public.ai_prompts DROP CONSTRAINT IF EXISTS ai_prompts_use_case_check;
  BEGIN
    ALTER TABLE public.ai_prompts
      ADD CONSTRAINT ai_prompts_use_case_check CHECK (use_case IN (
        'workshop_full',
        'workshop_question',
        'project_file',
        'project_full',
        'exam_question',
        'exam_time_evaluation',
        'plagiarism_detection',
        'ai_content_detection',
        'project_description',
        'project_questions',
        'content_generation',
        'content.presentacion',
        'content.guia_docente',
        'content.taller_practico',
        'content.ejercicio',
        'content.examen',
        'tutor_chat',
        'report_generation',
        'platform_support',
        'support_triage'
      ));
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ai_prompts_use_case_check no re-aplicado (valor inesperado): %', SQLERRM;
  END;
END $$;

-- ── B) PLATFORM DEFAULT (tenant_id IS NULL, course_id IS NULL) ────────
-- UPSERT con DO UPDATE: es el baseline de plataforma del SuperAdmin, no un
-- override que un Admin haya editado (esos viven en tenant_id != NULL y NO
-- se tocan acá).
DO $$
BEGIN
  IF to_regclass('public.ai_prompts') IS NOT NULL THEN
    INSERT INTO public.ai_prompts (use_case, course_id, tenant_id, system_prompt)
    VALUES (
      'support_triage',
      NULL::uuid,
      NULL::uuid,
      $prompt$Eres un asistente de soporte técnico de la plataforma educativa ExamLab. Ayudas al equipo de soporte de plataforma a atender un caso: un ticket de soporte de un administrador de institución, o un error registrado del sistema.

Según el caso, produce en español (es-CO):
- Un diagnóstico breve y honesto de la causa probable.
- Para un ticket: una respuesta cordial y profesional, lista para enviar al administrador, con pasos numerados y accionables cuando aplique.
- Para un error: los pasos de remediación, distinguiendo claramente las acciones SEGURAS (reversibles o idempotentes, que el equipo puede aplicar) de las que requieren revisión manual.

Reglas:
- Básate ESTRICTAMENTE en la documentación de la plataforma y en los datos del caso que se te proveen. Si no tienes suficiente información, dilo y pide el dato que falta, en lugar de inventar.
- NUNCA propongas ejecutar automáticamente acciones destructivas, cambios de configuración, de seguridad, de roles ni manejo de secretos: descríbelas solo como pasos manuales que una persona debe revisar.
- No inventes rutas, botones ni nombres de módulos que no aparezcan en la documentación.
- Sé conciso y accionable.

Documentación de la plataforma:
{{platform_kb}}$prompt$
    )
    ON CONFLICT (use_case) WHERE course_id IS NULL AND tenant_id IS NULL
      DO UPDATE SET system_prompt = EXCLUDED.system_prompt;
  END IF;
END $$;

-- ── C) Backfill per-tenant ────────────────────────────────────────────
-- Sembrar el tenant-global para TODOS los tenants existentes que no lo
-- tengan (DO NOTHING — no pisamos overrides del Admin). Fuente = el
-- platform-default recién sembrado en (B).
DO $$
DECLARE
  r RECORD;
  v_tpl TEXT;
BEGIN
  IF to_regclass('public.ai_prompts') IS NOT NULL
     AND to_regclass('public.tenants') IS NOT NULL THEN

    SELECT system_prompt INTO v_tpl
      FROM public.ai_prompts
     WHERE use_case = 'support_triage'
       AND course_id IS NULL
       AND tenant_id IS NULL
     LIMIT 1;

    IF v_tpl IS NOT NULL THEN
      FOR r IN SELECT id FROM public.tenants WHERE deleted_at IS NULL LOOP
        INSERT INTO public.ai_prompts (use_case, course_id, system_prompt, tenant_id)
        VALUES ('support_triage', NULL::uuid, v_tpl, r.id)
        ON CONFLICT (tenant_id, use_case) WHERE course_id IS NULL
          DO NOTHING;
      END LOOP;
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
