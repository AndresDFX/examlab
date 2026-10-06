# Regeneración de guiones — Serie Docente (2026-10)

Reescritura de los specs de la serie Docente para reflejar la plataforma actual.
Los specs venían de 2026-07-21 (salvo t04/t05, tocados el 2026-10-04); desde
entonces entró una gran tanda de features en `[Sin publicar]` del CHANGELOG. Solo
se tocaron archivos `module-tNN.json` (no admin/estudiante/sa/faq ni el pipeline).

**Requisito previo a grabar:** los commits deben estar DESPLEGADOS en
`app.examlab.workers.dev` (verificar `deploy-cloudflare.yml` en GitHub Actions) y
`ai_model_settings.processing_mode = sync` durante los videos de IA (restaurar a
`async` al terminar). Cuenta demo `test-demo-global-corp@examlab.test`, rol Docente
por el role-switcher SPA.

## Qué cambió por módulo

- **t01 Panel** — narración suma «estadísticas con alerta temprana» al recorrido de
  módulos. Sin cambios de targets.
- **t02 Cursos** — refleja la cascada curso en borrador ⇒ material en borrador y el
  vocabulario «Activar curso» / «Volver a borrador» con aviso de impacto. Solo
  narración (targets existentes verificados). i18n: `course.actionPublish` = "Activar
  curso (poner en curso)".
- **t03 Exámenes** — vista: ordenar por columna, filtro por curso/rango de fechas y
  supletorios/recuperatorios anidados en la fila del parcial. Acciones: publicar/volver
  a borrador, simular como estudiante, crear recuperatorio, y preguntas+estudiantes en
  «Editar» (ConfigurarDesdeEditar). Resultado IA: también identificar desde texto e
  importar del banco. Verificado: `simulacroExamen.accion`="Simular como estudiante",
  `exams.backToDraft`="Volver a borrador", `crearRecuperacion.action`="Crear
  recuperatorio", `questionsImport.button`="Identificar desde texto". Escenas IA en vivo
  intactas.
- **t04 Talleres** — acciones suma calificar por grupo, recuperatorio y sustentación
  opt-in; crear menciona modo grupal. Narración; escenas IA intactas.
- **t05 Proyectos** — acciones suma calificar por grupo y que la sustentación multiplica
  la nota. Narración.
- **t06 Preguntas (banco)** — suma tipos (incl. `bd_sql` PostgreSQL en el navegador) e
  «identificar pegando un texto». Narración; escena IA en vivo intacta.
- **t07 Calificaciones** — nota RELATIVA (cuenta solo lo dado → nota parcial a mitad de
  semestre) y recuperaciones anidadas dentro de su actividad en el Detalle del corte.
  Narración.
- **t08 Asistencia** — proyector del check-in: código manual, hora de cierre a la vista,
  +5/+10/+15 min, y un código para varias sesiones (asistencia múltiple). Narración;
  targets `text:Presentes`, `text:Código manual`, `field:Duración` intactos.
- **t09 Contenidos** — subir externo ahora incluye imágenes; imágenes/PDF se ven inline
  (imágenes se editan/anotan) y código/notebooks se ejecutan. Narración.
- **t11 Pizarras** — hojas ahora incluyen SQL (PostgreSQL real) y diagrama, además de
  dibujo/texto/código/consola. Verificado: `...MultiPageWhiteboard.sqlPage`="Hoja SQL",
  `.diagramPage`="Hoja de diagrama", `.codePage`, `.consolePage`. Narración + focus body.
- **t12 Encuestas** — suma edición manual de las preguntas del Reto en vivo y enlace
  público (responder sin login, solo encuestas de preguntas). Narración.
- **t10 Videos, t13 Mensajes, t14 Calendario** — ya eran exactos; sin cambios (Videos ya
  no menciona «archivados», que fue removido del UI).

## Módulo NUEVO

- **t15 Estadísticas** (`/app/teacher/statistics`) — cubre Alerta temprana y «Qué falta
  del corte», features grandes sin video. Targets verificados: `text:Estadísticas`
  (PageHeader), `text:Alerta temprana` (`earlyAlert.title`), `text:Qué falta del corte`
  (`statistics.ungradedTitle`), `firstcard`.

## Seeds necesarios antes de grabar

- **t15 Estadísticas (CRÍTICO):** el panel por curso (con Alerta temprana + Qué falta del
  corte) solo renderiza con UN curso seleccionado. Si el docente demo tiene exactamente
  UN curso en alcance, se auto-selecciona y ambos paneles salen sin `selectOption`. Si
  tiene varios, el default cae en «Todos los cursos» (solo Pendientes) → o reducir el
  alcance a un curso, o añadir `selectOption` (frágil). Ese curso necesita: actividades
  con peso y nota, asistencia tomada y ≥1 estudiante «en riesgo» (2 señales: baja
  asistencia + actividad reprobada/no entregada) para que la alerta no salga vacía.
- **t03/t07 recuperatorios anidados:** sembrar 1 supletorio/recuperatorio sobre un parcial
  para que la fila anidada y el Detalle del corte lo muestren (hoy la narración lo cuenta
  aunque no haya seed; con seed se ve).
- **t08 asistencia múltiple:** crear ≥2 sesiones para el mismo día y abrir el check-in
  marcando «varias sesiones», o la narración de «un código para varias sesiones» no tiene
  respaldo visual.
- **t07 consolidado:** mantener la nota real (workshop `is_external` con `final_grade` +
  `cut_id` con bucket) — reusar seed t07 existente.
- **t08 contador 0/N** y **t13 mensajes programados**: reusar seeds previos (AJUSTES §2).

## Riesgos

- **t15 Select de curso:** es el punto frágil (AJUSTES §5). Preferir alcance de un solo
  curso; validar el frame del panel por curso antes de dar por bueno.
- **t07 «Detalle del corte»:** el modal `button:Detalle` a veces no abre (AJUSTES §8); la
  nota del consolidado igual se ve.
- **t03 escenas IA en vivo:** sin cambios, pero dependen de `processing_mode = sync`.
- **t11:** la pizarra abierta usa un id fijo (`cc28ef0d-…`); verificar que exista en el
  tenant demo tras el deploy.
- Las features agregadas en t02–t12 son mayormente **narración** sobre targets ya
  verificados; no se añadieron beats interactivos nuevos frágiles salvo t15.

## Candidatos a nuevos módulos (NO creados, requieren decisión)

Módulos docente sin video: **Informes/Documentos** (`/app/teacher/reports`, plantillas de
actas/boletines — complejo de grabar), **Mis estudiantes** (`/app/teacher/students`),
**Prompts de IA** (`/app/teacher/ai-prompts`, overrides por curso + restaurar default),
**Cron/Jobs de IA** (`/app/teacher/ai-cron`), **Auditoría** (`/app/teacher/audit-logs`) y
**Papelera** (`/app/trash`). Se dejaron fuera por menor valor docente o fragilidad de
grabación; crear specs si se priorizan.
