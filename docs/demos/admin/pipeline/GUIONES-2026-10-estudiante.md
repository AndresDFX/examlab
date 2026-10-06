# Guiones serie Estudiante — regeneración 2026-10

Revisión y reescritura de los specs de la serie Estudiante
(`modules/module-s*.json`) para reflejar la plataforma al 2026-10-05, lista para
re-grabar sobre `app.examlab.workers.dev`, tenant **Demo Global Corp**, cuenta
`test-demo-global-corp@examlab.test` (cambiar a Estudiante por el role-switcher SPA).

> **Prerrequisito:** los commits de las features de abajo tienen que estar
> DESPLEGADOS (verificar `deploy-cloudflare.yml` en verde) antes de grabar — el
> recorder graba la app EN VIVO.

## Generador
`gen-student-specs.mjs` quedó **deprecado** (marcado en el propio archivo). Los
specs ya NO salen de él: está atrasado (escribe a scratch, no produce s03b/s03c/s14,
sin `syncWord` ni flujos `openVia`/`typeInto`). Correrlo sobreescribiría lo
hand-maintained. Se edita el `module-sNN.json` directamente.

## Cobertura de módulos
Todos los módulos del nav Estudiante tienen video: courses(s02), exams(s03),
workshops(s04), projects(s05), grades(s06), attendance(s07), polls(s08),
whiteboards(s09), tutor(s10), certificates(s11), calendar(s12) + panel(s01),
mensajes(s14), cuenta/sesión(s13), y los sub-módulos proctoring(s03b) y
comentar-examen-calificado(s03c). **No falta ningún módulo → no se crearon s15+.**

## Cambios por spec

- **s01 Panel** — sin cambios (ya refleja «Ranking de retos», calendario del mes, pendientes).
- **s02 Cursos** — sin cambios (tablero del curso, tutor, foro ya cubiertos).
- **s03 Exámenes** — narración de la lista ahora menciona el **aporte a la nota
  final** (CortePesoBadges). Flujo de toma (2 pasos: `a[href*="/app/student/take"]`
  → `button:Iniciar examen`) intacto; compilador + consola de redes verificados.
- **s03b Proctoring** — sin cambios; usa `fireWarnings:3` y entrada en 2 pasos.
- **s03c Comentar examen calificado** — reescrito el eje: ahora muestra que la
  retroalimentación **solo aparece CALIFICADO** (commit 1c0f9c5c). Target pasó del
  href hardcodeado `a[href*="0cb9b237"]` al texto verificado
  **`text:Ver detalle y retroalimentación`** (clave `exam.viewDetail`), más robusto.
- **s04 Talleres** — reescrito: añade **peso «de la nota final»** (CortePesoBadges),
  **filtro por fecha**, y gating de feedback con **`Ver detalle y retroalimentación`**
  visible solo al calificar (`retroDeTallerVisible`). Se quitó el target
  seed-específico `text:Excelente trabajo` y el `combobox:Calificado`.
- **s05 Proyectos** — añade aporte a la nota final en la narración de la lista; flujo
  ZIP/diagramas/análisis/repositorio intacto.
- **s06 Calificaciones** — reescrito completo: tarjetas **por corte** con peso,
  **«Corte actual»** (`estadoCortes.actual`), **nota relativa / «Nota parcial»**
  (`notaRelativa.notaParcial`), desglose por corte con aporte de cada actividad y la
  asistencia. Nota final ponderada.
- **s07 Asistencia** — reescrito: check-in QR/código rotativo + **% asistencia sobre
  sesiones dadas** (`studentAttendance.attendancePct` / `overGiven`) + **«Ausente
  (sin marca)»** y su leyenda (`statusAbsentNoMark`).
- **s08 Encuestas** — sin cambios (ya «reto en vivo», cambio de voto si se permite).
- **s09 Pizarras** — narración amplía las hojas: dibujo, texto, código, **diagramas**,
  consola Linux y **hoja de base de datos SQL** (`page_type` diagram/sql).
- **s10 Tutor** — añade **referenciar material con `#`** (`findActiveTagQuery`,
  `referencedFiles`) + nuevo beat sobre el `textarea`.
- **s11 Certificados / s12 Calendario / s13 Cuenta y sesión** — sin cambios
  (vigentes; calendario enfoca la grilla del mes, cuenta usa footer con overpan).
- **s14 Mensajes** — sin cambios (ya tiene `typeInto "#"` para etiquetar contenido).

## Targets verificados (contra código / es.json)
`exam.viewDetail` = «Ver detalle y retroalimentación» (1130/1210); `estadoCortes.actual`
= «Corte actual»; `notaRelativa.notaParcial` = «Nota parcial»; `studentAttendance.
statusAbsentNoMark` = «Ausente (sin marca)», `attendancePct` = «% asistencia»,
`overGiven` = «sobre N sesiones dadas», `checkInAvailable` = «Check-in de asistencia
disponible»; `cortePeso.weightOfFinal` = «N% de la nota final». CortePesoBadges,
DateRangeFilter y `retroDe*Visible` confirmados importados en exams/workshops/projects.

## Seeds necesarios en Demo Global Corp (antes de grabar)
- **s03 / s03b:** examen asignable con `require_exam_fullscreen=false` (si no, se queda
  en «Antes de comenzar») + pregunta de código. s03b necesita que `fireWarnings:3`
  marque sospechoso.
- **s03c:** un examen **ya calificado** con retroalimentación por pregunta y un hilo de
  conversación (para que aparezca `Ver detalle y retroalimentación`).
- **s04:** un taller **calificado** con observación del docente + un taller abierto con
  peso/corte (para la badge «de la nota final»).
- **s05:** proyecto con slots variados (ZIP en `position` baja, diagrama, abierta).
- **s06:** curso con cortes con peso, al menos un corte calificado y uno «actual» en
  marcha → fuerza «Nota parcial».
- **s07:** curso con sesiones, una con check-in abierto (QR) y alguna sesión dada sin
  marca → «Ausente (sin marca)» + % sobre sesiones dadas.
- **s09:** pizarra compartida con varias hojas (incl. diagrama/SQL).
- **s10:** tutor de un curso con material; conversación sembrada (texto «mientras se cumpla»).

## Riesgos
- Targets `text:` dependientes de datos sembrados (s04 `Ver detalle y retroalimentación`,
  s06 `Corte actual`/`Nota parcial`, s07 `% asistencia`, s09 `Diagrama de flujo`,
  s10 `mientras se cumpla`) requieren el seed correcto o el beat no enfoca.
- `openVia text:Ver detalle y retroalimentación` (s03c) clickea el primer match: con
  varios exámenes calificados, asegurar que el primero sea el de la demo.
- `require_exam_fullscreen=false` es condición DB para s03/s03b.
