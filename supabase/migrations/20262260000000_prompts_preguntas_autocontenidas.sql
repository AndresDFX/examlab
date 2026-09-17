-- ═══════════════════════════════════════════════════════════════════════
-- Una pregunta generada no puede apoyarse en OTRA pregunta.
--
-- ── El reporte ────────────────────────────────────────────────────────
-- En el Parcial 1 de Seminario apareció una pregunta que decía «modele el
-- diagrama del sistema del punto anterior». En un examen eso no se sostiene:
-- la navegación puede ser secuencial, el orden puede mezclarse y cada pregunta
-- se responde sola. El docente lo pidió explícito: «las preguntas deben tener
-- toda la información para contestarse por sí mismas».
--
-- ── Por qué también acá y no solo en el código ────────────────────────
-- Los prompts de generación viven en dos lugares. Los del EDGE son literales
-- de TypeScript y se arreglan con un deploy. Pero `project_questions` es
-- configurable: su texto vive en `ai_prompts`, una fila por institución, y esa
-- fila GANA sobre el respaldo del código (`resolveSystemPrompt`). O sea que
-- cambiar solo el edge dejaría el arreglo sin efecto en las 8 instituciones que
-- ya tienen su fila sembrada — que son todas.
--
-- ── Idempotente ───────────────────────────────────────────────────────
-- Solo toca las filas donde la regla NO está. Correr la migración dos veces no
-- duplica el párrafo, y una institución que edite su prompt a mano después no
-- lo pierde: se agrega al final, no se reemplaza el texto del docente.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_regla text :=
    ' REGLA DE AUTOSUFICIENCIA (obligatoria): cada pregunta debe entenderse y responderse POR SI SOLA. '
    'Esta prohibido referirse a otra pregunta ("lo hecho en el punto anterior", "el caso ya descrito", '
    '"usando la clase del ejercicio 2") o dar por sentado que el estudiante la resolvio antes: el orden puede '
    'cambiar y cada una se responde por separado. Si varias preguntas comparten un caso, un enunciado o un '
    'fragmento de codigo, repetilo COMPLETO dentro de cada una. La rubrica tampoco puede apoyarse en otra pregunta.';
  v_n integer;
BEGIN
  IF to_regclass('public.ai_prompts') IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.ai_prompts
     SET system_prompt = system_prompt || v_regla,
         updated_at = now()
   WHERE use_case = 'project_questions'
     AND system_prompt IS NOT NULL
     AND system_prompt NOT ILIKE '%AUTOSUFICIENCIA%';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Prompts de project_questions actualizados: %', v_n;
END $$;
