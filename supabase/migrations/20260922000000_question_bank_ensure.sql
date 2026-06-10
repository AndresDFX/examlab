-- WHY: el banco de preguntas devolvia HTTP 404 en PostgREST
--   (GET /rest/v1/question_bank?...) en el tenant FESNA. Root cause confirmado:
--   la tabla public.question_bank NO EXISTE en esa BD. La migracion original
--   20260518100000_question_bank.sql tiene el CREATE TABLE, pero el INSTALL de
--   Lovable marco esa migracion como aplicada SIN crear la tabla (desfase del
--   shadow de migraciones de Lovable — el mismo fenomeno documentado en
--   20260813000000_python_gui_support.sql lineas 78-90, donde el ALTER de
--   python_gui se salto via el branch ELSE de su guarda to_regclass). Sin la
--   relacion, PostgREST responde 404 porque no la conoce.
--
--   question_bank es un objeto de schema GLOBAL (UNA sola tabla para todos los
--   tenants; la RLS la acota por curso/course_teachers). Por eso esta UNICA
--   migracion idempotente la asegura y corrige TODOS los tenants de una vez.
--
--   Es 100% idempotente y NO destructiva: usa CREATE ... IF NOT EXISTS,
--   DROP POLICY/TRIGGER IF EXISTS + recreate, y un ALTER guardado del CHECK del
--   type para reconciliar tablas viejas sin python_gui. NADA de DROP TABLE /
--   TRUNCATE / DELETE — si la tabla ya existe con datos, no se toca ni una fila.
--   Los 3 RPCs add_questions_from_bank_to_{exam,workshop,project} NO se recrean
--   (ya existen via CREATE OR REPLACE en 20260518100000; el late-binding de
--   plpgsql los dejo creados aunque la tabla faltara). El seed de
--   module_visibility tampoco se re-siembra (ya esta en 20260601100000).
--
--   NOTIFY pgrst 'reload schema' al final refresca el schema cache de PostgREST
--   para que el 404 desaparezca sin reiniciar el servicio.

-- 1) Tabla. El CHECK inline del type YA incluye python_gui (a diferencia del
--    original 20260518100000, que no lo tenia) para asegurar el set completo
--    cuando la tabla se crea fresca. El paso 6 reconcilia el caso "tabla vieja".
CREATE TABLE IF NOT EXISTS public.question_bank (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('cerrada','cerrada_multi','codigo','codigo_zip','abierta','diagrama','java_gui','python_gui')),
  content TEXT NOT NULL,
  options JSONB,
  expected_rubric TEXT,
  language TEXT,
  starter_code TEXT,
  suggested_points NUMERIC NOT NULL DEFAULT 1 CHECK (suggested_points >= 0),
  topic TEXT,
  difficulty INT CHECK (difficulty BETWEEN 1 AND 5),
  tags TEXT[] NOT NULL DEFAULT '{}',
  times_used INT NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2-5) Indices.
CREATE INDEX IF NOT EXISTS idx_question_bank_course ON public.question_bank(course_id);
CREATE INDEX IF NOT EXISTS idx_question_bank_topic ON public.question_bank(topic);
CREATE INDEX IF NOT EXISTS idx_question_bank_difficulty ON public.question_bank(difficulty);
CREATE INDEX IF NOT EXISTS idx_question_bank_tags ON public.question_bank USING GIN (tags);

-- 6) Reconciliar el CHECK del type (caso tabla vieja creada sin python_gui),
--    DESPUES del CREATE TABLE. Guardado con to_regclass por defensa. Idempotente:
--    DROP CONSTRAINT IF EXISTS quita el inline auto-nombrado o uno previo; ADD lo
--    re-crea con nombre canonico y el set completo (superset del original — solo
--    agrega python_gui, no quita ninguno, asi que ninguna fila valida se invalida).
DO $$
BEGIN
  IF to_regclass('public.question_bank') IS NOT NULL THEN
    ALTER TABLE public.question_bank DROP CONSTRAINT IF EXISTS question_bank_type_check;
    ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_type_check
      CHECK (type IN ('cerrada','cerrada_multi','codigo','codigo_zip','abierta','diagrama','java_gui','python_gui'));
  END IF;
END $$;

-- 7) RLS. ENABLE es idempotente (no falla si ya esta habilitado). Necesario:
--    una tabla recien creada arranca con RLS deshabilitada por default.
ALTER TABLE public.question_bank ENABLE ROW LEVEL SECURITY;

-- 8) Trigger updated_at. DROP + CREATE para idempotencia.
DROP TRIGGER IF EXISTS trg_question_bank_updated_at ON public.question_bank;
CREATE TRIGGER trg_question_bank_updated_at
  BEFORE UPDATE ON public.question_bank
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 9) Policy SELECT. Predicado identico al original 20260518100000.
DROP POLICY IF EXISTS "question_bank_select" ON public.question_bank;
CREATE POLICY "question_bank_select"
  ON public.question_bank FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (SELECT 1 FROM public.course_teachers ct
               WHERE ct.course_id = question_bank.course_id AND ct.user_id = auth.uid())
  );

-- 10) Policy WRITE (FOR ALL). USING y WITH CHECK con el MISMO predicado.
DROP POLICY IF EXISTS "question_bank_write" ON public.question_bank;
CREATE POLICY "question_bank_write"
  ON public.question_bank FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (SELECT 1 FROM public.course_teachers ct
               WHERE ct.course_id = question_bank.course_id AND ct.user_id = auth.uid())
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (SELECT 1 FROM public.course_teachers ct
               WHERE ct.course_id = question_bank.course_id AND ct.user_id = auth.uid())
  );

-- 11) Refrescar el schema cache de PostgREST (CLAVE: sin esto el 404 persiste
--     hasta el proximo reinicio/reload natural del servicio).
NOTIFY pgrst, 'reload schema';
