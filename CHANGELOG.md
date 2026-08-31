# Changelog

> **Protocolo de trabajo (flujo)** — para Claude y cualquier colaborador:
>
> 1. **Antes de empezar una tarea**, leer este archivo y verificar que lo pedido
>    **no contradiga** una decisión ya tomada (sección "Decisiones / invariantes"
>    abajo). Si contradice, avisar al usuario y proponer cómo reconciliar antes de
>    implementar.
> 2. **Tomar contexto** de este archivo (qué ya se hizo, qué migraciones existen,
>    qué reglas aplican) y de `CLAUDE.md` antes de tocar código.
> 3. **Al terminar una tarea**, agregar una entrada en "Historial" con: qué se
>    pidió, qué se hizo, commit(s), migraciones, y cualquier decisión nueva (que
>    además debe subirse a "Decisiones / invariantes" si es una regla durable).
>
> Formato de fechas: AAAA-MM-DD. Las entradas más recientes van arriba.

---

## Decisiones / invariantes vigentes

Reglas que las tareas futuras NO deben contradecir sin acuerdo explícito:

- **Roles / cursos**
  - Al loguearse, un usuario multi-rol abre por DEFECTO como **Docente** (Docente > Admin > Estudiante). Admin puro abre como Admin. (`AppLayout`, commit `523ffb5`)
  - Un **Docente ve sólo SUS cursos** (los de `course_teachers`) cuando el rol ACTIVO es Docente; Admin/SuperAdmin ven todo el tenant. Vale para los cursos **y para todo lo que cuelga de ellos** (exámenes, talleres, proyectos, pizarras, certificados, papelera…). La regla vive en **`src/modules/courses/course-scope.ts`** y NO se reimplementa por pantalla: estaba repetida en 12 y por eso se omitió en la mitad. Tres detalles que la hacen frágil si se copia a mano: `[]` no es `null` (un `.in(col, [])` en PostgREST devuelve TODAS las filas), hay que filtrar en la INGESTA y no en `filtered*` (si no, los tiles de conteo mienten), y talleres/proyectos son M:N — filtrar por el curso ancla le esconde al docente su propio trabajo compartido. (`app.admin.courses.tsx` `fb40899` → generalizado `35fa57d8`…`16aaeb97`)
  - Un Docente **no puede auto-asignarse** como docente de un curso existente (RLS `20260966` + filtro UI por rol activo `520a40b`). PERO un Docente que **crea** un curso queda como su docente automáticamente (trigger `tg_course_add_creator_teacher`, `20260963`, SECURITY DEFINER).
- **Estados de curso** (`courses.status`: `borrador | en_curso | finalizado`, mig `20260964`, commit `afbaf99`)
  - `finalizado` se llega SÓLO explícitamente (manual vía `set_course_status`, o cron diario `auto_finalize_courses` cuando `end_date` pasó). NO se infiere "finalizado" de una fecha pasada en la vista.
  - `proximo` es una sub-vista por fecha DENTRO de `en_curso` (no es un estado persistido).
  - Finalizar es acción de docente del curso o Admin/SuperAdmin (validado en la RPC).
  - **Cascade al finalizar** (mig `20260991000000`): un trigger `AFTER UPDATE OF status` cierra en cascada lo asociado — exámenes/pizarras (`status='closed'`), talleres/proyectos/encuestas (cerrados SOLO si NINGÚN otro curso ligado sigue `<> 'finalizado'` — caveat M:N), foros (`manually_closed_at`), juegos Kahoot en vivo (`ended`), ventanas de check-in QR. NO cierra sesiones de asistencia ni contenidos/videos (histórico/consultable). NO auto-reabre al reabrir el curso. Funciones `close_*_for_course` son `SECURITY DEFINER` y **REVOCADAS de PUBLIC** (internas). Al agregar una entidad nueva ligada a curso con estado cerrado, sumar su `close_*` al orquestador. **Las actividades EXTERNAS también se cierran** (mig `20261630000000`): antes se excluían con `is_external = false` "porque solo registran nota", y el efecto era que un `Parcial I` externo de un curso finalizado quedaba `published` para siempre, mezclado con los borradores del periodo nuevo. `status` es ciclo de vida, no permiso de calificación: `ExternalGradesEditor` no lee `exams.status`, el alumno filtra los externos de plano, y un curso solo llega a `finalizado` sin pendientes de calificación. **El trigger solo dispara en la TRANSICIÓN** a `finalizado`, así que los cursos ya finalizados antes de `20260991000000` nunca corrieron la cascada — esa misma migración trae el **backfill** idempotente para todos los tenants.
  - **Contraseña temporal FIJA `Temporal#123` para todos** (no aleatoria por usuario). Decisión explícita del usuario (2026-07-14): prefiere una clave uniforme conocida —que el docente dicta en clase— aunque sea insegura, en vez de una temporal única por estudiante que nunca se comunica. El default del edge `bulk-import-users` es `Temporal#123` (era `Cambiar#123`); el template CSV del UI ya lo sugiere. Guardada en claro en `admin_visible_passwords`. Login = correo institucional + `Temporal#123`.
  - **Correo de bienvenida al curso — se envía al PUBLICAR, no al matricular en borrador** (mig `20261130000000`). Matricular a un estudiante en un curso en `borrador` NO emite bienvenida (el curso aún no está disponible; el trigger de matrícula `notify_course_enrollment_welcome` salta `status='borrador'`). La bienvenida sale cuando el curso pasa `borrador → en_curso`: trigger `trg_course_published_welcome` (`AFTER UPDATE OF status`) inserta una notif `course_welcome` por cada estudiante ya matriculado → pipeline de email. Matricular DIRECTO en un curso ya publicado (`<> borrador`) sí emite al instante (comportamiento previo, mig `20261110000000`). Esto permite importar/matricular en borrador sin spamear correos ni entregar claves temporales antes de tiempo.
- **Filtros de grids**: el filtro de ESTADO abre por defecto en lo vigente/activo (no "Todos"); el usuario puede cambiar a Todos/cerrados. (`c3271a5`)
- **Papelera (soft-delete)**: lo que está en papelera (`deleted_at`) NO se muestra ni cuenta en NINGÚN flujo ni rol (query directa, embed+skip, count, RPC, realtime, edges). (`a4edf79`, mig `20260962`)
- **Escala de calificación**: se hereda de la asignatura/curso; la vista de calificaciones muestra SIEMPRE la escala del curso. La "Nota" usa `toScale(raw, max_score)`; el "Puntaje" se normaliza a `grade_scale_max` en PRESENTACIÓN (`rescaleScore`), sin tocar datos. NO normalizar `max_score` de items legacy por migración masiva (riesgo de re-interpretar notas bajas de items /100). Items nuevos default `max_score = grade_scale_max`.
- **Finalizar curso exige SIN pendientes de calificación** (mig 20260972): `set_course_status`→finalizado RAISE si hay pendientes; `auto_finalize_courses` (cron) no finaliza cursos vencidos con pendientes y notifica a sus docentes. "Pendiente" = lógica del Diagnóstico (`course_pending_grading_count`). Esa función es **interna** (SECURITY DEFINER, SIN GRANT a `authenticated` desde mig `20260974` — los callers internos la conservan); NO invocarla desde el cliente.
- **Items SIN corte (`cut_id NULL`)**: cuentan en la NOTA FINAL del curso con su peso, tanto en el gradebook docente como en la vista del estudiante (paridad con el número del certificado). La tarjeta "Sin corte" del estudiante es informativa pero su nota SÍ entra al weighted avg. (`app.teacher.gradebook.tsx`, `app.student.grades.tsx`, fix #0)
- **Informes: Plantilla ≠ Informe generado** (mig `20260975`). La **Plantilla** (`report_templates`) es el blueprint reutilizable; el **Informe generado** (`generated_reports`) es la instancia con datos reales (snapshot HTML, descargable Word/PDF), persistida con historial. "Generar" produce el archivo descargable (Word vía MSO-HTML `.doc` o PDF vía impresión), es acción de DOCENTE (RLS: docente del curso / Admin del tenant / SA; el estudiante nunca lo ve; inmutable). Los saltos de página de Word se preservan al importar `.docx` y se ven como divisor "Salto de página" en pantalla + corte real en PDF/Word (marcador `.examlab-page-break`). UI del docente en 2 tabs: "Plantillas" / "Informes generados". **Importar `.docx`** captura cuerpo + **cabecera + pie** con **imágenes embebidas como data URI** (`parseDocxBundle` → `header_html`/`footer_html`/`body_html`); el preview del editor se renderiza como **hojas de página** ("Página X de N") con las **variables YA RESUELTAS** (datos de muestra o la marca real del tenant — el logo se ve, no `{{tokens}}`), y la exportación incluye el documento original completo + las `{{variables}}` (no sólo lo nuevo). La **Generación IA** vive en el panel de Variables disponibles (derecha) e inserta el contenido EXACTAMENTE en el cursor (`onAiGenerate` + `RichTextEditor.insertHtml`), NO como botón global que reemplaza el cuerpo. Su system prompt es **configurable** (`ai_prompts.use_case='report_generation'`, mig `20260976`), resuelto por el edge `ai-generate-report` (course→tenant→platform→FALLBACK). El texto default DEBE quedar **byte-idéntico** en 4 lugares: `DEFAULT_REPORT_GENERATION_PROMPT` (template-engine.ts), el seed de la mig `20260976`, el `FALLBACK_REPORT_PROMPT` del edge, y el `defaultPrompt` del `AdminPromptsPanel`. La generación inline manda `draftText:""` (fragmento, no reescritura) para no exceder el tope de 200K del edge (`prompt_too_large`). El **preview usa DATOS REALES** de un curso/estudiante elegido (selector en la pestaña Vista previa; estudiante seleccionable en scope estudiante), no mock. La **descarga Word es `.docx` OOXML real** (`html-to-docx.ts`): cabecera en `word/header1.xml` (área de encabezado, se repite por página), pie en `word/footer1.xml`, imágenes en `word/media/*`, tablas con `tblGrid`/`gridSpan`. El PDF pone header/footer `position:fixed` en `@media print`. En el editor visual, las variables/IA insertadas se marcan con `.examlab-added` (color sólo en el editor). Nombres de plantilla únicos (auto-sufijo) + nombre de archivo de informe con `fileStamp`.
- **`report_templates` NO tiene `tenant_id`; una plantilla GLOBAL es `owner_id IS NULL AND course_id IS NULL`.** Ese es literalmente el predicado de la policy `report_templates_read` (mig `20260528010000`), que distingue tres tipos: global de plataforma, privada del docente (`owner_id NOT NULL`) y override por curso (`course_id NOT NULL`). **`scope` NO sirve para esto**: dice de QUÉ habla la plantilla (`curso` / `estudiante`), no a quién pertenece. La mig `20261930000000` nació diciendo `AND tenant_id IS NULL` y **tumbó el deploy** con `column "tenant_id" does not exist` (arreglada en `aa467829`). Lo que dejó pasar el error no fue el SQL sino el ARNÉS: la verificación local **creaba** `report_templates` con una columna `tenant_id` inventada, así que validaba contra un esquema que no existe — y un `.get("col")` sobre una respuesta REST devuelve `None` para una columna AUSENTE, que se lee igual que "el valor es NULL". Regla: **un arnés de verificación se construye leyendo el esquema REAL** (`src/integrations/supabase/types.ts` o REST), nunca inventando el `CREATE TABLE`. Y ojo: una migración de seed con guardas `position(...) > 0` puede **aplicar en verde sin cambiar una sola fila** — CI verde no prueba que el parche llegó al dato; hay que verificar el EFECTO.
- **Item compartido (M:N) en >1 curso**: su nota debe verse en CADA curso al que pertenece (`workshop_courses`/`project_courses`), no solo en el curso ancla; el peso/corte es por curso. *(en refinamiento — #30/#31)*
- **Contenido**: el label de un contenido en el tablero ES el **nombre (`display_name`)**, no el tema (`topic`) — `display_name?.trim() || topic`. El contenido puede asociarse a >1 curso (`content_course_assignments`, vía `ManageContentCoursesDialog`) y a la sección "General" del curso (sin sesión, destino del upload del tablero). El grid de Contenidos muestra filas de **altura estándar** (una línea: nombre + estado + conteos; sin subtítulo del tema). (`f4c396d` + #22)
- **Resolución de la institución: override del SuperAdmin → SUBDOMINIO → `profile.tenant_id`** (`src/modules/tenants/subdomain.ts` + paso 2 de `use-tenant.ts`). El orden NO es negociable: "ver como X" es una acción deliberada y le gana a la dirección. El subdominio **se saltea para un SuperAdmin sin override**, porque el modo cross-tenant se define como `SuperAdmin && !override` (invariante compartida `AppLayout` ↔ `TenantThemeProvider`) y fijarle institución por el host le mostraría su nombre con el tema por defecto. Un subdominio inexistente **no es error**: cae al perfil y el selector reaparece. Nunca leer el hostname en un initializer de `useState` (React #418) — se lee post-mount. El subdominio es **pista de UI, no control de seguridad**: el aislamiento lo da la RLS. Hosts de plataforma (`*.lovable.app`, `*.pages.dev`…) NO se interpretan como institución: si no, `examlab.lovable.app` resolvería `examlab`. Manual: `docs/subdominios-cloudflare.md`.
- **Multi-tenant / RLS**: nunca `USING(true)` ni `has_role()` sin scope de tenant en tablas con datos de tenant (ver `CLAUDE.md`). Migraciones envuelven `ALTER` en guard `to_regclass`.
- **Demo**: tenant `ExamLab Demo` (`729b3114-…`) tiene un curso "Curso de pruebas" con TODOS sus usuarios como docentes (mig `20260965`) — porque los docentes no pueden auto-asignarse.
- **IA Compartida es el DEFAULT** (mig `20261340000000`, commit `1ecee536`). `tenants.ai_mode`: `shared` (default al crear institución) → usa la IA de la plataforma (fila activa SA `tenant_id IS NULL` + env), el tenant NO configura key propia; `own` → exige su key (sin ella, error accionable, no consume la cuota compartida); `managed` → compartida + medición/cobro aparte. `getActiveAiModel` (`_shared/ai-model.ts`) lo enforza. Un tenant que traiga su key DEBE quedar en `ai_mode='own'` desde el panel comercial. **En `shared` el PROVIDER y el MODELO de la fila platform-default gobiernan a TODAS las instituciones** (`{...shared}` en `getActiveAiModel`): lo que NO se hereda son las keys, el proveedor sí. Consecuencia dura: **nunca activar en esa fila un proveedor cuya key no esté cargada** (ni en la fila ni en su env secret) — la cadena de candidatos queda vacía y `aiChatCompletionFailover` corta con *"Falta la API key de X. Configúrala en Configuración → Modelo IA"* — se cae la IA de toda la plataforma (tutor, calificación y generación). El mensaje es claro y accionable; lo engañoso es a QUIÉN señala: aparece en las instituciones, que no pusieron nada mal y no pueden arreglarlo desde su panel. Pasó el 2026-08-19 al sembrar la fila con `bedrock` antes de cargar `AWS_BEARER_TOKEN_BEDROCK`, con las 5 instituciones en `shared`; sus keys propias de Gemini quedaron ignoradas porque el provider activo era otro. Orden correcto para activar un proveedor nuevo: **1)** cargar el secret / la key, **2)** verificarlo en Diagnósticos, **3)** recién ahí cambiar el proveedor. El caché de `getActiveAiModel` tiene TTL de 60s, así que un cambio (o su reversión) propaga en ≤1 min sin depender de que se recicle la instancia del edge.
- **Borrado de usuario = LÓGICO, no físico** (edge `admin-delete-user`, `1facb8cc`; mig `20261340000000`). Setea `profiles.deleted_at`+`is_active=false`+ban en Auth. `current_tenant_id()` retorna NULL para usuarios desactivados/eliminados y para tenants con `subscription_status IN (suspended,expired,cancelled)` o `is_active=false` → la RLS los bloquea en TODA la app. Al agregar una tabla que dependa del tenant, esto ya la cubre por `current_tenant_id()`.
- **Suscripción/facturación del tenant** (mig `20261350000000`). `process_tenant_subscriptions()` (cron diario `tenant-subscription-check-daily`) reactiva/suspende/marca past_due según `billing_end` + gracia en **días hábiles** (`add_business_days` excluye sábados/domingos + `platform_holidays`, SA-only). `auto_suspend` por tenant decide si el cron suspende al vencer la gracia. Solo el SuperAdmin edita lo comercial (RLS `tenants` UPDATE = `is_super_admin()` + guard `tg_guard_tenant_commercial_columns`).
- **Naming visible del asistente** (auditoría 2026-07-20): "Asistente de la plataforma" = asistente de plataforma (`/app/assistant`, todos los roles); "Asistente de IA" = vista unificada del estudiante; "Tutor del curso" = tutor por curso. En texto visible a **quien NO es SuperAdmin** nunca "tenant" → siempre "institución". "Kahoot" nunca visible → "Reto en vivo" (identificadores internos siguen `kahoot`).

---

## Historial

> Desde 2026-07-24 el Historial se versiona por release (`## [X.Y.Z] — fecha`, un Publish = una versión).
> Proceso y reglas de bump: **[docs/RELEASING.md](docs/RELEASING.md)**. Las entradas fechadas de abajo
> (formato viejo `### AAAA-MM-DD`) se conservan tal cual.

## [Sin publicar]

> Se despliega solo al pushear a `main` (GitHub Actions). Incluye **diez migraciones** (`20261600000000_bd_sql_support.sql`,
> `20261610000000_whiteboard_pages_sql.sql`, `20261620000000_ai_prompt_sql_generation.sql`,
> `20261640000000_fix_list_error_events_entity_id_text.sql`, `20261650000000_ai_provider_bedrock.sql`,
> `20261900000000_uniaj_2026_2_alinear_talleres_y_parciales.sql` —de DATOS, sin DDL— y
> `20261910000000_student_own_whiteboards.sql`, `20261920000000_docente_enrollment_target_guard.sql`
> `20261930000000_report_signature_slots.sql` y `20261940000000_report_signature_drawing.sql`,
> todas defensivas con `to_regclass`) y **una edge
> function nueva** (`ai-generate-sql`); el resto es cliente.
>
> Además, para que Bedrock funcione hay que cargar el secret **`AWS_BEARER_TOKEN_BEDROCK`** como
> *GitHub Actions repository secret* y re-correr `deploy-secrets.yml` (no viaja en las migraciones,
> a propósito).

### 🎉 Novedades

- **La firma se dibuja: el estudiante traza su firma con el dedo, el lápiz o el ratón.** Firmar era
  un clic y la marca que quedaba era el nombre en cursiva. Funcionaba, pero en un teléfono el gesto
  de firmar es pasar el dedo, y un acuerdo impreso se lee distinto con un trazo que con un nombre
  tipeado. Al pulsar la ranura de su renglón se abre un recuadro para dibujar; el trazo queda dentro
  del documento, en el lugar donde está su nombre, con la fecha y el código de verificación debajo.

  El trazo se recorta a la tinta antes de guardarse. Sin eso el recuadro es ancho, la firma ocupa una
  parte, y el navegador escala la imagen completa: la firma se vería diminuta en la celda. Recortada,
  llena el renglón como una firma en papel.

  **Firmar sin trazo sigue estando.** Quien esté en un computador donde dibujar con el ratón le sale
  mal no queda bloqueado: firma con un clic y la marca es su nombre, como antes. Un documento con
  firmas de las dos clases es válido. Y si el trazo quedó en una mancha de dos píxeles —un toque
  suelto—, ahora lo dice en vez de firmar en silencio sin trazo, que era lo que pasaba.

  El trazo viaja al Word y al PDF: verificado que el `.docx` descargado trae las firmas como imágenes
  embebidas, no como un hueco.

### 🔒 Seguridad

- **El trazo de la firma es contenido que sube el usuario y termina dentro del documento, así que
  está acotado en la base.** Se guarda como un PNG en data URL y una restricción de la tabla solo
  acepta eso: `image/png` y nada más —un SVG puede traer un `<script>` adentro—, con un patrón que no
  admite comillas ni `<`, así que el valor no puede romper el atributo de la imagen aunque el
  renderizador se olvide de escaparlo, y un tope de tamaño para que la columna no sirva de depósito.
  Va como restricción de la tabla y no solo como validación de la función: la función se puede
  reemplazar, la restricción no se salta. Verificado escribiendo directo a la columna, sin pasar por
  la función: el SVG, las comillas y el valor desmesurado los rechaza la base.

- **El estudiante firma el Acuerdo Pedagógico EN SU RENGLÓN, y la firma queda dentro del
  documento.** El flujo de firmas ya existía, pero la firma era un registro invisible: la tabla del
  acuerdo seguía imprimiendo un recuadro en blanco por estudiante y el estudiante firmaba con un
  botón al pie, después de tres páginas. Nadie podía mirar el acuerdo y ver quién firmó.

  Ahora la celda de Firma de cada estudiante es una ranura con tres estados. **Firmada**: sale el
  nombre, la fecha y un código de verificación de seis caracteres, distinto por firma, para que
  alguien pueda señalar una firma concreta al reclamar. **Pendiente**: en blanco — es lo que hace
  que el papel siga sirviendo, porque un acuerdo sin firmar se imprime y se firma a mano igual que
  antes. **Firmable**: un botón "Firmar aquí", y solo en la fila de quien está mirando; al abrir el
  documento la vista baja sola hasta ese renglón.

  El docente ya no tiene que cambiar de pestaña para mandarlo a firmar: el botón está en el mismo
  diálogo donde generó el documento, con el acuerdo en pantalla. Y cuando vuelve a descargar el
  informe desde "Informes generados", el Word y el PDF salen con las firmas puestas — antes se
  descargaba en blanco aunque el curso entero hubiera firmado.

  Dos decisiones que no se ven pero sostienen el resto. La firma **no** se resuelve al generar el
  informe: lo que se guarda es un snapshot inmutable —el hash de la firma se calcula sobre él— y al
  generarlo todavía no hay ninguna firma, así que la plantilla deja una ranura anclada a cada
  estudiante y las firmas se dibujan al MOSTRAR el documento. Y el ancla es el identificador de la
  persona, no su nombre ni su correo: los nombres se repiten y un correo se puede corregir (de hecho
  se corrigió uno esta semana), así que anclar por ahí pondría la firma de alguien en el renglón de
  otro.

  Los informes ya generados no tienen ranuras y siguen funcionando como hasta ahora, con el botón al
  pie: nada obliga a regenerarlos.

- **El docente puede matricular a un estudiante nuevo en VARIOS cursos de una vez.** El diálogo
  "Nuevo estudiante" pedía UN curso en un desplegable; ahora muestra los cursos que dicta con
  casillas, con "Seleccionar todos" cuando tiene más de uno. El caso que lo pedía es el de siempre:
  el alumno de una cohorte que ve todas las asignaturas del mismo docente, que había que dar de alta
  y después matricular a mano uno por uno.

  El servidor ya lo soportaba —el campo de curso acepta varios nombres separados por `|`, igual que
  los roles— así que faltaba solo la interfaz. Elegir casillas y no un desplegable múltiple es
  deliberado: con un desplegable hay que abrirlo para saber qué quedó elegido, y acá lo elegido es
  justamente lo que hay que revisar antes de crear la cuenta. Ese bloque estaba copiado byte por
  byte en el diálogo del Admin, así que se extrajo a un componente y ahora los dos usan el mismo.

  Los avisos dejaron de mentir en dos casos que el multi-curso vuelve frecuentes. Si el correo YA
  tenía cuenta, antes se anunciaba "su contraseña temporal es Temporal#123" sobre una contraseña que
  nadie cambió; ahora dice que se matriculó a una cuenta existente y no promete contraseñas. Y un
  fallo real de matrícula se mostraba como advertencia tranquila porque el servidor no distinguía
  "ya estaba matriculado" de "la matrícula falló": ahora lo distingue.

### 🔒 Seguridad

- **Un fallo de matrícula ya no se reporta como éxito.** Al crear un usuario, la matrícula a sus
  cursos no capturaba el error: los clientes de Supabase no lanzan, devuelven el error como dato, así
  que un fallo se tragaba en silencio y la fila se reportaba como creada. El resultado era una cuenta
  existente, con su correo de bienvenida ya enviado, matriculada en CERO cursos, mientras el aviso
  decía "matriculado en 3 cursos: A, B, C" — y el estudiante no aparecía en la lista, que se arma
  desde las matrículas. El propio archivo tenía un comentario marcado como CRÍTICO explicando esta
  misma lección para el alta de roles, cien líneas más arriba.

- **Un docente ya no puede fabricarse un estudiante para editarle el perfil.** La policy que le
  permite gestionar matrículas decía en qué cursos, pero no a quién: podía insertar la matrícula de
  un Admin en un curso que dicta, con lo cual ese Admin pasaba a contar como "su estudiante" y le
  quedaba habilitado el UPDATE de su perfil. El guard existente frena el estado de activación y la
  institución, pero no el **correo institucional**, que es la identidad de acceso. Reproducido de
  punta a punta en PostgreSQL con la RLS activa —el correo de la Admin terminaba cambiado— y cerrado
  en los dos extremos: la matrícula de una cuenta con rol de staff se rechaza, y el predicado
  "es mi estudiante" ya excluye al staff aunque la fila de matrícula exista. Lo legítimo sigue igual:
  el docente edita a sus estudiantes, los matricula y puede borrar una matrícula equivocada.

- **La bandera de "actualizar usuarios existentes" del importador se ignora para el docente.**
  Saltaba la rama de "el usuario ya existe" y dejaba caer la fila en la zona que parchea roles y
  perfil, con el objetivo identificado solo por correo y resuelto contra la lista global de cuentas,
  sin filtro de institución. Ningún cliente la envía, así que era una capacidad dormida y no un bug
  alcanzable desde la interfaz; se cierra igual, porque el diálogo no es la frontera.

- **El estudiante ahora tiene sus propias pizarras.** Hasta acá el módulo era una vitrina: solo
  mostraba lo que el docente compartía con el curso, y si no había compartido nada, la pantalla
  estaba vacía. Ahora el estudiante crea las suyas, las edita y las borra. Sirve para lo que ya le
  pide el semestre —los talleres de Arquitectura le piden diagramas C4 y los de Bases de Datos un
  modelo ER— y para lo que no le pide nadie: un cuaderno donde ensayar.

  La pantalla queda partida en dos, **Mis pizarras** y **Compartidas por tus docentes**, cada una con
  su paginación. La separación no es cosmética: a una pizarra propia NO se le aplican los filtros que
  sí valen para lo que recibe. Si el docente finaliza el curso, la cascada de cierre marca como
  cerradas las pizarras de ese curso, y lo compartido sale del listado — pero la del estudiante es
  suya y se queda. Lo mismo si el curso se va a la papelera. Sin esa distinción, el día que el
  docente cierra el semestre el alumno perdería de vista su propio trabajo.

  **Compartir con todo el curso sigue siendo del docente, y eso se cierra en la base, no en la
  pantalla.** La RLS ya dejaba al dueño de una fila escribir cualquiera de sus columnas, y dos no son
  suyas: `is_shared_with_course` —ponerla en true le publicaría contenido a todos sus compañeros sin
  que el docente lo autorice— y el vínculo con una sesión de clase. Un trigger nuevo
  (`trg_whiteboard_student_guard`, mig `20261910000000`) las rechaza, y también rechaza atar la
  pizarra a un curso donde el estudiante no esté matriculado o crearla a nombre de otro. Verificado
  en PostgreSQL con la RLS activa, actuando como estudiante, como compañero y como docente: 17 casos,
  incluido que un compañero no ve ni puede editar la pizarra personal de otro. El docente conserva lo
  suyo, con un endurecimiento que vino de arrastre: ya no puede compartir con un curso que no dicta.

  Asociar la pizarra a un curso es opcional y solo sirve para organizarlas; el aviso del diálogo dice
  exactamente qué implica. El **borrado es definitivo, no va a la papelera**: el módulo Papelera es de
  Docente/Admin, así que una pizarra del estudiante marcada como borrada quedaría irrecuperable para
  él e invisible para todos — peor que un borrado explícito. El diálogo lo advierte.

  El buscador (⌘K) también las encuentra; antes cortaba de plano si el alumno no tenía cursos.
  Pendiente a propósito: si el estudiante asocia la pizarra a un curso, el docente puede abrirla por
  enlace pero todavía no le aparece **listada** en su grid.

- **Los talleres y los parciales de Arquitectura y de Bases de Datos II coinciden otra vez con el
  material del curso.** El contenido de la plataforma se cargó el 2026-08-12 y los documentos se
  reescribieron el 2026-08-15 al pasar el semestre a 13 sesiones, así que quedaron tres días de
  deriva entre lo que el estudiante lee y lo que la plataforma le pide. Se comparó el texto de los 29
  documentos entre las dos revisiones, y el resultado fue más chico de lo que parecía: el contrato de
  preguntas de los 24 talleres es idéntico, y lo único que cambió de verdad son los Parciales 2 de
  los dos cursos, porque el calendario comprimido metió la Clase 10 dentro del Corte 2. Ahí se
  agregaron las preguntas que faltaban (right-sizing y costos en Arquitectura; niveles de aislamiento
  y un caso de interbloqueo en Bases de Datos), se repartieron de nuevo los 100 puntos del papel y el
  emparejamiento pasó de 4 a 6 pares.

  De paso se arregló un defecto que traían los seis talleres por corte desde que se cargaron: dos
  preguntas compartían posición, así que el orden que veía el estudiante quedaba a merced de lo que
  devolviera la base y "Pregunta 4" no señalaba nada fijo. El orden correcto no se eligió por gusto:
  en cada taller el enunciado de una de las dos preguntas depende de la otra ("Partiendo de la ficha
  y el C4 Context", "el cuello de botella bajo ese pico", "para cada operación del contrato"), y eso
  lo fija sin ambigüedad.

  Quedó UNA cosa sin aplicar, a propósito: cuatro ítems del material movieron el enunciado de VetCare
  a dominios ajenos al curso (un procedimiento de préstamo de equipos, una tabla Pedido, "una pyme").
  No se aplicaron porque el propio documento se contradice —en el mismo Parcial 2, la pregunta nueva
  y el caso final hablan de VetCare mientras la de optimización habla de Pedido— y porque los
  talleres y el Proyecto Integrador siguen siendo VetCare de punta a punta. Si el cambio era
  intencional, hay que corregirlo en el material, que es la fuente.

- **El enlace público de asistencia ya dice de qué curso y de qué sesión es.** Antes era un formulario
  pelado: el estudiante escribía su correo sin saber qué estaba marcando, y con varias materias el mismo
  día eso es pedirle que firme a ciegas. Ahora muestra el curso con su grupo, el título de la sesión y
  la fecha.

  Solo aparece cuando el check-in está **realmente** abierto. Un enlace de una sesión que no existe, de
  otra institución, en la papelera o con el check-in cerrado devuelven todos exactamente lo mismo — no
  se puede usar la página para averiguar qué cursos existen. Y si la ventana todavía no empezó, en vez
  de "está cerrado" dice a qué hora abre: la página ignoraba por completo ese estado, que el servidor ya
  le mandaba.

- **El diálogo del check-in llega con las fechas ya puestas: desde ahora, por seis horas.** Antes
  arrancaban vacías y el servidor aplicaba diez minutos, así que el docente abría el check-in sin ver
  cuándo cerraba y se enteraba del default recién cuando ya se había cerrado solo. Ahora las dos fechas
  están escritas, a la vista y editables. Si se corre la hora de apertura, el cierre la sigue para
  mantener la duración — pero si el docente ya editó el cierre a mano, no se lo pisa.

  Las seis horas son configurables por institución, en Configuración → General: una que solo toma
  asistencia en clases de dos horas no tiene por qué corregir el campo cada vez.

- **El check-in de asistencia se define por fechas, y el código puede quedar fijo todo ese tiempo.**
  Antes se pedía una duración en minutos con un tope, y ese tope se subió dos veces seguidas porque el
  modelo no era el correcto: lo que el docente tiene en la cabeza es "del martes a las 8 al jueves a
  las 18", no "2760 minutos a partir de ahora". Ahora se eligen **fecha de apertura y de cierre**. Se
  puede poner una apertura futura y el check-in no acepta nada antes de esa hora. El único límite que
  queda es un año, y está para que un año mal tecleado no deje una ventana abierta hasta 2126.

  Y poniendo la rotación del código en **0**, el código **no cambia** durante toda la ventana. Eso hace
  falta de verdad: no alcanzaba con poner una rotación muy grande, porque el código cambia en los
  múltiplos de la rotación —con rotación de un día cambiaría a la medianoche, en mitad de una ventana
  de tres días—.

  El aviso va en la pantalla, junto al campo: un código fijo de varios días se puede reenviar por chat
  y usarlo desde cualquier parte, así que deja de probar que la persona estuvo presente. Sigue
  exigiendo estar matriculado y que la ventana esté abierta. El valor por defecto no cambia: quien abre
  un check-in normal sigue con rotación de 60 segundos.

- **Ya se puede salir de la proyección del check-in sin cerrarlo.** Hasta ahora la única salida de esa
  pantalla era el botón rojo "Cerrar check-in", que además de cerrar la ventana en la base ofrece
  marcar como ausentes a todos los que no alcanzaron a marcar. En la práctica eso obligaba al docente a
  dejar la pantalla abierta —y el proyector encendido— todo el tiempo que quisiera recibir
  asistencias; con las ventanas nuevas de hasta 24 horas, directamente imposible.

  Ahora hay un botón **Salir** que solo cierra la proyección: el check-in sigue abierto, los estudiantes
  siguen marcando, y el botón de la sesión en la grilla cambia a "reabrir proyección" para volver a
  mostrarlo cuando haga falta. El botón rojo queda para lo que dice ser — cerrar de verdad.

- **El check-in de asistencia admite ventanas mucho más largas.** Los topes anteriores se estaban
  tocando: la ventana llegaba a 4 horas y el código rotaba como máximo cada 10 minutos. Ahora la
  ventana va **hasta 24 horas** y el código puede rotar **cada 2 horas**; extender una ventana abierta
  llega a 8 horas de un tirón, con el mismo techo total de 24.

  **Los valores por defecto no cambian** —la ventana sigue abriendo en 10 minutos y el código rotando
  cada 60 segundos— y eso es deliberado. El código rotativo es justo lo que prueba que el estudiante
  estaba mirando la pantalla proyectada: cuanto más dura cada código, más tiempo sirve para pasárselo
  por chat a alguien que no vino. Con 2 horas de rotación esa ventana es de dos horas; con 60 segundos,
  de un minuto. Quien necesita una jornada completa lo escribe; quien no, no se entera de que existe.
  Un default largo habría debilitado el control de todas las clases para servir al caso raro.

- **Un informe se puede enviar a firmar, a uno o a varios estudiantes del curso.** Pensado para el
  Acuerdo Pedagógico: en vez de imprimirlo y hacerlo circular con una lapicera, el docente lo genera y
  lo manda a firmar desde "Informes generados". Cada estudiante ve el documento **tal como se generó**,
  lo lee y confirma su aceptación; queda registrado quién firmó y cuándo. El docente ve en el mismo
  diálogo quién ya firmó y quién falta, y puede retirar una solicitud que nadie firmó todavía.

  **Se firma el documento congelado, no la plantilla.** Es lo que hace que la firma signifique algo: si
  se firmara la plantilla, el docente podría editarla después y el estudiante quedaría atado a un texto
  que nunca leyó. Se guarda además una huella (SHA-256) del documento firmado, para poder detectar si
  cambió después.

  **La firma no se puede falsear desde el navegador.** La tabla no acepta escrituras directas: la fila
  se escribe únicamente por una función del servidor que toma la identidad de la sesión y no admite
  "firmar por otro" como parámetro. Está comprobado, no supuesto: en el ensayo, intentar insertar la
  firma de un compañero y adelantar la fecha de la propia quedan bloqueados los dos.

  Y algo que conviene decir con claridad: **esto no es una firma digital.** No hay certificado, ni
  clave privada, ni sello de tiempo de un tercero. Es un registro de aceptación autenticado —consta que
  la persona dueña de esa cuenta aceptó ese documento, y cuándo—, que alcanza para un acuerdo
  pedagógico y no para algo que necesite valor probatorio ante un tercero. Por eso ningún texto de la
  app la llama "firma digital".

- **El Acuerdo Pedagógico ya está en la plataforma como plantilla, y la lista de firmas se llena
  sola con los estudiantes del curso.** El formato institucional (DO-F-021) traía un "listado de
  estudiantes asistentes" con **22 renglones vacíos numerados a mano**: en un curso de 31 personas,
  nueve firmaban al margen; en uno de 12, sobraban diez renglones. Ahora esa tabla se genera desde la
  matrícula — una fila por estudiante, con su número, nombre y código, y la celda de firma en blanco
  para firmar sobre el papel impreso. El bloque de arriba (Docente / Vocero / Director) queda igual
  que en el formato.

  El documento se convirtió con el mismo lector de Word que el módulo de informes ya usaba, así que
  el encabezado, las tablas y los estilos son los del original. Tres cosas se cambiaron a propósito
  para que sirva como plantilla **de la plataforma** y no de un curso: los datos del curso pasaron a
  ser variables (venía con "Programación II / 341-C / 2026-1" escritos literalmente), el logo del
  encabezado ahora sale de la institución que genera el informe, y **se retiró la firma escaneada del
  docente** — eran 112 KB de los 128 KB del documento, y la firma de una persona real no puede quedar
  dentro de una plantilla que cualquier institución puede usar.

  En el editor de plantillas hay además un botón **Firmas** que inserta esa misma tabla en cualquier
  informe de curso, sin tener que dibujarla a mano.

- **El monitor del examen ahora dice cuántas preguntas respondió cada estudiante — también después
  de que entregó.** La columna mostraba en qué pregunta iba, pero SOLO mientras el intento estaba en
  curso: apenas el alumno entregaba, quedaba en "—" y el docente perdía el dato justo cuando servía
  para algo. Ahora la columna significa una sola cosa en todos los estados —**respondidas de total**—
  y se pone en ámbar cuando quedaron preguntas en blanco, con el detalle al pasar el mouse. La
  posición no se pierde: en un intento en curso sigue disponible ahí mismo.

  **Buscando de dónde sacar ese número apareció algo más serio.** El criterio de "pregunta
  respondida" estaba escrito DOS veces —una en la pantalla de examen y otra en la de talleres— y las
  dos se contradecían: en una pregunta de código que el alumno no tocó, el taller la contaba **en
  blanco** y el examen la contaba **respondida**. El comentario del taller explicaba por qué su regla
  era la correcta: sin esa detección, quien pulsa Entregar sin abrir el editor pasaba el chequeo y
  **entregaba en cero sin ninguna advertencia**. O sea, el taller ya había arreglado un bug que el
  examen seguía teniendo.

  Ahora hay un solo criterio, y se quedó con la mejor regla de cada lado. Además del código, esto
  corrige dos casos que el examen no contemplaba: una respuesta de **base de datos** vacía contaba
  como respondida (porque el envoltorio que se guarda nunca está vacío, aunque el alumno haya
  borrado su SQL), y las preguntas de **consola Linux** no estaban contempladas en absoluto. Los tres
  arreglos hacen que el examen avise lo que hasta ahora se tragaba en silencio.

- **Al check-in de asistencia se le puede dar más tiempo sin invalidar el QR proyectado.** Cuando la
  ventana se quedaba corta —llegó un grupo tarde, la fila avanza lento— la única salida era volver a
  abrir el check-in, y eso **regenera todos los códigos**: el QR de la pantalla y el que los alumnos
  tenían a medio escanear dejaban de servir en el mismo instante. Ahora hay botones **+5 / +10 / +15**
  junto al contador, que solo mueven la hora de cierre: el QR sigue válido y quien está escaneando no
  se entera. Si la ventana ya venció, cuenta desde ahora y no desde el vencimiento.

- **La asistencia se puede compartir como enlace, y opcionalmente pedir solo el correo.** El check-in
  sin iniciar sesión ya existía, pero su enlace **solo vivía dentro del código QR**: en una clase
  virtual, donde no hay nada que proyectar ni que escanear, era inalcanzable aunque estuviera
  implementado. Ahora el proyector tiene **Copiar enlace** para pegarlo en el chat de la clase.

  Además, al abrir el check-in se puede activar **"Marcar solo con el correo"**. Con eso el estudiante
  entra por el enlace y escribe su correo y el código de la pantalla, sin contraseña — que era lo que
  volvía lento el check-in de un grupo grande y dejaba afuera a quien no la recordaba.

  **Viene apagado, y es a propósito.** La contraseña es lo que impide que alguien marque presente a un
  compañero que no vino: un correo institucional es adivinable, sigue un patrón. Con el modo activo
  siguen protegiendo el código rotativo (solo está en la pantalla proyectada y cambia cada minuto), la
  matrícula en el curso exacto y la ventana de tiempo; deja de proteger que un presente marque a un
  ausente. Por eso el docente lo elige al abrir, con el texto diciendo qué se gana y qué se pierde, y
  la recomendación de dejarlo apagado cuando la asistencia pesa en la nota. Tampoco se recuerda entre
  clases: cada apertura arranca apagada, para que una sesión con nota no herede el modo flojo de la
  anterior.

- **Los resultados de una encuesta se pueden imprimir, con la marca de la institución.** Hasta ahora
  vivían solo en la pantalla del docente: para llevarlos a un comité, adjuntarlos a un acta o
  archivarlos había que sacar una captura. Ahora hay un botón **Imprimir** en la vista de resultados —
  tanto en las de opciones y cupos como en las que tienen preguntas propias— que arma una hoja A4 con
  el logo y el nombre de la institución, su color de marca, el curso, el estado y la fecha.

  **Al imprimir se elige si van los nombres o no**, y esa es la decisión de diseño que importa: la
  hoja impresa circula. En una encuesta de cupos los nombres SON el contenido (quién quedó en qué
  horario); en una de bienestar, los nombres al lado de las respuestas abiertas son justo lo que no
  debería quedar sobre un escritorio. No hay un default correcto para las dos, así que se elige en el
  momento, y el pie del documento dice cuál de las dos versiones es — un documento anónimo lo declara,
  y uno con nombres avisa que se trate como reservado. La opción no se recuerda entre encuestas a
  propósito: recordarla haría que la próxima se imprima como quedó marcada la vez anterior.

  Los porcentajes no se recalculan para el papel: sale el mismo número que muestra la pantalla. En las
  encuestas de cupo eso importa —ahí el porcentaje mide el llenado del cupo, no la cuota sobre el
  total— y un docente que imprime para una reunión no debería terminar defendiendo una cifra que la
  plataforma no muestra.

  Detalles que se midieron en vez de suponerse: las barras se imprimen de verdad (el navegador las
  deja en blanco si no se le pide lo contrario); una barra o una respuesta nunca se cortan entre dos
  páginas y el título de una pregunta nunca queda solo al pie, pero la pregunta SÍ puede continuar en
  la hoja siguiente — prohibirlo daba 7 páginas donde alcanzaban 6, con huecos de media hoja que se
  leen como un error de armado.

  **La hoja trae el correo de cada participante, y quedó más corta que antes de tenerlo.** Con el
  nombre solo, quien lee el informe tiene que volver a la plataforma a buscar a cada persona para
  escribirle, así que el documento no alcanzaba para actuar. El correo va pegado al nombre, más chico y
  en gris, y los participantes van en flujo continuo (3 o 4 por renglón) en vez de uno por línea: una
  columna aparte para 23 personas habría costado 23 renglones. Lo que lo paga es sacar un renglón por
  opción — la etiqueta y el conteo ahora comparten línea. Medido con 23 participantes en 5 opciones: la
  maqueta anterior sin correos ocupaba 873 px y esta con los 23 correos ocupa 868, o sea que el dato se
  agregó sin que el informe crezca. El separador entre personas va pegado con espacio duro al que
  termina, como una coma: sin eso quedaban viñetas abriendo renglón, que se lee como un error.

  Un perfil sin correo cargado imprime solo el nombre, no un paréntesis vacío. Y en la versión anónima
  el correo se borra JUNTO al nombre: es un segundo dato de identidad —más identificatorio que el
  nombre, porque suele traer el código del estudiante— y ahora esa limpieza es una función aparte con
  tests, no un detalle del armado del que dependiera la privacidad.

- **"Volver" se ve igual en toda la app.** Estaba escrito a mano en cada pantalla y las copias
  divergieron en las tres cosas que el usuario percibe: el **ícono** (unas con flecha, otras con
  chevron), el **tamaño** y la **separación**. Peor: dos textos traducidos traían la flecha como
  carácter (`"← Volver al inicio"`), así que donde había ícono se veían **dos flechas** y donde no,
  una flecha de texto desalineada — eso es lo que se ve en el pie del inicio de sesión.

  Ahora hay una sola fuente: `BackLink` (la miga de pan sobre el título) y `BackButton` (el botón
  para salir de una vista embebida), migrados en las 16 apariciones. La distinción que se fija es
  que **el chevron no es "volver"**: es "el anterior de una serie" (mes previo, diapositiva previa,
  pregunta previa), y usarlo para salir enseña que el control es de paginación, así que el usuario
  no lo busca cuando quiere irse. Donde sí es una serie —calendario, paginación, revisión del Reto,
  pestañas de la pizarra— el chevron se queda.

  De paso: el botón "volver" de móvil en Mensajes y los de las vistas de examen, taller y proyecto
  envolvían un `<Button>` dentro de un `<Link>`, que anida un `<a>` alrededor de un `<button>`; el
  componente usa `asChild` y eso desaparece.

- **La Política de Privacidad ahora dice lo que la plataforma realmente hace.** Pasó de 12 a 16
  secciones, con índice para no barrer el documento entero buscando "mis derechos". Lo que faltaba
  no era redacción, era **contenido verificable**: quedó explícito quién es responsable (tu
  institución) y quién encargado (ExamLab) según la Ley 1581 de 2012; qué señales registra la
  supervisión de exámenes —cambiar de pestaña, copiar, pegar, salir de pantalla completa, intentos
  de captura— y, sobre todo, **que durante un examen no se activa la cámara ni el micrófono y no se
  graba la pantalla**; que para detectar copia las entregas de una misma actividad se comparan entre
  sí; que la IA sugiere nota y detecta texto generado pero **decide el docente**, con derecho a que
  te expliquen el señalamiento; para qué se pide la cámara (solo leer el QR de asistencia, la imagen
  no sale de tu dispositivo) y las notificaciones; que hay transferencia internacional porque varios
  proveedores están fuera de Colombia; los seis derechos del titular con la vía real para ejercerlos
  (admin de la institución → módulo Soporte); y el tratamiento de datos de menores de edad.

  También quedaron por escrito tres compromisos que hoy son ciertos y son fáciles de romper sin
  darse cuenta: **no recogemos ubicación, no usamos analítica de terceros y no entrenamos modelos con
  datos personales.** El archivo lleva la lista de dónde se verifica cada uno, para que quien agregue
  una función se entere de que la política dejó de ser verdad.

- **La plataforma cambió de dirección: ahora es `app.examlab.workers.dev`.** El sitio se hospeda en
  Cloudflare y cada institución tiene además su propia dirección (`uniaj.…`, `fesna.…`), que entra
  directo sin pedir que elijas institución. **`examlab.lovable.app` sigue abriendo, pero quedó
  congelado**: muestra la versión anterior de la app sobre los datos de hoy, así que quien lo tenga
  en favoritos ve una plataforma vieja sin enterarse. Se actualizaron los manuales (y sus PDF), los
  correos de bienvenida y las guías de configuración para que todos apunten a la dirección nueva.

- **Los listados del docente ahora se filtran por periodo y asignatura, no solo por curso.** Con
  varios semestres cargados, el filtro de curso era una lista larga donde había que reconocer el
  nombre exacto. Ahora Estudiantes, Exámenes, Talleres, Proyectos y Contenidos traen dos filtros más
  y se encadenan: al elegir un periodo, el selector de curso ya solo ofrece los de ese periodo. Los
  filtros aparecen solo cuando hay más de un valor para elegir, así que un docente con un único
  semestre no ve controles de más.

- **Se quitó del inicio de sesión el enlace "Soy del equipo de plataforma".** Solo servía para
  revelar una opción del selector de institución que rechaza a cualquiera que no sea del equipo, y
  quien entra por esa pantalla es casi siempre un estudiante o un docente. No se pierde nada: al
  equipo de plataforma le basta entrar por una institución y cambiar de rol dentro de la app.

- **El estudiante ya ve en qué grupo está y cómo se evalúa el curso.** Al entrar a un curso solo veía
  el nombre, el periodo y el rango de fechas: ni su **grupo** —y dos cursos de la misma asignatura se
  distinguen SOLO por el grupo— ni cómo se reparte la nota. Ahora la cabecera muestra **Grupo**,
  **código de la asignatura** y **semestre** junto al periodo, y debajo aparece **"Cómo se evalúa este
  curso"**: una tarjeta por corte con su porcentaje, su ventana de fechas y el desglose por tipo
  (exámenes, talleres, proyecto, asistencia), más la escala y la nota de aprobación.

  Los porcentajes se presentan **como % de la nota FINAL del curso**, que es el modelo real de
  ExamLab, y el texto lo dice explícitamente: mostrarlos como si fueran relativos al corte le mentiría
  al alumno sobre cuánto vale cada cosa. Los rubros que valen 0% no se listan (el corte 3 no lleva
  talleres porque ese peso lo toma el proyecto).

  **Por qué no alcanzaba lo que ya existía:** la sección "Evaluación por cohorte" se alimenta del RPC
  `get_course_cohort_weights`, que exige **filas de asignación** por estudiante
  (`exam_assignments` / `workshop_assignments` / `project_assignments`). Verificado con token de
  estudiante real en los 4 cursos de UNIAJ: devuelve **0 filas**, así que la sección no se renderizaba
  y el alumno no veía ningún porcentaje. Son dos preguntas distintas —"¿cómo se divide la nota?" vs.
  "¿qué me asignaron a mí?"— y ahora la primera se responde siempre, desde el primer día del semestre.
  Nada nuevo en la base: `courses.grupo/code/semestre` y `grade_cuts` ya existían y el estudiante ya
  los podía leer.


- **Una dirección propia por institución (`uniaj.midominio.co`), sin selector.** Hasta ahora, al
  entrar había que elegir la institución en una lista, y el enlace no decía a cuál se entraba: no se
  podía mandar "este es el acceso de tu universidad". Ahora, cuando la plataforma se sirve con un
  subdominio por institución, la dirección la define y **el selector desaparece** — en su lugar se
  muestra el nombre de la institución como dato.

  Es **aditivo**: sin subdominio (hoy, `examlab.lovable.app`) todo funciona exactamente igual, con
  su selector. Un subdominio que no corresponde a ninguna institución tampoco deja a nadie afuera:
  vuelve a aparecer el selector.

  El manual de configuración —incluida una vía **sin costo**— está en
  **[docs/subdominios-cloudflare.md](docs/subdominios-cloudflare.md)**. No hace falta abandonar
  Lovable: los dos pueden convivir porque la base de datos es la misma.


- **Amazon Bedrock como proveedor de IA.** Se suma a Google Gemini y OpenAI en Configuración → Modelo
  IA: se elige el proveedor, el modelo y la región, y se puede poner una API key propia por
  institución. Si una institución no pone la suya, usa la de la plataforma sin configurar nada. Los
  modelos disponibles son `openai.gpt-oss-120b-1:0` y `openai.gpt-oss-20b-1:0`.

  Mantiene todo lo que ya existía: la lista de keys de respaldo con rotación automática cuando una
  falla, y el diagnóstico del sistema que avisa si falta la key del proveedor activo.


- **La hoja de SQL de la pizarra ahora se entiende.** Tenía dos editores de SQL y nada decía cuál
  era cuál: uno se titulaba por su contenido ("Esquema y datos de partida") y el otro por su
  tecnología ("PostgreSQL real, en tu navegador"), así que no quedaba claro dónde escribir ni que
  el de arriba se ejecuta antes que el de abajo. Ahora los pasos van numerados —**1 · Esquema** y
  **2 · Consulta**—, debajo del esquema aparecen **las tablas que quedaste definiendo** (con 30
  líneas de CREATE TABLE ya no hay que releerlas para recordar si la tabla era `cliente` o
  `clientes`), y el editor vacío dice qué hacer en vez de no mostrar nada.

  Además se hizo visible lo que más desconcertaba: **cada ejecución empieza con una base nueva**.
  Quien insertaba una fila y en la corrida siguiente no la encontraba no tenía nada en pantalla que
  se lo explicara. Y el aviso de que la primera ejecución descarga el motor (~16 MB) ahora se ve
  ANTES de pulsar Ejecutar, no recién durante la espera.

  Dos textos de la hoja hablaban del "estudiante" (venían de los exámenes) cuando ahí no hay
  estudiante: es el docente escribiendo su propia demostración. Corregidos.


- **El buscador (⌘K) ahora encuentra cosas, no solo módulos.** Antes solo ofrecía las opciones del
  menú lateral: escribir el nombre de un examen o de un taller no daba nada y había que entrar al
  módulo y volver a buscar adentro. Ahora, con dos letras, busca **cursos, exámenes, talleres,
  proyectos, material y pizarras** (y usuarios, si sos administrador) y te lleva directo al que
  elegiste. Cada resultado muestra el curso al que pertenece, porque dos talleres se pueden llamar
  igual en cursos distintos. Además ya no importan las tildes ni las mayúsculas: escribir
  "matematicas" encuentra "Matemáticas". El estudiante busca lo que tiene asignado y las pizarras
  compartidas con sus cursos; el docente, lo de los cursos que dicta.

- **Generar SQL con IA mientras se dicta la clase.** En la hoja SQL de la pizarra el docente ahora tiene
  una caja donde pide en español lo que quiere mostrar —"una tabla de clientes y otra de pedidos con 10
  filas", "la consulta del cliente con más pedidos", "un permiso de solo lectura"— y recibe el SQL **ya
  comentado**, listo para explicar línea por línea. Con dos botones lo lleva a donde lo necesita: *Usar
  como esquema de partida* (para armar la base de prueba) o *Insertar en el editor* (para ejecutarlo).
  Cubre creación de tablas, inserción y modificación de datos, consultas (uniones, agrupaciones,
  subconsultas, funciones de ventana) y permisos. Si ya hay un esquema de partida escrito, la IA lo usa
  como referencia para no inventar tablas que no existen. Lo generado **se agrega al final** de lo que ya
  estaba: nunca reemplaza el trabajo del docente. El texto que guía a la IA es editable desde
  Configuración → Prompts (categoría **Pizarras**), como el resto de los prompts de la plataforma.

- **Preguntas de base de datos con PostgreSQL real.** El estudiante escribe SQL y lo ejecuta contra un
  Postgres de verdad que corre **en su propio navegador** — sin instalar nada, sin cuenta y sin conexión
  a ningún servidor de base de datos. El docente define el esquema y los datos de partida; cada
  ejecución arranca de una base limpia, así que correr dos veces da el mismo resultado. Sirve en
  exámenes, talleres, proyectos y banco de preguntas, y la IA la califica leyendo la consulta **y las
  tablas que devolvió**. La primera ejecución descarga el motor (~16 MB): conviene probarlo antes de la
  clase si el WiFi del salón es lento.
- **Hoja SQL en la pizarra.** Tercera hoja "ejecutable" junto a código y consola: el docente muestra una
  consulta SQL en vivo contra el mismo motor PostgreSQL real (PGlite/WASM) de la pregunta `bd_sql`, sin
  crear un examen ni un taller. Incluye un panel colapsable de "Esquema y datos de partida" (mismos
  CREATE TABLE / INSERT que el docente pondría en una pregunta). El alumno que ve la pizarra compartida
  puede ejecutar la consulta para probarla, pero ni el esquema ni la corrida se persisten desde su lado
  — mismo trade-off que las hojas de código/consola. Reusa `SqlRunner`/`sql-answer.ts` tal cual (mig
  `20261610000000_whiteboard_pages_sql.sql`, columnas `sql_setup`/`sql_answer` en `whiteboard_pages`).

### 🔧 Correcciones

- **Crear tablas desde el editor de la hoja de SQL ahora surte efecto.** Escribir un `CREATE TABLE` en
  el editor y ejecutar podía dejar la tabla sin crear, con un error que apuntaba a otra línea. La causa:
  la hoja se mandaba completa en una sola llamada, y Postgres ejecuta un lote de sentencias dentro de
  una **transacción implícita** — así que *cualquier* error revertía todo lo anterior. Con el guion de
  la captura del reporte (un `SELECT` a una vista que no existía, y debajo el `CREATE TABLE`), la
  creación se deshacía y la consulta siguiente fallaba diciendo que la tabla no existe: dos errores en
  cascada de los cuales el usuario no había cometido ninguno en el `CREATE`.

  Ahora cada sentencia se ejecuta por separado y la corrida **sigue después de un error**: lo que estaba
  bien surte efecto y cada error queda al lado de la sentencia que lo produjo, en vez de un único
  mensaje que se atribuye a toda la hoja. Partir el guion no se puede hacer con un `split(";")` —un
  punto y coma dentro de un literal, de un comentario o de un bloque `$ … $` de plpgsql partiría la
  sentencia al medio y el motor recibiría SQL inválido—, así que la partición vive en un módulo puro con
  tests, verificado además contra un PostgreSQL real: una función plpgsql con `;` adentro y un literal
  `'uno; dos'` sobreviven intactos.

  Y al ejecutar **una selección**, ahora corre antes lo que está más arriba en la hoja (sin mostrar sus
  resultados), igual que ya corría el esquema de partida. Con base nueva en cada ejecución, una consulta
  suelta no tenía contra qué correr si su tabla se creaba tres líneas más arriba: seleccionar una línea
  y ejecutar devolvía "la tabla no existe". Si alguna de esas sentencias previas falla se avisa cuántas
  fueron, porque es justamente la causa de que la selección falle.

- **Shift+Enter baja renglón en la caja del generador de SQL de la pizarra.** Era un campo de una sola
  línea, así que la tecla no tenía dónde escribir el salto; y el manejador atajaba *cualquier* Enter, de
  modo que Shift+Enter generaba en vez de bajar. Ahí se describe un esquema entero ("clientes y pedidos,
  10 filas, un GRANT de solo lectura"), así que ahora son dos renglones que crecen, y la pantalla dice
  el atajo. La regla quedó en un helper con tests en vez de repetida por pantalla —es exactamente el
  olvido que causó el bug— y de paso cubre la composición de un IME, donde Enter confirma el candidato y
  no debe enviar. Auditado el resto de las cajas: el asistente, el tutor y el composer de mensajes ya
  estaban bien.

- **Volver a escanear el QR ya no vuelve a marcar la asistencia: avisa que ya estaba.** Antes cada
  re-escaneo sobrescribía el registro y respondía "asistencia registrada" otra vez, así que el
  estudiante que escaneaba de nuevo —porque no vio el mensaje, porque recargó, porque el QR seguía
  proyectado— no tenía forma de saber si había marcado dos veces. Ahora dice "tu asistencia ya estaba
  registrada".

  Y lo más importante, que no se veía: como el registro se sobrescribía con "presente", un estudiante
  al que el docente había marcado **tardanza** podía volver a escanear y quedar presente — el propio
  interesado borrando la decisión del docente, sin dejar rastro. Ahora el estado que ya está puesto no
  se toca, y si es distinto de "presente" el estudiante lo ve en pantalla. Corregir un estado sigue
  siendo del docente, desde su grilla.

- **Se podía abrir un check-in de asistencia sobre una sesión que estaba en la papelera** — y también
  sobre una sesión cuyo curso entero estaba borrado. Lo primero es una regresión: el bloqueo existía y se
  perdió al reescribir la función para el modo de fechas. Lo segundo nunca había existido en ese camino,
  y era peor de lo que parece: borrar un curso no apaga el check-in de sus sesiones, así que un curso en
  la papelera podía seguir teniendo asistencia abierta. Los dos bloqueos están ahora, y con ellos el
  nombre de un curso borrado ya no puede aparecer en la página pública.

- **Iniciar el check-in con QR fallaba con «function gen_random_bytes(integer) does not exist».** La
  función que abre la ventana genera una semilla aleatoria con pgcrypto, que en esta base vive en un
  esquema aparte; al reescribirla para agregarle el modo "solo con el correo" se copió una versión
  vieja —anterior a un arreglo de mayo— y se perdió la referencia a ese esquema. No falló al
  desplegarse: falló recién cuando alguien intentó abrir un check-in.

  Buscando el mismo defecto en todas las funciones de la base apareció una segunda igual de rota:
  la que genera el **enlace público de una encuesta**. Nadie la había reportado porque el único enlace
  que existe se creó por otra vía, pero desde la app habría dado el mismo error. Las dos arregladas.

  Y para que no vuelva: hay un test que recorre todas las migraciones, se queda con la versión vigente
  de cada función y falla si alguna llama a pgcrypto sin poder resolverlo. Verificado devolviéndole el
  defecto a propósito: el test lo detecta. Era la tercera vez que este error entraba al proyecto por el
  mismo camino —alguien reescribe una función partiendo de la primera versión que encuentra, no de la
  vigente— y un comentario en la migración vieja no lo evitaba, porque quien la reescribe no la lee.

- **La plantilla del Acuerdo Pedagógico seguía con los datos de un curso concreto, aunque el cambio
  decía estar hecho.** Los objetivos de Programación II y su tabla de cortes con fechas de 2026-1
  seguían escritos dentro del documento en producción. La causa: la plantilla se sembró con una
  migración, esa migración YA se había aplicado, y la generalización se hizo **editando ese mismo
  archivo** — que el pipeline salta, porque una migración aplicada no se vuelve a correr. El cambio
  quedó en el repositorio y nunca llegó a la base, sin ningún error que lo delatara.

  Ahora la plantilla se actualiza de verdad. Todo lo que depende del curso sale de los datos: programa,
  nombre, grupo, semestre, periodo, docente, fecha, los objetivos de la asignatura, el total de
  asistentes y la tabla de evaluación completa (cortes con peso, fechas y distribución). Lo único que
  no es general es la **lista de firmas** — ahí van los estudiantes concretos del curso, que es el
  punto del documento. Y lo que queda como texto fijo es solo lo que pertenece al formato: los rótulos,
  las etiquetas de firma y una indicación de qué escribir en la sección metodológica.

- **El examen ya no exige instalar nada en el iPhone: abre en Safari y se puede presentar.** El
  arreglo anterior aceptaba la app instalada como equivalente a la pantalla completa, y eso sigue
  valiendo, pero dejaba al alumno dependiendo de instalar — un paso que ni él ni nosotros podíamos
  garantizar, porque depende de cómo se comporte iOS al crear el ícono.

  La raíz es una distinción que el código no hacía: **no querer** entrar a pantalla completa y **no
  poder** se veían iguales. Las dos terminaban en "no hay pantalla completa" y las dos bloqueaban.
  Bloquear a quien no quiere ES la función del proctoring. Bloquear a quien no puede —porque su
  plataforma no tiene esa API, como el iPhone— no protege nada: deja el examen inalcanzable y no
  existe ninguna acción del alumno que lo resuelva.

  Ahora se distinguen. En un iPhone el examen **abre en ventana normal**, se le avisa al alumno con
  claridad (no como error suyo) y queda registrado para que el docente sepa que esa entrega corrió sin
  pantalla completa. Donde el navegador SÍ puede y no la activó —rechazo del usuario, permiso
  denegado— se sigue bloqueando igual que antes.

  Y lo que se pierde es menos de lo que suena: **la señal "salió de pantalla completa" no existe en
  iOS de ninguna manera**, instalada la app o no. Lo que detecta que el alumno se fue a otra parte
  —cambio de app, pestaña oculta, pérdida de foco, copiar y pegar— funciona igual en Safari. Exigir
  pantalla completa en iPhone no aportaba una señal extra; solo cerraba la puerta.

  Se arregló además una trampa del examen **reanudado**: al recargar, la pantalla mostraba un panel
  "Reanudar" cuyo botón llamaba a una API inexistente. No fallaba ni avisaba: simplemente no pasaba
  nada, y el alumno quedaba mirando un botón muerto encima de su examen ya empezado.

  Verificado en el motor real de Safari con viewport de iPhone: en pestaña deja rendir, con la app
  instalada también, y en escritorio con la pantalla completa rechazada sigue bloqueando.

- **En el iPhone, el examen no se podía presentar — y la instrucción que daba la pantalla era falsa.**
  El mensaje le decía al alumno «instala la app desde Safari y vuelve a abrir el examen desde el
  ícono». Instalarla **no cambiaba nada**, por dos razones encadenadas.

  La primera: en iPhone **no existe la pantalla completa** para elementos de una página (solo la
  tienen los videos). Está medido, no supuesto: con user-agent y viewport de iPhone, ni
  `requestFullscreen` ni su versión prefijada existen. El examen exigía pantalla completa, en iPhone
  no hay, y no había alternativa prevista: callejón sin salida. Ahora se acepta la **app instalada**
  como equivalente — una ventana sin barra de direcciones, sin pestañas y sin botón de atrás, que
  para el propósito del examen cumple lo mismo y se abandona menos fácil que un fullscreen que se
  sale con Esc.

  La segunda: **a la app le faltaba lo que la vuelve instalable como app en iOS.** Sin el meta
  `apple-mobile-web-app-capable`, "Añadir a pantalla de inicio" en iPhone crea un ícono que abre una
  **pestaña normal de Safari**, con la barra de direcciones puesta. Así que incluso con lo anterior
  arreglado, el alumno instalaba y seguía sin poder rendir. Ya está declarado, junto con el título y
  el estilo de la barra de estado.

  Verificado en WebKit real (el motor de Safari) contra el sitio ya publicado: en una pestaña de
  Safari en iPhone el examen sigue bloqueando —lo correcto— y con la app instalada deja rendir. Y el
  motor de instalación de Chrome, consultado por CDP contra producción, no reporta **ningún** error de
  manifest ni de instalabilidad, y ofrece instalar: la cadena PWA (manifest, íconos 180/192/512
  válidos, service worker activo) está sana. Lo único que ninguna de esas pruebas puede ejercitar es
  que iOS honre el meta al crear el ícono desde el menú Compartir — eso es comportamiento del sistema
  operativo, no de la página, y se comprueba en el teléfono viendo si la app abre **sin** barra de
  direcciones.

  La barra de estado de la app queda **opaca** y no translúcida, aunque translúcida se vea mejor: con
  la vista web metida bajo el reloj, `env(safe-area-inset-top)` deja de ser 0 y la barra superior del
  móvil —que tiene alto fijo— pasa de 56 px útiles a 9 px y se recorta el menú, la marca y la
  campana. Está medido. Aprovechando el hallazgo, esa barra ahora **crece** con el inset en vez de
  aplastar su contenido, y el padding del contenido la sigue: con inset 0 —lo de hoy— se ve idéntico,
  así que la trampa queda desarmada sin cambiar nada de lo que ya funcionaba.

  De paso, los prefijos `webkit` de la API quedaron centralizados en un módulo
  (`src/shared/lib/fullscreen.ts`), donde antes estaban a mano en siete lugares. **No eran la causa**
  —en el Safari de escritorio actual la API sin prefijo ya existe— pero siguen siendo el único camino
  en Safari anterior a 16.4, y ese Safari emite el evento de salir de pantalla completa **solo**
  prefijado: sin escucharlo, esa advertencia no se registraba. El mismo hueco estaba en otras cinco
  pantallas que nadie reportó porque no bloquean un examen: proyectar el QR de asistencia, proyectar
  el Reto en vivo (ahí era un `TypeError`, no un fallo silencioso), la hoja de texto y la pizarra, y
  el auto-colapso del menú lateral.

- **El campo de contraseña ya no aparece como una caja blanca al iniciar sesión.** En tema oscuro, si
  el navegador tenía la contraseña guardada, ese campo se veía **blanco** entre campos oscuros. No era
  un color mal puesto: Chrome pinta su propio fondo (`rgb(232, 240, 254)`) encima de todo campo que
  autocompleta, y los campos de ExamLab son transparentes a propósito —muestran la superficie que
  tienen detrás—. Por eso chillaba solo la contraseña: el correo lo prellena la app desde
  "Recordarme", así que el navegador no lo marca como autocompletado y quedaba oscuro.

  Ese fondo no se puede sobrescribir con un color: el navegador lo aplica como estilo interno y gana.
  El arreglo recorta el fondo pintado a la silueta de las letras y neutraliza la transición con la que
  Chrome lo aplica, así que el campo vuelve a ser transparente y el texto sigue legible. Medido en
  Chromium: el interior del campo pasa de `232,240,254` al color del fondo de la página. Va en los
  estilos base, así que cubre **todos** los formularios —restablecer contraseña, cambio forzado en el
  primer ingreso, cambio de contraseña, paneles de admin— y también el autocompletado de correo o
  dirección, no solo el login.

- **Los números de las gráficas se veían distinto según el idioma del equipo.** En el detalle de una
  gráfica, un valor como 1234 aparecía «1,234» en un computador configurado en inglés y «1.234» en uno
  en español, en la misma pantalla. Ahora todos los números usan el formato de Colombia, igual que ya
  hacían las fechas y los porcentajes.


- **Barrido de los nueve principios de UI.** El calendario del docente se veía más angosto y con más
  aire arriba que el resto de los módulos, porque repetía por su cuenta el margen que ya pone la
  aplicación. Lo mismo, en menor medida, en la política de privacidad, la calculadora de precios y
  tres pantallas de detalle del estudiante. Y en la toma de examen el margen se sumaba dos veces.
  Ahora todas parten del mismo margen, así que el contenido no salta al cambiar de módulo.

- **Dos grids tenían una columna de más.** En Cursos, la *Escala* de notas, y en Banco de preguntas,
  los *Puntos*: las dos son configuración que se fija una vez y no ayudan a decidir sobre una fila,
  pero comprimían el nombre —el dato que sí identifica la fila—. Ahora aparecen solo en pantallas
  anchas. En monitores grandes no cambia nada.


- **El módulo de Errores no mostraba nada, y ahora además solo muestra lo que importa.** Eran dos
  cosas. Primero, la lista fallaba entera: pedía un dato con un tipo equivocado y la consulta se
  caía antes de devolver la primera fila, así que Admin y SuperAdmin veían el módulo vacío en todas
  las instituciones. Segundo, el 88% de lo que se registraba como error eran correos que el propio
  sistema iba a reintentar solo (Gmail responde "probá más tarde" cuando se le manda una ráfaga):
  3.334 entradas, de las cuales 2.936 no requerían que nadie hiciera nada, y entre tanto ruido un
  problema real —un buzón que no existe, el correo mal configurado— pasaba desapercibido. Ahora un
  fallo que se va a reintentar queda como advertencia y se marca como error solo cuando el correo
  de verdad se perdió; el registro completo se conserva igual.

- **Al cerrar un curso ya se cierra TODO lo suyo, incluidas las actividades externas.** Reporte:
  exámenes de cursos del periodo anterior seguían apareciendo como **Publicado** en el grid del docente,
  mezclados con los borradores del periodo nuevo. Eran dos cosas distintas: las actividades marcadas como
  **externas** se excluían del cierre (así que un "Parcial I" externo quedaba publicado para siempre), y
  los cursos que ya estaban finalizados desde antes nunca habían pasado por el cierre en cascada. Ahora se
  cierran talleres, parciales, proyectos, pizarras, encuestas y foros — y una corrección de una sola vez
  pone al día los cursos viejos de todas las instituciones. Cerrar una actividad externa **no** impide
  registrar ni corregir sus notas.

- **Duplicar una pizarra ahora preserva el contenido de las hojas de código/consola/SQL.** El agente de
  consistencia detectó que `duplicateWhiteboard` (`app.teacher.whiteboards.index.tsx`) solo copiaba
  `scene_json`/`page_type` desde que se introdujeron las hojas 'code'/'console' (mig `20261410000000`) —
  una pizarra duplicada con esas hojas nacía con el editor en blanco, perdiendo el lenguaje/fuente de
  código y el esquema SQL preparado por el docente. Ahora copia también `text_content`, `code_language`,
  `code_source` y `sql_setup` (el CONTENIDO reutilizable), pero deliberadamente NO copia la evidencia de
  ejecución (`last_stdout/stderr/exit_code/executed_at`, `console_transcript`, `sql_answer`) — mismo
  criterio que "Duplicar sesión" (`copySnippets` excluye su caché `last_*`): la copia es una plantilla,
  no el historial de una corrida puntual.
- **Un docente ya no ve cursos ni material de cursos que no dicta.** Reporte: *"un usuario que es docente
  y administrador, desde el rol docente puede ver cursos de los que no es docente"*. Afectaba a cualquier
  docente —la combinación con Admin solo lo hizo evidente— y llegaba más lejos de lo reportado: en
  Exámenes, Talleres y Proyectos el selector de curso **también era el del formulario**, así que se podía
  crear contenido en un curso ajeno; y en la **papelera** se podía restaurar o eliminar definitivamente el
  material de un colega.

- **El calendario del estudiante ahora se lee como un calendario, y ya no abre con una dirección para
  copiar.** El mes ocupaba todo el ancho: en un monitor grande cada día quedaba como una franja de
  218 × 40 píxeles, que no se lee como calendario sino como una tabla vacía. Ahora el mes va **al lado**
  de la lista de eventos, con la misma proporción que ya tiene el calendario del panel de inicio; en
  celular y tablet se siguen apilando. La búsqueda y los filtros pasaron adentro de la columna de la
  lista —que es lo único que filtran— y un texto al pie lo aclara, para que nadie reporte como falla
  que el mes "no les hace caso".

  Además se quitó el bloque **"Suscribir a tu calendario"**, que era lo primero y más grande de la
  pantalla y mostraba una dirección larga para copiar en Google/Outlook/Apple: eso es el mecanismo, no
  la tarea del estudiante, que entra a ver qué tiene esta semana. **Quien ya se suscribió sigue
  recibiendo sus eventos** —el servicio no se apagó—, pero hoy no queda desde dónde obtener esa
  dirección ni cambiarla si se compartió por error. Si se decide volver a ofrecerla, el lugar es una
  opción del perfil, no el encabezado del calendario.

### Interno (equipo)

- **`.env` estaba trackeado en un repositorio público.** `.gitignore` lo lista desde hace mucho, pero
  `.gitignore` **no aplica a lo que ya está tracked** — y el repo es `visibility=public`. De sus 7
  variables, 6 no son secretas (URL de Supabase, project id y la publishable/anon key, que ya viaja
  en el bundle por diseño). La séptima sí: una `VITE_PRIVATE_KEY` que **es la VAPID private key de
  producción**, confirmado derivando su punto público y comparándolo con `VITE_VAPID_PUBLIC_KEY` —
  x e y coinciden. Se destrackeó el archivo (la copia local se queda), pero **destrackear no remedia
  nada**: la historia del repo la sigue teniendo, así que la única solución es rotar el par, y eso
  invalida todas las suscripciones push existentes. Queda anotado para decidirlo, no aplicado.

  Dato que acota el riesgo de hoy: con la privada se puede firmar como servidor de aplicación, pero
  para entregarle a alguien hacen falta su `endpoint` y sus claves, y `push_subscriptions` tiene RLS
  `USING (user_id = auth.uid())`. El peligro es la combinación, no la clave sola.

- **`deploy-secrets.yml` nunca había seteado un solo secret.** Busca 25 nombres y **ninguno estaba
  cargado**: el repo tiene 8 secrets y ninguno de esa lista, sin *environments* que los aporten.
  Comprobado con un `dry_run`, que imprime "No hay ningun secret cargado — nada que setear" y
  termina en verde: un workflow que no hace nada y no falla. Los secrets de las edge functions
  vivían puestos directamente en Supabase. Se cargó `APP_PUBLIC_URL=https://app.examlab.workers.dev`
  y se aplicó (`✓ 1 secret(s) aplicados`) — es el valor que arma el enlace absoluto de TODO correo
  que manda la plataforma, y con el host viejo o vacío el correo sale igual pero con el botón roto.

- **Barrido de la documentación tras el cambio de hospedaje.** La migración a Cloudflare actualizó
  `CLAUDE.md` en su sección de despliegue, pero dejó afirmaciones viejas repartidas en 20 archivos que
  no son inertes: **inducen a hacer lo incorrecto**. Los tres casos que más costaban:
  `docs/correo-google-smtp.md` y `MIGRATION-GUIDE.md` decían configurar `APP_PUBLIC_URL` y el *Site
  URL* de Supabase Auth con el host congelado —seguir esa guía hace que TODO correo que manda la
  plataforma enlace a la app vieja—; el recorder de videos demo tenía `examlab.lovable.app` como
  default **y también en el `tenant-info.json` de la copia de trabajo, que le gana al default**, así
  que re-grabar habría filmado la UI anterior; y `examlab-dev.md` (el agente de ingeniería, que un
  subagente lee sin heredar nada más) instruía "el usuario hace clic en Publish en Lovable", que hoy
  es justo lo que CLAUDE.md prohíbe porque rompería ese sitio. Se corrigieron además los 7 correos
  plantilla, los 4 manuales **y sus PDF** (`bun run manual:pdf`), SSO-SETUP, el plan de pruebas y la
  memoria del proyecto. Se dejaron intactas a propósito las menciones que son correctas: el host
  aparece en `subdomain.ts` como host de plataforma reconocido, y en `docs/archive/` como historia.

  Dos datos verificados contra la realidad, no contra los documentos: el manual anunciaba el despliegue
  en `examlab.castano-julian.workers.dev`, que **no resuelve** (los 5 hosts que sí responden 200 son
  `app`, `uniaj`, `fesna`, `examlab-demo` y `demo-global-corp` sobre `.examlab.workers.dev`); y el
  error `vite.config.ts(79,3) TS2769` que aparece en `tsc --noEmit` **ya venía** con esos commits
  (comprobado en un worktree limpio de `origin/main`), no lo introdujo este trabajo.

- **Los filtros de periodo/asignatura salieron a un helper puro con tests.** `courseIdsInScope`
  ([course-filter-scope.ts](src/modules/courses/course-filter-scope.ts), 12 tests) existe para fijar
  UNA distinción: `null` = "no hay filtro" vs. conjunto vacío = "hay filtro y no matchea nada".
  Colapsarlas esconde la tabla entera o deja de filtrar — el mismo error que `course-scope.ts`
  documenta con los `[]` de PostgREST. Los talleres y proyectos usan la variante M:N
  (`anyCourseInScope`) porque son compartidos entre cursos y exigir que TODOS cumplan le escondería
  al docente su propio trabajo.

- **Los submódulos de `universidades/` ahora se sincronizan solos, todos los días.** Antes dependían de
  que alguien corriera `scripts/update-universidades.sh` a mano, así que el material podía quedar
  semanas atrás sin que nada avisara. El 2026-08-20 eso costó caro: el submódulo llevaba 10 días sin
  sincronizar y una validación de los 4 cursos UNIAJ 2026-2 se hizo contra ese snapshot. El informe
  salió **completamente invertido** —afirmaba que el periodo era 10/08 con 15 clases presenciales
  cuando los documentos vigentes dicen 24/08 con 13 sesiones virtuales— y seguirlo habría desalineado
  los 4 cursos a cuatro días del inicio de clases. **El material desactualizado no da error: da
  respuestas equivocadas con cara de correctas.**

  El workflow nuevo (`sync-universidades.yml`, diario a las 06:20 UTC + manual) **reutiliza el script**
  en vez de reimplementar la lógica: el script sigue siendo la fuente única de la semántica del sync
  (`--remote --merge`, commit de trazabilidad, salir sin hacer nada si no hubo cambios) y el workflow
  solo le da el entorno y publica. Si mañana cambia cómo se sincroniza, se cambia en un solo lugar.

  Tres cosas que se cuidaron: sin cambios **no hay commit** (nada de commits vacíos diarios); un push
  con `GITHUB_TOKEN` **no dispara otros workflows**, así que no se puede autoinvocar en bucle; y si un
  submódulo vuelve a privado el checkout **falla ruidosamente**, que es preferible a sincronizar a
  medias en silencio. Tiene `dry_run` para probarlo sin publicar.

  Medido antes de confiarle el pipeline: la ruta más larga del material es de **215 caracteres** y el
  componente más largo de **97**, ambos muy por debajo de los límites de Linux (4096 / 255). El clon
  recursivo falla en Windows solo cuando la carpeta destino agrega prefijo suficiente para pasar los
  260 caracteres — es un límite del sistema local, no del runner.


- **El cron que drena la cola de generación de IA no existía, y se encontró por qué.** La migración
  `20260603080000` debía crear `ai-generation-worker-hourly`, pero de los 25 jobs de pg_cron en
  producción ese no estaba: cuando un docente pedía "generar con IA" en modo async, el job quedaba en
  `ai_generation_queue` **para siempre** salvo que alguien entrara al módulo Cron y pulsara "Procesar
  todos". Un encolado que no se procesa se lee como "la IA está rota".

  Tres causas, las tres confirmadas con datos:
  - Usaba **`extensions.net.http_post`**, que no existe: pg_net vive en el schema `net` y Postgres
    responde *"cross-database references are not implemented"*. No es teoría: es el error exacto con
    el que **`calendar-recordings-sync-6h` viene fallando cada 6 horas** en producción, con el mismo
    anti-patrón (ver abajo).
  - Resolvía la URL con `format()` **al crear** el job, así que si la GUC estaba vacía el comando
    nacía con `url := NULL` y fallaba en cada corrida.
  - Envolvía todo en `EXCEPTION WHEN OTHERS THEN RAISE NOTICE`, así que su propio fallo era invisible
    y la migración quedaba "aplicada" sin haber creado nada.

  La nueva (`20261660000000`) sigue el patrón de los 23 crons que **sí** funcionan: el comando llama a
  una función SQL (`public.trigger_ai_generation_worker()`) que resuelve la configuración **en cada
  ejecución** y usa `net.http_post`. Y cuando la configuración falta **audita un warning en
  `audit_logs`** en vez de callarse — eso es lo que hizo que este cron estuviera meses ausente sin que
  nadie lo notara. Si no hay nada pendiente no hace nada, así que no gasta invocaciones ni cuota de IA.

  Probada contra Postgres 15 con stubs de `net`/pg_cron: sin pg_cron la migración termina en 0 con un
  aviso claro; con pendientes y sin configurar, audita nombrando la GUC que falta; sin pendientes no
  hace nada; y configurada, invoca el edge con la URL y el `Bearer` correctos.

  **Falta un paso manual** (un secreto no puede ir en una migración versionada): correr una vez en el
  SQL Editor `ALTER DATABASE postgres SET app.settings.supabase_url = '...'` y
  `... SET app.settings.service_role_key = '...'`. Hasta entonces el cron existe y avisa en Auditoría.

  **Y la primera versión de esta migración falló por la MISMA trampa que documenta.** Arreglé el
  `extensions.net.http_post` y dejé `extensions.cron.unschedule` / `extensions.cron.job`: nombre de
  tres partes → *"cross-database references are not implemented"*. El guard tampoco ayudó a detectarlo:
  preguntaba por `pg_extension`, así que en la base de prueba (sin pg_cron) el test **nunca entraba a
  la rama del cron** y el error quedó invisible hasta el deploy. Ahora el guard pregunta si
  `cron.schedule` es INVOCABLE (`to_regprocedure`), que es lo que de verdad importa y además se puede
  ejercitar con un stub del schema `cron`. Verificado entrando a la rama: crea el job, es
  re-ejecutable (no duplica) y la función sigue llamando al edge con la URL correcta.

- **La purga de la papelera estaba fallando todas las noches, y ya no.** `purge-deleted-items-daily`
  moría con *"No se puede editar el reto en vivo mientras hay un juego en vivo"*: al borrar un curso
  vencido, el cascade tocaba `kahoot_questions` y el trigger `tg_kahoot_block_edit_when_live` lo
  bloqueaba. La causa eran **dos juegos abandonados en estado `reveal` desde el 18/06** — sesiones que
  nunca se cerraron. Se cerraron con `kahoot_advance_game(..., 'end')` y la purga quedó desbloqueada.

  Queda la **clase** de problema: un reto en vivo que se abandona sin cerrar bloquea para siempre la
  edición de sus preguntas *y* la purga de la papelera de todo el sistema. Un job que cierre juegos
  inactivos (como `release-stuck-ai-grading-jobs` hace con la cola) lo resolvería de raíz.

- **`calendar-recordings-sync-6h` falla desde siempre** con el mismo `extensions.net.http_post`. Se
  deja reportado y NO se toca en esta migración: hay que decidir primero si ese cron sigue haciendo
  falta. El arreglo es el mismo patrón: mover el `http_post` a una función y usar `net.`.


- **La IA de toda la plataforma quedó caída ~5 h por la fila platform-default de Bedrock** (sin usuarios afectados, ver abajo). Al crear
  esa fila apuntando a `bedrock` sin tener cargado `AWS_BEARER_TOKEN_BEDROCK`, y estando las 5
  instituciones en `ai_mode='shared'` —el default—, `getActiveAiModel` empezó a resolver
  `provider='bedrock'` para todas: en modo compartido el `{...shared}` toma el PROVEEDOR de esa fila,
  no solo las keys. La cadena de candidatos quedó vacía y todas las llamadas cortaban con
  *"Falta la API key de Bedrock. Configúrala en Configuración → Modelo IA"* en tutor, calificación y
  generación. Las keys propias de Gemini de cada institución seguían ahí, pero no se usaban porque el
  proveedor activo era otro. El mensaje de error era claro, pero apuntaba al lugar equivocado: lo veía
  cada institución, que no había configurado nada mal y no podía resolverlo desde su propio panel.

  **Alcance real: no le pegó a nadie**, y conviene decirlo con la evidencia y no de memoria. Las dos
  colas de IA (`ai_grading_queue` y `ai_generation_queue`) tienen **0 jobs** en la ventana, y el
  último evento de un usuario real en `audit_logs` es del 18/08 21:31 UTC — durante toda la ventana
  no hubo ni un ingreso. Ojo con este método: los fallos de IA **no se auditan**, así que "0 eventos
  de auditoría" por sí solo no habría probado nada; lo que lo prueba es la ausencia de actividad de
  usuarios y de jobs encolados. Que no haya golpeado a nadie fue suerte de horario, no diseño.

  Corregido en producción (fila platform-default de vuelta a `gemini`/`gemini-2.5-flash`, con las
  columnas de Bedrock intactas) y **verificado con una llamada real a la IA**, no solo mirando la
  fila. Tres ajustes para que no vuelva a pasar:

  - **La migración siembra la fila con Gemini, no con Bedrock.** Una migración no puede saber si el
    secret está cargado en el entorno, así que no debe apostar a que lo esté. Bedrock queda
    disponible —columnas, failover, UI y región— pero se activa deliberadamente desde el panel
    DESPUÉS de cargar la key. Probado contra Postgres 15 con el esquema real: aplica, es
    re-ejecutable y no toca la fila si ya existe.
  - **El panel avisa antes de repetirlo desde la interfaz.** Cambiar el proveedor de la plataforma a
    uno sin key en la fila ahora muestra una advertencia con el radio de impacto ("las instituciones
    con IA compartida toman el proveedor de esta configuración"). Avisa, no bloquea: el env secret es
    una fuente legítima y el panel no puede verlo. Solo aparece al CAMBIAR el proveedor — en el
    estado normal (Gemini tomando la key del env) un aviso permanente no se leería.
  - **Se corrigió el comentario que hacía repetible el error**: decía que "los tenants ya no heredan"
    de la fila global, cuando heredan proveedor y modelo. Era la fuente de la suposición equivocada.

- **El diagnóstico de la key de IA miraba una fila arbitraria.** `health-check` tomaba "la fila más
  recientemente actualizada" de `ai_model_settings`, que con N instituciones es azar: si una guarda su
  configuración después de la de plataforma, el diagnóstico reporta el proveedor de esa institución y
  puede dar **verde con la IA compartida caída**; y una institución en `own` con su key en la base
  puede hacerlo reclamar un secret que la plataforma no necesita. Ahora lee la fila platform-default
  (`tenant_id IS NULL`), que es la que decide si la IA compartida funciona, y cae a la más reciente
  solo en entornos sin esa fila.

- **El caché de configuración de IA no tenía TTL.** Una entrada vivía lo que viviera la instancia del
  edge, así que cambiar de proveedor o rotar una key surtía efecto en un momento indeterminado — y lo
  mismo la RECUPERACIÓN de una configuración equivocada, que es cuando peor cae. `clearAiModelCache`
  existía pero **no lo llamaba nadie**, y no podría ayudar: corre en otro proceso que el que sirve la
  request. Ahora hay TTL de 60s: la desactualización queda acotada a algo explicable, al costo de una
  consulta por minuto por instancia.


- **El deploy de funciones ya no puede subir un despliegue a medias.** Un import mal formado en
  `tutor-chat` llegó a producción: `bun tsc --noEmit` NO cubre `supabase/functions` (son módulos
  Deno, fuera del tsconfig del front), así que el error de sintaxis recién apareció en el deploy —
  y como el workflow despliega función por función, subió 40 y falló en la 41.

  Ahora el workflow valida el parseo de **todas** las funciones ANTES de tocar el proyecto remoto:
  si algo no parsea, no se despliega nada. Usa `deno lint --json`, que separa los fallos de parseo
  (`.errors`) de los hallazgos de estilo (`.diagnostics`) — solo los primeros bloquean, porque el
  repo tiene 117 hallazgos de estilo preexistentes y bloquear por ellos sería ruido. Verificado
  contra una reproducción del error: reporta el mismo mensaje que dio el deploy y sale con código 1.

  **Y un segundo fallo silencioso, encontrado al desplegar el arreglo anterior:** el workflow
  clonaba con `fetch-depth: 2`, así que en un push de dos o más commits el commit base quedaba
  fuera del clon, `git diff <base> HEAD` fallaba con "unknown revision", y el `|| echo ""` del paso
  de detección convertía ese error en **"sin cambios detectados"**. El deploy terminaba en verde sin
  desplegar nada — dejando la función rota en producción con la apariencia de estar arreglada. Ahora
  el clon trae el historial completo, el `|| echo ""` se quitó (que muera el paso antes que mentir),
  y si el commit base no está en el clon —force-push— se despliega **todo** con un aviso: un deploy
  de más es barato, uno que no ocurre y no avisa no.

- **La migración de Bedrock asumía el nombre de una constraint y fallaba.** Hacía
  `DROP CONSTRAINT IF EXISTS ai_model_settings_provider_check`, pero en producción ese CHECK se
  llama `chk_ai_model_settings_provider` desde `20260824000000` (que lo recreó al deprecar
  'lovable'). El `IF EXISTS` no encontraba nada, no fallaba, y dejaba viva la constraint real, que
  después rechazaba el INSERT de la fila platform-default con `violates check constraint`.

  Ahora busca los CHECK que restringen la columna `provider` en `pg_constraint` y los dropea por su
  nombre real, cualquiera sea — el mismo enfoque dinámico que ya usaba `20260824000000`. Probada
  contra un Postgres 15 con el esquema y el nombre de constraint reales de producción: aplica limpio,
  es re-ejecutable y no duplica la fila platform-default ni toca las filas de las instituciones.


- **Buscador global (⌘K) — búsqueda de entidades server-side.** `CommandPalette` pasa a
  `shouldFilter={false}` (cmdk filtraba con un `includes` crudo, incompatible con resultados que ya
  vienen del servidor) y delega en dos módulos nuevos: `src/modules/search/search-text.ts` (PURO, con
  tests: normalización sin acentos, `matchesQuery` por palabras, `relevanceScore`, y
  `ilikePatternFor`) y `src/modules/search/global-search.ts` (las consultas + el alcance). Tres
  decisiones que conviene no revertir sin leer el encabezado de cada archivo:
  - **Acentos**: `ILIKE` de Postgres NO ignora diacríticos y `unaccent` no está instalado. El patrón
    del servidor reemplaza por `_` las letras que pueden llevar tilde (`_` matchea también la letra
    sin tilde ⇒ es un SUPERCONJUNTO del literal), se sobre-trae (`FETCH_LIMIT=40`) y el filtro exacto
    lo hace el cliente. El aflojado solo se aplica desde 4 caracteres: con 2-3 el patrón quedaría tan
    laxo que el `limit` se llenaría de basura. El patrón además **sanea** la entrada (todo lo que no
    es `[a-z0-9 ]` pasa a `_`), así que la consulta del usuario nunca se cuela como sintaxis de
    PostgREST — importa porque el grupo de usuarios usa `.or(...)`.
  - **Alcance**: el scope (cursos del docente / asignaciones del alumno / permisos por rol) se
    resuelve UNA vez por apertura y se cachea en un ref keyeado por `userId + rol activo + roles`;
    el texto no lo recalcula. Usa `course-scope.ts` (`scopedCourseIds` + `visibleForScopedCourses`
    con el mapa de comparticiones M:N de `workshop_courses`/`project_courses`), y corta sin consultar
    cuando la lista de ids es `[]`.
  - **Destinos**: solo se ofrece lo que pasa el RBAC del rol ACTIVO — pizarras a Docente/SuperAdmin
    (el Admin no pasa `/app/teacher/whiteboards`) y usuarios a Admin/SuperAdmin. Al estudiante los
    exámenes lo llevan a la LISTA, nunca a `/app/student/take/$examId`: empezar a rendir no puede ser
    el resultado de una búsqueda. Dos destinos nuevos que no existían: `?content=<id>` en
    `/app/teacher/contents` (abre el visor de archivos de ese material) y `?q=<texto>` en
    `/app/admin/users` (rellena el filtro; no hay ruta de detalle por usuario). Ambos consumen el
    param POST-mount y lo borran de la URL.
  - Papelera: además de `deleted_at IS NULL` en cada entidad, se descarta lo que cuelga de un CURSO en
    papelera — el soft-delete del curso no cascadea.
  - De paso: la lista de cursos precargada navegaba con la URL interpolada
    (`/app/teacher/board/<id>`), que es justo el patrón que falla mudo en TanStack; ahora va por
    `params`.

- **Generador de SQL con IA (`sql_generation`)**: edge nueva `ai-generate-sql` (síncrona por diseño — NO
  respeta `processing_mode='async'` ni encola, como `tutor-chat`; el docente está proyectando en vivo),
  `verify_jwt=true` + gate de rol server-side (Docente/Admin/SA) porque no hay caller service_role, rate
  limit `ai.generate_sql` 60/h, y `aiChatCompletionFailover` para la lista de keys con failover. El system
  prompt se resuelve con la jerarquía habitual (curso → tenant → platform → FALLBACK) y su texto entra a la
  tabla de invariantes cross-file de `CLAUDE.md`: **byte-idéntico en 3 lados** — seed de
  `20261620000000_ai_prompt_sql_generation.sql` ↔ `FALLBACK_SQL_GENERATION_PROMPT` del edge ↔
  `SQL_GENERATION_FALLBACK` (`src/modules/database/sql-generation-prompt.ts`, que el `AdminPromptsPanel`
  consume como `defaultPrompt`). El texto no puede contener backticks, barras invertidas ni `${` porque los
  3 lados lo embeben literal. Categoría nueva `whiteboards` ("Pizarras") en el filtro del panel de Prompts.
  Los datos dinámicos (petición + esquema de partida) van en el mensaje del USUARIO, no como placeholders.
- `SqlRunner` (motor de `bd_sql`) suma el prop `readOnlyAllowRun`: con `readOnly`, deja el botón Ejecutar
  visible y funcional (no persiste) en vez de esconderlo entero — lo necesitaba la hoja SQL de la pizarra
  para que el alumno pueda probar la consulta del docente sin poder editarla. Backward-compatible: ningún
  caller existente (examen/taller) pasaba `readOnly=true`, así que el comportamiento de esos flujos no
  cambia.
- Causa raíz: la policy de `courses` deja ver todo el tenant **a propósito** (matrícula/gestión), así que el
  alcance del docente no lo puede dar la base; y `has_role()` tampoco, porque los roles son **poseídos** —
  un Docente+Admin pasa la rama Admin aunque actúe como Docente. El gate es de cliente y lo decide el rol
  **ACTIVO**. Centralizado en `src/modules/courses/course-scope.ts` (+ `NoAssignedCoursesNotice`), 16
  pantallas migradas, 19 tests. Tres comentarios del código afirmaban lo contrario de lo que pasaba ("la RLS
  acota lo que cada rol ve"). Commits `35fa57d8`, `8fabe164`, `9265c4a2`, `446f6a66`, `16aaeb97`.
- Documentos de viabilidad nuevos: **`docs/viabilidad-lenguajes-frameworks.md`** — los 14 lenguajes ya están
  mapeados y la UI expone 4 a propósito (ampliarlos es horas, no semanas, pero solo 3 corren en la VM propia);
  "tipo CodeSandbox" es otro problema (el runner es por lotes, sin red); y **Codespaces NO se puede embeber**,
  verificado por cabeceras (`frame-ancestors 'none'`). StackBlitz/CodeSandbox sí, y el cierre del círculo es
  capturar el proyecto efímero al ZIP que `codigo_zip` ya califica. Commits `e84dc2e8`, `9e6ced72`.
- Agente **`examlab-dev`** (`.claude/agents/`): ingeniería de la plataforma con el contexto operativo
  destilado, porque un subagente NO hereda la memoria del usuario. Catálogo de agentes en `CLAUDE.md`.
  Lleva las **credenciales completas** por pedido explícito del usuario (dijo que las rota después) y una
  sección para **generar y subir contenido** con las formas verificadas contra el código y contra prod:
  la receta de 3 pasos del material (y que sin el paso 3 el contenido no aparece en ninguna parte),
  `kind:"uploaded"` + discriminar por extensión, los payloads de `generate-contents` /
  `ai-generate-questions`, y las plantillas CSV reales.
- Verificando eso salieron **tres datos desactualizados** en la documentación: la plantilla CSV de
  sesiones (CLAUDE.md decía 7 columnas con `duration_minutes`; son **8** con `end_time` y
  `session_type`, y vive en `src/modules/sessions/csv.ts`), el nombre del curso de FESNA
  (`Paradigmas de Programación-2682V`), y que producción tiene **5 tenants**, no 2 — apareció
  `linkvide`, que no estaba documentado en ningún lado. Los tres corregidos.

## [1.1.0] — 2026-07-24

### 🎉 Novedades
- **Sesiones y asistencia:** cada sesión se marca como **Presencial, Virtual o Autónoma**. Las autónomas
  **notifican a los estudiantes** en su fecha/hora de inicio para que revisen el material, y el alumno "asiste"
  marcando **"Ya revisé el material"** (cuenta como presente).
- **Pizarras:** hoja de **código con compilador** (igual que en el examen) + **autoguardado**; al asociar una
  pizarra a un curso la **sesión es obligatoria** (se puede crear en el momento); se pide el **nombre de la 1ª hoja**.
- **Consola / terminal:** se aclara que es un **sandbox efímero** (corre en el navegador, no toca ningún servidor
  real) con badge + botón **"Reiniciar"** (sesión limpia) y una guía **"¿qué comandos funcionan aquí?"**.
- **Preguntas:** el "Banco de preguntas" ahora se llama **"Preguntas"**; el material de un curso cerrado se ve bajo
  el filtro "cerrados".
- **Cursos:** recordatorio recurrente al docente para **cerrar un curso vencido**.

### 🔧 Correcciones
- **Experiencia de uso:** la app **ya no se recarga/reinicia al cambiar de pestaña** del navegador (la pizarra y la
  consola conservan el estado); pulido de la toma de examen, listas del estudiante y tableros (estados de carga y de
  error, esqueletos de carga); mejoras en móvil (áreas táctiles, diseño responsive).
- **Reto en vivo:** la **respuesta correcta ya no queda siempre en la primera opción** (se baraja al crear; datos
  existentes corregidos). *(El más rápido en acertar ya recibía más puntos — sin cambios.)*
- **Consola Linux (v86):** ahora **bootea y carga de forma confiable** (varios arreglos de imagen/assets del emulador).
- **Traducción al inglés:** se corrigieron pantallas que mostraban texto en español a usuarios en inglés (tour de
  bienvenida, catálogo de reportes, selects de facturación, días de la semana, varios textos).
- **Correos:** se quitaron los emojis decorativos de las plantillas; el correo de asociación referencia los 3 modelos
  + credenciales y video de acceso.

### Interno (equipo)
- Commits `2b5fb72e`…`1852ef81` (git log 2026-07-22 → 2026-07-24; incluye la auditoría web/móvil de consistencia+i18n).
- Migraciones: `20261480000000` (session_type + notified_start_at), `20261490000000` (kind `session_start` + cron
  `notify-autonomous-sessions` + RPC `student_review_autonomous_session`), `20261500000000` (barajado en import de banco a kahoot).
- Datos: re-barajado de opciones de kahoot en **FESNA** (cursos "Administración de SO de Servidor" y "Cableado
  Estructurado", 72 preguntas) — solo `position`, `is_correct` intacto.
- Videos demo regrabados (series por rol + escena Cola de IA). **Requiere Publish en Lovable.**
- Invariante nueva: la modalidad de sesión (`session_type`) y el kind emailable `session_start` (predicado de 3 lados).

### 2026-07-20

- **Módulo comercial de Instituciones (SuperAdmin).** `tenants` gana columnas comerciales
  (plan_tier, contracted_services, ai_mode, storage_quota_mb, subscription_status,
  billing_start/end, billing_cycle, monthly_amount, grace_business_days, auto_suspend…);
  RPC `superadmin_tenant_overview()` (licencias por rol + almacenamiento real por bucket) y
  `my_tenant_billing()`. Ciclos de facturación con **auto-suspensión/reactivación** del tenant
  completo vía cron diario `process_tenant_subscriptions()` + gracia en **días hábiles**
  (`add_business_days` excluye fines de semana + `platform_holidays`). Diálogo
  `TenantBillingDialog`, banner al Admin (`TenantBillingBanner`). Migs `20261340000000`,
  `20261350000000`, `20261380000000`. Commits `56c6aa52`, `15a32c93`, `d3ad2b6a`, `b0f01d76`,
  `6a62e3e4`. El grid de Instituciones quitó la columna "Licencias" (ruido) → detalle en el
  diálogo (`0bded47e`); se le agregó buscador + columnas Plan/IA/Almacenamiento/Facturación.
- **IA Compartida real y por defecto** (`1ecee536`). `getActiveAiModel` respeta `tenants.ai_mode`:
  `shared` (default) usa la IA de la plataforma sin pedir key; `own` exige la key del tenant;
  `managed` = compartida + medición aparte. Safe pre-Publish (sin la columna → `shared`).
- **Borrado LÓGICO de usuario** (`1facb8cc`). `admin-delete-user` ya no hace hard-delete: setea
  `profiles.deleted_at`/`is_active=false` + banea en Auth. `current_tenant_id()` devuelve NULL
  para usuarios desactivados/eliminados o tenants suspendidos → la RLS bloquea todo server-side.
  `tenant_role_count` excluye `deleted_at` (baja el contador de licencias).
- **Prompts del asistente de plataforma → editables SOLO por SuperAdmin** (mig `20261360000000`,
  `8d1304d4`). RLS de `ai_prompts` excluye los `use_case` `platform_support*`/`support_triage`
  de la escritura del Admin.
- **Reto en vivo — guard de obsolescencia** (mig `20261370000000`, `323010ef`): un juego solo
  aparece activo si el host dio señal en los últimos 3 min.
- **execute-code**: los errores del CÓDIGO del alumno (exit≠0 con stderr, http 200) ya NO se
  loguean como warning de "compilador"; solo fallos de infra (`650d485b`).
- **Unificación del sidebar "Asistente de IA"** (`694bd274`): el asistente de plataforma aparece
  como chat destacado junto a los tutores de curso del estudiante.
- **Fix recarga extra al iniciar sesión** (`40547943`): login navega a `consumeReturnTo() ??
  readLastRoute() ?? "/app"` (sin doble navegación).
- **Videos FAQ cortos por rol** (migs `20261390000000`, `45928e06`; `674dd300`): `platform_help_videos`
  gana `kind` (`module`|`faq`) + `question`. Guiones versionados `docs/demos/.../module-faq{a,t,s}NN.json`
  (fuente de verdad) + README + `seed-faq-videos.mjs`. El asistente inyecta la pregunta del clip
  para matchear y comparte el link público. Cross-tenant (phv_select=true), SA-only write.
- **Auditoría de consistencia de nombres** (workflow, 20 hallazgos). Corregido: filtros de cola en
  inglés (Pending→Pendiente…), "Broadcast"→"Difusión", "Strikes"→"Advertencias", títulos de tour
  desalineados (Certificaciones/Encuestas/Pizarras), "Foro"→"Foros", "tenant"→"institución" en
  texto visible a Admin/Docente, y el asistente de plataforma unificado a "Asistente de la
  plataforma". Doc: `docs/audits/consistencia-nombres-2026-07-20.md`. Commits `595c41cd`,
  `a02cb5cd`, `af73059f`, `28ae1e78`.

### 2026-07-19

- **Regeneración de videos demo (recorrido general + serie admin) con correcciones de QA.** Pipeline (`docs/demos/admin/pipeline/`): arranque de voz limpio (LEAD + afade en `build-mux.mjs`), carátulas azules que revelan la app tras un cap (`record-module.mjs`), `createbtn` doc-wide + click nativo por JS (inmune a toasts que tapaban el botón), toasts de sonner ocultos en grabación. Specs: outro deja de decir "Siguiente módulo" (recapitula el módulo actual), intro nombra el módulo, module-02 abre el form de usuario, module-07 espera a que carguen los prompts, module-16 con cola de IA sembrada, overview muestra la lista real de exámenes. Datos demo (Demo Global Corp): cursos a `en_curso` + `end_date` futura, notificaciones marcadas leídas. QA con 15 agentes en paralelo. Commits `fecd8ce3` (videos).
- **Organización de la documentación + archivado de obsoletos.** Barrido de 128 `.md`. Raíz reducida a `CLAUDE.md`/`README.md`/`CHANGELOG.md`; se archivó a `docs/archive/` el intento de self-host con Docker/AWS (abandonado por Lovable), el contexto pre-`CLAUDE.md` (`EXAMLAB-CONTEXT`/`PROJECT_CONTEXT`), y los reportes de hallazgos/QA/auditorías ya resueltos (`HALLAZGOS-*`, `AUDITORIA-PAPELERA`, `QA-RESULTADOS`, `REVISION-SEGURIDAD`, serie `audit/00-06`, planes superados). Se borró `Conversacion.md` (export crudo de chat). Nuevos índices `docs/README.md` + `docs/archive/README.md`. README sin secciones obsoletas de HeyGen/Docker. Credencial `test-fesna` marcada obsoleta (migró a SSO 2026-06-12, password no funciona). Clasificación asistida por workflow (9 agentes). Commits `9ea7d917`, `64d6345e`, `b79be5e5`.

### 2026-07-15

**Correo: enfoque "From verificado + Reply-To" (sin spoofear).** Implementa la alternativa
del plan (evita romper SPF/DKIM/DMARC): el From sigue siendo el remitente verificado; se pone
como **Reply-To** el correo del **docente emisor** (difusiones con `related_user_id`) →
**Reply-To de la institución** (`tenant_email_settings.reply_to`) → default (el From).
- Mig `20261150000000`: columna `tenant_email_settings.reply_to` (aplica aunque no use SMTP propio).
- Edge `send-email`: trae `related_user_id` + `reply_to`, resuelve `replyTo` y lo usa en
  `mailOptions` (antes `replyTo: from` fijo). From NO cambia (sin spoofing).
- UI: campo "Correo de respuesta (Reply-To)" en `TenantEmailSettingsDialog` (fuera del gate de
  SMTP propio). Nota: el modelo "app OAuth multi-dominio" se descartó por requerir revisión de
  Google (scopes sensibles). Aplicada a PROD; requiere Publish.

**URLs referenciables por ítem — fix de `tagRoute` (mensajes `#`-tags).** Auditoría
([docs/AUDIT-URLS-REFERENCIABLES.md](docs/AUDIT-URLS-REFERENCIABLES.md)) encontró que los tags
iban a la grilla raíz (id descartado) y, para content/video, a rutas inexistentes.
- `tagRoute` → `{to, params?, search?}`: detalle `$id` (workshop/project est., exam doc.) o
  grilla+param que resalta (`?workshop=`, `?exam=`, `?content=`, `?video=`, `?project=`). El id
  SIEMPRE viaja. Rutas corregidas: `/app/teacher/contents` (plural), `/app/videos` (compartida).
- Videos y Contenidos leen el deep-link y resaltan el ítem (best-effort, patrón `?poll=`).
- Commits `cc642941` (tagRoute + tests, 35 pass) + `1d2b6261` (highlights). tsc EXIT=0.

### 2026-07-14

**Refactor de envío de correos — investigación + plan (no implementado) + fix de seguridad.**
Objetivo: que cada institución/usuario envíe desde su propia cuenta en vez de la Gmail
compartida (`castano.julian@correounivalle.edu.co` = env `SMTP_USER`). Workflow de 4 agentes.
- **Hallazgo**: el envío por INSTITUCIÓN ya existe end-to-end (`tenant_email_settings` mig
  `20260959000000` + rama en la edge `send-email`) pero está DORMIDO (las 4 instituciones en
  PROD con `use_custom_smtp=false` → todo cae al env global). No existe config por usuario.
  Enviar "como" el correo del usuario por otro relay rompe SPF/DKIM/DMARC → spam.
- **Fix de seguridad aplicado** (mig `20261140000000`): `REVOKE anon` sobre
  `tenant_email_settings` (guardaba `smtp_password`; tenía GRANTs completos a `anon`, solo la
  RLS lo tapaba = rls-self-tamper-class). `authenticated` reducido a lo mínimo. Sin impacto
  funcional. **Aplicado a PROD**; requiere Publish para versionar.
- **Plan** (decisión del usuario: "solo el plan por ahora", NO implementar):
  [docs/PLAN-CORREO-POR-CUENTA.md](docs/PLAN-CORREO-POR-CUENTA.md) — resolver SMTP central,
  jerarquía usuario→institución→plataforma, Fase 1 (institución: panel Admin + test-send +
  secreto write-only) y Fase 2 (usuario opt-in + anti-spoof).

**Videos demo: series completas + specs + limpieza de docs/ (commit `71979f5f`).**
- `serie-{admin,student,teacher}-completa.mp4` rearmadas desde los módulos nuevos (nuevo
  `build-serie.mjs`, concat lossless, duración = suma de módulos verificada).
- Todo video individual tiene spec (creado `module-login.json`; 0 huérfanos).
- Eliminado `docs/heygen/` (sistema deprecado); CLAUDE.md actualizado. Regla: en UI "institución", no "tenant".

**Correo de bienvenida al PUBLICAR un curso (borrador → en_curso).**
El usuario pasó a `en_curso` dos cursos de FESNA que estaban en `borrador` (creados +
matriculados en este ciclo con la bienvenida suprimida a propósito) y esperaba que los
estudiantes recibieran el correo de bienvenida al publicar. No existía trigger de
publicación; solo el de matrícula (mig `20261110000000`), que además no chequeaba estado.
- **Mig `20261130000000`**: (1) `notify_course_enrollment_welcome` ahora SALTA cursos en
  `borrador` (no emailar antes de publicar); (2) nuevo `trg_course_published_welcome`
  (`AFTER UPDATE OF status`, `borrador→en_curso`) inserta `course_welcome` por cada
  matriculado. Aplicada a prod y **verificada empíricamente** (rolled-back): matricular en
  borrador → 0; publicar → 1 por matriculado; matricular en publicado → 1 inmediato.
- **Backfill de los 2 cursos ya publicados** (Cableado Estructurado 57 + Administración de
  Sistemas Operativos de Servidor 23 = 80): insertadas 80 notifs `course_welcome`. Envío:
  **78/80 entregados**; los últimos se drenaron vía el cron existente
  `retry-failed-email-notifications` (cada 5 min, reintenta `provider_error: 4xx`
  transitorios de Gmail hasta 5 veces) — los 421/454 fueron throttle transitorio de Gmail
  por la ráfaga de 80 correos, no config. No se cambió la lógica de reintento.
- Invariante nueva registrada arriba (Estados de curso). Requiere **Publish** en Lovable
  para que la mig quede versionada en el entorno (ya está aplicada en la DB de prod).

**Diagnóstico "estudiantes no pueden acceder" + contraseña temporal fija.**
Estudiantes de los 2 cursos nuevos no podían entrar. Diagnóstico en prod: el correo de
login (institucional) y la cuenta eran correctos (80/80 con password, email confirmado,
`auth.email == institutional_email`), pero **nunca se les envió el correo de credenciales**
(`force_password_change:false` en el import omite el welcome/reset) → tenían una temporal
única `Fes-XXXX#7` que nadie les comunicó. Solo 9/80 habían entrado.
- **Decisión del usuario**: la contraseña temporal debe ser **fija `Temporal#123` para todos**
  (aunque sea insegura). Edge `bulk-import-users`: default `Cambiar#123` → `Temporal#123`.
- **Fix inmediato**: reset de los 71 estudiantes que nunca entraron → `encrypted_password =
  crypt('Temporal#123', gen_salt('bf'))`, `must_change_password=false`, `admin_visible_passwords`
  actualizado. **Login real verificado** (HTTP 200 + access_token con `Temporal#123`).
- **Videos de intro**: los MP4 (`docs/demos/student/output/modulo-s01.mp4` = "Panel del
  Estudiante" / explorar; `modulo-overview.mp4` = recorrido general) NO están hospedados —
  `videoUrl` es `null` en `tour-config.ts`, no hay links públicos. NO existe video de "cómo
  iniciar sesión" (los demos arrancan ya logueados). Para tener links hay que hospedarlos.

### 2026-06-19

**Auditoría de módulos (workflows en paralelo) — Exámenes + Talleres + fix de calificación.**
Dos workflows adversariales en paralelo auditaron Exámenes y Talleres. Hallazgos
serios verificados (ver reporte); este commit cierra el más acotado y de impacto
en notas:
- 🔴 **Auto-grade regalaba puntos** — en `ai-grade-submission` la rama `cerrada`
  hacía `userAnswer === correctIdx`; una pregunta `cerrada` con `correct_index`
  ausente (config corrupta/legacy) + SIN responder daba `undefined === undefined`
  → **puntaje completo por una pregunta en blanco**. Fix: guard de tipo (ambos
  deben ser `number` finito) en el edge + helper puro `scoreCerradaSingle` en
  [question-scoring.ts](src/modules/exams/question-scoring.ts) (mirror, con tests
  del caso en-blanco/config-corrupta). +8 tests.
- Pendiente (reportado, remediación de seguridad aparte): fuga columnar de
  respuestas correctas en `questions`/`workshop_questions` (RLS filtra filas, no
  columnas) y varios leaks cross-tenant por `has_role` sin scope de tenant
  (`workshop_submission_answers` ← PII, `workshop_assignments`,
  `exam_timer_controls`, `code_executions`, ramas Admin de RPCs de cola IA /
  clone_workshop / add_questions_from_bank). + bug funcional: miembros de grupo
  no pueden editar respuestas de la entrega compartida (RLS de
  `workshop_submission_answers` sin rama de grupo).

**Validación e2e post-Publish + hotfix de seguridad del cascade.**
Tras publicar, validé en vivo (Demo Global Corp) lo que estaba pendiente:
- **Kahoot P0** ✓: responder durante el splash "¡Prepárate!" ahora se **rechaza**
  ("La pregunta aún no está abierta", HTTP 400); tras el lead se acepta normal.
- **Kahoot P1** ✓: `kahoot_my_live_games` devuelve el juego con título (el banner
  ya descubre Kahoots aunque estén en borrador).
- **Cascade** ✓ (7/7): finalizar un curso cerró su examen (`status=closed`),
  pizarra (`status=closed`) y encuesta (`closed_manually=true`).
- 🔴 **Hallazgo de seguridad → hotfix** (mig
  [20260993000000](supabase/migrations/20260993000000_cascade_close_revoke_authenticated.sql)):
  las 7 funciones `close_*_for_course` (SECURITY DEFINER, internas) eran
  **ejecutables por `authenticated`** pese al `REVOKE FROM PUBLIC` — en Supabase
  `authenticated`/`anon` tienen EXECUTE concedido aparte. Cualquier usuario podía
  cerrar contenido de otro curso/tenant (escritura cross-tenant). Fix: `REVOKE`
  también de `authenticated` y `anon`. El trigger sigue funcionando (corre como
  owner). **Requiere un nuevo Publish.**

**Revisión e2e por módulo (loop "siguiente módulo y rol") — Asistencia + Foros.**
Pasadas de revisión e2e en vivo (Demo Global Corp, sin IA/costo):
- **Asistencia** (docente+estudiante): el invariante crítico `compute_attendance_code`
  (SQL) ↔ `computeAttendanceCode` (JS) verificado **bit-a-bit** en 5 casos; RPCs
  `teacher_open/close_attendance_check_in` + `student_check_in_attendance` vivas; el
  guard `check_in_closed` funciona. **Limpio, sin cambios.**
- **Foros** (docente+estudiante): el invariante de "foro abierto" en 3 capas
  (`is_forum_open` SQL ↔ `isForumOpen` ↔ `computeForumState`) verificado en vivo
  (4 estados: abierto/programado/auto-cerrado/cierre-manual, SQL==JS) y estático.
  Único hallazgo: `src/modules/forum/forum-state.ts` no tenía tests (helper puro
  correctness-critical) → se agregaron ([forum-state.test.ts](src/modules/forum/forum-state.test.ts), 8 casos).

**Kahoot — fixes de la auditoría adversarial de los 6 ajustes (workflow + e2e).**
Una auditoría por workflow (1 agente por ajuste) + e2e live (Demo Global Corp)
destapó 3 issues reales en los ajustes ya implementados (commit `2fbfd291`):
- **P0 (integridad de puntaje)** — `kahoot_submit_answer` no rechazaba responder
  mientras `now() < question_started_at`. Con el lead de 3s de "¡Prepárate!"
  (mig `20260989`), responder durante el splash daba **puntaje máximo**
  (`elapsed = GREATEST(0, now-started) = 0`). Fix: guard `IF now() <
  question_started_at THEN RAISE` (mig
  [20260992000000](supabase/migrations/20260992000000_kahoot_audit_fixes.sql)).
- **P1 (banner inoperante en el caso típico)** — `KahootLiveBanner` y
  `KahootJoinCard` descubrían juegos con embed `poll:polls(...)`, pero la RLS de
  `polls` del alumno exige `is_published=TRUE` y un Kahoot se hospeda **en
  borrador** → el embed volvía `null` y se descartaba el juego: la notificación
  **nunca aparecía** (ni el botón reconectar). Fix: nueva RPC
  `kahoot_my_live_games()` `SECURITY DEFINER` (trae los juegos vivos de mis
  cursos con título, bypassa esa RLS, guard de papelera + `_poll_has_member`);
  el banner y el card ahora la usan.
- **P2 (default 20s incompleto)** — dos flujos reinyectaban `time_limit_seconds=10`
  saltándose el DEFAULT: el edge `ai-generate-questions` (ahora omite la columna)
  y `add_questions_from_bank_to_kahoot` (CREATE OR REPLACE en `20260992` que omite
  la columna → hereda el DEFAULT 20).
- **Menores**: gate del splash con `nowMs>0` (evita un frame con número gigante);
  tests de `getReadySecondsLeft`; 4 claves i18n del banner (es+en).
- **Confirmado OK por la auditoría** (sin cambios): animaciones (tw-animate-css),
  responders-by-option (privacidad host-only server-side), gating del banner. El
  join 1-click sin PIN se confirma como decisión de producto intencional.

**Cascade de cierre al finalizar un curso.**
Cuando un curso pasa a `status='finalizado'` (por `set_course_status` manual O
por el cron `auto_finalize_courses` — ambos hacen `UPDATE courses.status`), todo
lo asociado pasa a su estado CERRADO, sobre todo para que en cada módulo **lo
cerrado deje de aparecer en los listados activos** por defecto. Diseño vía
workflow (8 agentes mapearon entidad×vista). Mig
[20260991000000](supabase/migrations/20260991000000_cascade_close_on_course_finalized.sql):
- **UN trigger** `AFTER UPDATE OF status ON courses WHEN (NEW='finalizado' AND
  OLD IS DISTINCT FROM 'finalizado')` → 7 funciones `close_*_for_course`
  (`SECURITY DEFINER`, **REVOKE de PUBLIC** — internas; sin eso un authenticated
  podría cerrar contenido de otro curso/tenant). Cada paso en su propio
  `BEGIN/EXCEPTION`: un fallo de cascade NUNCA aborta la finalización del curso.
- **Cascadea**: exámenes (1:1) y pizarras (1:1) → `status='closed'`; talleres,
  proyectos y encuestas/Kahoot (**M:N**) → cerrados SOLO si ningún otro curso
  ligado sigue `<> 'finalizado'`; Kahoot en vivo → `status='ended'`; foros →
  `manually_closed_at` (bloquea postear, el historial se sigue leyendo);
  ventanas de check-in QR abiertas → cerradas (NO se borran/cierran sesiones —
  su histórico es necesario para la nota por corte).
- **NO cascadea**: `attendance_sessions` (date-based, sin estado closed; el
  histórico debe preservarse), `generated_contents`/`videos` (sin estado closed;
  desvincular sería destructivo y el material debe seguir consultable).
- **NO auto-reabre**: la transición `finalizado→en_curso` no dispara nada
  (reabrir es granular y deliberado por ítem). Idempotente (re-finalizar no
  re-toca). Defensiva `to_regclass` en cada función + en el `CREATE TRIGGER`.
- **Front**: los grids docentes de exámenes/talleres/proyectos/pizarras ya
  ocultan `closed` por defecto (`matchesActivityStatus`) → caen solos al
  cerrarse. Se agregó filtro de estado (Abiertas/Cerradas/Todas, default
  "abiertas") al grid docente de encuestas ([app.teacher.polls.tsx](src/routes/app.teacher.polls.tsx))
  — era el único módulo docente que no ocultaba lo cerrado.
- **Nota de producto**: cerrar encuestas con `results_visible_to_students='after_close'`
  revela los conteos al alumno (esperable en un curso finalizado; documentado).

**Pizarras — estado (borrador / activa / cerrada).**
Las pizarras (`whiteboards`) ahora tienen `status` con el MISMO vocabulario que
exámenes/talleres/proyectos (`draft | published | closed`, mig
[20260990000000](supabase/migrations/20260990000000_whiteboards_status.sql),
DEFAULT `published` → las existentes quedan activas sin backfill). Esto reusa el
filtro compartido `matchesActivityStatus` (default oculta cerradas), el
`StatusBadge` y el `ActivityStatusSelect`.
- **Docente** ([app.teacher.whiteboards.index.tsx](src/routes/app.teacher.whiteboards.index.tsx)):
  filtro de estado (Activos/Cerrados/Todos, default oculta cerradas) + columna
  `StatusBadge` + acción de fila **Cerrar / Reabrir** (alterna published↔closed) +
  4ª stat-card "Cerradas" (reemplaza "En curso"). Cerrar saca la pizarra del
  listado activo sin borrarla (para archivar de verdad está la Papelera).
- **Estudiante** ([app.student.whiteboards.index.tsx](src/routes/app.student.whiteboards.index.tsx)):
  una pizarra cerrada NO se le muestra (nullish ⇒ published).
- Base para que al cerrar un curso, sus pizarras (y demás) pasen a `closed` y
  desaparezcan del listado activo.

**Pizarra (Excalidraw) — paleta de figuras estilo draw.io (categorías + miniaturas).**
El panel "Figuras" agrupaba por tema pero era una lista de TEXTO en un panel
angosto — no se veía qué era cada figura ni quedaba claro qué grupo es para un
diagrama de clases. Rehecho ([WhiteboardEditor](src/modules/whiteboard/WhiteboardEditor.tsx)
+ [excalidraw-libraries.ts](src/modules/whiteboard/excalidraw-libraries.ts)):
- **Secciones por TIPO DE DIAGRAMA** con ícono + nombre explícito + descripción
  "para qué sirve" + conteo, **colapsables** (acordeón). Orden: **Diagrama de
  clases (UML)** primero (clase/interfaz/abstracta/enum/herencia), luego Diagrama
  de flujo, Entidad–Relación / BD, Estructuras de datos, Arquitectura AWS.
- **Miniatura SVG de cada figura** (se VE qué es, como en draw.io). Helper PURO
  `libraryItemPreview(elements, boxW, boxH)` que escala los elementos del template
  a una caja, mantiene aspecto y mapea rect/ellipse/diamond/line/arrow/text a
  primitivas SVG (sin rough.js ni dependencias). Strokes con `currentColor`
  (respeta tema claro/oscuro). Tests del helper + metadata de categorías.
- Panel más ancho (`w-72`), grilla de 2 columnas, responsive (`max-w-[calc(100vw-1rem)]`).
- Sin migración ni cambios de DB — es solo front de la pizarra.

**Kahoot en vivo — experiencia mejorada (5 frentes).**
- **Notificación global persistente + "login directo"** ([KahootLiveBanner](src/modules/polls/KahootLiveBanner.tsx), montado en [AppLayout](src/shared/components/AppLayout.tsx)): cuando hay un Kahoot en vivo en un curso del alumno, una barra animada arriba (en CUALQUIER pantalla) lo invita a entrar con **un click** — su cuenta institucional ES la credencial (matrícula), sin teclear PIN. Nueva RPC `kahoot_join_game_by_id` (mismos guards que `kahoot_join_game`: tenant, matrícula, host presente + lobby para nuevos, papelera, ended) — el PIN sigue para el QR / ingreso manual. La barra se auto-oculta dentro de la vista del juego y no aparece durante un examen.
- **Cuenta regresiva "¡Prepárate!" + más animaciones** (Parts 3): `kahoot_advance_game` fija `question_started_at` 3s en el FUTURO; mientras tanto host y alumno ven un splash animado de cuenta regresiva (sin opciones). El cronómetro y la ventana de respuesta del servidor arrancan recién en ese instante, así que la espera NO le come tiempo a nadie (`secondsLeft` devuelve el límite completo; el server computa `elapsed=GREATEST(0,…)`). Transiciones de fase con `animate-in` (fade/zoom/slide) + pulso del cronómetro en los últimos 5s. Helper `getReadySecondsLeft` en [kahoot.ts](src/modules/polls/kahoot.ts).
- **Tiempo por defecto 20s** (Part 4): `kahoot_questions.time_limit_seconds` DEFAULT 10→20 + `blankQuestion()` del editor a 20.
- **Por opción, quién respondió** (Part 5): `kahoot_get_state` agrega `responders_by_option` (SOLO host; se atribuye por `option_ids`, cubre single y multi) → el host ve bajo cada opción los nombres de quienes la eligieron, en vivo y al revelar. Los alumnos NO lo reciben (no se filtran respuestas ajenas).
- Migración [20260989000000_kahoot_live_experience.sql](supabase/migrations/20260989000000_kahoot_live_experience.sql) (default 20s + lead de inicio en `kahoot_advance_game` + `kahoot_join_game_by_id` + `responders_by_option` en `kahoot_get_state`).
- Fix colateral: anotación de tipo en el `.map` del filtro de cursos en papelera de [app.teacher.polls.tsx](src/routes/app.teacher.polls.tsx) (implicit-any que rompía `tsc`, introducido en `6a1977b6`).

### 2026-06-18

**Encuestas MIXTAS — nuevo `poll_type='mixed'` con mix de preguntas (abiertas + cerradas).**
Una encuesta puede ahora tener N preguntas de distintos tipos, como un taller:
`abierta` (texto libre, con tope opcional de caracteres) y `cerrada` (opción
única). El modelo plano legacy (`single`/`multiple`/`slot`/`kahoot` sobre
`poll_options`/`poll_responses`/`kahoot_*`) **coexiste intacto — cero migración
de datos**; `poll_type` bifurca a las tablas hijas nuevas.
- **DB** (migs `20260983000000` enum `mixed` aislado + `20260984000000` tablas
  `poll_questions`/`poll_question_responses` + RLS, + `20260985000000` RPCs/triggers):
  RLS reusa los helpers `_poll_*` AÑADIENDO guard de papelera (`deleted_at`).
  Respuestas con **write directo DENEGADO** (solo vía RPC). `poll_question_responses`
  NO se publica a realtime ni tiene `REPLICA IDENTITY FULL` (privacidad de las
  respuestas abiertas). RPCs `submit_poll_question_response` (guards: papelera,
  publicada, abierta, matrícula multi-curso vía `_poll_has_member`,
  `allow_change_response` SOLO para cerradas ANTES del upsert, rango de
  `selected_index`), `clear_poll_question_responses`,
  `teacher_clear_poll_question_response_for_user`. Triggers: una mixta NO se
  publica con 0 preguntas (`BEFORE INSERT OR UPDATE OF is_published`) + choices/tipo
  inmutables si la pregunta ya tiene respuestas.
- **Docente** ([PollQuestionsEditor.tsx](src/modules/polls/PollQuestionsEditor.tsx)
  + [app.teacher.polls.tsx](src/routes/app.teacher.polls.tsx)): tipo `mixed` en el
  form (nace en borrador, abre el editor de preguntas al crear); editor de
  preguntas abiertas/cerradas (choices read-only con respuestas); "Preguntas" en el
  menú de fila; `auto_close` oculto para mixed; tipo bloqueado en edición; resultados
  por pregunta (cerradas = conteo, abiertas = lista con autor, nombres por 2-query,
  borrar por alumno, aviso "solo el docente ve las abiertas"); duplicar copia las
  preguntas (flag `copyQuestions`).
- **Estudiante** ([app.student.polls.tsx](src/routes/app.student.polls.tsx),
  `MixedPollCard`): responde cada pregunta con autosave (abierta = textarea al salir
  del campo, cerrada = botones de opción única); hidrata sus respuestas; "Quitar mis
  respuestas" si abierta + `allow_change_response`.
- v1 difiere: `cerrada_multi`, realtime de respuestas abiertas, quiz (correct_index),
  auto-cierre "todos respondieron" para mixed.

**Difusión (notificaciones masivas) — no mostrar/usar cursos en la papelera.**
El selector de cursos del diálogo de difusión (`/app/messages`) no filtraba
`deleted_at`, así que aparecían cursos en la papelera. Fix en 3 capas (regla
universal soft-delete — no usable en NINGÚN flujo):
- **Front** ([app.messages.tsx](src/routes/app.messages.tsx)): ambas queries del
  selector (Admin = todos, Docente = los que dicta) filtran `.is("deleted_at", null)`.
- **Edge** `broadcast-course-message`: la verificación de cursos excluye los
  soft-deleted → si llega un curso en papelera (stale, o enviado a la papelera
  entre abrir el diálogo y el envío) aborta con 404 (sin difusiones parciales).
- **Difusión programada** (mig `20260982000000`, `dispatch_scheduled_messages`):
  si algún curso del broadcast quedó en papelera entre programar y despachar,
  aborta la fila (`failed`) — consistente con la edge inmediata.

**IA — respetar SIEMPRE la cola en modo batch + resolver el modo por tenant.**
Revisión funcional (lectura del entorno de prueba) que destapó dos bugs en el
despacho de IA:
- **Admins se saltaban la cola en batch**: `AiAuthorizationGate.ensureAuthorized`
  hacía `if (isAdmin) return "proceed-sync"` ANTES de mirar el modo → un
  Admin/SuperAdmin generando con IA corría inline aunque el modo global fuera
  `async` (batch). Ahora la decisión es pura y testeable (`resolveAiGateDecision`
  en [ai-grading.ts](src/modules/ai/ai-grading.ts)): el admin sigue SIN ver el
  dialog (no es ruido) pero en batch **encola** (`proceed-async`) en vez de
  inline. Invariante: en batch nadie corre inline salvo modo `sync` o código
  "IA inmediata" vigente. +tests.
- **`getProcessingMode` ignoraba el tenant**: con `ai_model_settings` per-tenant
  (una fila activa por tenant + platform-default `tenant_id IS NULL`), el
  `.eq("is_active",true).maybeSingle()` rompía con >1 fila → `data` null → caía
  a `async` SIEMPRE, ignorando el modo del tenant (un tenant en `sync` quedaba
  forzado a la cola; ej. los docentes de FESNA no podían generar inline). Ahora
  resuelve como el edge `getActiveAiModel`: prefiere la fila del propio tenant
  sobre la platform-default (`order tenant_id NULLS LAST, limit 1`).

`ai_model_settings` es GLOBAL/per-tenant (no se tocó dato en prod); el fix es de
código. Validado local: tsc 0, IA 18/18.

**Pizarra — imágenes pegadas PERSISTEN + panel de figuras categorizado.**
- **Persistencia de imágenes**: `WhiteboardEditor.onChange` solo capturaba
  `(elements, appState)` y descartaba el 3er arg de Excalidraw, `files` (los
  binarios de las imágenes pegadas). Resultado: la imagen se veía mientras la
  pizarra estaba abierta y DESAPARECÍA al recargar (su element referenciaba un
  `fileId` sin datos). Ahora se capturan y persisten los `files` en la escena
  (`scene_json` / RPC `update_session_whiteboard_scene`; `initialData.files` ya
  los cargaba). Dedup sigue sobre elements+appState (no stringificar MB de
  base64 en cada trazo). El broadcast en vivo va SIN files (reenviar MB cada
  200 ms saturaría Realtime; los peers ven la imagen al recargar desde DB).
- **Figuras organizadas**: el panel "Library" nativo de Excalidraw es una grilla
  plana. Se agregó un panel propio categorizado (Diagramas de flujo · Bases de
  datos/E-R · POO/UML · Estructuras de datos · AWS) que inserta la figura
  centrada en el viewport al click (`instantiateLibraryElements`: clona con
  ids/seed nuevos + groupId común). Helpers puros con tests
  (`LIBRARY_CATEGORIES`, `instantiateLibraryElements`, `shortLibraryItemName`).

**Auditoría móvil (375–428px) + manejo de errores.** Revisión a detalle del
diseño móvil contra las reglas del design system: el `DialogContent` base ya
acota ancho (`w-[calc(100%-1rem)]`), alto (`dvh`) y padding (`p-4 sm:p-6`); no
hay grids forzando 2/3 columnas en móvil, ni `max-h` en `vh` (solo `dvh`), ni
touch targets <32px, y los elementos `fixed bottom` (bottom-nav, FAB) ya llevan
`env(safe-area-inset-bottom)`. Corregido lo encontrado:
- `flex-wrap` en los `CardHeader` (título + acción) de `AdminAcademicSubjectsPanel`,
  `ActasManager` y `SupabaseCronPanel` — quedaban sin envolver (a diferencia de
  los paneles hermanos), arriesgando overflow del título/botón a 375px.

(Manejo de errores y bug de foros se commitearon aparte el mismo ciclo.)

**Grids del docente: por defecto se ven activos + borradores; los completados se
ocultan.** Antes los grids de actividades mostraban todo sin distinción de
estado, y cursos abría en "En curso" (sin borradores). Ahora, al abrir, el
filtro por defecto muestra lo vigente Y los borradores; los cerrados/finalizados
solo aparecen al cambiar el filtro a "Cerrados"/"Finalizados" o "Todos".
- **Actividades** (exámenes, talleres, proyectos): nuevo filtro de estado en la
  barra (`ActivityStatusSelect` en el slot `extra` de `ListFilters`), default
  **"Activos y borradores"** (= no cerrados). Helper puro
  [status-filter.ts](src/shared/lib/status-filter.ts) (`matchesActivityStatus`,
  `DEFAULT_ACTIVITY_STATUS_FILTER`) con tests. El empty-state ya distingue
  "sin resultados" (filtro) de "crea el primero" (sin datos).
- **Cursos** ([app.admin.courses.tsx](src/routes/app.admin.courses.tsx)): opción
  "Activos y borradores" (= todo lo NO finalizado: en curso + próximos +
  borradores) como **default** (antes "En curso"). Los finalizados se ven con
  "Finalizados" o "Todos".
- El filtro se añade al `resetKey` de la paginación y `useMultiSelect` sigue
  operando sobre lo filtrado (seleccionar-todo no abarca filas ocultas).

**La fecha FIN de una actividad nunca supera la fecha fin de su curso (front +
datos).** Al asociar un examen/taller/proyecto a un curso con `end_date`, su
fecha fin se topa automáticamente a ese día; si ya era menor, se deja igual. No
salta la validación existente inicio < fin (sigue aplicando sobre el valor ya
topado).
- **Helper** `capEndToCourseEnd` / `courseEndOfDay` / `earliestCourseEnd` en
  [date-range.ts](src/shared/lib/date-range.ts) (puros, con tests). El fin del
  curso (columna DATE) se interpreta como 23:59 hora local es-CO. Multi-curso →
  se topa al curso que termina ANTES (cabe en todos).
- **Front**: al elegir/cambiar el curso (toggle) y al guardar, los 3 forms
  (`app.teacher.exams.index` `end_time`, `app.teacher.workshops` /
  `app.teacher.projects` `due_date`) topan la fecha fin. **Externos no se topan**
  (la fecha es marcador del evento ya ocurrido; en examen además end=start).
- **Datos** (mig `20260981000000`): trigger BEFORE INSERT/UPDATE que CLAMPa
  `end_time`/`due_date` al fin del día del curso (America/Bogota, espejo del
  front). Cubre import CSV, clonado, RPC y API directa. Helper SQL
  `_course_end_instant`. Externos exentos.

**Kahoot — reconexión: el jugador vuelve a la pregunta ACTUAL tras caída de
internet.** Supabase Realtime no re-emite los eventos perdidos al reconectar el
socket, así que `useKahootGame` (que solo recargaba en cada `postgres_changes`)
dejaba al jugador CONGELADO en la pregunta que tenía cuando se cayó la red, sin
saltar a la actual hasta que el host volvía a tocar la DB. Además un `reload()`
fallido (poll sin internet) podía voltear la pantalla a estado de error.
Ajuste (client-side, `use-kahoot-game.ts`):
- Re-sincroniza el snapshot (`kahoot_get_state`) al (re)suscribir el canal
  (status `SUBSCRIBED`, incluye reconexión), en `online`, al volver el foco/
  visibilidad de la pestaña, y con un poll de respaldo cada 5 s.
- Un `reload()` fallido ya NO descarta el último estado bueno: la pantalla se
  mantiene y converge a la pregunta en vivo en cuanto la red regresa.
- Server sin cambios: los jugadores no se podan al desconectar (solo el host
  tiene heartbeat), `kahoot_join_game` upsertea y `kahoot_get_state` devuelve la
  pregunta actual + `me` por `auth.uid()` — bastaba con re-pedir el snapshot.

**Recordatorio de entregas: "1 hora antes", parametrizable y UNA sola vez.**
Antes `notify_students_{workshop,project}_due_soon(24)` corría cada 2h con
ventana de 24h y dedup de solo 6h → el alumno recibía el aviso al entrar en las
24h y luego otra vez cada 6h hasta el cierre (varios correos por la misma
entrega). Ajuste (mig `20260980000000`):
- **Ventana = lead configurable** (`app_settings.due_reminder_lead_hours`,
  default **1 h**, rango 1–168). El arg explícito de la función sigue ganando
  (compat); si es NULL lee el setting; si no hay, cae a 1.
- **Dedup PERMANENTE**: un único aviso por (alumno, entrega) — ya no se repite.
- **Cron** reagendado a cada 15 min (`workshop-due-reminder` / `project-due-reminder`,
  reemplazan a `*-due-24h`); como el dedup es permanente, el alumno recibe UN
  solo recordatorio aunque el cron corra seguido. Descripciones actualizadas en
  el panel SuperAdmin.
- **UI**: campo "Recordatorios de entregas → Avisar (horas antes)" en
  Configuración → Parámetros (`AdminGeneralSettingsPanel`).
- Solo aplica a talleres/proyectos no entregados (entrega = submission). El
  recordatorio de inicio de examen (`*_exam_starting_soon`) no se tocó.

**Correos — lista de SUPRESIÓN (rebotes / bandeja llena).** Reportado (tenant
Camacho): la cuenta remitente recibe "Mail Delivery Subsystem" todo el tiempo
porque ExamLab sigue mandando notificaciones a una dirección con el buzón lleno
(`452 4.2.2 out of storage` / `5.2.2 mailbox full`). El rebote es ASÍNCRONO
(Gmail acepta con 250 y rebota un NDR horas después al remitente), así que el
edge nunca lo ve en el envío. Fix: lista de supresión.
- **Tabla `email_suppressions`** (mig `20260979000000`): el edge `send-email` NO
  envía a direcciones de la lista (enforcement GLOBAL por dirección; in-app/push
  siguen). RLS: SA todo; Admin su tenant. Email normalizado a minúsculas
  (trigger) + índice único por (email, tenant). **Sembrada** `sebasegar2006@gmail.com`
  (global) para alivio inmediato — el SA la quita del panel cuando el buzón se libere.
- **Auto-supresión** en el edge: si el handshake SMTP rebota PERMANENTEMENTE
  (5.x.x de buzón/usuario) agrega la dirección sola. NUNCA por 4.x transitorio.
  Helper `isPermanentMailboxError` con tests (fuente de verdad en
  `src/modules/notifications/email-bounce.ts`, réplica en el edge).
- **UI**: sección "Direcciones suprimidas" en el panel de Config. de correos
  (Admin + SuperAdmin) para agregar/quitar direcciones. `friendlyError` mapea el
  índice único ("ya está en la lista").

### 2026-06-15

**Informes — TODA variable `{{…}}` se resalta en el editor visual (no sólo las
insertadas).** Antes el color sólo se aplicaba a lo insertado desde el catálogo,
envuelto en un `<span class="examlab-added">` por `execCommand("insertHTML")` —
frágil (no garantiza preservar la clase) y, sobre todo, NO coloreaba las
variables ya horneadas en el `.docx` importado ni las tipeadas a mano (caso
reportado: `{{curso.nombre}}` en la celda "Asignatura" salía en negro).
- `RichTextEditor` ahora **decora todo token `{{…}}`** del DOM (incluye
  `{{#each}}`/`{{/each}}`) preservando el caret por offset de texto; guard de IME.
- El `body_html` que se **guarda y exporta va LIMPIO**: `stripVarDecoration` quita
  los wrappers al emitir (también los `span.examlab-added` viejos de plantillas
  previas). El resaltado es 100% del editor — el `.docx`/PDF conservan el formato
  del template. Los bloques de IA (`div.examlab-added`) sí persisten, como antes.
- El insert desde el catálogo mete texto/markup PLANO; el editor lo colorea.
- Helpers `decorateVars`/`stripVarDecoration` con tests (round-trip, importadas,
  bloques de control, atributos con llaves, limpieza de legacy).

**Informes — cabecera de CUADROS DE TEXTO reconstruida (caso Camacho).** Con el
.docx real (`diagnostico.docx`) se halló que la cabecera NO es una tabla sino 3
**cuadros de texto flotantes** (`<w:drawing>`+`<w:txbxContent>`, anclados con
`<wp:positionH>`): logo (inline) + título + versión. El importador los aplanaba
a párrafos apilados → la exportación quedaba desfasada.
- **`reconstructPositionedBoxes`** (docx-import): detecta cuadros de texto, los
  agrupa por posición horizontal y los reconstruye como una **fila de tabla** —
  una columna por cuadro, ordenadas izquierda→derecha, ancho proporcional a su
  tamaño. Verificado contra el archivo real: logo 26% | título 55% | versión 19%,
  título centrado/negrita, logo embebido. + tests con cabecera sintética.
- **Dedup de imágenes** (mc:AlternateContent DrawingML+VML ya no duplica el logo).
- **Tope de tamaño de imagen en el .docx** (`html-to-docx`): el logo se acota al
  ancho de SU columna/página (en .docx no hay `max-width` → un logo grande
  desbordaba y rompía el layout). Verificado E2E: el `.docx` del archivo real
  produce un `<w:tbl>` de 3 celdas en `word/header1.xml` con el logo embebido.

**Informes — fidelidad de estilos del .docx + variables en ambos scopes + iterar
estudiantes en preview.**
- **Estilos del .docx copiados con más fidelidad**: el importador ahora preserva
  tamaño de fuente (`w:sz`→pt), color (`w:color`), fuente (`w:rFonts`), subrayado,
  alineación vertical de celda (`w:vAlign`) y sombreado (`w:shd`). La exportación
  `.docx` (`html-to-docx`) los lleva al run (`w:sz`/`w:color`/`w:rFonts`/`w:u`) y a
  la celda (`tcBorders` POR CELDA — la del título sí, el logo no — `w:shd`,
  `w:vAlign`). + tests.
- **Variables de la derecha en AMBOS scopes**: `reportCatalogForScope` ya no
  oculta grupos — los muestra TODOS, sólo reordena (lo relevante al scope
  primero). Así, aunque el informe sea por estudiante, aparecen las variables del
  curso para referenciar (y los escalares del alumno en uno por curso).
- **`{{#each estudiantes}}` ahora itera en la vista previa**: insertar un bloque
  de control (`{{#each}}`/`{{#if}}`) en el editor visual lo metía en un `<span>`
  inline que partía el par de tokens y rompía la iteración. Ahora se inserta como
  BLOQUES (apertura / línea editable / cierre) con el par intacto → el preview
  itera con datos reales/de muestra.
- El resaltado de lo agregado en la plataforma (variables/IA/bloques) sigue
  siendo SÓLO del editor; la exportación conserva el formato del template (sin
  color). *Nota: colorear texto libre tecleado vs original requiere control de
  cambios y queda fuera de alcance; lo insertado (variables/IA) sí se resalta.*

**Acta oficial — "No se pudo generar el acta" CORREGIDO (workflow).** Un workflow
de diagnóstico (14 hallazgos, 7 confirmados) halló la causa: `generate_course_acta`
hacía un INSERT plano sobre `course_actas`, que tiene UNIQUE (course_id,
COALESCE(period_id, zero-uuid)); al **regenerar** un acta ya existente lanzaba
23505 → toast genérico. Fix (mig `20260978`, recrea el RPC):
- **ON CONFLICT DO UPDATE** → "Generar" ahora REGENERA (reemplaza) el acta del
  curso/periodo con las notas actuales, sin pedir borrar a mano. Diálogo
  actualizado.
- **Talleres vía `workshop_courses`** (M:N, peso/corte por curso): antes el RPC
  leía `workshops.course_id` (modelo viejo) y OMITÍA los talleres COMPARTIDOS
  (p. ej. el "Taller Final" de Camacho) del acta.
- Filtros `deleted_at IS NULL` (papelera) en exámenes/talleres/proyectos; RAISE
  claro si el curso no tiene estudiantes; `search_path` incluye `extensions`.
- `friendlyError` mapea `idx_course_actas_unique` + el toast de acta muestra el
  detalle real (message/hint) — ya no oculta la causa.

**Informes — nombre único también al IMPORTAR + diagnóstico del fallo de acta.**
- El nombre único de plantilla ahora se aplica tanto a las creadas de 0 (en
  guardar) como a las **importadas** desde `.docx` (docente y admin): si ya
  existe una con ese nombre se crea una NUEVA con sufijo "(N)" — nunca se entra
  en modo edición de la existente.
- `ActasManager`: el fallo "No se pudo generar el acta" ahora **muestra el
  detalle real** (message/hint) en el toast + `console.error`, para diagnosticar
  (antes el toast genérico ocultaba la causa). La descarga Word ya es `.docx`
  real (commits previos `925c8a6`/`d2f9916`) — el `.doc` que se ve aún es la
  versión sin Publish.

**Informes — variables y prompt IA según el TIPO de informe (scope).** El panel
de variables de la derecha y el contexto de la IA dependen ahora del scope:
- `reportCatalogForScope(scope)` (template-engine): por **estudiante** muestra
  variables del alumno único (`estudiante.*`, notas, asistencia) + curso/docente/
  institución; por **curso** muestra el consolidado `{{#each estudiantes}}` +
  totales. El editor (`TemplateEditor`) usa el catálogo según `value.scope`.
- La **IA** recibe ese mismo catálogo (`buildAiReportPrompt({ catalog })`) y los
  datos reales según scope: curso → datos del curso completo; estudiante →
  datos de ese estudiante (vía `studentId` en `buildReportContext`).
- El editor **pide PRIMERO el tipo de informe** (scope), full-width y con nota
  de que de él dependen variables + datos. + tests de `reportCatalogForScope`.

**Informes — exportación .docx REAL (cabecera en el área de encabezado),
resaltado de lo agregado por la plataforma, y nombres únicos.** (commit pendiente)

- **Descarga Word ahora es `.docx` OOXML real** (no `.doc` MSO-HTML que Word
  re-interpretaba y cambiaba el formato). Nuevo `html-to-docx.ts` (fflate +
  DOMParser, sin libs): el cuerpo va en `word/document.xml`, **la cabecera en
  `word/header1.xml`** (área de encabezado de página, referenciada en
  `<w:sectPr>` → se repite arriba en cada página, ya NO al inicio del cuerpo),
  el pie en `word/footer1.xml`, imágenes embebidas en `word/media/*`, tablas con
  anchos de columna (`tblGrid`/`gridSpan`), headings/negrita/itálica, saltos de
  página. + 7 tests de estructura OOXML (incl. que la cabecera NO queda en el
  cuerpo).
- **PDF**: header/footer con `position:fixed` en `@media print` → van al área de
  encabezado/pie de cada página (1 pág exacto; multi-pág se repiten). Pantalla
  sin cambios. Para fidelidad total de encabezado, la descarga `.docx` es la vía.
- **Resaltado de lo agregado en la plataforma**: en el editor VISUAL, lo que el
  docente inserta (una `{{variable}}` o contenido de IA) se envuelve en
  `.examlab-added` y se ve en otro color (violeta) — sólo en el editor (la clase
  no tiene estilo en el preview ni en el `.docx`/PDF), distinguiéndolo del
  template original.
- **Nombres únicos**: las plantillas (docente y admin) auto-sufijan "(2)", "(3)"…
  si el nombre choca; los informes generados llevan una **marca temporal** en el
  nombre de archivo (`fileStamp`) para que dos descargas no se sobrescriban.

Validación: `tsc` EXIT 0; reports 113/113 + locale-parity 7/7.

**Informes — saltos de página visibles en el editor visual + fidelidad de la
cabecera del .docx al exportar.** (commit pendiente)

- **Editor visual muestra dónde empieza/termina cada página**: el marcador
  `examlab-page-break` se decora en el contentEditable (regla global en
  `styles.css`, sólo afecta al editor — las previsualizaciones son iframes con
  su propio doc) como divisor "Salto de página". Antes sólo se veía el conteo
  total de páginas, no las divisiones.
- **La cabecera del .docx ya no se DESFASA al exportar**: el importador ahora
  preserva los anchos de columna del `<w:tblGrid>` (cada `<w:gridCol>` →
  `width:%`) + `gridSpan` (→ `colspan` + suma de anchos) + `table-layout:fixed`.
  Sin esto, una cabecera "logo | título | versión" reflowaba a columnas
  automáticas y la estructura quedaba distinta al original. + tests
  estructurales ("e2e" del flujo importar→exportar: docx con grid → bundle →
  `composeTemplateHtml` conserva tabla/anchos/logo/título centrado).

Validación: `tsc` EXIT 0; reports 99/99.

**Diagnóstico (workflow) + fix: tormenta de correos "de notificaciones que ya
pasaron" en el tenant Camacho.** Un workflow de auditoría (32 hallazgos, 19
confirmados) identificó las causas. Causa raíz de los CORREOS de eventos
pasados: `dispatch_scheduled_messages()` seleccionaba `status='pending' AND
send_at <= now()` SIN tope inferior → un mensaje programado vencido (outage de
cron / send_at pasado) se disparaba RETROACTIVAMENTE; como `broadcast` emaila,
mandaba un correo a CADA estudiante de un aviso ya pasado.

- **Fix (mig `20260977000000`)**: `dispatch_scheduled_messages` ahora (1) cancela
  de entrada los pendientes vencidos >24h, (2) sólo despacha lo vencido en las
  últimas 24h (nunca retroactivo), (3) limpieza one-shot de los acumulados. El
  resto del cuerpo (direct/broadcast + GUC) idéntico a `20260709000000`.
- **Corrección de un over-flag del audit**: las funciones cron de recordatorio de
  estudiante NO tienen un "leak cross-tenant" real (notifican a cada alumno de SU
  propio curso); agregarles `tenant_id = current_tenant_id()` (NULL bajo
  service_role) ROMPERÍA todos los recordatorios — NO se aplicó.
- **Otras causas confirmadas (relevadas, fix recomendado, no aplicado aún)**:
  dedup por TÍTULO exacto en recordatorios (se reabre al editar el título → usar
  dedup por id de entidad); remoción del rate-limit de mensajería (`20260531`,
  decisión de producto — kill-switch `email_settings.enabled_kinds.messages`);
  `notify_send_email` re-dispara en UPDATE/re-insert (guard `TG_OP='UPDATE'` /
  `email_delivered_at IS NOT NULL`); `notify_teachers_pending_grading` duplica
  notificación DIARIA en la CAMPANA (no correo: kind='system') → falta guard
  `created_at::date = CURRENT_DATE`. SQL diagnóstico entregado al usuario para
  confirmar cuál(es) están activas en Camacho.

**Informes IA — fix `prompt_too_large`, prompt configurable y preview con datos reales.**
(commit pendiente)

- **`prompt_too_large` (413) corregido**: la Generación IA inline mandaba el
  CUERPO COMPLETO del informe como `draftText` (que tras importar un .docx
  incluye imágenes base64 → >200K chars, el tope del edge). Ahora la generación
  inline manda `draftText: ""` (es un FRAGMENTO para el cursor, no una
  reescritura). Además `buildAiReportPrompt` elimina los data URIs y acota el
  resumen del curso (12K) y el borrador (8K) — defensa anti-tamaño.
- **Prompt configurable** (`ai_prompts.use_case = 'report_generation'`): el
  system prompt de la Generación IA dejó de estar hardcodeado en el front; ahora
  vive en el módulo de Prompts (Admin → IA → categoría "Informes"), editable por
  el SuperAdmin (PLATFORM DEFAULT) y disponible para todos los tenants vía el
  resolver del edge (`ai-generate-report` resuelve course→tenant→platform→
  FALLBACK, igual que el Tutor). Mig `20260976000000` (CHECK + seed). El front
  manda el `user` dinámico; el edge resuelve el `system`.
- **Vista previa con DATOS REALES (no mock)**: el editor ahora previsualiza con
  los datos reales de un curso que el docente elige (selector de curso en la
  pestaña Vista previa). En scope **estudiante** aparece además un selector de
  ESTUDIANTE para "situar" las variables con ese alumno; en scope **curso** las
  iteraciones (`{{#each estudiantes}}`) traen TODOS los estudiantes reales. La
  Generación IA usa ese mismo curso/estudiante como fuente de datos (ya no un
  selector aparte). Hasta elegir curso, cae al contexto de muestra/marca.

Validación: `tsc` EXIT 0; reports 95/95 + locale-parity 7/7.

**Editor de informes — preview renderizado, números de página y Generación IA al cursor.**
(commit pendiente) Mejora el editor de plantillas (flujo de importar .docx):

- **Vista previa RENDERIZADA**: el preview del editor ya NO muestra los
  `{{placeholders}}` crudos — los resuelve con datos de MUESTRA (o la marca real
  del tenant: `useTenant()` → logo + nombre), así se ve el documento como
  quedará (el logo institucional aparece, las notas se ven). `composePreviewHtml`
  ahora usa `renderTemplate` + `buildSampleReportContext` (nuevo, en
  template-engine) en vez de resaltar tokens. Render resiliente (un bloque sin
  cerrar no rompe el preview).
- **Números de página claros**: cada hoja del preview se titula "Página X de N"
  (badge), y el tab Cuerpo muestra un contador "N página(s)".
- **Generación IA al cursor**: se quitó el botón inferior global "Generar con IA"
  (que reemplazaba todo el cuerpo). Ahora hay un botón "Generación IA" arriba en
  el panel de **Variables disponibles** (derecha): el docente sitúa el cursor en
  el cuerpo, abre un prompt (curso de referencia + instrucción) y la IA inserta
  el contenido EXACTAMENTE donde está el cursor (`RichTextEditor.insertHtml` +
  selección guardada al abrir el diálogo). El edge `ai-generate-report` y el
  fallback a portapapeles se conservan. `TemplateEditor` recibe `onAiGenerate`,
  `aiCourses` y `previewContext`.

Validación: `tsc` EXIT 0; tests de reports 95/95 + locale-parity 7/7 (15 claves
nuevas en es+en del editor).

**Auditoría funcional #39 (workflow) — fixes de seguridad y correctitud.** El
workflow halló 53 candidatos → 36 confirmados. Se corrigió el subconjunto de
ALTA + las MEDIA de seguridad/correctitud + cheap-code; el resto (safe-failing
o de mayor riesgo) queda registrado abajo como **diferido**.

Corregido (commit pendiente):

- **#0 ALTA — divergencia nota final docente↔estudiante con items SIN corte**:
  el gradebook docente incluye TODOS los items en la nota final (y el
  certificado usa ese número), pero la vista del estudiante excluía los items
  con `cut_id NULL` (vivían en "Sin corte" como informativos). Ahora el
  estudiante también los suma al weighted avg → paridad con docente/certificado.
  (`app.student.grades.tsx`)
- **#1/#25 MEDIA — fuga cross-tenant**: `course_pending_grading_count(uuid)`
  (mig `20260972`) era SECURITY DEFINER + GRANT authenticated SIN authz → cualquier
  autenticado leía el conteo de pendientes de cualquier curso/tenant. `REVOKE`
  (los llamadores internos SECURITY DEFINER conservan EXECUTE). Mig `20260974`.
- **#3 MEDIA — `content_course_assignments`**: políticas WRITE/SELECT con
  `has_role` SIN scope de tenant → Admin de tenant A podía asociar material a
  curso de tenant B. Scopeadas con `course_in_my_tenant`. Mig `20260974`.
- **#4 MEDIA — `workshop_courses`**: la política tenant-scoped de `20260528`
  nunca se aplicó (la tabla se creó después, en `20260704`) → quedó viva la WRITE
  bare-`has_role` (leak cross-tenant de binding taller↔curso + weight/cut).
  Re-aplicado el scope (`workshop_courses_staff_manage`/`_select_in_tenant`).
  Mig `20260974`.
- **#16 MEDIA — `get_course_cohort_weights` mostraba DRAFT**: el tablero del
  estudiante listaba actividades/% aún no publicadas (las filas `*_assignments`
  existen desde la creación, incluso en borrador). Filtro `status <> 'draft'`.
  Mig `20260974`.
- **#21/#27 BAJA — curso demo oculto**: el "Curso de pruebas" se sembró sin
  `status` → heredó `borrador` y quedaba oculto bajo el filtro por defecto
  `en_curso`. `UPDATE` a `en_curso` (idempotente). Mig `20260974`.
- **#28/#30 BAJA — TZ off-by-one en `deriveCourseDisplayState`**: DATE-only se
  parseaba como medianoche UTC → en es-CO un curso que empieza "hoy" se
  clasificaba mal las primeras horas. Anclado a mediodía local (patrón
  `formatDateOnly`). + test de regresión TZ-independiente. (`course-status.ts`)
- **#19 BAJA — columna "Asistencia (0%)" espuria** en export: `cutHasAttendance`
  usaba `!= null` en vez de `> 0`. (`app.teacher.gradebook.tsx`)
- **#9 MEDIA — `.xlsx` inválido por chars de control**: `xmlEscape` no eliminaba
  los caracteres prohibidos por XML 1.0 (un nombre con control char tras CSV mal
  formado generaba un archivo que Excel no abría). Strip antes de escapar.
  (`xlsx.ts`)

Diferido (registrado, no corregido en este commit):

- **#5/#29 — colisión de claves en export Excel/CSV** cuando 2 items comparten
  label (mismo título+peso+tipo en cortes distintos): requiere refactor de
  `toXLSX` para usar id estable como key y label sólo como header.
- **#6/#8 — atribución de items COMPARTIDOS/GRUPO** en dashboards y gradebook
  (un workshop/project compartido se atribuye a UN solo curso; entregas de grupo
  sólo cuentan al "último editor"). Pre-existente, más visible con la feature de
  cursos compartidos.
- **#10/#11/#17 — validación/resolución de peso POR-CURSO** en talleres/proyectos
  multi-curso usa columnas legacy en vez de `*_courses` (sólo afecta validación
  de bucket y el caso `weight NULL` en curso secundario).
- **#12–#15 — `useDirtyDialog`**: spurious-dirty al abrir para editar (polls,
  EditExternalContent) + estados fuera de `form` no observados (videos intro,
  cursos, pesos por-curso en workshops/projects). Safe-failing (peor caso: prompt
  "¿descartar?" de más o guardia omitida — nunca corrupción). Requiere verificar
  timing de hidratación por diálogo.
- **#2 — `notify_teachers_daily_summary`** cuenta entregas con status en inglés
  (`'submitted','in_progress'`) que nunca matchean el dominio español → el conteo
  de talleres/proyectos del digest diario es siempre 0. Pre-existente; bajo impacto.
- Varios BAJA de borde: #18/#31 (presentación de items external/`max_score=0`),
  #20/#22/#23/#24/#26/#32/#33/#34/#35.

Validación: `tsc` EXIT 0; tests afectados (xlsx + course-status + cohort-weights)
verdes (course-status 13/13 con el nuevo test TZ).

**Refactor del módulo Informes — Plantilla ≠ Informe generado, claridad de
páginas, descarga Word/PDF.** (commit pendiente)

- **Páginas claras al editar un .docx**: el importador (`docx-import.ts`) ahora
  detecta los saltos de página de Word (`<w:br w:type="page"/>` y el hint
  `<w:lastRenderedPageBreak/>`) y los traduce a un marcador
  `<div class="examlab-page-break">`. `composeTemplateHtml` lo convierte en un
  corte REAL en impresión/PDF/Word (`page-break-after`) y en un divisor visible
  "Salto de página" en pantalla (`@media screen`) — antes el .docx se veía como
  un bloque continuo sin saber dónde cambiaba la página. + tests.
- **"Generar" = archivo descargable (Word o PDF)**: nuevo
  [report-download.ts](src/modules/reports/report-download.ts) — Word vía técnica
  HTML-como-Word (MSO, sin librerías, `.doc` editable que respeta `@page` +
  saltos) y PDF vía impresión en iframe oculto. El generador ahora muestra
  "Vista previa" + "Descargar Word" + "Descargar PDF" (antes sólo "Imprimir/PDF").
  El flujo es de DOCENTE, nunca de estudiante (RLS lo refuerza).
- **Plantilla vs Informe generado**: nueva tabla `generated_reports` (mig
  `20260975`) que persiste cada informe generado (plantilla + curso/estudiante/
  periodo + snapshot HTML + quién/cuándo). RLS: sólo docente del curso / Admin
  del tenant / SA (scopeada con `course_in_my_tenant`); inmutable (sin UPDATE);
  el estudiante NO la ve. La pantalla del docente se reorganizó en 2 **tabs**:
  "Plantillas" (gestionar blueprints) e "Informes generados" (actas + historial
  con re-descarga Word/PDF + eliminar). Persistir ocurre al descargar (una fila
  por generación, dedupe Word+PDF del mismo preview).

Validación: `tsc` EXIT 0; tests de reports 85/85; locale-parity 7/7 (17 claves
nuevas en es+en).

**Importar .docx — cabeceras con imagen, páginas claras y export completo.**
(commit pendiente) Refuerza el flujo de IMPORTAR un Word a una plantilla:

- **Cabeceras/pies con imágenes**: el importador (`docx-import.ts`) ahora
  extrae también la CABECERA y el PIE del .docx (vía `<w:sectPr>` →
  `headerReference`/`footerReference`, o fallback `header1.xml`/`footer1.xml`)
  y **embebe las imágenes** (logo institucional) como data URI — resolviendo
  rId → rels → `word/media/*` y base64. Las celdas de tabla se renderizan con
  su contenido real (imágenes + negrita + alineación `<w:jc>`), no sólo texto;
  los bordes se respetan sólo si la tabla/celda los declara. Así una cabecera
  "logo | título | versión" aparece en el preview y al exportar. `parseDocxBundle`
  devuelve `{ bodyHtml, headerHtml, footerHtml }`; los handlers de importar
  (docente + admin) pueblan `header_html`/`footer_html`, no sólo `body_html`.
- **Páginas claras al editar**: el preview del editor (`composePreviewHtml`) se
  rediseñó como **hojas de página** separadas (una por bloque entre saltos),
  cada una con etiqueta "Página N", tamaño real de hoja (mm según size/orient.)
  y cabecera/pie repetidos — antes se veía todo el contenido junto sin saber
  qué texto caía en cada página.
- **Export = antiguo + nuevo**: al poblar `header_html`/`footer_html` en la
  importación (y persistirlos en `report_templates`), la generación/exportación
  (`composeTemplateHtml` → `<header>`+`<main>`+`<footer>`) ahora incluye el
  documento ORIGINAL completo (logo/cabecera/cuerpo del .docx) MÁS las
  `{{variables}}` que agregó el docente. Antes sólo exportaba lo nuevo porque
  la cabecera/pie nunca se importaban.

Validación: `tsc` EXIT 0; tests de reports 97/97 (docx-import con casos de
cabecera+imagen+alineación; preview con hojas de página); locale-parity 7/7.

### 2026-06-14

Sesión de mejoras amplia (cada ítem = un `/goal` del usuario). Commits sobre `main`.

> ⚠️ **PENDIENTE DE PUBLISH (Lovable):** varios fixes son de código/migración y
> sólo se ven tras **Publish**. En particular el fix de **talleres COMPARTIDOS**
> (`6912b4b`) resuelve #35/#36 (la nota del Taller Final no aparecía en Seminario)
> — el dato está sano, falta deploy. Migraciones nuevas: 20260962–20260973.

- **Colores en el Excel de calificaciones** (#38): estilos OOXML opcionales en
  xlsx.ts (6ª parte sólo si se usan; byte-idéntico sin estilos) + encabezado/grupo/
  verde-aprobado/rojo-reprueba como el grid. — `b8fe520`
- **i18n: consolidación** de 35 claves defaultValue de la sesión en es+en (7680/7680). — `81b2a76`
- **Aviso "cambios sin guardar"** (#11b) extendido a 12 diálogos de crear/editar. — `0dce3be`
- **Tablero del estudiante: evaluación por cohorte** (#33): RPC SECURITY DEFINER
  get_course_cohort_weights + helper + panel (qué actividades/% aplican a cada
  cohorte). Mig 20260973. — `c1e3d63`
- **Item COMPARTIDO muestra nota en AMBOS cursos** (#30/#31/#35/#36): talleres se
  cargaban por ancla legacy; ahora via workshop_courses (grades + gradebook +
  cut-detail). Datos VetCare/Taller Final sanos. — `6912b4b` *(requiere Publish)*
- **Crash al ordenar grilla de talleres por Corte** (#32, TDZ cuts) — `1f681e8`. +
  fix `<strong>` literal en weightBucketDesc/weightAvailable (#27/#34) — `3162b8a`,`985ccba`.
- **Finalizar curso exige sin pendientes** (#29, mig 20260972) — `b1ef9cd`.
- **Datos Camacho**: Taller Final compartido a 2 cursos (Corte 3, 15% c/u) vía REST (#28).

> **Paralelización (#25):** desde acá los workflows con archivos de código DISJUNTOS
> corren EN PARALELO usando `t(..., {defaultValue})` (sin editar locales) para no
> chocar en `es.json`/`en.json`; un pase final consolida las claves. Se corrieron
> hasta 3 workflows a la vez.

- **Kahoot con IA desde el contenido del curso** (#18): elegir curso + fuente
  (una sesión / todo); la edge lee el material real y genera las preguntas; si es
  de una sesión, el Kahoot queda asociado a ella. — `d5f084f`
- **"Puntaje" siempre en escala del curso** (#19, presentación, sin tocar notas) +
  **editar peso por curso** en talleres compartidos (#21). — `917d134`.
  ⚠️ **Se DESCARTÓ** la migración que normalizaba `max_score` a la escala del curso:
  su heurística ("notas ≤ escala se asumen ya en escala del curso") podía
  RE-INTERPRETAR notas bajas de items /100 (4/100 ≈ 0,2/5 → 4/5), cambiando notas
  finales. El fix de presentación resuelve el síntoma sin riesgo. Si se quiere
  normalizar `max_score`, hacerlo per-tenant verificando que no haya notas 0<g≤escala
  en items /100.
- **Finalizar curso (auto/manual) exige no tener pendientes de calificación** (#29):
  manual → RAISE; auto (cron) → no finaliza + notifica a los docentes. Mig 20260972. — `b1ef9cd`
- **Fix #27**: `weightBucketDesc` mostraba `<strong>` literal (i18n vía t() escapa); tags
  quitados en es+en. — `3162b8a`
- **Validación fecha fin ≥ fecha inicio** (#10, iguales permitido): helper
  `isValidDateRange` + aplicado en cortes/curso, exámenes (create+edit), talleres,
  proyectos, periodos académicos. — `b30101e`
- **Excel calificaciones: cortes COMBINADOS** (#26): `mergeCells` por corte +
  columna de asistencia por corte + etiqueta "Corte N (peso%)". — `41f0e37`
- **Dashboard Admin: diagnóstico de TODOS los cursos del tenant** (#8): stat
  "Por calificar" clickeable → modal con todos los cursos → CourseDiagnosticDialog. — `567935d`
- **Export Excel de calificaciones — fila de grupo por corte** (#9): `toXLSX` acepta
  `options.groupHeader` opcional → fila extra arriba del header que mapea cada columna
  de item al nombre de su corte. Sólo Excel (CSV sin cambios). `GradeColumn.cutId`
  cargado. Sin items con corte → sin fila de grupo. tests xlsx 15/15.
- **Contenido / tablero**: labels por `display_name` (no `topic`) en tablero docente y
  estudiante; multi-curso vía `ManageContentCoursesDialog` (un contenido en >1 curso,
  visible en cada tablero); destino "General" del upload (ya existía) verificado
  end-to-end. Sin migración de datos (era de visualización). — `f4c396d`
- **Grid de Contenidos a altura estándar**: fila de UNA línea (nombre + estado +
  conteos); se quitó el subtítulo del tema (queda en el tooltip) y el alto fijo h-16. — (#22)
- **CHANGELOG.md** + protocolo: validar contra decisiones previas antes de cada tarea. — `492555a`
- **Diagnóstico (cohortes)**: verificado que la tab Cohortes YA lista el detalle de
  actividades sin cohorte asignada (actividad + cohortes faltantes + alumnos afectados);
  sólo falta Publish. (#24, sin cambio de código)
- **Filtro de estado por defecto = vigente** en grids con filtro de estado
  (estudiante exámenes/talleres/proyectos → "available"; Admin Cursos → nuevo
  filtro con default "en_curso"; Soporte → "active"; Errores → "nuevo"). Conserva
  "Todos"/cerrados. — `c3271a5`
- **Filtro de auto-asignación de docentes por rol ACTIVO** (multi-rol Admin+Docente
  actuando como Docente no ve su checkbox). — `520a40b`
- **Estados de ciclo de vida de curso** (borrador/en curso/finalizado) + auto-finalize
  por fecha (cron) o manual (RPC) + UI (badge, acciones, 5 stat cards) + tab integrada.
  Mig `20260964`. — `afbaf99`
- **Docente no puede auto-asignarse** (drop policy "Docentes manage own course_teachers").
  Mig `20260966`. — `c621cd7`
- **Curso de pruebas demo** con todos los usuarios como docentes (ExamLab Demo).
  Mig `20260965`. — `f487072`
- **Foros**: no muestran sesión en papelera ni la listan en el picker. — `6709b9c`
- **Docente ve sólo sus cursos** + puede editar pizarras de su curso (rama RLS
  course-teacher) + trigger auto-docente al crear curso. Mig `20260963`. — `fb40899`
- **Rol por defecto = Docente** al loguearse (multi-rol). — `523ffb5`
- **Auditoría de papelera** (59 fugas: 27 archivos frontend + edges + RPCs).
  Mig `20260962`. tsc 0, suite 1855/1855. — `a4edf79`
- **Diagnóstico de curso**: tab "Cobertura de pesos" (% sin asignar por corte/bucket
  + total del curso). — `c1545a4`
- **Export de calificaciones**: agrupado por cohorte + % de cada item en encabezados
  (CSV + Excel). — `191e633`
- **Dashboard Admin**: "Por calificar" y "Cursos" excluyen cursos en papelera. — `ed3b4e7`
- **Conteo "por calificar"**: no contar exámenes ya calificados a mano (`final_override_grade`)
  ni talleres/proyectos calificados por IA. — `48f2cfe`
- **Datos Camacho**: removido usuario huérfano `e8b3c430` (sin perfil) de course_teachers
  + course_enrollments de 2 cursos → 1 docente / 17 estudiantes (vía REST como Admin).
- **Local**: fuente Nerd Font del terminal VS Code (`settings.json` → MesloLGLDZ Nerd Font Mono).

#### En progreso / pendiente (workflows en cola)

- Contenido: usable en >1 curso a nivel de tablero + label por `display_name` (no `topic`)
  + asociar a sección "General" + corregir datos FESNA. *(workflow en curso)*
- Grid de Contenidos: filas a altura estándar (recortar info redundante).
- Export Excel de calificaciones: fila que agrupe cada entregable por su corte.
- Validación front: fecha fin ≥ fecha inicio en todos los flujos (iguales permitido).
- Aviso "¿seguir editando?" (cambios sin guardar) en todos los flujos de crear/editar.
- Admin: ver el diagnóstico de TODOS los cursos del tenant.
- Generar Kahoot con IA leyendo el contenido del curso (de una sesión o todo) + asociar a sesión.
- Consistencia de escala: actividades/calificaciones siempre en la escala del curso (no 100) + migrar datos.
- Editar el peso/corte por curso de talleres/proyectos asociados a >1 curso (como en creación).
