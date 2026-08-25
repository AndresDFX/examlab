-- ══════════════════════════════════════════════════════════════════════
-- Objetivos de las cuatro asignaturas de UNIAJ.
--
-- ── De dónde salen ────────────────────────────────────────────────────
-- Del MICROCURRÍCULO oficial de cada asignatura (los .docx que viven en el
-- repositorio de la universidad, bajo `universidades/UNIAJ/<asignatura>/Plan
-- curso/`), leídos con el mismo lector de Word del módulo de informes. No están
-- redactados de nuevo ni resumidos: son el "Objetivo de Aprendizaje" y los tres
-- "Resultados de Aprendizaje de la Asignatura" (RAA) tal como los define el
-- documento institucional, incluida su numeración.
--
-- Eso importa: el Acuerdo Pedagógico se firma. Si los objetivos que el
-- estudiante firma no son los del microcurrículo aprobado, el documento pierde
-- su valor. Por eso se transcriben, no se reescriben.
--
-- ── Por qué acá y no escritos dentro de la plantilla ──────────────────
-- Antes, el Acuerdo Pedagógico traía los objetivos ESCRITOS DENTRO del
-- documento: cambiar uno obligaba a editar la plantilla, y cada curso que
-- copiara el acuerdo arrastraba los objetivos de otra asignatura. Ahora viven
-- en `academic_subjects.objetivos`, se editan en Académico → Asignaturas y la
-- plantilla los toma con `{{curso.objetivos}}`: un solo lugar, y todos los
-- documentos que los usen quedan al día solos.
--
-- Solo escribe donde está VACÍO (`objetivos IS NULL OR = ''`): si alguien de la
-- institución ya los ajustó a mano, esta migración no le pisa el trabajo.
-- ══════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE
  v_tenant uuid;
  v_n int := 0;
BEGIN
  IF to_regclass('public.academic_subjects') IS NULL THEN
    RAISE NOTICE 'academic_subjects ausente — se omiten los objetivos';
    RETURN;
  END IF;

  SELECT id INTO v_tenant FROM public.tenants WHERE slug = 'uniaj';
  IF v_tenant IS NULL THEN
    RAISE NOTICE 'la institución uniaj no existe en este entorno — se omite';
    RETURN;
  END IF;

  UPDATE public.academic_subjects SET objetivos = v.texto, updated_at = now()
  FROM (VALUES
    ('Bases de Datos II',
     'Objetivo de aprendizaje: diseñar, administrar y optimizar bases de datos relacionales avanzadas, garantizando seguridad, integridad y eficiencia en el manejo de grandes volúmenes de información.' || chr(10) || chr(10) ||
     'Resultados de aprendizaje de la asignatura:' || chr(10) ||
     'RAA1. Administra bases de datos aplicando estrategias de seguridad y respaldo.' || chr(10) ||
     'RAA2. Implementa procedimientos almacenados y disparadores para la automatización de procesos.' || chr(10) ||
     'RAA3. Optimiza consultas y estructuras de bases de datos para mejorar el rendimiento del sistema.'),

    ('Arquitectura de Sistemas Computacionales',
     'Objetivo de aprendizaje: diseñar e implementar arquitecturas de sistemas computacionales aplicando principios de computación en la nube, virtualización y escalabilidad, asegurando eficiencia y sostenibilidad.' || chr(10) || chr(10) ||
     'Resultados de aprendizaje de la asignatura:' || chr(10) ||
     'RAA1. Comprende y aplica modelos de servicio cloud (IaaS, PaaS, SaaS).' || chr(10) ||
     'RAA2. Configura entornos virtualizados y despliega sistemas distribuidos.' || chr(10) ||
     'RAA3. Evalúa la seguridad, rendimiento y sostenibilidad de arquitecturas en la nube.'),

    ('Programacion II',
     'Objetivo de aprendizaje: diseñar e implementar aplicaciones avanzadas utilizando programación orientada a objetos, garantizando eficiencia, mantenibilidad y escalabilidad mediante el uso adecuado de estructuras de datos y patrones de diseño básicos.' || chr(10) || chr(10) ||
     'Resultados de aprendizaje de la asignatura:' || chr(10) ||
     'RAA1. Implementa estructuras de datos aplicadas a la resolución de problemas.' || chr(10) ||
     'RAA2. Desarrolla aplicaciones con manejo de eventos y componentes gráficos.' || chr(10) ||
     'RAA3. Aplica patrones de diseño básicos para optimizar la arquitectura del software.'),

    ('Seminario de Sistemas',
     'Objetivo de aprendizaje: desarrollar un proyecto de software aplicando técnicas avanzadas de programación orientada a objetos, fortaleciendo la documentación, validación y comunicación efectiva de soluciones.' || chr(10) || chr(10) ||
     'Resultados de aprendizaje de la asignatura:' || chr(10) ||
     'RAA1. Aplica patrones de diseño y principios de modularidad en proyectos de software.' || chr(10) ||
     'RAA2. Documenta y valida aplicaciones mediante pruebas básicas.' || chr(10) ||
     'RAA3. Presenta y sustenta proyectos de software de manera clara y estructurada.')
  ) AS v(nombre, texto)
  WHERE public.academic_subjects.tenant_id = v_tenant
    AND public.academic_subjects.name = v.nombre
    AND COALESCE(public.academic_subjects.objetivos, '') = '';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Objetivos sembrados en % asignatura(s) de UNIAJ', v_n;
END $mig$;
