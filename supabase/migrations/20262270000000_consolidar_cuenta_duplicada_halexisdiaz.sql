-- Reasigna las respuestas de encuesta de una cuenta DUPLICADA a la cuenta real
-- del mismo estudiante (UNIAJ, Harold Alexis Díaz Taborda).
--
-- ══════════════════════════════════════════════════════════════════════════
-- ── El caso ──────────────────────────────────────────────────────────────
-- El estudiante terminó con dos cuentas que se diferencian en UNA letra del
-- dominio:
--   REAL       halexisdiaz@estudiante.uniajc.edu.co   — 177 de las 178 cuentas
--              de estudiante de UNIAJ usan este dominio. Matriculado el 15 de
--              agosto, ANTES de que se generara el Acuerdo Pedagógico de
--              Arquitectura (2 de septiembre), así que SÍ tiene su ranura de
--              firma en el snapshot y su solicitud pendiente.
--   DUPLICADA  halexisdiaz@estudiantes.uniajc.edu.co  — la ÚNICA del proyecto
--              con el dominio en plural. Matriculada el 12 de septiembre, diez
--              días DESPUÉS de generado el acuerdo.
--
-- `generated_reports.html` es un snapshot inmutable —es lo que se firma— con
-- una ranura por estudiante anclada a un `data-firma-uid`. La cuenta duplicada
-- no aparece en él, así que no tenía dónde dibujar la firma: el reporte «no me
-- deja firmar el acuerdo» era eso, y el bloqueo era correcto. Misma clase de
-- caso que el backfill 20262220000000 (Kevin Chocue).
--
-- ── Por qué esto necesita una migración y no un UPDATE por REST ──────────
-- `poll_question_responses` tiene los tres write policies en `FALSE` a
-- propósito (mig 20260984000000): solo se escribe por RPC SECURITY DEFINER,
-- para que nadie —ni un Admin, ni el SuperAdmin— pueda alterar las respuestas
-- de una encuesta desde el cliente. Es la misma defensa anti-«self-tamper» que
-- el resto del proyecto. La consecuencia práctica es que la reasignación tiene
-- que pasar por acá, donde además queda registro de quién la hizo y por qué.
--
-- La entrega del Quiz 1 ya se movió por REST (esa tabla sí tiene rama de
-- Admin/SuperAdmin en su policy de UPDATE). Lo único que faltaba eran estas 9
-- respuestas de la encuesta de inicio de semestre sobre bienestar,
-- conectividad y flexibilidad — datos que sirven para acompañar al estudiante,
-- así que perderlos al borrar la cuenta duplicada sería el peor resultado.
--
-- ── Por qué mover y no dejar que se borren en cascada ────────────────────
-- La encuesta sigue ABIERTA y admite cambios, así que técnicamente él podría
-- volver a responderla desde su cuenta real. Pero son nueve respuestas
-- escritas a mano sobre su propia situación: pedirle que las reescriba porque
-- la plataforma le duplicó la cuenta es trasladarle a él un problema que no
-- causó.
--
-- ── Idempotente y defensiva ─────────────────────────────────────────────
-- No hace nada si la tabla no existe, si la cuenta duplicada ya se borró, o si
-- las respuestas ya están en la cuenta real. El `UNIQUE (question_id,
-- user_id)` no puede chocar: el WHERE excluye las preguntas que la cuenta real
-- ya tenga respondidas (hoy, ninguna).
-- ── Ojo con el NÚMERO de esta migración ─────────────────────────────────
-- Nació como 20262240000000 y NO se aplicó: ya existía
-- `20262240000000_reset_attempt_yefferson_scope_taller.sql` con ese mismo
-- número. Supabase lleva el registro por VERSIÓN (el prefijo), no por nombre
-- de archivo, así que dio la versión por aplicada y se saltó el archivo — el
-- workflow terminó en verde y no movió ni una fila. Por eso se renumeró.
-- Al crear una migración, verificar que el prefijo no exista ya:
--   ls supabase/migrations/*.sql | sed 's#.*/##' | cut -c1-14 | sort | uniq -d
-- ══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_dup  UUID := '2bf22c07-11b7-48ee-a1ac-8f4539f31149';
  v_real UUID := 'e45f37ef-ef52-4db3-bd70-470c3139d9be';
  v_movidas INT := 0;
BEGIN
  IF to_regclass('public.poll_question_responses') IS NULL THEN
    RAISE NOTICE 'poll_question_responses no existe en este entorno; no hay nada que mover.';
    RETURN;
  END IF;

  -- Si alguna de las dos cuentas ya no está, la consolidación se hizo (o el
  -- entorno es otro). No es un error.
  IF to_regclass('public.profiles') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_real) THEN
    RAISE NOTICE 'La cuenta destino no existe en este entorno; se omite.';
    RETURN;
  END IF;

  UPDATE public.poll_question_responses r
     SET user_id = v_real
   WHERE r.user_id = v_dup
     -- Ninguna pregunta que la cuenta real ya haya respondido: eso violaría
     -- el UNIQUE (question_id, user_id) y además pisaría una respuesta suya.
     AND NOT EXISTS (
       SELECT 1
         FROM public.poll_question_responses x
        WHERE x.user_id = v_real
          AND x.question_id = r.question_id
     );

  GET DIAGNOSTICS v_movidas = ROW_COUNT;
  RAISE NOTICE 'Respuestas de encuesta reasignadas a la cuenta real: %', v_movidas;
END $$;
