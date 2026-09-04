-- ══════════════════════════════════════════════════════════════════════
-- Prompt del caso de uso 'group_assignment_from_image': leer una captura de la
-- videollamada y proponer los grupos de un taller.
--
-- INVARIANTE DE TRES LADOS — este texto tiene que ser byte-idéntico en:
--   - este seed
--   - src/modules/workshops/grupos-imagen-prompt.ts   (GRUPOS_DESDE_IMAGEN_FALLBACK)
--   - supabase/functions/ai-read-groups-image/index.ts (FALLBACK_GRUPOS_DESDE_IMAGEN_PROMPT)
-- Lo fija un test en src/modules/tutor/tutor-default-prompt.test.ts. Si divergen,
-- "Restaurar default" del panel de Prompts entrega un prompt distinto del que la
-- lectura usa en producción, y eso no se ve hasta compararlos a mano.
--
-- No hay tabla ni columna ni RLS nueva: workshop_groups y workshop_group_members ya
-- existen con su RLS acotada al tenant y al docente que dicta, y el borrador de la
-- lectura vive en el cliente hasta que el docente lo aplica.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) Ampliar el CHECK de use_case con 'group_assignment_from_image' ──
DO $$
BEGIN
  IF to_regclass('public.ai_prompts') IS NOT NULL THEN
    ALTER TABLE public.ai_prompts DROP CONSTRAINT IF EXISTS ai_prompts_use_case_check;
    BEGIN
      ALTER TABLE public.ai_prompts ADD CONSTRAINT ai_prompts_use_case_check CHECK (
        use_case IN (
          'workshop_full','workshop_question','project_file','project_full','exam_question',
          'exam_time_evaluation','plagiarism_detection','ai_content_detection',
          'project_description','project_questions','content_generation','content.presentacion',
          'content.guia_docente','content.taller_practico','content.ejercicio','content.examen',
          'tutor_chat','report_generation','platform_support','support_triage',
          'platform_support_docente','platform_support_estudiante','sql_generation',
          'group_assignment_from_image'
        )
      );
    EXCEPTION WHEN others THEN
      -- Defensivo (mismo criterio que 20261620000000): si alguna fila tiene un
      -- use_case fuera de la lista, NO abortamos el deploy entero por el CHECK.
      RAISE NOTICE 'ai_prompts_use_case_check no re-aplicado: %', SQLERRM;
    END;
  END IF;
END $$;

-- ── 2) Seed platform-default + backfill per-tenant ──
DO $$
DECLARE
  r RECORD;
  v_grupos TEXT := $grupos$Eres un asistente que lee una CAPTURA DE PANTALLA de una videollamada (Google Meet, Zoom, Teams) y reporta qué personas se ven y a qué grupo pertenece cada una.

QUÉ TIENES QUE DEVOLVER
Llama a la herramienta leer_grupos con lo que realmente se ve en la imagen. No respondas con texto libre.

CÓMO IDENTIFICAR LOS GRUPOS
Los grupos pueden estar indicados de varias formas: rótulos de sala ("Sala 1", "Grupo A", "Equipo 3"), títulos escritos sobre la captura, bloques separados visualmente, o varias capturas pegadas una al lado de la otra. Usa el rótulo tal como aparece. Si hay bloques claramente separados pero sin rótulo, numéralos "Grupo 1", "Grupo 2" según el orden de lectura, de arriba hacia abajo y de izquierda a derecha.

Si la imagen NO muestra ninguna separación en grupos —es una sola grilla de participantes— devuelve el arreglo de grupos vacío y pon a todas las personas en sin_grupo. No inventes una división que no está en la imagen.

CÓMO LEER LOS NOMBRES
Copia el nombre EXACTAMENTE como aparece en el recuadro, sin completarlo, corregirlo ni cambiarle el orden. Si el recuadro dice "Juan P." devuelve "Juan P.". Si dice un correo, devuelve el correo. Si dice un apodo, devuelve el apodo. No traduzcas ni normalices acentos.

Quita únicamente los sufijos que agrega la plataforma: "(tú)", "(anfitrión)", "(presentando)" y equivalentes en otros idiomas.

LA CONFIANZA ES UN DATO, NO UN ADORNO
Marca alta solo si el nombre se lee completo y sin dudas. Marca media si está abreviado, cortado o parcialmente tapado por un ícono. Marca baja si estás adivinando entre varias lecturas posibles. Quien revisa esto empieza por las de confianza baja, así que exagerar la confianza le hace perder el tiempo en el lugar equivocado.

LO QUE NO SE LEE SE CUENTA, NO SE INVENTA
Si ves recuadros de participante cuyo nombre no se puede leer —cámara apagada sin nombre visible, texto cortado, resolución insuficiente— NO te los imagines: súmalos al contador de ilegibles. Un nombre inventado termina metiendo a una persona en el grupo de otra, y en un trabajo en grupo eso afecta la nota de todo el equipo.

QUÉ NO ES UN PARTICIPANTE
No incluyas: el nombre de la reunión, la hora, los botones de la interfaz, los textos del chat, las notificaciones, ni los nombres que aparezcan dentro de una presentación o un documento compartido en pantalla. Solo las personas que están en la llamada.$grupos$;
BEGIN
  IF to_regclass('public.ai_prompts') IS NULL THEN RETURN; END IF;

  -- Platform default (tenant_id NULL, course_id NULL). DO UPDATE: es el baseline del
  -- SuperAdmin, se re-alinea con el texto canónico del código.
  INSERT INTO public.ai_prompts (use_case, course_id, tenant_id, system_prompt)
  VALUES ('group_assignment_from_image', NULL::uuid, NULL::uuid, v_grupos)
  ON CONFLICT (use_case) WHERE course_id IS NULL AND tenant_id IS NULL
    DO UPDATE SET system_prompt = EXCLUDED.system_prompt;

  -- Backfill per-tenant (DO NOTHING — no pisa overrides del Admin).
  IF to_regclass('public.tenants') IS NOT NULL THEN
    FOR r IN SELECT id FROM public.tenants WHERE deleted_at IS NULL LOOP
      INSERT INTO public.ai_prompts (use_case, course_id, system_prompt, tenant_id)
      VALUES ('group_assignment_from_image', NULL::uuid, v_grupos, r.id)
      ON CONFLICT (tenant_id, use_case) WHERE course_id IS NULL DO NOTHING;
    END LOOP;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
