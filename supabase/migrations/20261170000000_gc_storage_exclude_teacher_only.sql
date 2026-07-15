-- Storage RLS: el alumno NO debe descargar material solo-docente por path directo.
--
-- La policy gc_student_read_via_course (bucket generated-contents) deja al alumno
-- matriculado leer CUALQUIER archivo de un contenido publicado — incluidas las
-- SOLUCIONES, CLAVES DE EXAMEN y GUÍAS DOCENTES (archivos cuyo nombre matchea
-- isTeacherOnlyFile en el front). El board del alumno los oculta en JS, pero por
-- REST/Storage directo se podían bajar. Agregamos la exclusión al nivel de RLS.
--
-- El patrón replica src/modules/contents/contents-extract.ts `isTeacherOnlyFile`
-- (SOLUCION/SOLUTION, GUIA_DOCENTE/TEACHER_GUIDE, EXAMEN/EXAM por segmento). Se
-- aplica sobre el NOMBRE de archivo (último segmento del path), case-insensitive.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'gc_student_read_via_course'
  ) THEN
    ALTER POLICY gc_student_read_via_course ON storage.objects
      USING (
        (bucket_id = 'generated-contents'::text)
        AND (
          regexp_replace(objects.name, '^.*/', '') !~*
          '(solucion|solution|guia[_ -]*docente|teacher[_ -]*guide|^examen|[_ -]examen|^exam[_ -]|[_ -]exam[_ -])'
        )
        AND (EXISTS (
          SELECT 1
          FROM ((generated_contents gc
            JOIN content_course_assignments cca ON ((cca.content_id = gc.id)))
            JOIN course_enrollments ce ON ((ce.course_id = cca.course_id)))
          WHERE (((gc.id)::text = (storage.foldername(objects.name))[2])
            AND (gc.status = 'done'::content_status)
            AND (gc.is_published = true)
            AND (gc.deleted_at IS NULL)
            AND (ce.user_id = auth.uid()))
        ))
      );
  END IF;
END $$;
