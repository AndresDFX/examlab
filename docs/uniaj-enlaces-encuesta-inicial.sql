-- ══════════════════════════════════════════════════════════════════════
-- Enlaces de la encuesta inicial de UNIAJ, uno por curso.
--
-- Pegar en Supabase → SQL Editor (proyecto uxxpzfsfcnqiwwdxoelm) y ejecutar.
-- Devuelve una fila por curso con el enlace listo para enviar.
--
-- Por qué hace falta esta consulta y no una lista fija: el enlace lleva el
-- UUID de la encuesta, que solo existe en la base. No se puede escribir de
-- memoria ni deducir del nombre del curso.
--
-- Notas de lectura del resultado:
--   · `abierta` = la ve el estudiante hoy (publicada + dentro de la ventana +
--     no cerrada a mano). Si sale `false`, el enlace abre pero la encuesta no
--     aparece: revisar `is_published` y `closes_at`.
--   · `preguntas` = cuántas preguntas cargó el docente. Si sale 0, el alumno
--     entra a una encuesta vacía.
--   · El host es el subdominio propio de UNIAJ, así que el estudiante NO
--     tiene que elegir institución al entrar.
-- ══════════════════════════════════════════════════════════════════════

SELECT c.name                                   AS curso,
       c.status                                 AS estado_curso,
       p.title                                  AS encuesta,
       p.poll_type                              AS tipo,
       p.is_published                           AS publicada,
       public.poll_is_open(p)                   AS abierta,
       (SELECT count(*) FROM public.poll_questions q WHERE q.poll_id = p.id) AS preguntas,
       'https://uniaj.examlab.workers.dev/app/student/polls?poll=' || p.id    AS enlace
  FROM public.polls        p
  JOIN public.poll_courses pc ON pc.poll_id  = p.id
  JOIN public.courses      c  ON c.id        = pc.course_id
  JOIN public.tenants      t  ON t.id        = c.tenant_id
 WHERE t.slug          = 'uniaj'
   AND p.deleted_at   IS NULL      -- una encuesta en papelera no se comparte
   AND c.deleted_at   IS NULL
   AND p.poll_type     = 'mixed'   -- 'mixed' es el tipo con preguntas del docente
 ORDER BY c.name, p.created_at;

-- ── Si la consulta anterior devuelve MENOS de 4 filas ─────────────────
-- Puede ser que la encuesta esté compartida con solo algunos cursos (el caso
-- de la cohorte 341C, que cursa Programación II y Seminario con los mismos
-- estudiantes). Esta segunda consulta lista los 4 cursos del periodo y al lado
-- las encuestas que tiene cada uno, para ver cuál quedó sin encuesta:

SELECT c.name AS curso,
       c.status,
       coalesce(string_agg(p.title, ' · ' ORDER BY p.created_at), '(sin encuesta)') AS encuestas
  FROM public.courses c
  JOIN public.tenants t ON t.id = c.tenant_id AND t.slug = 'uniaj'
  LEFT JOIN public.poll_courses pc ON pc.course_id = c.id
  LEFT JOIN public.polls p
         ON p.id = pc.poll_id AND p.deleted_at IS NULL AND p.poll_type = 'mixed'
 WHERE c.deleted_at IS NULL
   AND c.status <> 'finalizado'    -- en el tenant conviven versiones viejas homónimas
 GROUP BY c.id, c.name, c.status
 ORDER BY c.name;

-- ══════════════════════════════════════════════════════════════════════
-- ENLACE PÚBLICO (sin iniciar sesión) — mig 20261700000000
--
-- El de arriba exige sesión. Este no: el estudiante abre el enlace, escribe su
-- correo institucional y responde. El correo TIENE que estar matriculado en un
-- curso de la encuesta (así la respuesta queda atribuida a la persona real y no
-- entra nadie de afuera), pero no necesita contraseña.
--
-- ⚠ ANTES DE CORRERLO, dos cosas que conviene saber:
--
--  1. Solo funciona con encuestas de preguntas propias (`poll_type='mixed'`).
--     Un CHECK en la tabla lo impide para las demás: abrir una de cupos al
--     público dejaría que un bot los queme.
--
--  2. **El envío público es de una sola vez y no se puede modificar.** Con
--     identidad por correo —que es adivinable— permitir modificar dejaría que
--     un tercero pise las respuestas de un compañero. El riesgo que QUEDA es
--     que alguien con el enlace y un correo adivinado se adelante y responda
--     por otro que todavía no respondió.
--
--     Por eso, para un instrumento CONFIDENCIAL (bienestar, salud, situación
--     económica) conviene NO usar el enlace público y quedarse con el
--     autenticado de arriba. Si igual lo querés público, es tu decisión — pero
--     que sea a sabiendas.
--
-- Para activarlo, descomentá el bloque y poné el título exacto de la encuesta:
-- ══════════════════════════════════════════════════════════════════════

-- WITH objetivo AS (
--   SELECT DISTINCT p.id
--     FROM public.polls p
--     JOIN public.poll_courses pc ON pc.poll_id = p.id
--     JOIN public.courses c       ON c.id = pc.course_id
--     JOIN public.tenants t       ON t.id = c.tenant_id AND t.slug = 'uniaj'
--    WHERE p.deleted_at IS NULL
--      AND p.poll_type = 'mixed'
--      AND p.title = 'PONER ACÁ EL TÍTULO EXACTO'
-- )
-- SELECT p.title,
--        'https://uniaj.examlab.workers.dev/encuesta/' || public.poll_set_public(p.id, TRUE) AS enlace_publico
--   FROM public.polls p
--  WHERE p.id IN (SELECT id FROM objetivo);

-- Para CORTAR un enlace público ya compartido (queda inservible al instante):
--   SELECT public.poll_set_public('<poll_id>'::uuid, FALSE);
-- Para cambiarlo por uno nuevo sin desactivarlo:
--   SELECT public.poll_set_public('<poll_id>'::uuid, TRUE, TRUE);
