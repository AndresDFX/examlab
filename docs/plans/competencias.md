# Competencias / resultados de aprendizaje — diseño y bloqueantes

> Brecha #3 de [`viabilidad-brechas-edutori.md`](../viabilidad-brechas-edutori.md). Diseñada por un
> workflow de 5 agentes (3 exploradores + diseñador + crítico adversarial). **No implementada**: el
> crítico encontró 8 bloqueantes, 3 críticos. Este documento los deja escritos para que el próximo
> intento arranque desde acá y no desde cero.

## Veredicto

**Viable-construcción**, ~4-6 semanas el paquete completo, con un primer incremento de ~3-4 días.
Pero **no se puede empezar por el incremento 1**: dos de los bloqueantes críticos están en la capa
de datos que el feature usaría, y uno de ellos ya era un defecto en producción (ver abajo).

## La decisión central: la competencia se mapea a la ACTIVIDAD, no a la pregunta

El hallazgo no es "no hay nota por pregunta". Es más específico: **hay nota por pregunta en 2 de los
3 módulos, y falta justo en el que más pesa.**

| Módulo | Nota por ítem | Dónde |
|---|---|---|
| Talleres | ✅ relacional e indexada | `workshop_submission_answers(submission_id, question_id, ai_grade)` + `idx_workshop_answers_question` |
| Proyectos | ✅ relacional e indexada | `project_submission_files(submission_id, file_id, ai_grade)` + `idx_project_sub_files_file` |
| **Exámenes** | ❌ **no hay tabla** | dentro de `submissions.answers.__breakdown` (JSONB), **sin ningún índice GIN** |

Y el argumento que cierra la decisión: la nota real de una pregunta de examen es
`__manual_overrides[qid].score ?? __breakdown[qid].earned`, y esa precedencia está implementada UNA
vez, en `grade.ts`. **Cualquier consulta SQL que leyera solo `__breakdown` reportaría el número de la
IA e ignoraría la recalificación del docente** — en silencio, y contradiciendo lo que el docente ve
en pantalla. En un informe de acreditación es el peor fallo posible.

Además, mapear a preguntas se evapora solo: `add_questions_from_bank_to_exam` **copia** la pregunta
sin back-reference al banco, así que etiquetar competencias en `question_bank.tags` produce un mapeo
que se pierde en cuanto la pregunta se usa.

**Mitigación honesta de la grosería:** un `coverage_weight` por mapeo donde el docente **declara**
cuánto de esa actividad evidencia la competencia. Es una declaración, no una medición — y la UI y el
informe deben decirlo así, no disfrazarlo de métrica.

El modelo no se cierra la puerta: `source_kind` polimórfico desde el día 1 permite agregar
`workshop_question` y `project_file` sin cambio de esquema (ambos ya relacionales), y deja
`exam_question` para el final, después de normalizar exámenes.

## Los 8 bloqueantes

### Críticos

**B1 — El trigger que deriva `course_id` rompe talleres y proyectos multi-curso.**
`workshops.course_id` es el ancla, no la pertenencia. Un trigger que derive el curso desde ahí, con
`UNIQUE (competency_id, source_kind, source_id)`, admite UNA sola fila por actividad clavada al
ancla; y la policy de escritura hace que **el docente del curso no-ancla reciba un 42501 sobre un
valor que él nunca escribió**. *Fix:* validar en vez de derivar — `UNIQUE` incluye `course_id`, y el
trigger verifica que el `course_id` que mandó el cliente exista en `workshop_courses`/`project_courses`.

**B2 — Las dos fuentes de datos discrepan en QUÉ actividades pertenecen al curso.**
`report-context.ts` lee por el join M:N; `statistics.ts` leía por la columna ancla. Montar la tarjeta
sobre `CourseDataset` y el informe sobre `report-context` habría dado **dos porcentajes distintos para
la misma competencia**. ✅ **Arreglado** (commit del fix de `flattenSharedActivities`) — y resultó ser
un defecto activo en producción, no solo groundwork: el dashboard de estadísticas y la alerta temprana
ya estaban ignorando los talleres compartidos.

**B3 — `CourseDataset` no lleva `weight`, `parent_exam_id` ni `retry_mode`.**
La fórmula del rollup los necesita. Parcialmente atendido: el fix de B2 ya suma `weight` por curso.
Faltan `parent_exam_id` y `retry_mode`, sin los cuales las recuperaciones cuentan como actividades
separadas en la tarjeta y plegadas al padre en el informe — tercer origen de divergencia.

### Altos

**B4 — Cero rastro de auditoría sobre el mapeo.** El proyecto ya audita forensemente cada cambio
manual de nota (`20261090000000`: quién, cuándo, IP, campo, valor anterior y nuevo). Un docente que
borra un mapeo o edita `coverage_weight` mueve el % de logro de toda la cohorte **sin dejar registro**.
El informe histórico es corrompible por re-generación y v1 no tendría forma de detectarlo.

**B5 — El scope PROGRAMA no tiene dónde guardarse.** `report_templates.scope` tiene
`CHECK IN ('curso','estudiante')`, así que el informe que de verdad pide la acreditación —el
consolidado por programa— no se puede persistir ni re-descargar.

**B8 — El denominador del rollup no está anclado en el tiempo.** Agregar o borrar un mapeo a mitad de
semestre cambia **retroactivamente** el logro ya reportado, y marcar la competencia como `active=false`
no la saca de los informes. Un informe de acreditación que se mueve solo no sirve como evidencia.

### Medios

**B6 — El SuperAdmin con institución elegida no puede crear competencias** (falla con 23502).

**B7 — "V2 es casi gratis en 2 de 3 módulos" es falso**: los talleres tienen la misma divergencia de
override que se usó para descartar la granularidad por pregunta en exámenes.

## Qué hacer antes de implementar

1. ✅ **B2** — hecho: el cargador de actividades lee por el join M:N.
2. **B3** — sumar `parent_exam_id` y `retry_mode` al `CourseDataset`.
3. **B1** — rediseñar el trigger: validar, no derivar; `course_id` en el `UNIQUE`.
4. **B4 + B8** — decidir el modelo de auditoría y de anclaje temporal **antes** de la migración. Son
   los dos que determinan si el informe sirve para acreditar o es solo un número lindo.
5. **B5** — ampliar el `CHECK` de `report_templates.scope` o decidir que el consolidado por programa
   se sirve fuera del sistema de plantillas.

## Preguntas de producto abiertas (las decide el dueño)

- ¿Cuál es el criterio de "alcanzó la competencia"? Un umbral sobre el promedio ponderado de las
  actividades mapeadas es lo obvio, pero el umbral **es** la definición del indicador y no debería
  inventarlo el código.
- ¿El logro se recalcula siempre, o se congela al cerrar el periodo? Es la respuesta a B8.
- ¿Las competencias cuelgan del PROGRAMA (perfil de egreso), de la ASIGNATURA (resultado de la
  materia), o de las dos? El modelo académico permite las dos, pero el informe cambia.
- Los cursos con `subject_id` NULL (la obligatoriedad vive **solo en el cliente**, la columna nunca se
  endureció ni se backfilleó): ¿quedan fuera del informe? Hoy desaparecerían en silencio.
