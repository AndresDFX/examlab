-- ============================================================
-- similarity_pairs: detección de copia entre estudiantes
-- ============================================================
-- Una fila por par de entregas que la IA marcó como sospechosamente
-- similares dentro del mismo examen/taller/proyecto. El docente (o
-- admin) puede ver y borrar estas filas — el estudiante no las ve.
--
-- Diseño polimórfico (kind + ref_id) en vez de tres tablas separadas:
-- la consulta es siempre "para este examen/taller/proyecto, tráeme las
-- copias detectadas", y mantener una sola tabla simplifica el UI común.
--
-- Canonicalización: submission_a < submission_b (por uuid). Garantiza
-- que NO se inserten ambos sentidos (a→b y b→a) del mismo par. El edge
-- function ordena los uuid antes de insertar.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.similarity_pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('exam', 'workshop', 'project')),
  ref_id uuid NOT NULL,
  question_id uuid NULL,
  submission_a uuid NOT NULL,
  submission_b uuid NOT NULL,
  user_a uuid NOT NULL,
  user_b uuid NOT NULL,
  score numeric NOT NULL CHECK (score >= 0 AND score <= 1),
  method text NOT NULL DEFAULT 'gemini',
  reasons text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT similarity_pairs_ordered CHECK (submission_a < submission_b),
  CONSTRAINT similarity_pairs_distinct CHECK (submission_a <> submission_b)
);

CREATE INDEX IF NOT EXISTS idx_similarity_pairs_ref
  ON public.similarity_pairs(kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_similarity_pairs_question
  ON public.similarity_pairs(question_id);
CREATE INDEX IF NOT EXISTS idx_similarity_pairs_score
  ON public.similarity_pairs(score DESC);

-- Evita pares duplicados al re-ejecutar la detección. Cuando question_id
-- es NULL (taller/proyecto sin granularidad por pregunta) usamos el uuid
-- "cero" para que el índice trate los NULL como iguales.
CREATE UNIQUE INDEX IF NOT EXISTS idx_similarity_pairs_unique
  ON public.similarity_pairs(
    kind,
    ref_id,
    COALESCE(question_id, '00000000-0000-0000-0000-000000000000'::uuid),
    submission_a,
    submission_b
  );

ALTER TABLE public.similarity_pairs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Docentes/Admins read similarity_pairs" ON public.similarity_pairs;
CREATE POLICY "Docentes/Admins read similarity_pairs"
  ON public.similarity_pairs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "Docentes/Admins insert similarity_pairs" ON public.similarity_pairs;
CREATE POLICY "Docentes/Admins insert similarity_pairs"
  ON public.similarity_pairs FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "Docentes/Admins delete similarity_pairs" ON public.similarity_pairs;
CREATE POLICY "Docentes/Admins delete similarity_pairs"
  ON public.similarity_pairs FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));
