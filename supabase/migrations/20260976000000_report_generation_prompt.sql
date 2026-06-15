-- ══════════════════════════════════════════════════════════════════════
-- ai_prompts: nuevo use_case `report_generation` (Generación IA de informes).
--
-- El editor de plantillas de informes tiene una acción "Generación IA" que
-- inserta contenido en el cursor. Hasta ahora su system prompt estaba
-- hardcodeado en el front (buildAiReportPrompt). Lo movemos a `ai_prompts`
-- para que sea EDITABLE desde Admin → IA → Prompts (SuperAdmin edita el
-- PLATFORM DEFAULT, cada Admin su tenant-global), con la jerarquía estándar:
--   1. course override   (course_id NOT NULL)            ← Docente
--   2. tenant global     (course_id IS NULL, tenant_id=<tenant>) ← Admin
--   3. PLATFORM DEFAULT  (course_id IS NULL, tenant_id IS NULL)  ← SuperAdmin
--   4. fallback hardcodeado en el edge `ai-generate-report`
--
-- El PLATFORM DEFAULT (tenant_id NULL) queda disponible para TODOS los tenants
-- vía el fallback del resolver; los tenants nuevos lo reciben copiado por el
-- provisión de defaults (mig 20260912000000, que copia todos los globales).
-- ══════════════════════════════════════════════════════════════════════

-- 1) Extender el CHECK de use_case para aceptar 'report_generation'.
--    Re-aplicamos el SUPERSET de todos los use_cases conocidos (defensivo:
--    no rechaza ninguna fila existente). Si por algún valor inesperado el ADD
--    fallara, dejamos la columna SIN CHECK en vez de abortar el deploy.
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
        'report_generation'
      ));
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'ai_prompts_use_case_check no re-aplicado (valor inesperado): %', SQLERRM;
  END;
END $$;

-- 2) Seed del PLATFORM DEFAULT (tenant_id NULL, course_id NULL). Idempotente
--    vía idx_ai_prompts_platform_default(use_case). DEBE quedar byte-idéntico
--    con DEFAULT_REPORT_GENERATION_PROMPT (template-engine.ts) + el FALLBACK
--    del edge `ai-generate-report` + el defaultPrompt del AdminPromptsPanel.
DO $$
BEGIN
  IF to_regclass('public.ai_prompts') IS NOT NULL THEN
    INSERT INTO public.ai_prompts (use_case, course_id, tenant_id, system_prompt)
    VALUES (
      'report_generation',
      NULL::uuid,
      NULL::uuid,
      $tpl$Eres un asistente que redacta secciones de informes académicos para un docente.
Escribe en español (es-CO), tono formal e institucional, claro y conciso.
El texto que produces es una PLANTILLA: cuando un dato provenga de las variables
disponibles, inserta el placeholder con doble llave (por ejemplo {{estudiante.nombre}})
EN LUGAR del valor concreto, para que el sistema lo reemplace luego por cada
estudiante o curso. Usa los valores concretos solo como referencia de contexto.
Devuelve únicamente el texto/HTML de la sección, sin explicaciones ni comentarios,
sin envolver en bloques de código.$tpl$
    )
    ON CONFLICT (use_case) WHERE course_id IS NULL AND tenant_id IS NULL
      DO UPDATE SET system_prompt = EXCLUDED.system_prompt;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
