---
name: seguimiento-clases-uniajc
description: >
  Llena el formulario «Seguimientos a programas FI <periodo>» de la UNIAJC (Microsoft Forms, una
  respuesta por ENCUENTRO dictado) con las clases que ya se dieron, sacadas de ExamLab: tema,
  actividades, fecha, franja, plataforma, matriculados, asistentes y quiénes faltaron. Arma
  primero una tabla para que el docente la revise, envía solo lo confirmado y anota cada envío
  para no repetirlo nunca. Úsalo cuando el usuario pida «llenar el seguimiento de clases», «el
  formulario de seguimientos a programas», «reportar las clases que he dado» o «ponerme al día
  con el formulario de encuentros».
---

# Seguimiento de clases (UNIAJC)

El formulario (`cursos.json` → `formulario`) es **una respuesta por encuentro** y tiene 4 páginas:

| Página | Qué pide | De dónde sale |
|---|---|---|
| 1 | Profesor, documento, programa y asignatura (desplegables), fecha estipulada o recuperación, **sede**, grupo | `cursos.json`; el documento, de `UNIAJC_DOCUMENTO` en `.env.uniajc` (nunca en el repo) |
| 2 | «Encuentro #N: tema», actividades, fecha, franja horaria (opciones fijas), **LMS** (Moodle/Teams), modalidad, videoconferencia | la sesión de ExamLab y la metodología del curso en `cursos.json` |
| 3 | Matriculados, asistentes, **nombres de quienes no asistieron** («NA» si fueron todos), observaciones | asistencia de ExamLab contra el listado oficial |
| 4 | Vocero (nombre, teléfono, correo): solo la primera vez por grupo | `course_enrollments.vocero_*` |

`sede` (por curso) y `lms` los decide el docente (los cursos son virtuales y el formulario igual
los exige); sin ellos el script de envío no arranca. La sede sale de la **hoja de horarios del
programa** que comparte la dirección (en 2026-2, «HOR ING SISTEMAS - CALENDARIO A», hojas NORTE /
SUR DIURNO y NOCTURNO; se descarga con su enlace como `.xlsx`): la hoja en que está la fila del
grupo ES la sede, y en Sur los grupos empiezan por «S». Los grupos que no están en esa hoja
(Introducción, de primer semestre) los confirma el docente: en 2026-2, SB141B/SB141C en Sur y
LB141F en Multicampus Ladera. La franja es la opción del formulario más cercana al horario
oficial de esa hoja (6:30pm-9:30pm → «6:30Pm A 9:00Pm»).

## Cómo se corre (desde la raíz del repo)

1. `node .claude/skills/seguimiento-clases-uniajc/scripts/encuentros.mjs` — solo lee ExamLab y
   escribe en `privado/seguimiento-clases-<periodo>/` (lleva nombres: **nunca al repo**)
   `encuentros.json` y `encuentros.md` con cada encuentro en `listo`, `revisar` o `enviado`.
2. Mostrarle al docente las filas en `revisar` con su motivo; lo que decida se escribe en
   `ajustes.json` (clave `"<curso>|<aaaa-mm-dd>"`, los campos que cambian, y `"estado": "listo"`
   o `"descartar"`) y se vuelve a generar.
3. `node …/scripts/llenar.cjs` — prueba: llena las 4 páginas de cada encuentro listo y verifica,
   sin enviar. Después `--enviar` (opcional `--max N`, `--solo "<clave>"`). Cada envío
   confirmado queda en `enviados.jsonl`; volver a correrlo solo manda lo nuevo.

## Por qué un encuentro queda «revisar» (lo que no se deduce)

El título de una sesión en ExamLab es lo PLANEADO. En 2026-2:
- Sesiones llamadas «Parcial 1» en las que no se presentó ningún examen: el parcial se había
  movido (Arquitectura lo presentó un viernes; Bases de Datos II, en la sesión siguiente, que
  además se borró en ExamLab). Lo que se presentó y cuándo sale de los intentos de `submissions`.
- Sesiones pasadas sin una sola marca de asistencia: no se sabe si hubo clase.
- Días de evaluación en que más estudiantes la presentaron que los que tienen asistencia: la
  asistencia de ese día quedó incompleta (el 06/10 se cayó la plataforma).
- Un parcial presentado un día sin sesión: puede ser un encuentro de recuperación.

Esos no se envían sin la decisión del docente: un envío no se puede corregir. Tampoco se reportan
las sesiones autónomas de festivo (no hubo encuentro sincrónico) ni una sesión de hoy que no ha
terminado.

## Reglas

- **Listado oficial**: el CSV del último corte pasado a la universidad, menos quien quedó anotado
  en `observaciones.json` como «No figura en el listado oficial». Quien está en ExamLab y no en
  ese listado no cuenta como matriculado ni como ausente.
- **Grupo** como lo escribe el listado de Academusoft (`641A-2`, no `641A`).
- **Sesión del docente**: el formulario se llena con su cuenta @profesores en una ventana visible.
  Lo preferible es que él inicie sesión; si da la contraseña, va por `OUTLOOK_EMAIL` /
  `OUTLOOK_CLAVE` en el entorno de esa corrida, nunca a un archivo, y se le recomienda rotarla.
- **La fecha se verifica en el CALENDARIO, no en el texto.** El campo es texto con un selector, y
  en 2026-10 una corrida escribió «05/10/2026» y quedó «10/5/2026» (releído como mes/día: 10 de
  mayo), de forma intermitente. El script fija el navegador en es-CO, saca el foco del campo, abre
  el calendario y compara el día y el mes marcados; si no coinciden, reintenta una vez y se detiene.
- **La confirmación de envío cambia de formulario a formulario** («La respuesta se ha enviado.»
  acá, «…enviado correctamente» en el de control currículo). Si el script no la reconoce, se
  detiene SIN anotar el envío: hay que mirar la pantalla y anotarlo a mano en `enviados.jsonl`
  antes de volver a correr, o ese encuentro se duplica. Pasó con el primer encuentro de 2026-2.
- **Inicio de sesión de Microsoft**: detectar si llegó el formulario por su CONTENIDO y no por la
  dirección (el enlace corto es de `forms.*` y redirige al login después), y pulsar los botones
  por su nombre («Siguiente», «Iniciar sesión»): Enter y los selectores viejos dejaron de
  funcionar con el diseño nuevo de la página.
- Ver también la skill `control-curriculo` (mismo tipo de formulario y las mismas trampas:
  preguntas que aparecen tarde, borrador que conserva respuestas, valores con espacio al final).
