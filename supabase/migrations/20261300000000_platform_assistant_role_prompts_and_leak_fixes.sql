-- ══════════════════════════════════════════════════════════════════════
-- Asistente IA de plataforma: prompts POR ROL en el módulo del SuperAdmin +
-- cierre de fugas de información (auditoría adversarial).
--
-- 1) Prompts editables por rol (goal: "el prompt del asistente para los
--    diferentes roles esté en el módulo de Prompts del SuperAdmin"):
--    nuevos use_case 'platform_support_docente' y 'platform_support_estudiante'
--    (el 'platform_support' existente queda para Admin/SuperAdmin). El edge
--    resuelve la plantilla por el ROL validado en servidor. Texto byte-idéntico
--    con los fallbacks del código:
--      src/modules/support-assistant/support-prompt.ts  (+ copia Deno)
--      src/modules/admin/AdminPromptsPanel.tsx (defaultPrompt)
--
-- 2) Fuga cross-tenant (media, confirmada): el edge ya deriva el tenant del
--    PERFIL (no de session.tenant_id). Acá endurecemos también la DB: un
--    trigger BEFORE INSERT/UPDATE fuerza platform_support_sessions.tenant_id al
--    del perfil del caller, para que nadie pueda apuntar su sesión a otra
--    institución por REST crudo (el WITH CHECK solo validaba user_id).
--
-- 3) Fuga por RLS de platform_kb_docs (defensa en profundidad): el SELECT era
--    USING(true) → cualquier autenticado leía la KB 'admin' por REST directo,
--    saltándose el filtro por audiencia del edge. Se scopea el SELECT por
--    rol→audiencia (Estudiante→estudiante/all, Docente→+docente, Admin/SA→todo).
--    El edge usa service_role (bypassa RLS) → sigue funcionando igual.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1a) Ampliar el CHECK de use_case con los 2 nuevos ──
DO $$
BEGIN
  IF to_regclass('public.ai_prompts') IS NOT NULL THEN
    ALTER TABLE public.ai_prompts DROP CONSTRAINT IF EXISTS ai_prompts_use_case_check;
    ALTER TABLE public.ai_prompts ADD CONSTRAINT ai_prompts_use_case_check CHECK (
      use_case IN (
        'workshop_full','workshop_question','project_file','project_full','exam_question',
        'exam_time_evaluation','plagiarism_detection','ai_content_detection','project_description',
        'project_questions','content_generation','content.presentacion','content.guia_docente',
        'content.taller_practico','content.ejercicio','content.examen','tutor_chat',
        'report_generation','platform_support','support_triage',
        'platform_support_docente','platform_support_estudiante'
      )
    );
  END IF;
END $$;

-- ── 1b) Seed platform-default (tenant_id NULL) + backfill per-tenant, para
--        cada nuevo use_case. Byte-idéntico con los fallbacks del código. ──
DO $$
DECLARE
  r RECORD;
  v_docente TEXT := $prompt$Eres el Asistente de ExamLab para docentes. Ayudas a {{user_name}}, docente de la institución {{tenant_name}}, a usar la plataforma en lo que le corresponde a un docente: crear y configurar cursos con cortes y pesos de evaluación, crear exámenes, talleres y proyectos (incluida la generación con IA), calificar y ajustar notas, tomar asistencia y abrir el check-in por QR, consolidar el gradebook, gestionar contenidos y comunicarse con sus estudiantes.

Reglas:
- Responde en español (es-CO), claro y conciso. Cuando expliques un flujo, usa pasos numerados y accionables.
- Básate ESTRICTAMENTE en la documentación de la plataforma que aparece más abajo. Si algo no está en la documentación, dilo con honestidad y sugiere abrir un ticket en el módulo Soporte, en lugar de inventar.
- No inventes rutas, botones ni nombres de módulos que no aparezcan en la documentación.
- Cuando menciones una acción, indica en qué módulo del menú lateral se encuentra.
- Nunca pidas ni manejes contraseñas, tokens ni secretos.

Fecha y hora actual: {{current_datetime}}.

Documentación de la plataforma:
{{platform_kb}}$prompt$;
  v_estudiante TEXT := $prompt$Eres el Asistente de ExamLab para estudiantes. Ayudas a {{user_name}}, estudiante de la institución {{tenant_name}}, a usar la plataforma en lo que le corresponde a un estudiante: presentar exámenes, entregar talleres y proyectos, marcar asistencia con el código QR, ver sus notas y retroalimentación, participar en encuestas y retos en vivo, y usar el tutor de IA de sus cursos.

Reglas:
- Responde en español (es-CO), claro y breve. Cuando expliques un flujo, usa pasos numerados y accionables.
- Básate ESTRICTAMENTE en la documentación de la plataforma que aparece más abajo. Si algo no está en la documentación, dilo con honestidad y sugiere escribir a su docente o al módulo Soporte, en lugar de inventar.
- No inventes rutas, botones ni nombres de módulos que no aparezcan en la documentación.
- Cuando menciones una acción, indica en qué opción del menú lateral se encuentra.
- Nunca pidas ni manejes contraseñas, tokens ni secretos.

Fecha y hora actual: {{current_datetime}}.

Documentación de la plataforma:
{{platform_kb}}$prompt$;
BEGIN
  IF to_regclass('public.ai_prompts') IS NULL THEN RETURN; END IF;

  -- Platform defaults (tenant_id NULL, course_id NULL). DO UPDATE: baseline del SuperAdmin.
  INSERT INTO public.ai_prompts (use_case, course_id, tenant_id, system_prompt)
  VALUES ('platform_support_docente', NULL::uuid, NULL::uuid, v_docente)
  ON CONFLICT (use_case) WHERE course_id IS NULL AND tenant_id IS NULL
    DO UPDATE SET system_prompt = EXCLUDED.system_prompt;
  INSERT INTO public.ai_prompts (use_case, course_id, tenant_id, system_prompt)
  VALUES ('platform_support_estudiante', NULL::uuid, NULL::uuid, v_estudiante)
  ON CONFLICT (use_case) WHERE course_id IS NULL AND tenant_id IS NULL
    DO UPDATE SET system_prompt = EXCLUDED.system_prompt;

  -- Backfill per-tenant (DO NOTHING — no pisa overrides del Admin).
  IF to_regclass('public.tenants') IS NOT NULL THEN
    FOR r IN SELECT id FROM public.tenants WHERE deleted_at IS NULL LOOP
      INSERT INTO public.ai_prompts (use_case, course_id, system_prompt, tenant_id)
      VALUES ('platform_support_docente', NULL::uuid, v_docente, r.id)
      ON CONFLICT (tenant_id, use_case) WHERE course_id IS NULL DO NOTHING;
      INSERT INTO public.ai_prompts (use_case, course_id, system_prompt, tenant_id)
      VALUES ('platform_support_estudiante', NULL::uuid, v_estudiante, r.id)
      ON CONFLICT (tenant_id, use_case) WHERE course_id IS NULL DO NOTHING;
    END LOOP;
  END IF;
END $$;

-- ── 2) Trigger: forzar platform_support_sessions.tenant_id = tenant del perfil
--        del caller (server-verified). Cierra el oráculo cross-tenant. ──
DO $$
BEGIN
  IF to_regclass('public.platform_support_sessions') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public.tg_platform_support_session_tenant()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
    BEGIN
      -- Solo en contexto de usuario (auth.uid() no nulo). El service_role
      -- (raro para esta tabla) conserva lo que setee. Para SuperAdmin el
      -- perfil tiene tenant_id NULL → sesión sin tenant (correcto).
      IF auth.uid() IS NOT NULL THEN
        NEW.tenant_id := (SELECT tenant_id FROM public.profiles WHERE id = auth.uid());
      END IF;
      RETURN NEW;
    END $fn$;

    DROP TRIGGER IF EXISTS platform_support_session_tenant ON public.platform_support_sessions;
    CREATE TRIGGER platform_support_session_tenant
      BEFORE INSERT OR UPDATE OF tenant_id ON public.platform_support_sessions
      FOR EACH ROW EXECUTE FUNCTION public.tg_platform_support_session_tenant();
  END IF;
END $$;

-- ── 3) RLS de platform_kb_docs: SELECT por rol→audiencia (no más USING(true)) ──
DO $$
BEGIN
  IF to_regclass('public.platform_kb_docs') IS NOT NULL THEN
    DROP POLICY IF EXISTS platform_kb_docs_select ON public.platform_kb_docs;
    CREATE POLICY platform_kb_docs_select
      ON public.platform_kb_docs
      FOR SELECT
      TO authenticated
      USING (
        audience = 'all'
        OR (audience = 'estudiante' AND (
              public.has_role(auth.uid(), 'Estudiante'::public.app_role)
           OR public.has_role(auth.uid(), 'Docente'::public.app_role)
           OR public.has_role(auth.uid(), 'Admin'::public.app_role)
           OR public.is_super_admin()))
        OR (audience = 'docente' AND (
              public.has_role(auth.uid(), 'Docente'::public.app_role)
           OR public.has_role(auth.uid(), 'Admin'::public.app_role)
           OR public.is_super_admin()))
        OR (audience = 'admin' AND (
              public.has_role(auth.uid(), 'Admin'::public.app_role)
           OR public.is_super_admin()))
      );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
