---
name: cierre-de-corte
description: >
  Cierre de un corte en los cursos de UNIAJ: barrido de lo que falta (entregas sin nota, cola de
  IA, talleres y evaluaciones abiertas o en borrador, asistencia, Acuerdo y encuesta), reabrir la
  asistencia del corte con un enlace y código por curso, calificar lo pendiente con el criterio
  de la plataforma, y el mensaje único para los grupos de WhatsApp con notas, plazos de reclamo,
  pendientes por curso y enlaces de asistencia. Úsalo cuando el usuario pida «cierre del corte»,
  «el mensaje con pendientes y asistencia», «barrido del corte N» o «regenera el mensaje».
---

# Cierre de corte

El docente llega acá a fin de corte: tiene que subir notas en una fecha fija y necesita que los
estudiantes revisen, reclamen, se pongan al día y marquen asistencia. El resultado son DOS cosas:
la plataforma ajustada (asistencia abierta, todo calificado, evaluaciones publicadas) y UN mensaje
para pegar en todos los grupos. Se hizo así por primera vez el 2026-10-04 (Corte 1, 2026-2).

Antes de empezar: [aviso-a-estudiantes](../aviso-a-estudiantes/SKILL.md) (reglas de redacción y
verificación) y [calificar-parcial](../calificar-parcial/SKILL.md) (calificar a mano). Esta skill
las encadena; no las reemplaza.

## 1. Barrido (solo lectura, `scripts/db-query.mjs`)

Por cada curso `en_curso` de la institución, con su corte (`grade_cuts`, orden por `start_date`):

- **Evaluaciones del corte y las próximas**: `exams` con `cut_id` del corte o `start_time` futuro.
  Mirar `status`: una evaluación **en borrador con fecha** no la ve nadie. Y una con fecha YA
  PASADA en borrador nunca se presentó: hay que preguntar si se reprograma.
- **Talleres** (ancla + `workshop_courses`; corte y peso de la fila de unión si la tiene),
  **proyectos**: entregas, notas y **asignados**. Publicado sin filas en `*_assignments` = nadie lo
  ve ([memoria uniaj-actividades-publicadas-sin-asignar]). Preguntar antes de asignar.
- **Entregas sin nota** con la definición oficial de entregado (`ESTADOS_SIN_ENTREGAR` de
  `src/modules/submissions/entrega-hecha.ts`) y la **cola** `ai_grading_queue` en
  pending/processing/failed. UNIAJ tiene su IA sin credencial: la cola no drena sola.
- **Requisitos de asistencia** por estudiante, con la regla de `attendance_requirement_met`:
  Acuerdo = firma con `signed_at`; encuesta = al menos una respuesta.
- **Asistencia** del corte: sesiones, quién tiene todas, alguna o ninguna.
- **Externas que reemplazan algo**: preguntar (en SB141B la exposición valía el 10 % del corte).

Contar SIEMPRE excluyendo a los docentes del curso (`course_teachers`): el dueño está matriculado
en los cursos de UNIAJ a propósito.

## 2. Ajustes en la plataforma

- **Calificar lo pendiente** con `calificar-parcial` (exámenes) o el mismo método para talleres:
  notas por pregunta en `workshop_submission_answers` **de a una fila** (cada UPDATE dispara un
  recálculo de ~3,6 s y 5 juntas pasan el timeout de 8 s) y la cabecera con
  `consolidarNotaTaller`/`patchCabeceraTaller`. Después **cancelar** los trabajos de la cola
  (`cancel_ai_grading_job`, también los `failed`), o un «Procesar todos» recalifica encima.
- **Reabrir la asistencia** del corte: las RPC de docente rechazan al SuperAdmin → entrar como el
  docente con `admin-impersonate` ([memoria acciones-de-docente-por-impersonacion]). Abrir con
  `teacher_open_attendance_check_in_multi` por curso; si ya está abierta, AJUSTAR sesión por
  sesión con `teacher_open_attendance_check_in` (`p_manual_code` = el código del curso,
  `p_email_only: true`, `p_requirements` = Acuerdo + encuesta, `p_closes_at` = fecha de cierre).
  La **diagnóstica ya no es requisito** (decisión del 2026-10-04): no incluirla.
- **Evaluaciones**: fecha, `time_limit_minutes` = la franja completa (decisión: 90 min para una
  franja de 1 h 30), `exam_assignments` a todos los matriculados, y publicar.
- **Verificar** releyendo la base y probando cada enlace con `rpc/attendance_check_in_public_info`
  (`open`, `email_only`, `closes_at`).

## 3. Enlaces y códigos por curso (2026-2)

Mismo código y mismo enlace en cada reapertura, a propósito: los enlaces viejos de los grupos
siguen sirviendo. El enlace apunta a una sesión del corte; si cambia el corte, la sesión cambia.

| Curso | Código | Sesión del enlace (Corte 1) |
|---|---|---|
| Programación II (341C) | 632599 | 741a84fd-b5fa-43a8-a471-eeb9b7761d3f |
| Seminario de Sistemas (341C) | 276343 | 94630687-0162-41bb-8970-f241b822e343 |
| Bases de Datos II (641A-2) | 859590 | 5ab94674-50fb-46af-82bd-4d0ed2e2d443 |
| Arquitectura de Sistemas Computacionales (6303C) | 858622 | 94ee2e88-52c6-47bc-9cc8-b3b09e95080a |
| Introducción a la Ingeniería (SB141B) | 074664 | bbb51b41-f26c-5316-8d02-b4bee987c963 |
| Introducción a la Ingeniería (SB141C) | 446320 | 8fe2755d-7f61-5e01-bfef-ebb39f527da0 |
| Introducción a la Ingeniería (LB141F) | 692693 | 074c5249-556b-5022-b050-8ea22487f133 |

Enlace: `https://uniaj.examlab.workers.dev/asistencia?session=<sesión>&code=<código>`.

## 4. El mensaje

Un solo mensaje para todos los grupos (de usted, sin vocabulario de la plataforma). Cada curso
lleva SOLO lo que sus estudiantes pueden ver: nada en borrador, nada sin asignar. Fechas con el día
de la semana verificado. Plantilla (Corte 1, 2026-10-04):

```
Buenas tardes, estudiantes.

*Notas del Corte {N}*
Ya están en la plataforma las notas parciales del Corte {N}. Revise las de su curso en «Mis notas»:
https://uniaj.examlab.workers.dev/app/student/grades

Si no está de acuerdo con la calificación de alguna pregunta, en «Mis notas» abra «Ver detalle» de esa actividad y escriba en la caja «Conversación» que aparece debajo de la pregunta. Tiene plazo hasta el {día de subida de notas}, día en que se suben las notas.

*Asistencia del Corte {N}*
Quedó abierta de nuevo para todas las clases del Corte {N}, hasta el {cierre} a las 11:59 p. m. Un solo registro cubre todas las clases: abra el enlace de su curso y escriba su correo institucional.

Para que quede registrada debe tener firmado el Acuerdo Pedagógico y respondida la encuesta «Inicio de semestre 2026-2 · Bienestar, conectividad y flexibilidad». Si le falta alguno, la misma página le muestra cuál y el enlace para completarlo.

*Su curso*

*{Curso} ({grupo})*
• {Actividad abierta}: cierra {día, fecha}, a las {hora}.
• Evaluación de Corte {N}: {día, fecha}, de {inicio} a {fin}. Empiece a la hora: tiene 1 hora y 30 minutos.
• Asistencia (código {código}):
https://uniaj.examlab.workers.dev/asistencia?session={sesión}&code={código}

(… un bloque por curso; en 341C agregar: «Si está en Programación II y en Seminario, registre la asistencia en los dos enlaces.»)
```

## 5. Cierre para el docente (fuera del mensaje)

- Que la plataforma NO avisa (categorías de publicación apagadas en UNIAJ): el mensaje es el único canal.
- Tabla por curso: entregas sin entregar, sin Acuerdo, sin encuesta, asistencia.
- Lo que hay que decidir: evaluaciones en borrador o vencidas, notas externas faltantes,
  actividades publicadas sin asignar, fechas que caen el mismo día de la subida de notas o fuera
  del corte.
