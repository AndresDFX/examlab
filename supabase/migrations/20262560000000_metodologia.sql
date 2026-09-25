-- ══════════════════════════════════════════════════════════════════════
-- La metodología acordada: un campo del sílabo, no una instrucción impresa.
--
-- El Acuerdo Pedagógico tiene una sección «Acuerdo sobre los aspectos
-- metodológicos» cuyo contenido es TEXTO LITERAL de la plantilla: «Describa acá
-- la modalidad de las clases, la metodología acordada y la dinámica de cada
-- sesión». O sea que todos los Acuerdos firmados llevan impresa una instrucción
-- dirigida a quien iba a redactarla, en lugar de lo acordado.
--
-- Va donde ya vive el resto del sílabo —`academic_subjects`, junto a objetivos,
-- contenidos, bibliografía, intensidad horaria y sistema de evaluación— y por
-- el mismo camino que los OBJETIVOS, que es como el Acuerdo ya los imprime: se
-- editan una vez en Académico → Asignaturas y todos los cursos de esa
-- asignatura los reflejan. Un campo por curso habría significado reescribir lo
-- mismo en cada grupo.
--
-- Sin valor por defecto: nada cambia hasta que alguien la escriba, y mientras
-- tanto la casilla sale vacía. Vacía es mejor que la instrucción: un documento
-- firmado no puede decirle al lector que redacte algo.
-- ══════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF to_regclass('public.academic_subjects') IS NOT NULL THEN
    ALTER TABLE public.academic_subjects
      ADD COLUMN IF NOT EXISTS metodologia TEXT;
  END IF;
END $$;

COMMENT ON COLUMN public.academic_subjects.metodologia IS
  'Metodología del sílabo: modalidad de las clases y dinámica de las sesiones. '
  'La imprime el Acuerdo Pedagógico, igual que objetivos y contenidos.';
