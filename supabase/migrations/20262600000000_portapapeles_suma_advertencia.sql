-- Que copiar/pegar sume advertencia, por EXAMEN.
--
-- ── Por qué existe ───────────────────────────────────────────────────────
--
-- El portapapeles dejó de sumar strike por un motivo bueno: en una pregunta de
-- CÓDIGO, mover una línea de un lado a otro del propio editor es escribir la
-- respuesta, y sumaba. Varios docentes lo reportaron y se cambió.
--
-- Pero la excepción se aplicó a TODOS los exámenes, incluidos los que no tienen
-- una sola pregunta de código. Caso real (UNIAJ, 2026-09-28): un parcial de 5
-- cerradas, 3 de SQL y 2 abiertas, donde un estudiante pegó algo a mitad del
-- examen. El sistema lo registró, no sumó nada, y el evento ni siquiera decía
-- en qué pregunta fue — el docente se quedó con «alguien pegó algo» y sin forma
-- de saber si fue copiar la respuesta o mover su propio SQL.
--
-- ── OPT-IN, y eso NO es negociable ───────────────────────────────────────
--
-- `DEFAULT false`: con el interruptor apagado el comportamiento es byte
-- idéntico al de hoy y ningún examen existente cambia. Encenderlo por defecto
-- haría que, el día que la suspensión vuelva a funcionar (mig 20262580000000),
-- media clase se suspenda por pegar — un cambio enorme, silencioso y
-- retroactivo sobre siete instituciones. Es el mismo criterio con el que la
-- sustentación de talleres se hizo opt-in.
--
-- Y aun ENCENDIDO respeta la excepción original: en una pregunta con editor
-- (código, SQL, GUI, consola) pegar sigue sin sumar. Esa parte la decide el
-- cliente en `pegarCuentaComoStrike`, que tiene sus tests.
DO $$
BEGIN
  IF to_regclass('public.exams') IS NOT NULL THEN
    ALTER TABLE public.exams
      ADD COLUMN IF NOT EXISTS clipboard_counts_as_warning boolean NOT NULL DEFAULT false;

    COMMENT ON COLUMN public.exams.clipboard_counts_as_warning IS
      'Si copiar/pegar suma advertencia en este examen. Default false = comportamiento historico. Aun encendido, NO suma en preguntas con editor (codigo/SQL/GUI/consola): ver pegarCuentaComoStrike en src/modules/exams/proctoring.ts.';
  END IF;
END $$;
