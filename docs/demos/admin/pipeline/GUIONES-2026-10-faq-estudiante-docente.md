# Regeneración de guiones FAQ — Estudiante y Docente (2026-10)

Alcance: `module-faqs01…faqs11` (Estudiante) y `module-faqt01…faqt12` (Docente).
Todos los specs databan del 2026-07-20/22; se verificaron contra el código de hoy
(rutas, `src/i18n/locales/es.json`, `src/shared/components/AppLayout.tsx`, módulos de
`src/modules/*`, CHANGELOG/CLAUDE.md). Regla aplicada: una pregunta por video,
narración autocontenida, tuteo es-CO, "institución" (nunca "tenant"), "Reto en vivo"
(nunca "Kahoot"), 30–60 s, tenant Demo Global Corp.

## Cambios por archivo

### Editados

- **faqs03 — Ver mis calificaciones.** La etiqueta del nav del estudiante es
  **"Calificaciones"** (`nav.studentGrades`), no "Notas". Reescrita la narración y los
  focus. Ajustada a la **nota relativa** (mig 20262670000000 + strings `notaRelativa.*`):
  "la nota cuenta solo lo que ya pasó… lo que todavía no se dio no te resta, y mientras
  falten actividades verás una nota parcial". Se eliminó la afirmación vieja "lo que aún
  no tiene nota cuenta como pendiente" (ya no es cierta así).
- **faqs06 — Asistente IA del curso.** El nav del estudiante hacia `/app/student/tutor`
  se llama **"Asistente IA"** (`nav.aiAssistant`), y la marca visible es "Asistente IA"
  (CLAUDE.md). Renombrado question/title/card/narration/focus de "Tutor de IA" →
  "Asistente IA". Ruta y `data-tour-nav` se conservan (`/app/student/tutor`).
- **faqs08 — Mis certificaciones.** El nav es **"Certificaciones"** (`nav.studentCertificates`).
  Ajustado el focus title y la narración; se agregó que con curso sin cerrar la nota es
  parcial y aún no se emite el certificado (regla de nota parcial).
- **faqt10 — Generar un documento.** El módulo de informes se llama **"Documentos"**
  (`nav.reports` + `hc_routesAppTeacherReports.pageTitle` = "Documentos"). Reescrito de
  "Informes" → "Documentos" (acta/boletín como ejemplos).
- **faqt12 — Cola de calificación con IA.** Focus title corregido de "Cron" →
  **"Tareas de IA"** (`nav.aiCron`). Narración ya era correcta.

### Sin cambios de fondo (verificados, siguen siendo ciertos)

- faqs01 (presentar examen: autoguardado + aviso de preguntas en blanco — `isQuestionAnswered`).
- faqs02 (check-in: QR o código de 6 dígitos — vigente, incluye enlace/deep-link).
- faqs04 (entregar taller: borrador local hasta entregar + entrega de grupo compartida).
- faqs05 (proyecto: archivos + ZIP + enlace de repo obligatorio + nota final tras sustentación).
- faqs07 (encuestas: elegir/cambiar/quitar respuesta + Reto en vivo con PIN).
- faqs09 (mensajes: campana + adjuntar + etiquetar con #).
- faqs10 (calendario: grilla de mes + puntos por tipo).
- faqs11 (material del curso: ver y ejecutar código/notebooks en el tablero).
- faqt01–faqt09, faqt11 (crear examen/taller/proyecto, QR, libro de notas + CSV, banco de
  Preguntas, contenidos, Reto en vivo, pizarra compartida, monitor + fraude). Todos vigentes.

### Nuevos (próximos números libres)

- **faqs12 — "¿Por qué no veo la retroalimentación de mi taller o examen?"** La
  retroalimentación se muestra **solo cuando la entrega está calificada** (commit 1c0f9c5c,
  `retroalimentacion-visible.ts`). Mientras está "Por calificar" no hay botón ni comentarios.
- **faqs13 — "¿Me cuenta como falta si no hice el check-in de una clase?"** Si la clase se
  dio y no quedaste con registro, cuenta como falta; el % de asistencia coincide con la nota
  del corte; tarde = asistió; justificada no resta (commits a672843b/a90e31f2/7a538047).
- **faqs14 — "¿Por qué mi consulta SQL no da el resultado que espero?"** La base corre en el
  navegador y **arranca limpia cada ejecución** (incluir esquema+datos en la hoja); lo
  comentado **no se ejecuta**; `RAISE NOTICE` se muestra bajo el resultado (commit ec3566fd,
  `pglite-loader.ts`/`sql-answer.ts`); al entregar se guarda consulta + resultado.
- **faqt13 — "¿Por qué mis estudiantes no ven el examen o taller que publiqué?"**
  **Publicar ≠ asignar**: el estudiante solo ve lo asignado; y **curso en borrador ⇒ material
  en borrador** (CLAUDE.md; migs 20262690000000 / asignar-no-notifica).

## Targets verificados

- Rutas de nav existen (`src/routes/app.{student,teacher}.*`) y los `data-tour-nav` coinciden
  con `to:` de `AppLayout.tsx`.
- Labels de nav confirmados en `es.json`: studentGrades="Calificaciones",
  aiAssistant="Asistente IA", studentCertificates="Certificaciones", reports="Documentos",
  aiCron="Tareas de IA", polls="Encuestas", questionBank="Preguntas".
- `firstcard` / `text:Nuevo|Nueva|Exportar` son resolvers existentes (ver AJUSTES §5). No se
  introdujeron targets nuevos ni `syncWord` (los specs FAQ no los usan).

## Seeds necesarios antes de grabar (tenant Demo Global Corp)

- firstcard requiere **al menos una fila** en cada listado: exámenes, talleres, proyectos,
  encuestas, certificaciones, cursos con material, sesión de asistencia.
- faqs12: una entrega del estudiante en estado **"Por calificar"** para mostrar el estado.
- faqs13: una sesión que ya ocurrió con registro de asistencia del curso.
- faqs14: un examen o taller con una pregunta `bd_sql` (opcional; el beat enfoca el nav).
- faqt13: un examen publicado (y, para el contraste, un curso en borrador).
- IA en `processing_mode=sync` solo si se graban generaciones; restaurar a `async` al terminar.

## Riesgos

- `firstcard` falla si el listado está vacío → sembrar datos.
- Rutas sin nav item: ninguna en este lote (todas tienen `data-tour-nav`).
- faqs14 apunta a `/app/student/exams`: las preguntas SQL también viven en talleres/pizarra;
  el beat solo enfoca el nav, así que es seguro.
- Las 4 FAQ nuevas quedarán **inactivas** en `platform_help_videos` hasta que exista el MP4
  (el seed las sube con `is_active=false`). El regex del seeder (`faq[ats]\d+`) ya las incluye.
