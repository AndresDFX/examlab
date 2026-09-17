-- ══════════════════════════════════════════════════════════════════════════
-- Reabrir un reintento puntual del taller "Taller Conceptos Scope y Arreglos
-- estaticos" (Programación II / Seminario de Sistemas, 341C UNIAJ) para
-- Yefferson Llanten Mambuscay.
--
-- El taller no tiene `max_attempts` propio, así que hereda el default de la
-- institución (1). Su entrega ya tenía nota (`final_grade` no nulo), así que
-- `attempt_count=1 >= 1` la marcaba agotada y el botón "Actualizar" desaparecía
-- (mismo criterio que `app.student.workshops.tsx`: intento agotado = alcanzó el
-- cap Y la entrega ya está calificada).
--
-- No se sube el `max_attempts` del taller: eso habilitaría un reintento para
-- LOS OTROS 18 estudiantes que ya entregaron con su único intento, no solo
-- para él. Se resetea `attempt_count` a 0 en SU fila: en el próximo submit,
-- `WorkshopQuestions.tsx` lo vuelve a subir a 1 (increment solo porque la
-- entrega previa ya estaba calificada — mismo camino que cualquier primer
-- intento), sin tocar la nota ni las respuestas que ya tiene guardadas hasta
-- que él vuelva a entregar.
-- ══════════════════════════════════════════════════════════════════════════

DO $reintento$
BEGIN
  IF to_regclass('public.workshop_submissions') IS NULL THEN
    RAISE NOTICE 'workshop_submissions ausente; nada que hacer.';
    RETURN;
  END IF;

  UPDATE public.workshop_submissions
     SET attempt_count = 0
   WHERE id = 'b73cac3b-9b64-4bea-b506-86c1b782b95e'
     AND workshop_id = 'fea84550-9549-4bfa-b4f1-017856267e05'
     AND user_id = '33a73d3c-db02-47ad-8724-c7c57cad7474';
END $reintento$;
