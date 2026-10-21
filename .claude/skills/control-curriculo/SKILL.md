---
name: control-curriculo
description: >
  Control currículo de la UNIAJC: arma los documentos que pide cada entrega del semestre (Acuerdo
  pedagógico, Plan de curso, Diagnóstico y seguimiento) con los FORMATOS ACTUALIZADOS que manda la
  dirección, los deja en `<Curso>/Entregas docente/<periodo>/` de la carpeta de Drive de cada curso,
  y llena el formulario de Microsoft Forms de cada entrega. Úsalo cuando el usuario pida «control
  currículo», «la entrega 1 / 2 / 3 / 4 de currículo», «el plan de curso en el formato nuevo»,
  «el diagnóstico y seguimiento» o «subir los acuerdos al formulario».
---

# Control currículo (UNIAJC)

La dirección manda cada semestre un correo «CONTROL CURRICULO <periodo>» con un Genially (las
fechas y el enlace de cada entrega, calendario A o B) y un zip con los formatos actualizados. Hay
**4 entregas**, cada una en un Microsoft Forms con la cuenta institucional (@profesores).

| Entrega (2026-2, calendario A) | Qué pide el formulario | Fecha máxima |
|---|---|---|
| 1 | Acuerdo pedagógico y plan de curso de cada grupo (archivos) | 11 sep |
| 2 · Diagnóstico y seguimiento 1 | Nivel de los conocimientos previos (Alto/Medio/Bajo/Nulo), UNA acción frente al diagnóstico, «¿qué otra acción?» y la **primera parte** del formato de diagnóstico de cada grupo (archivos) | 25 sep |
| 3 · Seguimiento 2 | Asignaturas y grupos con más inconvenientes (texto), efectividad de las estrategias (Alto/Medio/Bajo), si hubo dificultades recurrentes con los recursos (Sí/No) y la **segunda fase** del formato de diagnóstico de cada grupo (archivos). Con «Sí» pide además cuáles dificultades y en qué grupos | 16 oct |
| 4 · Seguimiento 3 | (leerlo al llegar) | 13 nov |

**Leer el formulario completo antes de responder**: Forms pinta algunas preguntas tarde y otras
solo aparecen según una respuesta. La primera lectura de la entrega 2 mostró 4 preguntas y tenía
6 (el primer intento de envío no pasó porque faltaba el archivo de la 6), y en la entrega 3 la
carga de archivos solo aparece después de responder la pregunta de los recursos. Esperar a que
cargue, contestar las opciones, desplazarse hasta el final y listar los `input` antes de enviar.

## Dónde está cada cosa

- Formatos oficiales: `G:\Mi unidad\Trabajos\Empleo\UNIAJ\Formatos\` (comparar con el zip del
  correo por md5: si cambiaron, **mandan los del zip**).
- Cursos: `G:\Mi unidad\Trabajos\Empleo\UNIAJ\Cursos\<Curso>\` — mapa en
  `LEEME - Mapa de cursos y agentes.md`. Calendario de cada sesión en
  `config/calendario/semestre_<periodo>.json` y `introduccion_ingenieria_<periodo>.json`, y en
  `Plan curso/<periodo>/PLAN_DE_CURSO_<periodo>.md` / `CALENDARIO_<periodo> - <grupo>.md`.
- Notas del corte ya pasadas a la universidad: `privado/notas-<periodo>/corte1/` del repo (CSV por
  grupo, informe, observaciones). El listado OFICIAL del grupo es el de esos CSV/informe, no el de
  ExamLab: en 2026-2 un estudiante de Seminario estaba en ExamLab y no en el listado de la
  universidad. Y el grupo oficial no lleva el sufijo de ExamLab (641A-2 → 641A).
- Salida: `<Curso>\Entregas docente\<periodo>\` — un `.docx` y un `.pdf` por documento y grupo.

## Cómo se arma (scripts en `scripts/`; Word por COM, corren sin `python -I`)

1. `tables.py <salida.json> <docs…>` vuelca las tablas de cualquier `.doc`/`.docx`.
2. `plan.py` arma las filas del plan de curso: **Trabajo dirigido** = el tema de la sesión del
   calendario del periodo; **Trabajo independiente dirigido / independiente** = las filas del plan
   del semestre anterior cuyo tema coincide (por palabras, no por número de sesión: el material
   «Clase N» no es la fila N del plan viejo). Los parciales llevan su texto fijo. **Revisar la
   salida a ojo**: una coincidencia por palabras se equivoca con «presentación» o «evaluación»
   (ver `FIX` en `fill.py`).
3. `fill.py` llena `PLAN DE CURSO ACTUALIZADO.doc` (16 filas; borra las sobrantes) y exporta PDF.
4. `acuerdo.py` arma el acuerdo de un curso nuevo partiendo de uno ya armado del mismo periodo.
5. `analisis-diagnostico.mjs <salida.json>` (solo lectura, desde la raíz del repo): por grupo, la
   nota de la prueba diagnóstica y el logro por pregunta, el primer parcial (o «Evaluación de
   Corte 1» en Introducción) con sus recuperaciones vía `exam_attempts_raw_grade` /
   `exam_effective_raw_grade` (la misma regla del libro y del acta) y la asistencia del corte.
   Los ids de curso son del periodo: actualizarlos cada semestre.
6. `anexo-instrumento.cjs <dir> <datos.json>`: el **instrumento diagnóstico** que pide anexar el
   formato, armado con las preguntas tal como se aplicaron en ExamLab y SIN respuestas. Los Word
   del Kit docente NO sirven de anexo: en 2026-2 tenían otro número de preguntas que lo aplicado.

Rutas con `os.path.normpath`: `ExportAsFixedFormat` rechaza las barras `/`. En las celdas largas
del formato, párrafos (`\r`) y alineación a la izquierda: el formato viene justificado y un salto
de línea manual estira las líneas cortas.

## El acuerdo pedagógico sale de ExamLab, no de Word

Los acuerdos de cada curso se generan y se FIRMAN en ExamLab (`generated_reports`,
`template_name` «Acuerdo Pedagógico», `periodo`). El PDF con las firmas se saca del enlace público
`/documento/<public_token>`: tomar el HTML del iframe, inyectar
`@media print{header,footer{position:static!important} main{padding:0!important}}` (si no, el
encabezado fijo tapa la primera fila de cada página) y exportarlo con `page.pdf`. Se guarda como
`ACUERDO PEDAGOGICO - <ASIGNATURA> - <GRUPO>.pdf`.

## Diagnóstico y seguimiento: qué va en cada parte

- **Primera parte** (entrega 2): conocimientos previos, hallazgos de la diagnóstica (quiénes la
  presentaron, promedio, cuántos ≥ 3,0, fortalezas y debilidades con el % de acierto por pregunta)
  y acciones. Se sube SOLO esta parte, con el anexo del instrumento.
- **Segunda parte** (seguimiento del primer parcial): matriculados del listado oficial; «perdieron
  el primer parcial» y «no lo presentaron» se cuentan sobre el examen ORIGINAL, y lo que pasó en
  supletorio o recuperatorio va en el texto. En «estudiantes con dificultades» van los que HOY
  necesitan seguimiento (quien recuperó el parcial ya no), con el motivo.
- Cada cifra del texto se verifica contra los datos antes de generar: una frase como «las
  conceptuales superaron el 82 %» puede ser falsa por UNA pregunta abierta que no se miró.

## El formulario (Microsoft Forms)

- Hasta **10 archivos** por pregunta: con 7 grupos, los acuerdos y los planes fueron dos envíos.
- **Recorta el nombre del archivo a ~45 caracteres** y se pierde el grupo: subir copias con la
  asignatura abreviada (`PLAN DE CURSO - INTRO ING - LB141F.pdf`).
- **Guarda un borrador** con los archivos ya cargados: antes de subir, eliminar los que haya
  (botones `Eliminar "<archivo>"`, visibles al pasar el mouse), o se duplican.
- Algunos `value` de las opciones terminan en espacio (`"Medio "`): seleccionar por prefijo.
- Hacer una pasada SIN enviar que verifique textos, opciones y que todos los nombres de archivo
  aparezcan en la página; enviar solo si todo coincide, y confirmar «enviado correctamente».

## Reglas

- **Datos de estudiantes**: nombres, documentos y firmas van en los documentos que se entregan a
  la universidad y viven en Drive. **Nunca en el repo**, que es público: ni en los scripts (un
  documento de identidad metido en una constante también cuenta).
- **Primero validar el semestre anterior**: qué se subió (en `Entregas docente/<periodo anterior>`)
  y con qué formato, para no subir este semestre un formato viejo.
- **El formulario se llena con la sesión del docente** en un navegador VISIBLE (Playwright con
  ventana). Lo preferible es que el docente inicie sesión él mismo; si insiste en dar la
  contraseña, pasarla solo por variable de entorno (nunca a un archivo), borrar el perfil del
  navegador al terminar y recomendarle rotarla (ver CLAUDE.md: «Qué credencial pedir»).
- Las preguntas de opinión del formulario (nivel, efectividad, recursos) son del docente: se
  proponen con los datos que las respaldan; si algo no se puede saber desde los datos (por
  ejemplo, problemas con los recursos asignados), se le pregunta.
- Un envío de Forms no se edita después: revisar antes de enviar.
