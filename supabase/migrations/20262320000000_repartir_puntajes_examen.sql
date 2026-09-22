-- ═══════════════════════════════════════════════════════════════════════
-- «Cuadrar en N» del editor de examen: nunca funcionó
-- ═══════════════════════════════════════════════════════════════════════
-- El botón repartía los puntajes con UN `upsert` parcial `{id, points}`,
-- elegido a propósito para no reescribir enunciado/opciones/rúbrica con la
-- copia en memoria del render. El problema es que PostgREST lo traduce a
--
--   INSERT INTO questions (id, points) VALUES … ON CONFLICT (id) DO UPDATE …
--
-- y PostgreSQL evalúa el `WITH CHECK` de la política de INSERT sobre la fila
-- PROPUESTA, donde `exam_id` va en NULL. `exam_in_my_tenant(NULL)` es falso,
-- así que la sentencia entera rebota con 42501 ANTES de llegar al conflicto —
-- y como 42501 se traduce a «No tienes permisos para realizar esta acción.»,
-- el docente leía un problema de permisos sobre su propio examen.
-- Reproducido contra PostgreSQL real: el upsert parcial da 42501 y el UPDATE
-- por fila pasa. Falla para TODOS, siempre; no depende del tenant ni del rol.
--
-- El arreglo no puede ser «mandar la fila completa» (eso es justo lo que el
-- upsert parcial evitaba) ni «N updates sueltos» (si el sexto falla, el examen
-- queda con cinco puntajes nuevos y cinco viejos, sumando MENOS que antes de
-- pulsar el botón que existe para cuadrarlo). Una sola sentencia UPDATE …
-- FROM unnest() da las dos cosas: es atómica y no toca ninguna otra columna.
--
-- SECURITY INVOKER a propósito: así la política `questions_staff_manage`
-- aplica tal cual, sin reimplementar acá quién puede tocar qué. Lo único que
-- agrega la función es exigir que TODOS los ids sean del mismo examen, para
-- que un id suelto de otro examen del mismo tenant no se cuele en el lote.
CREATE OR REPLACE FUNCTION public.exam_repartir_puntajes(
  _exam_id uuid,
  _ids uuid[],
  _puntos numeric[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  _n integer;
BEGIN
  IF _exam_id IS NULL OR _ids IS NULL OR _puntos IS NULL THEN
    RAISE EXCEPTION 'Faltan datos para repartir el puntaje.';
  END IF;
  IF array_length(_ids, 1) IS DISTINCT FROM array_length(_puntos, 1) THEN
    RAISE EXCEPTION 'La cantidad de preguntas y de puntajes no coincide.';
  END IF;

  -- El examen no puede estar en la papelera. La policy en la que se apoya
  -- (`questions_staff_manage` → `exam_in_my_tenant`) NO mira `deleted_at`, así
  -- que sin esto un examen borrado seguiría aceptando el reparto — y la regla
  -- del proyecto es que lo que está en la papelera no se usa en NINGÚN flujo.
  IF NOT EXISTS (
    SELECT 1 FROM public.exams e
     WHERE e.id = _exam_id AND e.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'El examen no está disponible.';
  END IF;

  -- Que ningún id sea de otro examen. Sin esto el lote podría mover el
  -- puntaje de un examen que el docente no está editando, y el resultado
  -- (una nota distinta en otro parcial) no lo relacionaría nadie con este clic.
  IF EXISTS (
    SELECT 1 FROM public.questions q
     WHERE q.id = ANY(_ids) AND q.exam_id IS DISTINCT FROM _exam_id
  ) THEN
    RAISE EXCEPTION 'Alguna de las preguntas no pertenece a este examen.';
  END IF;

  UPDATE public.questions q
     SET points = v.punto
    FROM unnest(_ids, _puntos) AS v(id, punto)
   WHERE q.id = v.id
     AND q.exam_id = _exam_id;

  GET DIAGNOSTICS _n = ROW_COUNT;

  -- Si la RLS filtró filas, el reparto quedó incompleto y la suma ya no da el
  -- total. Mejor abortar que dejar el examen a medio cuadrar en silencio.
  IF _n <> array_length(_ids, 1) THEN
    RAISE EXCEPTION 'No se pudieron actualizar todas las preguntas del examen.';
  END IF;

  RETURN _n;
END;
$$;

REVOKE ALL ON FUNCTION public.exam_repartir_puntajes(uuid, uuid[], numeric[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.exam_repartir_puntajes(uuid, uuid[], numeric[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.exam_repartir_puntajes(uuid, uuid[], numeric[]) TO authenticated;
