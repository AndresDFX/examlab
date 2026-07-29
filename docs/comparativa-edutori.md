# ExamLab vs EDUTORI — comparativa funcional

**Documento interno de decisión.** No es material de venta.
Fecha: 2026-07-29 · Rama: `main` · Commit base: `64ef9b4e`

**Método.** Cada afirmación sobre ExamLab está verificada contra código, migración o edge function, con
`archivo:línea` o nombre de tabla/migración. `CLAUDE.md` **no** se usó como fuente: es documentación
escrita a mano y en varios puntos sobrevende (se señalan abajo, sección 6). Del lado de EDUTORI solo
tenemos su documento de alcance funcional — es decir, comparamos **código verificado contra promesa
comercial no verificable**. Esa asimetría es la limitación central del informe y está desarrollada en la
sección 6.

Datos de contexto verificados: 527 migraciones (`supabase/migrations/*.sql`), 40 edge functions
(`supabase/functions/`, excluyendo `_shared`), 133 tablas creadas en migraciones, 8 850 claves de i18n
con paridad exacta es/en. Nota: `src/integrations/supabase/types.ts` está **desactualizado** — declara 95
tablas y le faltan `kahoot_*`, `whiteboards`, `support_tickets`, `question_bank`,
`session_code_snippets`; la autoridad de esquema son las migraciones. Nota 2: el stack real es **React
19** (`package.json:82`), no React 18 como dice `CLAUDE.md`.

---

## 1. Veredicto en tres líneas

ExamLab gana de forma decisiva en **evaluación de desempeño técnico y en integridad académica**: ejecuta
código en 14 lenguajes con 4 proveedores conmutables, captura GUIs Java/Python por screenshot, corre un
laboratorio de redes tipo Cisco IOS con calificación determinista y una consola Linux real en WASM,
detecta copia entre pares con IA, hace proctoring por señales de navegador y emite certificados
verificables públicamente por QR con hash inmutable.

EDUTORI gana en **experiencia de aprendizaje y en interoperabilidad institucional**: SCORM 1.2,
lecciones HTML5, rutas de estudio con prerrequisitos, progreso por asignatura, aprendizaje adaptativo,
búsqueda semántica, gamificación completa (puntos/insignias/niveles/rachas/misiones), alerta temprana de
deserción, mapa de competencias, sincronización con SIS y SAML 2.0 — de todo eso ExamLab tiene **cero**
código, no versiones parciales.

Traducción comercial: ExamLab es superior para una **facultad de ingeniería/tecnología** que evalúa
programación, redes y sistemas operativos, y para cualquier institución que priorice integridad
académica y operación multi-institución; EDUTORI es superior para una **universidad grande y
heterogénea** que licita por interoperabilidad (SIS/SCORM/SAML), retención de estudiantes y
acreditación por resultados de aprendizaje.

---

## 2. Tabla módulo por módulo

Leyenda: **SÍ** existe completo · **PARCIAL** existe algo, no lo prometido · **NO** no existe ·
**MEJOR** existe y supera lo descrito por EDUTORI.

| Módulo | Qué promete EDUTORI | ExamLab | Nota corta |
|---|---|---|---|
| **A** Portal del Estudiante | Panel con asignaturas del periodo, avance, próximas entregas y logros | **PARCIAL** | El panel no lista asignaturas, no hay % de avance en ninguna vista y no hay logros. Las entregas pendientes son contadores; solo exámenes tienen lista (`app.index.tsx:1589-1683`) |
| A | Asignaturas por periodo y sección + estructura de contenidos | **PARCIAL** | Tablero cronológico por sesión real y completo (`app.student.courses.tsx:422+`), pero **no hay árbol módulo→unidad**, no hay filtro por periodo (solo orden/búsqueda) y `grupo` no se le muestra al alumno (ausente del select, `:221`) |
| A | Reproductor unificado: video, HTML5, lecturas, cuestionarios, simuladores IA | **NO** (como unificado) | Son N diálogos por extensión (`MediaViewerDialog`, `CodeFileRunnerDialog`, `NotebookRunnerDialog`). Cero SCORM/xAPI/H5P/LTI en todo el repo (grep confirmado). Cuestionarios son rutas aparte |
| A | "Mi aprendizaje": continuidad y progreso por asignatura y ruta | **NO** | Sin tabla de rutas ni de progreso. `video_views` (mig 20260603100000) es marcador binario "visto", sin posición ni % |
| A | Perfil: historial académico, notas, certificados, insignias | **PARCIAL** | Notas fuertes (`app.student.grades.tsx`, 994 líneas). Certificados **MEJOR**. Pero **no existe pantalla de perfil** (`app.preferences.tsx` son 426 líneas de notificaciones), no hay historial consolidado multi-curso ni insignias |
| A | Notificaciones y calendario personal | **MEJOR** | 3 canales (in-app + email + Web Push VAPID) con preferencia por `kind`, + feed `.ics` con token privado rotable (`student_calendar_tokens`, edge `student-calendar-ics`) |
| A | Navegador + app móvil instalable con modo sin conexión | **PARCIAL** | PWA instalable sí (`public/manifest.json`, `IosInstallBanner.tsx`). **No hay app nativa** (sin Capacitor/RN) y **no hay offline real**: `public/sw.js:110` salta todo tráfico Supabase y `:122` declara "Navegación: SIEMPRE red. Sin cache". Offline solo dentro del examen en curso (`src/modules/exams/offline-sync.ts`) |
| **B** Estructura Académica | Periodos / semestres | **SÍ** | `academic_periods` (mig 20260613000000) con estados planificado/activo/cerrado + auditoría de cierre; `AdminAcademicPeriodsPanel.tsx` |
| B | Facultades y programas | **PARCIAL** | Programas sí (mig 20260611000000). **Facultad es TEXT libre** en `academic_programs.faculty` — sin entidad, sin jerarquía, sin decano, sin rollup. Dos programas pueden escribir "Fac. de Ing." y "Facultad de Ingeniería" sin reconciliar |
| B | Asignaturas y secciones con docente, cupo y horario | **PARCIAL** | Asignatura con sílabo completo (mig 20260617000000) y docentes múltiples (`course_teachers`) sí. Sección = el curso + `courses.grupo` TEXT libre. **Cupo NO existe**: sin columna de capacidad y la matrícula no valida nada (`app.admin.courses.tsx:1376-1420`). Horario **MEJOR** (`course_schedules` + festivos colombianos) |
| B | Matrícula individual, masiva y **sincronizada con SIS** | **PARCIAL** | Individual y CSV masivo sí (edge `bulk-import-users`, matricula incluso si el usuario ya existía, `:255-306`). **SIS: NO** — cero conectores, cero webhooks, y el SSO por política **nunca crea cuentas** (`auth-sso-verify`) |
| B | Manejo de cohortes | **PARCIAL** | `profiles.cohorte` es TEXT libre (mig 20260612000000:24). Se usa como dimensión real (RPC `get_course_cohort_weights`, migs 20260973/20260974) pero **no es entidad gestionable y no se puede asignar una actividad a una cohorte** — la asignación es por estudiante |
| B | Nomenclatura, escalas y módulos activos por institución | mixto | Módulos **MEJOR** (`module_visibility` módulo×rol + orden drag&drop, enforzado en ruta por `ModuleRouteGuard`). Escalas **SÍ** (`courses.grade_scale_min/max` + defaults de tenant). **Nomenclatura NO** — labels estáticos de i18n, no renombrables por institución |
| **C** Contenido y Autoría | Constructor en módulos y lecciones | **PARCIAL** | El modelo es Curso→Corte→**Sesión fechada**→material (mig 20260509220000). El troceo por lección es una convención de nombre de archivo (`_CLASE_<N>`). No hay agrupador libre independiente del calendario |
| C | Video, lecturas, documentos | **SÍ** | Biblioteca de videos (mig 20260603100000) + visores de pdf/pptx/docx/md/imágenes |
| C | Cuestionarios como contenido | **SÍ** | Enlazables a la clase y al contenido origen (mig 20260510150000:29-31) |
| C | **Lecciones interactivas HTML5** | **NO** | `.html`/`.h5p` no están en `ACCEPTED_EXTENSIONS` (`UploadExternalContentDialog.tsx:97-121`) |
| C | **Paquetes SCORM 1.2** | **NO** | Cero coincidencias de `scorm`/`imsmanifest` en todo el repo. Sin tabla, sin player, sin tracking `cmi.*` |
| C | **Simuladores conversacionales** | **NO** | El Tutor IA es asistente de estudio, sin persona/escenario/evaluación de la conversación |
| C | Autoría asistida por IA con revisión docente | **MEJOR** | 4 edges de autoría; borradores nacen sin publicar (`generated_contents.is_published DEFAULT FALSE`, mig 20260603040000:146); + cola async con auto-retry, failover de keys, prompts overrideables por curso |
| C | Secuenciación y prerrequisitos con liberación condicional | **PARCIAL (débil)** | Solo dos gates: liberación por **fecha** (mig 20261160000000, con 0 uso en prod según su propio comentario) y videos obligatorios en orden antes de entregar (`IntroVideoGate.tsx:53-58`). Grep de `prerequisit|unlock_after|requires_completion`: **cero** |
| C | Banco de recursos y preguntas reutilizable | **MEJOR** | `question_bank` (mig 20260518100000) reutilizable en 4 destinos (examen/taller/proyecto/Reto), compartible org-wide (mig 20260928000000:20), generable con IA e importable por CSV |
| **D** Evaluación | Tareas con entrega de archivo, texto o enlace | **PARCIAL** | Texto y enlace sí (`workshop_submissions.external_link`, `project_submissions.repository_url`). Archivo **solo ZIP y código fuente** (`WorkshopQuestions.tsx:3043,3112-3130`) — **no se puede entregar un PDF o un DOCX** |
| D | Fechas límite y **entregas tardías** | **PARCIAL** | Deadline sí, duro y binario (`app.student.workshops.tsx:600,739`). **Tardías: NO existen** — grep de `allow_late|late_submission|late_penalty|grace_period` da **cero**. Sin marca, sin penalización, sin gracia; el docente debe mover el `due_date` |
| D | Rúbricas y retroalimentación por entrega | **PARCIAL / MEJOR** | Rúbrica es `expected_rubric TEXT` libre — **no hay matriz criterios×niveles×puntos**. Retro **MEJOR**: hilo bidireccional con adjuntos (`feedback_comments`, mig 20260503210000) + feedback por pregunta con override docente |
| D | Cuestionarios: banco + **6 tipos** (múltiple, V/F, emparejar, corta, numérica, ensayo) | **PARCIAL en el set exigido / MEJOR en total** | Múltiple y ensayo sí; V/F y corta se emulan (`cerrada` de 2 opciones; `abierta` calificada por IA, no autocorrección determinista). **Emparejar y numérica: NO** (grep cero). En cambio hay 11 tipos incl. código, GUI, ZIP, diagrama, redes y consola (CHECK en mig 20261280000000:26-62) |
| D | Aleatorización, intentos, tiempo límite | **SÍ (con matices)** | Shuffle sembrado por (examen, alumno) — estable por alumno (`src/modules/exams/shuffle.ts`), pero **mezcla preguntas, no opciones**, y no hay "extraer N de un pool". Intentos **MEJOR**: `retry_mode ∈ {last, average, highest}` (mig 20260501025625) |
| D | Libro de calificaciones: categorías ponderadas | **MEJOR con un matiz** | Dos niveles (corte→ítem) + asistencia como componente calificable derivado por fechas. Matiz honesto: los buckets por tipo son hoy **techo de validación y agrupador visual**, no divisor del cálculo — `src/modules/grading/grade.ts:78-79`: *"LEGACY: cut.exam_weight / workshop_weight / project_weight ya no se usan"* |
| D | Escala configurable | **PARCIAL** | Cualquier rango numérico por curso y default por tenant. **Por letras: NO** (grep `letter_grade` cero) |
| D | Publicación de notas | **PARCIAL, otro modelo** | No hay switch publicar/ocultar: la nota es visible al escribirse. En su lugar: **actas inmutables** (`course_actas`, migs 20260615000000 + 20260619000000) y certificados verificables — **MEJOR** en ese eje, distinto en el pedido |
| **E** IA | Tutor IA 24/7 sobre el material | **SÍ**, extracción **MEJOR** | `tutor-chat` es síncrono siempre (`:293-300`). Extrae texto real de md/txt/código/`.ipynb` y **descomprime `.docx`/`.pptx`/`.xlsx`** + `.pdf`, con notas del orador, y cachea el resultado en `files[].body` (`:180-260`). Filtra material solo-docente (`:98-104`) |
| E | **Cita la fuente dentro del contenido** | **PARCIAL** | Es prosa inducida por prompt (`tutor-chat/index.ts:63`), no dato estructurado: el edge devuelve solo `{ok, response, messageId}` (`:590-596`), sin array de fuentes, sin enlace al pasaje, sin verificación de que el título citado exista. Y trunca a 30 contenidos / 22 000 chars sin avisar |
| E | Aprendizaje adaptativo (refuerzo + ajuste de ruta) | **NO** | Cero tablas de ruta, dificultad o refuerzo. Ningún consumidor del desempeño histórico altera lo que el alumno ve después |
| E | Recomendador de contenidos | **NO** | Nada. `video_views` es señal cruda sin consumidor |
| E | Búsqueda semántica | **NO** | Cero `pgvector`/`vector(`, cero `tsvector`. El tutor apila los 30 contenidos más recientes por `updated_at` (`:478-485`) — no es recuperación |
| E | Simuladores conversacionales (blandas/clínico/negociación) | **NO** | Existen simuladores técnicos **no conversacionales** (redes, Linux, GUI) — no cubren el caso |
| E | Autoría asistida | **MEJOR** | 4 edges + colas con auto-retry + failover de keys + modo sync/async para controlar gasto |
| E | Analítica explicada en lenguaje natural | **PARCIAL** | `ai-generate-report` redacta prosa sobre contexto real del curso, one-shot hacia el editor de plantillas. **Asistente de datos conversacional: NO** — `platform-support-chat` recibe KB y videos, **ni una métrica** (`:313-360`) |
| **F** Gamificación | Puntos por logros | **NO** | Solo `kahoot_players.score` dentro de partida + `kahoot_course_leaderboard()` (mig 20260936000000). No hay puntos de plataforma ni concepto de logro |
| F | Insignias Open Badges por competencia | **NO** | Cero tablas de badge/competencia (grep `CREATE TABLE` confirmado). Lo que hay son certificados propietarios por nota final |
| F | Niveles | **NO** | — |
| F | Rachas de constancia | **NO** | — |
| F | Misiones/retos individuales y por equipo o facultad | **NO** | "Reto en vivo" es quiz sincrónico con host, no misión persistente; nada agregado por equipo ni facultad |
| F | Tablas de posición configurables por privacidad | **PARCIAL** | Leaderboards existen; **configuración de privacidad no** — sin opt-out, sin anonimización, comportamiento hardcodeado |
| F | Recompensas canjeables | **NO** | — |
| **G** Comunicación | Anuncios por asignatura | **SÍ** | Edge `broadcast-course-message`: multi-curso, dedup por usuario, notif + correo BCC + réplica al inbox; docente debe dictar **todos** los cursos (403 sin difusión parcial) |
| G | Anuncios **institucionales** | **PARCIAL** | No hay canal fuera del curso: los destinatarios se resuelven por `course_enrollments`. **No se puede anunciar a docentes ni a personal administrativo** |
| G | Foros por asignatura | **SÍ** | `forums`/`forum_threads`/`forum_replies`/`forum_upvotes`, ventana de apertura enforzada por RLS (`is_forum_open()`) |
| G | Mensajería interna | **MEJOR** | Borrado asimétrico por usuario con resurrección, editar/borrar propios, adjuntos, búsqueda, **mensajes programados** con re-validación de autorización en el dispatch (mig 20260709000000), etiquetado `#` de contenido |
| G | Notif. in-app + correo (tarea, nota, anuncio, **vencimiento**) | **SÍ** | Triggers de publicación (mig 20260603050000:70,132) + recordatorios de vencimiento con anti-duplicado (mig 20260523000007:34,93) |
| G | Calendario académico | **PARCIAL** | Calendario del estudiante y del docente **MEJOR** (unificado + `.ics` + sync a Google Calendar y Microsoft Graph con Meet). **Falta el institucional**: `academic_periods` solo tiene start/end; `platform_holidays` es de facturación, no académico |
| **H** Certificación | Certificados PDF con identidad visual | **SÍ** | `certificate-pdf.ts` + `certificate_settings` en 3 niveles (global/tenant/curso) |
| H | Verificación pública por código único | **MEJOR** | Ruta `/verify/$shortCode` sin autenticación, confirmada a nivel DB: mig 20260518140000:367-369 `REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO anon`. Además **QR en el PDF**, `payload_hash` SHA-256 y estado de revocación |
| H | Historial académico | **PARCIAL** | Notas por curso (uno a la vez) + actas por curso con `integrity_hash`. **No hay transcript multi-curso ni promedio acumulado** (grep `GPA|acumulado|transcript`: cero) |
| H | **Insignias y credenciales por competencias** | **NO** | Cero |
| **I** Analítica | Tableros docente y coordinación | **SÍ** | `app.teacher.statistics.tsx` (712 líneas) + `app.admin.statistics.tsx` con filtros por programa, periodo e institución (`:443-470`) |
| I | **Alerta temprana de deserción con semáforo** | **NO** | Sin tabla de riesgo, sin score, sin umbral, sin semáforo, sin `kind` de notificación de riesgo. La materia prima existe (`computeFailedStudents`, `computeNoPresentedStudents`) pero es descriptiva y no dispara nada |
| I | **Mapa de competencias / resultados de aprendizaje** | **NO** | Sin entidad de competencia. Lo más cercano son `academic_subjects.objetivos` (TEXT) y `expected_rubric` (TEXT) — no trazables ni derivables |
| I | Reportes exportables | **MEJOR** | Motor de plantillas propio con `{{vars}}` y `{{#if}}`, import/export **DOCX**, actas inmutables, CSV del gradebook, PDF con QR |
| I | Asistente de datos en lenguaje natural | **NO** | Ver E |
| **J** Administración | Panel académico (periodos, programas, asignaturas, secciones, matrículas, reportes) | **PARCIAL→MEJOR** | Todo sí y con sílabo + tab Overview por programa; **secciones no son entidad** (`courses.grupo` TEXT, mig 20260610000000) |
| J | Panel institucional: identidad visual, nomenclatura, escalas, módulos | **PARCIAL** | Branding **MEJOR** (recolorea tokens OKLCH en runtime, `TenantThemeProvider.tsx`); escalas sí; módulos **MEJOR**; **nomenclatura NO** |
| J | Usuarios: alta individual, **invitación**, carga masiva | **PARCIAL** | Alta y CSV sí. Invitación existe como mecanismo (welcome token 32 bytes, TTL 7 días, `bulk-import-users/index.ts:10-25`) pero **sin ciclo de vida**: no hay estado "pendiente", ni reenviar, ni ver expiración, ni auto-registro |
| J | Multi-institución aislada | **MEJOR** | 210 usos de `current_tenant_id()`; dos clases de vuln reales cerradas y verificadas empíricamente contra prod (migs 20260929, 20260945, 20261045-20261048); + override "Ver como institución", impersonación, cuotas, `hard_delete_tenant` |
| **K** Integraciones | **SSO SAML 2.0** | **NO** | Cero implementación (único hit: un comentario en `bulk-set-passwords/index.ts:140`) |
| K | SSO Google Workspace / Microsoft Entra | **SÍ** | `auth.index.tsx:240-269`, providers `google` y `azure`. Política **MEJOR**: `auth-sso-verify` nunca crea cuentas, borra el `auth.users` huérfano y audita el rechazo |
| K | **Sincronización con SIS** | **NO** | Cero conectores/webhooks/mapeo de IDs externos. Única vía masiva: CSV manual |
| K | **SCORM 1.2** | **NO** | Cero, en todo el repo. Ni importa ni exporta paquetes estándar |
| K | **API pública** | **NO** (en el sentido pedido) | Existe el PostgREST de Supabase gobernado por RLS (transporte del propio front) y 40 edges internas. Sin API keys de partner, sin versionado, sin docs, sin rate limit por cliente. Única superficie para terceros: los 2 feeds `.ics` con token |
| K | **Webhooks** | **NO** | Grep `webhook` en `src/` y `supabase/`: **cero** |
| **L** Seguridad | Aislamiento por institución | **MEJOR** | Ver J |
| L | Auditoría de acciones sensibles | **MEJOR** | ~150 acciones en `audit_logs`, cubriendo notas, usuarios y contenidos; **con triggers a nivel DB** para cambios de pesos (mig 20260517120000:104-135) que capturan hasta ediciones por REST directo; retención configurable por severidad. Matiz: la mayoría de eventos son app-level |
| L | Control por roles y permisos | **PARCIAL** | 4 roles fijos en enum. `rbac.ts:22-93` es prefijo-de-ruta→roles, hardcodeado. **No hay roles personalizados ni matriz de permisos por acción**. Lo configurable es `module_visibility` (coarse pero enforzado en ruta) |
| L | Respaldo de información | **PARCIAL** | `db_backups` + edge `db-backup-runner` + cron semanal. **La restauración no está en producto** — snapshots JSON que el admin aplica por SQL (`DbBackupsPanel.tsx:12-15`). Decisión consciente, pero media respuesta a "respaldo y recuperación" |
| L | Datos personales conforme a ley | **PARCIAL / débil** | Política de privacidad in-app y pública (164 líneas), pero **sin marco citado** (grep `Ley 1581|habeas data|GDPR`: 1 hit trivial) y sin flujo de derechos del titular. El borrado es admin-initiated, no ejercible por el titular |
| **M** Accesibilidad y movilidad | Responsive | **MEJOR** | Convenciones auditadas con target 375-428px: `dvh` en toda altura de modal (26 archivos migrados; `vh` en iOS Safari desbordaba ~80-100px), touch targets ≥32px, `env(safe-area-inset-*)`, tablas con scroll dentro del Card + PWA |
| M | Interfaz en varios idiomas | **PARCIAL** | **Exactamente 2** (`src/i18n/index.ts:20`), con paridad verificada 8 850/8 850 claves. Extra: idioma **por curso** (`courses.language`, mig 20260423000000) forzado durante la toma de examen. Un 3º idioma es mecánico, no arquitectónico |
| M | Accesibilidad formal | **PARCIAL** | 171 `aria-label`, `aria-live` en ~5 puntos, eslint `jsx-a11y` activo. Sin conformidad WCAG declarada, sin skip-to-content, sin `prefers-reduced-motion`; y el tema **ignora `prefers-color-scheme` por regla explícita** (claro forzado) |
| **Roles** | Estudiante / Docente | **SÍ** | — |
| Roles | **Asistente / Monitor** (califica preliminarmente, sin publicar definitivas) | **NO** | Triple bloqueo: (1) enum cerrado `app_role` (mig 20260419051958:2 + 20260621000000:35); (2) **`course_teachers` es tabla plana** sin columna de rol ni capacidad (mig 20260419090000:11-17) → todo docente del curso tiene poder idéntico; (3) **no existe nota preliminar vs definitiva**. Requiere enum + columna + estado de publicación + RLS + gates de UI |
| Roles | Coordinación académica | **PARCIAL** | El `Admin` es tenant-wide y cubre las funciones, pero **no hay tier intermedio**: coordinar Ingeniería obliga a dar Admin de toda la institución, incluyendo secrets, settings de IA y borrado de usuarios. Separación de deberes insuficiente |
| Roles | Administración institucional | **SÍ** (+ `SuperAdmin` cross-tenant, **MEJOR** para el operador) | — |

---

## 3. Lo que EDUTORI tiene y ExamLab NO

Ordenado por cuánto pesa en una venta a universidad. Distingo **integración** (bloquea la licitación
completa: es requisito de arquitectura de TI, no de pedagogía) de **feature** (se negocia en roadmap).

### Bloqueantes de licitación — integraciones

1. **Sincronización con SIS** — *integración, peso máximo.*
   Sin conector, sin webhook entrante, sin mapeo de identificadores externos, sin reconciliación de
   roster, sin des-matrícula automática. La única vía masiva es CSV manual (`bulk-import-users`).
   En una universidad con 20 000 estudiantes y matrícula que se mueve cada semana, "CSV manual" no es
   una respuesta aceptable. Un integrador **podría** scriptear la edge con una cuenta de servicio, pero
   eso es "hay API disponible", no "sincronizado con el SIS", y en un pliego se evalúa como incumplido.

2. **SCORM 1.2** — *integración, peso muy alto.*
   Cero código en todo el repo. Bloquea dos escenarios reales: (a) reutilizar contenido ya comprado o
   heredado de otro LMS — inversión hundida que la universidad no va a repetir; (b) migrar el contenido
   propio de ExamLab a otro sistema, lo que convierte a ExamLab en riesgo de lock-in a ojos de un
   comité de compras. También ausentes: xAPI, cmi5, LTI, H5P.

3. **SAML 2.0** — *integración, peso alto en universidad pública o grande.*
   Google y Microsoft OAuth están cubiertos y en la práctica resuelven la mayoría de casos. Pero una
   universidad con Shibboleth, ADFS o federación nacional (tipo RENATA/eduroam) pide SAML por nombre.
   Supabase lo soporta en planes Pro+; **no está cableado**.

4. **Webhooks y API pública de partner** — *integración, peso medio-alto.*
   Cero `webhook` en el repo. No hay API keys de integración, endpoints versionados, documentación ni
   rate limiting por cliente. Impide que la institución construya su propio tablero, su BI o su
   automatización — algo que casi toda universidad grande exige para no depender del proveedor.

### Bloqueantes de acreditación y retención — features estructurales

5. **Mapa de competencias / resultados de aprendizaje (outcomes)** — *peso muy alto donde hay
   acreditación.* Sin entidad de competencia no hay mapeo ítem→outcome ni rollup de logro, y por tanto
   no se puede alimentar un informe de acreditación (CNA en Colombia, ABET en ingeniería). Lo que
   existe — `academic_subjects.objetivos` y `expected_rubric`, ambos TEXT libre — **no es derivable ni
   con post-procesamiento** porque no hay identificador de competencia en ninguna punta.

6. **Alerta temprana de deserción con semáforo** — *peso muy alto.*
   La retención es KPI de rector, y en LatAm suele estar atada a financiación. ExamLab tiene la materia
   prima (`computeFailedStudents`, `computeNoPresentedStudents`, asistencia, entregas faltantes) pero no
   la clasificación, ni el umbral, ni el semáforo, ni la notificación al tutor. Es la brecha con **mejor
   relación esfuerzo/valor** de toda la lista (ver sección 7).

7. **Progreso y continuidad por asignatura ("Mi aprendizaje")** — *peso alto.*
   Ni % de avance, ni "continuar donde ibas", ni tracking de posición en video. `video_views` es un
   booleano. Es lo primero que un estudiante compara entre dos plataformas y lo primero que un
   evaluador prueba en una demo.

8. **Rutas de estudio con prerrequisitos y liberación condicional** — *peso alto.*
   Sin `prerequisite_id`, sin criterios de completitud, sin rutas obligatorias. Lo que hay: gate por
   fecha (con 0 uso en producción según el comentario de su propia migración 20261160000000) y videos
   obligatorios antes de entregar. Bloquea autoestudio, nivelatorios y cursos no cronológicos.

9. **Gamificación completa** — *peso medio, alto si el prospecto la puso en el pliego.*
   Puntos, insignias Open Badges, niveles, rachas, misiones individuales/por equipo/por facultad y
   recompensas: **cero tablas**. Tener un juego (Reto en vivo) con score no es tener un sistema de
   gamificación, y conviene no confundirlos en la conversación comercial porque se detecta al
   preguntar "¿y cómo acumula el estudiante entre cursos?".

10. **Rol Asistente/Monitor** — *peso medio-alto en universidades con monitorías, muy alto costo de
    implementación.* Es la brecha más caras de las "pequeñas": enum cerrado + `course_teachers` plano +
    ausencia total del concepto nota preliminar/definitiva. No es configuración, es desarrollo.

11. **Coordinación con alcance sub-institucional** — *peso medio-alto.*
    No hay tier entre Docente y Admin-de-todo. Un decano necesita ver su facultad, no los secrets de
    IA de la institución. Es un problema de separación de deberes que un auditor sí marca.

### Features negociables

12. **Simuladores conversacionales** (habilidades blandas, casos clínicos, negociación) — cero.
    Decisivo si el prospecto es Medicina, Psicología, Derecho o escuela de negocios; irrelevante en
    ingeniería.
13. **Insignias/credenciales digitales por competencias** — cero (distinto de certificados, que sí y bien).
14. **Aprendizaje adaptativo** — cero.
15. **Búsqueda semántica y recomendador** — cero embeddings, cero full-text search. Ojo: esto además
    limita al propio Tutor IA, que apila material por recencia y trunca sin avisar.
16. **Reproductor unificado y lecciones HTML5** — son N visores por extensión.
17. **Tipos de pregunta emparejar y numérica** — cero. Y "respuesta corta" no es autocorregible de
    forma determinista: la califica la IA.
18. **Entregas tardías como concepto** — cero (`allow_late|late_penalty|grace_period`: sin hits).
    Deadline duro y binario; el docente solo puede mover la fecha, y la entrega queda indistinguible
    de una a tiempo. Es una queja operativa que aparece la primera semana de uso.
19. **Escala por letras** — cero.
20. **Nomenclatura configurable** — cero. Una institución que dice "asignatura" y "parcial" no puede
    renombrar "curso" y "corte".
21. **Rúbrica estructurada** (matriz criterios×niveles×puntos) — es TEXT libre. Funciona para el
    grader IA, pero el estudiante no ve rúbrica tabulada y no hay puntaje por criterio.
22. **Historial académico consolidado / transcript / promedio acumulado** — cero.
23. **Modo sin conexión real** — la PWA no cachea ni HTML ni datos (`sw.js:110,122`). Solo el examen
    en curso sobrevive. Presentarlo como "modo sin conexión" es sobreventa verificable.
24. **Cupo por sección** — no existe columna ni validación; la matrícula inserta sin límite.
25. **Anuncio institucional** y **calendario académico institucional** — todo cuelga de matrícula en
    curso; no hay canal para docentes ni personal, ni fechas oficiales del periodo.
26. **Secciones, facultades y cohortes como entidades** — son TEXT libre (`courses.grupo`,
    `academic_programs.faculty`, `profiles.cohorte`). Funciona para operar; no para agregar, validar
    ni reportar por esa dimensión.
27. **App móvil nativa** — es PWA (sin Capacitor/RN). Defendible, pero si el pliego dice "app en las
    tiendas", no se cumple.
28. **Más de 2 idiomas** — es mecánico de agregar, no arquitectónico. Bajo peso salvo pliego explícito.

---

## 4. Lo que ExamLab tiene y EDUTORI NO

Separado por si es **diferencial real** (universal, defendible ante cualquier facultad) o **de nicho**
(espectacular en STEM, irrelevante o contraproducente afuera).

### Diferenciales universales

1. **Integridad académica nativa.**
   - Detección de copia **entre pares de la clase** — edge `detect-plagiarism` (590 líneas), tabla
     `similarity_pairs` (mig 20260505100000), idempotente para re-ejecutar al llegar entregas nuevas.
     El prompt está calibrado: exige marcadores no triviales (mismos typos, mismos comentarios palabra
     por palabra) y **excluye explícitamente** boilerplate, `i`/`j`/`temp` y starter code. A diferencia
     de Turnitin compara contra la clase, que es el caso real de copia en programación.
     *Límites declarados en el propio código:* tope de 30 respuestas por llamada y 3 000 chars por
     respuesta; para `codigo_zip` solo compara metadata textual, no el contenido de los ZIPs.
   - Sospecha de generación por IA por entrega (`submissions.ai_detected_score`, umbral 0.6 →
     `sospechoso`), con `FraudPanel.tsx` reutilizable por `kind`+`refId`.
   - **Proctoring por señales de navegador** — `app.student.take.$examId.tsx`: `blur`,
     `visibilitychange` (`:1810`, existe porque Cmd+Tab no dispara `blur`), `fullscreenchange`,
     copy/paste/cut diferenciados, intento de pantallazo como señal blanda, Esc bloqueado en captura,
     debounce de 500 ms anti-doble-strike, `max_warnings` configurable 1-50.
   - **Session lock sin migración** por `answers.__session_id` + heartbeat en `updated_at` (`:674-822`)
     → no se toma el mismo examen en dos dispositivos.
   - **Monitor docente en vivo** con Realtime y **control remoto por alumno**: pausar / reanudar /
     agregar tiempo (`exam_controls`, mig 20260419060000).

2. **Asistencia presencial con QR rotativo TOTP.** `sha256(seed + ":" + period)` → 6 dígitos que rotan;
   implementado dos veces y obligado a coincidir bit a bit (`src/modules/attendance/attendance-code.ts:35`
   y `compute_attendance_code` en mig 20260507100000). La seed **nunca llega al alumno** (RLS
   Docente/Admin en `attendance_check_in_state`). Proyector fullscreen con contador realtime, escáner
   con fallback manual, deep-link para cámara nativa, ruta pública `/asistencia` con edge
   (mig 20261430000000) y cierre automático por cron. En Colombia y LatAm la asistencia es requisito
   normativo y de retención de becas: un LXP sin esto obliga a mantener un sistema paralelo, y un QR
   estático no es defendible ante auditoría.

3. **Proyectos con sustentación como factor multiplicativo.** `nota final = submission_grade ×
   defense_factor`, sin sustentación `final_grade = NULL` (mig 20260507170000, con backfill a
   `defense_factor=1` para no romper histórico). Link al repositorio obligatorio. Import masivo de
   sustentaciones por CSV (`BulkImportDefensesDialog.tsx`). Modelarlo como factor —no como una nota más
   que se promedia— es exactamente lo que dicen los reglamentos: la defensa puede anular el trabajo.
   *Límite declarado:* la verificación de fechas de commit contra la entrega es manual del docente.

4. **Reto en vivo (quiz-show sincrónico).** 27 migraciones. Máquina de estados completa
   `lobby→question→reveal→leaderboard→podium→ended`, scoring por velocidad **server-authoritative**
   (`points * (1 - (t/limite)/2)`, la fórmula del cliente es solo preview), reloj anclado al servidor
   (`kahoot_server_now`, mig 20261520000000 — existe porque un dispositivo con reloj adelantado rompía
   la partida), y **unirse sin login por PIN/QR** con validación de matrícula (RPC `kahoot_join_public`).
   Universal: funciona igual en Derecho que en Cálculo, y el join sin login es la diferencia entre
   "funciona en clase" y "perdimos 10 minutos con contraseñas".

5. **Actividades externas** (`is_external` en exámenes/talleres/proyectos + `ExternalGradesEditor.tsx`):
   registrar notas de parciales presenciales o de otra herramienta sin fingir que pasaron por la
   plataforma. Es la palanca de **adopción gradual** — permite que la institución empiece sin migrar todo.

6. **Multi-institución white-label con RLS auditada empíricamente.** No es aislamiento nominal: 210
   usos de `current_tenant_id()`, y dos clases de vulnerabilidad **encontradas con datos reales y
   cerradas** — `USING (true)` en tablas hijas (mig 20260929000000) y `has_role()` sin scope de tenant
   (leak confirmado en `ai_override_activations`, migs 20260945 + 20261045-20261048), verificadas con
   `SET LOCAL ROLE authenticated` + jwt claims contra producción. Esto responde un due-diligence de
   seguridad con evidencia, no con promesas. Más: branding que recolorea todo el design system en
   runtime (`TenantThemeProvider.tsx`), override "Ver como institución", `hard_delete_tenant` con
   limpieza ordenada de FKs RESTRICT.

7. **Impersonación con tres niveles de scope** (edge `admin-impersonate`): SuperAdmin→cualquiera;
   Admin→su tenant y no-Admin; **Docente→solo estudiantes matriculados en SUS cursos**. Vía magic-link
   `hashed_token`, auditada con severidad warning. Resuelve "al alumno no le carga" sin pedirle
   credenciales.

8. **Papelera transversal con regla universal auditada.** 8 entidades soft-delete con purga a 30 días
   por cron (mig 20260816000000), y la invariante de que un ítem en papelera desaparece de **todos** los
   flujos y roles: calendarios, dashboards, gradebook, feed ICS y hasta el RPC de join a Reto en vivo.
   Está documentada con la lista de flujos derivados que se arreglaron uno por uno.

9. **Duplicación parametrizable en 12+ entidades** (`DuplicateAssessmentDialog.tsx` + RPCs
   `clone_exam`/`clone_workshop`/`clone_project` con flags `_copy_questions`/`_copy_proctoring`/
   `_copy_groups`/`_copy_files`, mig 20260918000000; + `DuplicateOptionsDialog.tsx` para encuestas,
   Reto, pizarras, contenidos, sesiones, cursos, banco, estructura académica e instituciones). Ahorro
   de tiempo docente entre semestres — el argumento de adopción más fuerte que existe.

10. **Operación de IA como producto, no como demo.** Colas `ai_grading_queue` y `ai_generation_queue`
    con `isTransientError` (429/5xx/timeout/quota reintenta hasta 3; los 400 van a failed sin gastar
    crédito), panel con `last_error` copiable, modo sync/async decidido por Admin **para controlar el
    gasto**, y failover de API keys principal→respaldo→env (`_shared/ai-failover.ts`, puro y testeado,
    mig 20261010000000): rota ante 401/402/403/429/5xx y respeta `Retry-After` en la última. La IA no
    se cae porque una key agotó cuota a mitad de un examen.

11. **Módulo Soporte/PQRS** (mig 20260904000000) con chat realtime, adjuntos por signed URL de 60 s,
    auto-asignación y notificaciones por trigger. PQRS es figura legal en Colombia.

12. **Verificación pública de certificados por QR** — ver sección 5.

13. **Panel de pg_cron, backups desde UI, audit log con triggers DB, monitor de errores de front con
    filtro de ruido.** No se le vende al usuario final, pero decide due-diligences.

14. **Pizarras multi-hoja colaborativas en tiempo real** (`WhiteboardEditor.tsx` sobre Excalidraw con
    broadcast `scene_update` debounced 200 ms; `attendance_sessions.whiteboard_shared` +
    `update_session_whiteboard_scene` SECURITY DEFINER, mig 20260815000000, para que los alumnos editen
    la misma pizarra). Cuatro tipos de hoja: `drawing`, `text`, `code` (Monaco + compilador) y `console`
    (VM Linux). *Límite declarado:* last-write-wins, sin OT/CRDT; dos personas dibujando a la vez pueden
    hacer ping-pong ~1,5 s.

15. **Detalles locales que un producto genérico no trae:** festivos colombianos ley 51/1983 al generar
    sesiones (`src/modules/schedules/co-holidays.ts`, con tests), actas con plantillas DOCX del formato
    oficial, escala 0-5 nativa, es-CO forzado en `Intl` para que la app no cambie según el SO.

### De nicho — espectacular en STEM, irrelevante afuera

16. **Ejecución de código con 4 proveedores conmutables.** `execute-code/index.ts` (974 líneas):
    `aws_lambda` (VM propia), `onlinecompiler`, `jdoodle` y `cheerp` (client-side).
    `language-support.ts` mapea **14 lenguajes** × proveedor con sus `language_id`, y
    `resolveProviderFor()` **rutea al proveedor que sí soporta el lenguaje** en vez de fallar.
    Soporte multi-archivo (`combine-files.ts`: para Java pone primero la clase con `main` y degrada
    `public class` en las secundarias). **El alumno puede cambiar de compilador durante el examen**
    (`CodeRunnerPicker.tsx`, auditado con `provider_overridden`) — existe porque un proveedor caído a
    mitad de examen es un incidente académico.
    *Matiz honesto:* la UI expone 4 lenguajes (`UI_EXECUTABLE_LANGUAGES`), no los 14. Es decisión de
    producto, no límite técnico.

17. **11 tipos de pregunta** (CHECK en mig 20261280000000:26-62) vs los 6 de EDUTORI, con
    `java_gui`/`python_gui` que **devuelven un screenshot renderizado** de la app Swing/tkinter del
    alumno (`aws/code-runner/app.py` con Xvfb + Pillow, `GuiBootstrap.java` para que Swing alcance a
    pintar sin pedirle un `Thread.sleep`), `codigo_zip` que descomprime el repo y lo manda al modelo
    filtrado por whitelist, y `diagrama` (Mermaid con editor y plantillas, calificado por IA con
    directiva propia).

18. **Laboratorio de redes tipo Packet Tracer con calificación determinista** — y esto es el hallazgo
    más subestimado del inventario. `src/modules/network/ios-interpreter.ts` (334 líneas) interpreta un
    subconjunto de Cisco IOS con modos user/priv/config/if; `topology.ts` simula conectividad por BFS;
    y `grading.ts` evalúa **aserciones tipadas con puntos** (`hostname`, `interface_ip`, `interface_up`,
    conectividad). Crítico: **se re-califica en el servidor con el mismo motor puro, sin IA**
    (`ai-grade-submission/index.ts:2612-2640` sobre `_shared/network/grading.ts`), con feedback
    `✓/✗ etiqueta — detalle` por aserción. Un lab de redes se califica hoy mirando capturas una por una.

19. **Consola Linux real (x86→WASM)** — `V86Console.tsx` (1 028 líneas) bootea v86 con BIOS e imagen
    self-hosteados en Storage propio (se migró desde jsDelivr `@master` porque servía el BIOS con
    `content-range` inconsistente y v86 lo descarga por rangos). Efímera y aislada por diseño: corre en
    el navegador, sin backend de ejecución, `rm -rf` no toca infra real. Tiene tres defensas encadenadas
    para garantizar que **el transcript calificable nunca contenga un comando que el alumno no escribió**.
    Aparece también como tipo de hoja de pizarra para demostrar Linux en vivo.
    *Caveats obligatorios:* `so_consola` **solo existe en talleres, no en exámenes** (verificado: los
    únicos usos en `src/` son `WorkshopQuestions.tsx:98,1677,2300,3011`); su calificación **no es
    determinista** — el transcript va al prompt de IA como `executionOutput`; y la imagen por defecto es
    buildroot/busybox (~10 MB), donde `apt`/`systemctl`/`useradd` probablemente no existan.
    Además, el **motor determinista de aserciones para consola de servidor está huérfano**:
    `src/modules/serverconsole/shell.ts` (939 líneas), `system.ts`, `grading.ts` (14 clases de aserción)
    y `scenario.ts` (6 escenarios) solo los importa su propio test. Redes sí está cableado de punta a
    punta; consola de servidor no.

20. **Material subido = ejecutable.** Sube un `.java`/`.py`/`.js`/`.ipynb` y el alumno lo corre desde el
    tablero (`CodeFileRunnerDialog.tsx`, `NotebookRunnerDialog.tsx`). Los notebooks se limpian de
    outputs al subir; "Ejecutar todo" concatena las celdas de código en un script — **stateless, sin
    kernel entre celdas y sin figuras**, declarado en la propia UI.

21. **Snippets de código por sesión de clase** (mig 20260814000000): el docente prepara código con
    Monaco + Run en clase y queda cacheado con su salida para que el alumno lo revise después.

22. **Evaluador IA de duración de examen** (edge `evaluate-exam-time`): le dice al docente si los 60
    minutos que puso son razonables para sus preguntas. Pequeño; nadie más lo tiene.

---

## 5. Donde ExamLab es MEJOR en lo mismo

Casos donde ambos declaran la capacidad y ExamLab va más profundo, con el respaldo verificado.

**Certificación → verificación pública.** EDUTORI ofrece "certificados con verificación pública por
código único". ExamLab lo tiene **más el mecanismo anti-fraude**: `payload_hash` SHA-256 como snapshot
inmutable, estado de revocación visible (`is_revoked`, `revoked_at`, `revoke_reason`), QR embebido en el
PDF que apunta a la URL de verificación (`certificate-pdf.ts:234-258`), y acceso realmente anónimo
confirmado a nivel DB: `mig 20260518140000:367-369` hace `REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO
anon`. Los certificados **sobreviven al purgado del curso** (mig 20261240000000), y la página va
`noindex,nofollow`. Un empleador verifica sin cuenta y ve si fue revocado — eso es lo que hace útil la
verificación.

**Notificaciones → tres canales con preferencia granular.** EDUTORI describe in-app + correo para 4
eventos. ExamLab cubre esos 4 (publicación de tarea, mig 20260603050000:70,132; nota; anuncio;
vencimiento con anti-duplicado de 6 h y lead time parametrizable, mig 20260523000007:34,93) y agrega
**Web Push VAPID** con Service Worker, **preferencias por `kind` y por canal** (`app.preferences.tsx`) y
**mensajes programados** con pg_cron que **re-valida la autorización en el dispatch** en vez de confiar
en lo agendado (mig 20260709000000). Tres canales configurables, no dos fijos.

**Calendario personal → suscripción real.** Ambos tienen calendario. ExamLab además expone un feed
`.ics` con token privado rotable (`student_calendar_tokens` + edge `student-calendar-ics`), así que el
estudiante lo engancha a Google/Outlook/Apple y lo ve junto a su vida; y el docente sincroniza
bidireccionalmente a Google Calendar y Microsoft Graph con Meet link e invitación a estudiantes
(`supabase/functions/calendar/`). *Contrapeso:* falta el calendario **institucional**.

**Banco de preguntas → 4 destinos + org-wide + IA.** EDUTORI dice "banco reutilizable". ExamLab
reutiliza la misma pregunta en examen, taller, proyecto **y Reto en vivo**, con
`question_bank.shared_org` (mig 20260928000000:20) para que cualquier docente del tenant la use — con
RLS que solo permite marcar las propias — más generación con IA e import CSV, y `times_used`,
`difficulty` y `tags` para curar.

**Módulos activos → toggle por rol + enforcement en ruta.** EDUTORI dice "módulos activos configurables".
ExamLab lo hace **por módulo × por rol** (Admin/Docente/Estudiante) con orden drag&drop persistido, y lo
enforza en tres capas: nav, **ruta** (`PREFIX_TO_MODULE` en `ModuleRouteGuard.tsx` — apagar un módulo
bloquea la URL directa, no solo esconde el menú) y un catálogo único con **guardrail de test**
(`module-catalog.test.ts` + check de compile-time `_exhaustiveModuleKeys`) que rompe el build si un
módulo queda a medio registrar.

**Auditoría → triggers a nivel DB, no solo app-level.** EDUTORI pide auditoría de calificaciones,
usuarios y contenidos. ExamLab cubre las tres con ~150 acciones distintas, y para lo más sensible baja a
la base: `_audit_grade_cuts_weight_change` y `_audit_exams_weight_change` (mig 20260517120000:104-135)
capturan cambios de pesos **aunque se hagan por REST directo saltándose el UI**, y mig 20260513140000
traza ediciones de entrega con flag `within_deadline`. Más retención configurable por severidad
(`audit_retention_settings`, mig 20260517150000) — necesaria para que la tabla no reviente.
*Honestidad:* la mayoría de eventos siguen siendo `logEvent` app-level, así que un actor con token
válido operando fuera del UI no queda registrado salvo en los casos con trigger.

**Aislamiento multi-institución → auditado con evidencia.** Cualquiera declara "aislamiento por
institución". ExamLab tiene 210 usos de `current_tenant_id()` **y el historial de haber encontrado
leaks reales y cerrarlos**: `USING (true)` en tablas hijas (mig 20260929000000) y `has_role()` sin
scope de tenant — porque el rol es global, un Admin de otra institución veía filas; leak confirmado con
datos en `ai_override_activations` (migs 20260945, 20261045-20261048), verificado empíricamente contra
producción con `SET LOCAL ROLE authenticated` + jwt claims. En un due-diligence eso vale más que una
declaración.

**Libro de calificaciones → dos niveles + asistencia ponderada.** EDUTORI dice "categorías ponderadas".
ExamLab modela Corte (% de la final) → ítem (% capeado al corte), con validación de que los cortes suman
100 (`app.admin.courses.tsx:994-1010`), y **la asistencia como componente calificable** del corte,
derivando pertenencia de la sesión por rango de fechas (`grade.ts:192-204`), con la misma fórmula
replicada en el acta SQL. Regla explícita y deliberada: `score=null` cuenta como 0 con su peso original,
no se reescala (`grade.ts` docstring) — refleja que lo no entregado es nota perdida.
*Matiz honesto y verificado, contra lo que dice `CLAUDE.md`:* los buckets por tipo
(`exam_weight`/`workshop_weight`/`project_weight`) son hoy **techo de validación y agrupador visual**, no
divisor del cálculo — `src/modules/grading/grade.ts:78-79` dice literalmente *"LEGACY: … ya no se usan.
Quedan en la DB como 0 tras la migración"*. Solo `attendance_weight` sigue vivo en el cálculo.

**Retroalimentación → conversación, no comentario.** EDUTORI dice "retroalimentación por entrega".
ExamLab tiene `teacher_feedback` **más un hilo bidireccional** donde el alumno responde y adjunta
(`feedback_comments`, mig 20260503210000:21; `feedback_attachments`, mig 20260517100000) **más feedback
por pregunta** con override docente que gana sobre la IA (`grade.ts:11-21`).

**Intentos → política de consolidación.** EDUTORI dice "intentos". ExamLab tiene `max_attempts` **y
`retry_mode ∈ {last, average, highest}`** (mig 20260501025625, lógica en `exam-attempts.ts`) — el
docente decide cómo se consolida, que es la pregunta que sigue a "cuántos intentos".

**Aleatorización → estable por alumno.** El shuffle es Fisher-Yates **sembrado por (examen, alumno)**
(`src/modules/exams/shuffle.ts`): distinto para cada alumno pero idéntico entre recargas — evita el bug
clásico de que recargar reordene y el alumno pierda el hilo. *Contrapeso:* mezcla preguntas, no opciones,
y no extrae N de un pool.

**Tutor IA → lee el contenido, no los títulos.** EDUTORI promete tutor sobre el material. El de ExamLab
extrae el **texto real**: md/txt/código inline, notebooks convertidos a markdown, y `.docx`/`.pptx`/
`.xlsx` **descomprimiendo el ZIP y parseando el XML interno** con fflate, más `.pdf` con unpdf
(`tutor-chat/index.ts:180-215`), incluyendo notas del orador de las diapositivas, y **cachea el texto
extraído de vuelta en `files[].body`** como backfill self-healing (`:241-260`). Filtra material
solo-docente para que no filtre soluciones (`:98-104`). El alumno referencia archivos con `#` y esos se
priorizan en el presupuesto del prompt. El bug de raíz documentado: la versión anterior gateaba por
`kind` y descartaba **todo** el material subido.
*Contrapeso importante:* la **citación de la fuente es prosa inducida por prompt**, no dato
estructurado, y el material se trunca a 30 contenidos / 22 000 chars sin avisarle al alumno.

**Reportes → motor de plantillas con DOCX.** EDUTORI dice "reportes exportables". ExamLab tiene motor
propio con `{{variables}}` y `{{#if}}` (`template-engine.ts`), editor rich-text, **import y export
DOCX** (`docx-import.ts`, `html-to-docx.ts`, ambos con tests), override de plantilla por curso,
generación asistida por IA que **inserta los placeholders en vez de valores** para que la plantilla sirva
para todos los estudiantes (`ai-generate-report/index.ts:31-42`), y actas inmutables con
`integrity_hash`.

**Responsive → convenciones auditadas, no "usamos Tailwind".** `dvh` en toda altura de modal (audit de
26 archivos migrados en batch, porque en iOS Safari `vh` usa el viewport máximo y desbordaba ~80-100 px
con la URL bar visible), touch targets ≥32 px, `env(safe-area-inset-bottom)` en elementos `fixed`,
tablas con scroll **dentro** del Card y columnas progresivas `hidden sm/md/lg:table-cell`. Es
mantenimiento real de mobile, no un breakpoint puesto una vez.

**SSO → política más estricta que el estándar.** Además de Google y Microsoft, `auth-sso-verify`
**nunca crea cuentas**: valida que el email exista en `profiles.institutional_email`, y si no, **borra
el `auth.users` huérfano** y rechaza (`not_provisioned`), detectando además colisiones de identidad
(`duplicate_email`), con el rechazo auditado. Cierra el agujero clásico de "cualquiera con un correto
del dominio entra". *Contrapeso:* no hay SAML, y el pre-aprovisionamiento obligatorio es precisamente
lo que impide que el SSO sustituya al SIS.

---

## 6. Riesgos de esta comparación

**Leer esto antes de usar el informe con un cliente.**

1. **La asimetría de evidencia es total y no se puede corregir con más trabajo.** De ExamLab leímos el
   código: sabemos que `so_consola` no es creable desde la UI, que los buckets de peso son LEGACY, que
   el motor de consola de servidor está huérfano y que el Service Worker no cachea datos. De EDUTORI
   tenemos un **documento de alcance funcional**, es decir el equivalente a nuestro `CLAUDE.md` — y
   nuestro propio `CLAUDE.md` sobrevende en al menos cinco puntos verificados (ver #3 abajo). Es
   razonable asumir que el de ellos también. **Todo "EDUTORI tiene X" en este informe significa
   "EDUTORI declara X"**, y merece la misma sospecha que le aplicamos a nuestra propia documentación.

2. **Los ítems más probables de estar sobrevendidos en el documento de EDUTORI**, por ser los que en
   nuestra experiencia se declaran fácil y se implementan caro:
   - *"Aprendizaje adaptativo"* — muchas veces es un branching por nota de quiz, no un modelo.
   - *"Búsqueda semántica"* — a veces es full-text de Postgres con otro nombre.
   - *"Cita la fuente dentro del contenido"* — exactamente donde nosotros quedamos en PARCIAL. Pedir
     demo con enlace clicable al pasaje: si no lo tienen, están en el mismo lugar que nosotros.
   - *"Simuladores conversacionales"* — un prompt con persona es fácil; **evaluar** la conversación con
     rúbrica y nota, no.
   - *"Sincronizado con SIS"* — preguntar cuáles SIS específicos (Banner, PeopleSoft, Academusoft,
     SINU), en qué dirección, con qué frecuencia y si hay reconciliación o solo importación.
   - *"SCORM 1.2"* — preguntar si además reproduce **y reporta** `cmi.core.lesson_status` y suspend
     data, o solo abre el paquete.
   - *"Insignias Open Badges"* — preguntar si emite assertions verificables exportables a un backpack o
     son imágenes decorativas.
   - *"Alerta temprana"* — preguntar qué variables entran, quién definió los umbrales, y si hay
     validación del modelo o es un `if nota < 3`.
   - *"API pública"* — pedir la URL de la documentación.

3. **Puntos donde nuestro propio `CLAUDE.md` sobrevende y que corregimos acá** (relevante porque si
   alguien arma el pitch leyendo `CLAUDE.md` en vez de este informe, va a afirmar cosas falsas):
   - Dice React 18; es **React 19** (`package.json:82`).
   - Describe el modelo de buckets de peso como plenamente activo; `grade.ts:78-79` dice **LEGACY, ya
     no se usan**.
   - Sugiere que en `diagrama` se adjunta una imagen; es **código Mermaid en texto**.
   - Presenta el Tutor IA como que "cita el título del contenido del que proviene cada idea": eso es el
     **texto del prompt**, no una capacidad verificable ni estructurada.
   - Implica offline general por la PWA; `sw.js:110,122` **excluye todo Supabase y no cachea navegación**.
   - `src/integrations/supabase/types.ts` está desactualizado (95 tablas de 133): no usarlo como
     inventario de capacidades.

4. **Verificaciones internas que se contradecían y cómo quedaron resueltas** (miradas al código de nuevo
   para este informe):
   - *Conteo de tablas:* una pasada dijo 95, otra 120. Correcto: **133** `CREATE TABLE` únicos en
     migraciones; 95 es lo que declara el `types.ts` desactualizado.
   - *`so_consola` creable desde la UI:* confirmado que **no** — los únicos usos en `src/` son
     `WorkshopQuestions.tsx:98,1677,2300,3011`, ningún `SelectItem`. El CHECK de DB lo permite y el
     render del alumno existe, pero no hay camino de creación en el editor ni en el banco. Si se
     demuestra, hay que averiguar por qué vía se creó la pregunta.
   - *React 18 vs 19:* verificado, es 19.

5. **Riesgo de usar mal el bloque de nicho.** Los diferenciales STEM (redes, Linux, GUI, 14 lenguajes)
   son abrumadores frente a cualquier LMS **si el interlocutor es de ingeniería**. Presentados a una
   escuela de negocios o a Derecho leen como "este producto no es para nosotros" y **restan**. La
   segmentación de la sección 4 (universal vs nicho) es la parte operativa del informe.

6. **Riesgo de la palabra "proctoring".** ExamLab hace proctoring **por señales de navegador**: no hay
   cámara, ni micrófono, ni biometría, ni verificación de identidad, ni grabación de pantalla (grep de
   `getUserMedia`/`MediaDevices` en el módulo de exámenes: cero). Frente a Proctorio/Respondus es otra
   categoría, más liviana. Decirlo antes de que lo pregunten.

7. **Lo que no se verificó.** No se probó el producto en ejecución para este informe (todo es lectura de
   código), así que no hay evidencia sobre rendimiento con carga real, latencia de los proveedores de
   ejecución de código, ni tasa de acierto de la calificación con IA. Tampoco se verificó el estado de
   despliegue: hay features commiteadas pendientes de *Publish* en Lovable, así que **"está en `main`" no
   equivale a "está en producción del cliente"** — validar contra el entorno antes de demostrar.

---

## 7. Qué haría falta para cerrar la brecha

Priorizado por peso comercial ÷ esfuerzo. Las estimaciones son de orden de magnitud, no compromisos.

### Alto valor, bajo esfuerzo — hacer ya

| # | Qué | Por qué pesa | Esfuerzo aproximado |
|---|---|---|---|
| 1 | **Alerta temprana con semáforo.** Tabla `student_risk` + job que combine señales que ya existen (asistencia por sesión, entregas faltantes vía `computeNoPresentedStudents`, notas bajo `passing_grade`, inactividad) + umbrales configurables por tenant + `notification.kind='risk'` + columna semáforo en el gradebook | KPI de rector, atado a financiación. Materia prima ya calculada; falta clasificar y notificar | 1-2 semanas |
| 2 | **Entregas tardías.** `allow_late BOOLEAN` + `late_penalty_percent` + `late_until` en talleres/proyectos/exámenes, marca "Entregado con retraso" en la entrega y aplicación de la penalización en `computeWeightedGrade` | Queja operativa de la primera semana de uso. Hoy el docente solo puede mover el `due_date` y pierde la trazabilidad | 3-5 días |
| 3 | **Progreso por asignatura.** Definir completitud (material visto + entregas hechas / total) y renderizar `<Progress>` en el tablero del alumno y en el dashboard. Requiere extender `video_views` con posición y agregar marcador de "material visto" | Es lo primero que se compara en una demo. Los datos base ya están | 1 semana |
| 4 | **Panel del estudiante completo.** Agregar la lista de asignaturas del periodo (los datos ya se cargan en `app.index.tsx:1463-1472` solo para el ranking) y convertir los contadores de talleres/proyectos en listas accionables como ya lo son los exámenes | Cierra el gap A1 casi sin lógica nueva | 2-3 días |
| 5 | **Pantalla de perfil.** Los datos ya existen en `profiles` (código, documento, cohorte, programa, estado) y en `academic_subjects` (sílabo); falta la vista y el ítem de nav | Ausencia visible y llamativa: hoy `app.preferences.tsx` son solo notificaciones | 3-4 días |
| 6 | **Entrega de archivo genérico.** Ampliar el input de entrega más allá de ZIP y código a pdf/docx/imagen, reusando `MediaViewerDialog` para que el docente lo vea inline | "No puedo entregar un PDF" es un no rotundo en cualquier facultad no técnica | 3-5 días |
| 7 | **Tipos emparejar y numérica.** Ampliar el CHECK de `type`, agregar render + scoring determinista (numérica con tolerancia ±; emparejar con pares) | Cierra 2 de los 6 tipos exigidos, y son autocorregibles (no gastan IA) | 1 semana los dos |
| 8 | **Escala por letras.** Tabla de cortes por letra por tenant + conversión en el render de notas | Requisito frecuente y aislado | 3-4 días |
| 9 | **Cupo por sección.** `courses.capacity` + validación en `toggleEnroll`/`enrollAllVisible`/`bulk-import-users` | Hoy la matrícula inserta sin límite. Barato y se pregunta en pliegos | 2-3 días |
| 10 | **Anuncio institucional.** Extender `broadcast-course-message` para resolver destinatarios por rol y por tenant, no solo por `course_enrollments` | Hoy no hay canal para docentes ni personal | 3-5 días |
| 11 | **Tercer idioma.** Copiar `en.json` y agregar la entrada al array de `src/i18n/index.ts:20` | Mecánico. Solo si el pliego lo pide | 2 días + traducción |

### Alto valor, esfuerzo medio — planificar por trimestre

| # | Qué | Por qué pesa | Esfuerzo |
|---|---|---|---|
| 12 | **Rúbricas estructuradas.** Tablas `rubric_criteria` / `rubric_levels`, editor, render tabulado para el alumno, puntaje por criterio, y alimentar el prompt de IA con la matriz en vez del TEXT libre | Aparece en todo pliego y mejora la calidad de la calificación IA de paso | 3-4 semanas |
| 13 | **Rutas de estudio y prerrequisitos.** `learning_paths` + `path_items` + `prerequisite_id` + criterios de completitud, reusando el patrón de `content_released_for_student()` que ya está en RLS | Desbloquea autoestudio, nivelatorios y cursos no cronológicos | 4-6 semanas |
| 14 | **Mapa de competencias.** `competencies` + `subject_competencies` + `question_competencies` + rollup de logro por estudiante y por programa | Es lo que exige la acreditación. Sin identificador de competencia no es derivable después, así que **cuanto más se demore, más caro** | 4-6 semanas |
| 15 | **Rol Asistente/Monitor + notas preliminares.** Valor de enum + columna de capacidad en `course_teachers` + estado de publicación de notas + RLS nueva + gates de UI | Alto costo porque toca el enum, RLS y el flujo de calificación completo. Trae de regalo el switch publicar/ocultar notas que EDUTORI también pide | 4-6 semanas |
| 16 | **Coordinación con alcance por programa/facultad.** Tier intermedio: rol o tabla de scope + filtros en los paneles de estadísticas y académico | Separación de deberes; lo marca un auditor | 3-4 semanas |
| 17 | **Historial académico consolidado.** Vista multi-curso multi-periodo del estudiante + promedio acumulado + export | Complementa las actas que ya existen | 2-3 semanas |
| 18 | **Gamificación mínima creíble.** Puntos de plataforma + insignias por regla + racha. Solo hacerlo si un prospecto lo puso en el pliego; el `kahoot_course_leaderboard` da el patrón de agregación | Peso medio salvo pliego explícito. Media implementación es peor que nada | 4-6 semanas |
| 19 | **Facultades, secciones y cohortes como entidades.** Migrar `academic_programs.faculty`, `courses.grupo` y `profiles.cohorte` de TEXT a FK, con backfill | Habilita rollup y validación por esas dimensiones. Riesgo de migración de datos existentes | 2-3 semanas cada una |
| 20 | **Offline real o dejar de decir offline.** Configurar `vite-plugin-pwa` (ya está en `dependencies` y **sin usar**) para precache del shell + cachear lecturas idempotentes. Alternativa de costo cero: **corregir el discurso** a "PWA instalable con resiliencia offline durante el examen" | Hoy es sobreventa verificable por cualquiera que apague el wifi en la demo | 2-3 semanas la implementación; 0 la corrección del discurso |
| 21 | **Nomenclatura configurable.** Overlay de overrides de i18n por tenant sobre las claves visibles | Con 8 850 claves conviene limitarlo a un subconjunto curado (entidades principales) | 2-3 semanas |
| 22 | **Restauración de backup en producto.** Hoy solo hay snapshots JSON que el admin aplica por SQL | Media respuesta a "respaldo y recuperación" en un pliego | 2-3 semanas + diseño de salvaguardas |
| 23 | **Cumplimiento de datos personales.** Citar Ley 1581 en la política, flujo de derechos del titular (exportar mis datos / solicitar supresión), registro de tratamiento | Riesgo legal, no técnico. Bajo esfuerzo de código, alto de redacción legal | 1-2 semanas + asesoría |

### Alto esfuerzo — decisión estratégica, no de roadmap

| # | Qué | Consideración |
|---|---|---|
| 24 | **SCORM 1.2** | Parser de `imsmanifest.xml`, player en iframe con API `cmi.*`, tabla de tracking, y export. 2-3 meses. **Decisión estratégica**: es la llave para reutilizar contenido comprado y para no ser percibido como lock-in. Si el mercado objetivo son universidades que ya tienen Moodle/Blackboard, es prácticamente obligatorio |
| 25 | **Sincronización con SIS** | No es una feature, es N integraciones. Estrategia realista: construir **una** capa de sync genérica (identificadores externos, reconciliación, delta, des-matrícula) y **un** conector de referencia para el SIS del primer cliente grande. 2-3 meses la capa + 3-4 semanas por conector |
| 26 | **SAML 2.0** | Habilitarlo en Supabase (plan Pro+) y cablearlo, incluyendo mapeo de atributos y la decisión de si el pre-aprovisionamiento obligatorio se mantiene. Menor que los dos anteriores: 3-4 semanas. **Alto retorno relativo** — mismo casillero de licitación que SIS/SCORM, mucho menos trabajo |
| 27 | **API pública + webhooks** | Tabla de API keys, endpoints versionados, firma de payload, cola de reintentos, catálogo de eventos y documentación. 1-2 meses. Habilita que el cliente construya su BI y deja de ser un no en el pliego |
| 28 | **Búsqueda semántica** | `pgvector` + pipeline de embeddings sobre el material ya extraído por `material-extract.ts`. 3-4 semanas. **Beneficio doble**: cierra el casillero y arregla el límite real del Tutor IA, que hoy apila por recencia y trunca a 22 000 chars sin avisar. De todo el bloque estratégico, es el de mejor relación esfuerzo/valor |
| 29 | **Simuladores conversacionales** | Persona + escenario + rúbrica de evaluación de la conversación. 1-2 meses. **Solo si el mercado objetivo incluye salud, derecho o negocios**; en ingeniería no mueve la aguja |
| 30 | **Aprendizaje adaptativo** | Depende de #13 (rutas) y #14 (competencias) — sin esas dos no hay sobre qué adaptar. Posponer hasta tenerlas |
| 31 | **Insignias Open Badges** | Assertions verificables + baking de imagen + portabilidad a backpack. Reutiliza el patrón de `payload_hash` y verificación pública de certificados, que ya está resuelto. 3-4 semanas si se hace después de #18 |

### Deuda interna a resolver aparte (no es brecha vs EDUTORI, pero afecta el pitch)

- **Regenerar `src/integrations/supabase/types.ts`** — 95 de 133 tablas; le faltan módulos enteros
  (`kahoot_*`, `whiteboards`, `support_tickets`, `question_bank`, `session_code_snippets`).
- **Decidir el destino de `so_consola`**: o se expone en los selectores de tipo del editor y del banco,
  o se retira del discurso. Hoy tiene CHECK de DB y render de alumno pero **no hay camino de creación**.
- **Cablear o retirar el motor determinista de consola de servidor** —
  `src/modules/serverconsole/{shell,system,grading,scenario}.ts` son ~1 400 líneas testeadas que **solo
  importa su propio test**. Cablearlo convertiría `so_consola` en calificación determinista como ya lo
  es redes, que es un diferencial mucho más fuerte que "la IA lee el transcript".
- **Corregir `CLAUDE.md`** en los 6 puntos de la sección 6.3 — es la fuente que alguien va a leer para
  armar el pitch.
- **`vite-plugin-pwa` y `workbox-window` están en `dependencies` y sin configurar** — o se usan (#20) o
  se quitan.
