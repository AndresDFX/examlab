# Guiones de la serie Admin — revisión 2026-10

Revisión de los specs de video de la serie **Administrador** (`module-01`…`module-16`,
`module-overview`, `module-promo`, `module-social`, `module-login`) contra el código ACTUAL
(`src/routes`, `src/i18n/locales/es.json`, `AppLayout.tsx`, `module-catalog.ts`). Objetivo: que la
narración y los targets reflejen la plataforma de hoy y queden listos para re-grabar en **Demo Global
Corp** (`test-demo-global-corp@examlab.test`, app en vivo `app.examlab.workers.dev`).

> Los specs de julio ya grababan OK; solo se tocó lo que quedó desactualizado. Todos los JSON validan
> con `JSON.parse`. Regla «institución» (nunca «tenant») y tuteo es-CO verificadas.

## Cambios por módulo

### module-01 — Panel y Dashboard  ·  sin cambios
Verificado: `data-tour-module` `courses/academic/contents/audit_logs` y `data-tour-nav`
`/app/admin/users`, `/app/admin/settings` existen (AppLayout + `NAV_PATH_TO_MODULE`). `stat:0/1`,
`card:Cursos recientes`, `card:Actividad reciente` siguen siendo los textos reales. Narración vigente.

### module-02 — Usuarios  ·  narración actualizada
- **Nuevo:** la inscripción al crear un usuario es **multi-curso** (`CourseCheckboxList`). Narración y
  focus cambiados a «en uno o varios cursos».
- Verificado: `field:Nombre` (Nombre completo), `field:Email institucional`, `field:Contraseña`
  (Contraseña inicial), `field:Roles`, `field:Inscribir` (Inscribir en curso (opcional)),
  `create-user`, `bulk-import-users`, `th:Roles`. La acción de fila «Iniciar como» (impersonación,
  `adminUsers.actionImpersonate`) existe → el beat `rowaction:0 clickToOpen` la muestra.

### module-03 — Estructura Académica  ·  sin cambios
Tabs Carreras/Asignaturas/Periodos y los `field:` (Nombre, Código, Área, Objetivos, Contenidos,
Inicio, Fin) vigentes. (Existe además «Duplicar» en los paneles académicos; no se agregó beat.)

### module-04 — Cursos  ·  sin cambios
`create-course` + `course-field-name/period/subject/dates/cuts` existen. Narración (asignatura como
fuente de verdad, cortes, correo de bienvenida al inscribir) sigue correcta. Nota de contexto: un
curso nace en borrador y se «activa» cuando está listo (feature nueva), pero eso es flujo docente/
admin fuera del formulario de creación; no se forzó un beat para no fragilizar la grabación.

### module-05 — Contenidos  ·  sin cambios
Verificado que `createbtn` abre el diálogo **«Nuevo contenido»** que ES el generador con IA
(`contents.newContent`), con `field:Nombre` (Nombre del contenido), `field:Tema`, `field:Modo`,
`field:Tipos` (Tipos de contenido). Nota: existe además el botón `upload-external-content` para subir
archivos (incl. código/notebooks ejecutables), usado solo en `readySelectors`.

### module-06 — Biblioteca de Videos  ·  sin cambios
`text=Nuevo video`, `field:Título`, `field:URL`, `field:Descripción` (… (opcional)), `field:Curso`
(… (opcional)) vigentes. El «archivado» se removió del UI pero la narración nunca lo mencionaba.

### module-07 — Configuración de IA  ·  narración actualizada
- **Nuevo:** los prompts hoy cubren más casos de uso (incl. **Tutor del curso** y **Asistente IA**),
  cada prompt tiene **«Restaurar default»** (`adminPromptsPanel.btnRestoreDefault`), y el Modelo
  admite **clave propia por institución + claves de respaldo (failover)**. Narración reescrita en
  Prompts, Modelo y foco.
- Targets conservados y verificados: tabs `Prompts`/`Modelo`, `text:Módulo` (filtro), `text:Taller
  completo`, `field:Proveedor`, `field:API key`, `readySelectors` `text=Mostrando`
  (`adminPromptsPanel.showingCount`).

### module-08 — Configuración de la institución  ·  narración actualizada (Correos)
- **Nuevo:** el panel de Correos gobierna la **notificación completa** (campana + email + push),
  no solo el email. Narración de la escena «correos» ajustada.
- Tabs verificados: `Institución`, `Módulos`, `Correos`, `Compilador`, `Auditoría` (todos existen).
  `field:Nombre`, `field:Logo institucional`, `field:Color primario`, `text:Bienvenida` vigentes.
- Contexto (no grabado): el panel de settings ahora tiene además tabs **Generales** y **Modelo IA**;
  se mantuvo el recorrido de 5 tabs para no inflar el video.

### module-09 — Certificados  ·  sin cambios
`row:0`, `rowaction:0`, `firstcard` de la página de verificación vigentes. **Riesgo**: la escena
`verify` usa la ruta fija `/verify/2VRRLPYDB24Z`; ese código debe existir en el tenant demo o la
página de verificación saldrá «no encontrado». Verificar/actualizar el código antes de grabar.

### module-10 — Estadísticas  ·  sin cambios
`text=Estadísticas globales`, `statrow` (5 KPIs incl. alertas de integridad), `text:Programa`
(filtro), `card:Comparativa entre cursos`, `card:Detalle por curso` verificados.

### module-11 — Informes → **Documentos**  ·  título y narración actualizados
- **Nuevo:** el módulo se llama **«Documentos»** (`adminReportTemplates.title`, `nav.reports`). Se
  cambió `title`, card de intro/outro y narración.
- `button:Cargar Word` (Cargar Word (.docx)), `createbtn`/`Nueva plantilla`, `field:Nombre`,
  `field:Tipo de informe` (labelReportType), `card:Variables disponibles` verificados.

### module-12 — Auditoría  ·  narración actualizada
- **Nuevo:** «Errores» se unificó como pestaña dentro de Auditoría (ya no es módulo propio). Se
  añadió una frase; `firstcard` y `row:0` sin cambios. `text=Registro de auditoría` vigente.

### module-13 — Soporte  ·  sin cambios
`createbtn` + `field:Categoría/Asunto/Descripción` vigentes. (El beat «Sugerir respuesta con IA» vive
en el detalle del ticket del SA/Admin; no se agregó para no depender del edge `support-ai-suggest` en
vivo — candidato a sumar si se graba con la conversación abierta.)

### module-14 — Papelera  ·  sin cambios
`stat:0`, `row:0`, `th:Purga en` (`trash.colPurgesIn`) y los botones Restaurar/Eliminar definitivo
vigentes.

### module-15 — Cuenta y Sesión  ·  narración corregida (regla)
- **Corrección obligatoria (AJUSTES §1):** se eliminó la frase «se limpia el contexto de la
  institución» de la narración, el focus de logout y el outro. `syncWord` del logout pasó de
  `cerrar` a `cierras` (palabra única en la nueva narración). Targets del footer sin cambios.

### module-16 — Cola de IA → **Tareas de IA**  ·  título, readySelectors y targets actualizados
- **Nuevo:** nombre del módulo «Tareas de IA» (`aiCronPage.title`); la card es «Tareas de IA en cola»
  (`unifiedAiQueue.cardTitle`). `readySelectors` cambiado de `text=Cola IA unificada` →
  `text=Tareas de IA en cola`.
- El botón de fila por estado cambió: ya **no** hay `button[title="Reintentar"]`; el beat ahora apunta
  a `button[title="Procesar ahora"]` (`unifiedAiQueue.processNow`, verificado). `syncWord` →
  `procesarlo`. Labels de stats en narración actualizados (En espera / Procesando / Con error / Listas).
  `button[title="Click para ver el error completo"]` sigue vigente.

### module-17 — **Asistente IA (NUEVO)**
- Módulo nuevo (un módulo por video). `appPath` `/app/assistant` (ruta universal; `/app/admin/support-
  assistant` redirige aquí). Muestra el estado vacío (`text=Tu Asistente IA`), las **Preguntas
  frecuentes** por rol (`text=Preguntas frecuentes`) y el campo de pregunta (`main textarea`).
- **Decisión:** NO se hace una consulta a la IA en vivo (evita depender de sync + edge); la narración
  describe que responde en lenguaje natural con la documentación. Si se quiere beat en vivo: `typeInto`
  en `main textarea` + `click button:Enviar` con `afterClickMs` alto (flag: respuesta puede tardar).

### module-overview / module-promo / module-social / module-login  ·  sin cambios
- overview: rutas `/app/admin/users`, `/app/teacher/exams`, `/app/teacher/gradebook`,
  `/app/student/exams`, `/app/student/tutor` verificadas; `statrow`, `maincard`, `firstcard`,
  `createbtn` vigentes. Narración (Tutor que lee el material real, correo de bienvenida) correcta.
- social: `createbtn`, `row:0`, `card:Consolidado por cortes` (gradebook), `firstcard` (asistencia)
  verificados. promo/login son card-only (marketing); sin targets de UI.

## Seeds requeridos antes de grabar (tenant Demo Global Corp)

- **module-14 Papelera:** soft-delete de UNA entidad descartable (`deleted_at` ~25 días atrás) para el
  badge ámbar en «Purga en» y un `row:0` real.
- **module-16 Tareas de IA:** sembrar las colas (`ai_grading_queue` + `ai_generation_queue`) con jobs
  en estados variados (pending/processing/failed/done, `body._demo_seed=true`) para el `statrow`, una
  fila con error (`last_error`) para `button[title="Click para ver el error completo"]`, y al menos una
  con `button[title="Procesar ahora"]`. Limpiar al terminar. `processing_mode=async` deja la cola con
  trabajos; restaurar al final.
- **module-07 Config IA:** `ai_model_settings` con `processing_mode=sync` si se quisiera demo en vivo;
  para este módulo basta la fila del tenant con `provider`+`model` y la key para que las tabs carguen
  (`text=Mostrando` aparece solo con prompts cargados).
- **module-09 Certificados:** al menos un certificado emitido en el tenant (para `row:0`/`rowaction:0`)
  y que el código de `/verify/<code>` exista (hoy el spec trae uno fijo — actualizarlo).
- **module-17 Asistente IA:** no requiere datos (estado vacío + FAQ). Si se graba beat en vivo, el edge
  del asistente debe estar desplegado y respondiendo.
- **module-02 Usuarios / module-10 Estadísticas / module-05 Contenidos:** necesitan datos que el tenant
  demo ya trae (3 cursos + 8 usuarios); verificar que haya ≥1 fila para `row:0` y `statrow`.

## Riesgos abiertos

1. **module-09** código `/verify/2VRRLPYDB24Z` fijo — confirmar que exista en el tenant demo.
2. **module-07** `field:API key`: el label real es dinámico («API key de Google Gemini / OpenAI»); el
   resolver `field:` hace match por «contiene» → OK, pero validar el frame al grabar.
3. **module-16** `.divide-y > div:first-child` y `button[title=...]` dependen de que la cola tenga filas
   (ver seed). Sin seed, sale vacía.
4. **module-17** si se agrega la consulta en vivo, la respuesta de IA puede tardar/colgar `waitText`.
5. **selectOption** sigue siendo el punto frágil general (AJUSTES §5) — ningún spec admin nuevo depende
   de un `selectOption` crítico.

## Módulos creados

- **module-17.json** — «Asistente IA» (`/app/assistant`). No se renumeró ningún archivo; los outros ya
  no encadenan al «siguiente módulo» (AJUSTES §10), así que no hubo que editar el outro de module-16.
