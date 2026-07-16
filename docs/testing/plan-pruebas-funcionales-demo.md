# Plan de pruebas funcionales — ExamLab

> **Fecha:** 2026-07-16 · **Alcance:** verificación funcional + UI/UX de todos los módulos, por rol, contra el tenant de pruebas. Generado con un panel de 8 agentes QA (uno por grupo de módulos) leyendo el código y las convenciones del proyecto.

## Cómo entrar y credenciales de prueba

- **URL:** https://examlab.lovable.app/auth
- **Institución:** **Demo Global Corp** (elegir en el selector "Institución"). Deep-link directo: `/t/demo-global-corp/auth`.
- **Usuario:** `test-demo-global-corp@examlab.test` · **contraseña** `sZhrnEu4N6XsYD`
- **Roles:** Admin + Docente + Estudiante → cambia de rol con el **selector del sidebar** (un solo login permite probar los 3 roles).
- El tenant ya trae 3 cursos y usuarios de muestra (docentes: carlos.ruiz@, laura.gomez@; alumnos: ana.torres@, mateo.rojas@, … @demoglobalcorp.test).

> ⚠️ **Sobre el video de "cómo entrar":** no existe un video que muestre la selección de institución + credenciales. El clip `modulo-login.mp4` es un *bumper de marca* (~13s); por diseño el pipeline graba ya autenticado (login fuera de cámara). Si se necesita, hay que grabar un tutorial con el login EN cámara.

## Cómo usar este plan

- Cada **sección** = un grupo de módulos; cada **módulo** trae una tabla de casos con columnas **ID · Caso · Precondición · Pasos · Resultado esperado**, más una lista de **Checks UI/UX**.
- Marca cada caso: **✅** pasa · **⚠️** observación · **❌** falla (adjunta evidencia / captura).
- Prueba los **3 roles** con el mismo usuario usando el role-switcher.
- Repite los checks de UI/UX clave en cada módulo: **375px sin scroll horizontal**, **modo claro/oscuro**, **estados loading/empty/error**, **toasts en español**, **fechas es-CO**, **paginación/orden/filtros**, **touch targets ≥32px**.

## Índice

1. Autenticación, navegación, tenant y roles
2. Cursos, estructura académica, cortes/pesos y matrículas
3. Exámenes (creación, tipos de pregunta, toma, proctoring, monitor, revisión)
4. Talleres y Proyectos
5. Calificaciones/gradebook, asistencia (QR) y certificados
6. Contenidos, pizarras, videos, Tutor IA y Asistente de plataforma
7. Encuestas, Reto en vivo, foros y mensajería
8. Administración y SuperAdmin

---

## Autenticación, navegación, tenant y roles

Cubre el ingreso a la plataforma (login + selección de institución, SSO, recuperar contraseña, cambio forzado de contraseña, guardar credencial en el navegador), el cambio de rol y el enrutamiento por rol activo, el branding/aislamiento por institución (tenant), el tema claro/oscuro, el tour de onboarding y el ecosistema de avisos (notificaciones, push, campana de mensajes). El tenant de referencia es **Demo Global Corp** y el usuario multi-rol (Admin + Docente + Estudiante).

### Módulo: Login + selección de institución (AUTH)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| AUTH-01 | Carga del formulario de login | Sesión cerrada | Abrir `https://examlab.lovable.app/auth` | Se muestra un spinner breve (verificación de sesión) y luego el formulario. NO parpadea el form antes del spinner. Campos: `Institución` (con ícono edificio), `Correo institucional` (autofoco), `Contraseña`, checkbox `Recordarme`. Panel de marca ExamLab visible en `lg+` |
| AUTH-02 | Selector de instituciones carga vía RPC pública | Sesión cerrada | Abrir el desplegable `Institución` | El placeholder pasa de `Cargando…` a `Selecciona tu institución`. Lista las instituciones activas (incluye "Demo Global Corp") + la opción especial `— SuperAdmin: vista cross-tenant —`. Al elegir una, aparece bajo el campo la URL `/t/<slug>` |
| AUTH-03 | Botón login deshabilitado sin institución | Sesión cerrada | Escribir correo + contraseña, NO elegir institución | El botón de ingreso permanece `disabled` mientras no haya institución seleccionada |
| AUTH-04 | Login exitoso (happy path) | Cuenta válida en Demo Global Corp | Elegir `Demo Global Corp`, ingresar correo + contraseña válidos, `Ingresar` | Toast de bienvenida (verde), redirección a `/app`. El dashboard corresponde al rol por defecto (Docente para el multi-rol) |
| AUTH-05 | Credenciales inválidas | Sesión cerrada | Elegir institución, contraseña incorrecta, `Ingresar` | Toast de error de credenciales (español), permanece en `/auth`, se registra intento fallido (`log_failed_login`). NO se filtra si el correo existe |
| AUTH-06 | Correo no pertenece a la institución elegida | Cuenta de Demo Global Corp | Elegir una institución distinta a la del usuario, credenciales correctas, `Ingresar` | Se cierra la sesión recién creada (scope local) y aparece toast "No perteneces a la institución seleccionada." No entra al app ni cierra sesión en otros dispositivos |
| AUTH-07 | No-SuperAdmin elige "vista cross-tenant" | Cuenta sin rol SuperAdmin | Elegir `— SuperAdmin: vista cross-tenant —`, credenciales correctas | Se cierra la sesión local y aparece toast "Solo SuperAdmin puede acceder en modo cross-tenant." |
| AUTH-08 | Mostrar/ocultar contraseña | En formulario | Escribir contraseña, pulsar el botón de ojo | Alterna texto/oculto; el `aria-label` cambia entre "Mostrar contraseña"/"Ocultar contraseña"; el botón no entra en el tab order del form |
| AUTH-09 | "Recordarme" persiste correo + institución (no la contraseña) | Sesión cerrada | Marcar `Recordarme`, iniciar sesión, cerrar sesión, reabrir `/auth` | El correo y la institución quedan pre-llenados; el campo contraseña queda vacío (lo maneja el gestor del navegador). Verificar en localStorage: hay `examlab_remember_email`/`_slug`/`_flag`, NO hay contraseña |
| AUTH-10 | Destildar "Recordarme" limpia lo guardado | Login previo con "Recordarme" activo | Iniciar sesión con `Recordarme` desmarcado | Se eliminan las 3 entradas de localStorage; el próximo `/auth` abre con campos vacíos |
| AUTH-11 | Sesión ya activa evita el formulario | Sesión abierta en otra pestaña/recarga | Navegar a `/auth` | Muestra solo spinner y redirige directo a `/app` (o al deep-link recordado). Nunca destella el formulario |
| AUTH-12 | Deep-link protegido regresa tras login | Sesión cerrada | Abrir un deep-link `/app/...` (o QR Kahoot/asistencia), ser enviado a `/auth`, iniciar sesión | Tras login vuelve a la ruta original (return-to validado como interno, sin open-redirect) |
| AUTH-13 | Pre-selección por URL `/t/<slug>/auth` | Sesión cerrada | Abrir `https://examlab.lovable.app/t/<slug>/auth` con un slug válido | La institución queda pre-seleccionada una vez carga la lista; un slug inexistente NO se autoselecciona |
| AUTH-14 | Recuperar contraseña — envío | En formulario | `¿Olvidaste tu contraseña?` → se abre "Recuperar contraseña" con el correo pre-cargado → `Enviar enlace` | Se invoca `request-password-reset`; el diálogo muestra siempre el mensaje genérico "Si esa dirección está registrada…" (sin enumerar usuarios), con botón `Cerrar` |
| AUTH-15 | Recuperar contraseña — validación de campo | Diálogo abierto | Vaciar el correo | El botón `Enviar enlace` queda deshabilitado |
| AUTH-16 | SSO Google inicia OAuth | Sesión cerrada | Pulsar `Google` | Redirige al consentimiento Google forzando selección de cuenta (`prompt=select_account`). Solo ese botón muestra spinner; el resto queda deshabilitado |
| AUTH-17 | SSO Microsoft inicia OAuth | Sesión cerrada | Pulsar `Microsoft` | Redirige al login Microsoft (Azure). Nota de política visible: "El SSO solo entra si tu admin ya creó tu cuenta. No registra usuarios nuevos." |
| AUTH-18 | SSO no crea cuentas nuevas | Correo Google/MS sin cuenta pre-aprovisionada | Completar SSO con un correo que no existe en `profiles.institutional_email` | El callback rechaza, cierra la sesión huérfana y muestra error claro; NO crea usuario |
| AUTH-19 | Cambio de idioma en el login | En formulario | Usar el `LanguageSwitcher` (es/en) | Los textos del formulario cambian de idioma sin recargar |
| AUTH-20 | Enlaces de pie del login | En formulario | Verificar `Volver al inicio` y `Política de privacidad` | Navegan a `/` y `/privacy` respectivamente |

**Checks UI/UX (AUTH)**
- 375px: la Card de login usa `max-w-[calc(100vw-2rem)]` en móvil; el panel de marca se oculta en `<lg`; sin scroll horizontal. Botones SSO pasan a 1 columna en móvil.
- Claro/oscuro: formulario legible en ambos temas; el diálogo "Recuperar contraseña" respeta el tema.
- Loading: placeholder `Cargando…` en el selector de instituciones; spinner en botón `Ingresar`, `Google`/`Microsoft` y `Enviar enlace`.
- Empty/error: si la RPC de instituciones falla, el selector queda deshabilitado pero el login sigue disponible (el server valida igual).
- Toasts en español vía `friendlyError`/claves i18n (nunca inglés técnico).
- Touch targets ≥32px: el botón de ojo (`p-2`) y checkbox `Recordarme` con hit zone adecuada.
- Accesibilidad: labels con `required` (asterisco), `input hidden name="username"` para gestores de contraseñas, `aria-label` en el ojo.
- Hidratación (React #418): `email`/`rememberMe`/`selectedSlug` inician determinísticos; no debe verse el toast huérfano "Uncaught Error" en audit_logs al cargar `/auth`.

### Módulo: Cambio de contraseña forzado + guardar credencial (PWD)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| PWD-01 | Diálogo bloqueante en primer login | Usuario recién creado / contraseña reseteada por Admin (`must_change_password=true`, clave temporal `Temporal#123`) | Iniciar sesión con la clave temporal | Al entrar aparece el diálogo "cambio de contraseña" bloqueante sobre el app; no hay X, no hay Cancelar |
| PWD-02 | No se puede cerrar por Esc / click afuera | Diálogo abierto | Pulsar Esc; hacer click fuera del diálogo | El diálogo NO se cierra en ninguno de los dos casos |
| PWD-03 | Única salida alternativa = Cerrar sesión | Diálogo abierto | Pulsar `Cerrar sesión` | Cierra sesión y vuelve a `/auth` sin cambiar la contraseña |
| PWD-04 | Validación: ambos campos requeridos | Diálogo abierto | Dejar un campo vacío y `Guardar` | Toast "Completa ambos campos." y no procede |
| PWD-05 | Validación: mínimo 8 caracteres | Diálogo abierto | Nueva contraseña `abc12`, confirmar igual, `Guardar` | Toast "La nueva contraseña debe tener al menos 8 caracteres." |
| PWD-06 | Validación: contraseñas no coinciden | Diálogo abierto | Nueva contraseña ≠ confirmación | Texto inline rojo "Las contraseñas no coinciden." bajo el campo + botón `Guardar` deshabilitado |
| PWD-07 | Cambio exitoso desmonta el diálogo | Diálogo abierto | Ingresar contraseña válida en ambos campos, `Guardar` | Se actualiza la contraseña, se baja `must_change_password`, toast "Contraseña actualizada. ¡Bienvenido!", el diálogo se desmonta y se libera el app |
| PWD-08 | El flujo por token NO fuerza cambio | Usuario que definió su contraseña vía enlace de bienvenida / "olvidé mi contraseña" | Iniciar sesión con esa contraseña | NO aparece el diálogo forzado (el flag ya está en false porque el usuario eligió su clave) |
| PWD-09 | Guardar contraseña en el navegador (login) | Chromium (Chrome/Edge), cuenta nueva | Iniciar sesión desde `/auth` | El navegador ofrece guardar la contraseña (burbuja nativa) antes del redirect |
| PWD-10 | Actualizar contraseña guardada (cambio forzado) | Chromium, credencial temporal guardada | Completar PWD-07 | El navegador ofrece actualizar la credencial a la contraseña REAL, no queda la temporal |
| PWD-11 | Fallback en navegadores no-Chromium | Firefox/Safari | Repetir PWD-09 | No rompe: el flujo se apoya en `autoComplete` (username/current-password/new-password) y el `<form>` con username oculto |
| PWD-12 | Cambio de contraseña voluntario (menú) | Sesión iniciada, sin flag forzado | Menú de opciones (⋯) → `Cambiar contraseña` | Abre `ChangePasswordDialog` (cerrable), con `PasswordInput` y ojo |

**Checks UI/UX (PWD)**
- 375px: diálogo `max-w-[calc(100vw-2rem)] sm:max-w-sm`, sin desbordes; en iOS usa `dvh` (no `vh`) para que el footer no quede cortado con la barra de URL visible.
- Claro/oscuro: ícono `ShieldAlert` ámbar visible en ambos temas.
- Loading: spinner en `Guardar` mientras persiste.
- Toasts en español (`friendlyError` para errores de Auth/DB).
- Touch targets ≥32px en los ojos de `PasswordInput`.
- El tour de onboarding NO se dispara mientras el diálogo forzado está activo (queda tapado si no).

### Módulo: Role-switcher y enrutamiento por rol (ROLE)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| ROLE-01 | Rol por defecto en usuario multi-rol | Usuario con Admin + Docente + Estudiante | Iniciar sesión | Entra como **Docente** (prioridad Docente > Admin > Estudiante); el dashboard es el de Docente |
| ROLE-02 | Selector visible solo con >1 rol | Usuario multi-rol | Ver el sidebar | Aparece el `Select` de rol (data-tour-id `role-switcher`) con ícono y label del rol activo. Un usuario de un solo rol ve una píldora estática, no un selector |
| ROLE-03 | Cambio de rol recompone el nav | Rol activo = Docente | Cambiar a `Estudiante` | El sidebar cambia a los módulos del estudiante y redirige a `/app`; el branding/acento del rol se actualiza |
| ROLE-04 | Cambio de rol limpia el override de tenant | SuperAdmin con "Ver como X" activo (si aplica) | Cambiar rol a Admin/Docente/Estudiante | Se limpia `examlab_tenant_override`; el branding vuelve al del tenant del perfil |
| ROLE-05 | Acceso denegado por rol activo | Rol activo = Estudiante | Navegar por URL a `/app/admin/users` | Redirige a la home del rol (no queda en pantalla no autorizada); RLS es la autoridad real, esto es UX |
| ROLE-06 | SuperAdmin hereda nav de Admin | Rol activo = SuperAdmin | Ver el sidebar | Ve los ítems Admin (Usuarios, Cursos, etc.) + los SuperAdmin-only (Instituciones, Sistema) |
| ROLE-07 | Acciones de staff gateadas por rol ACTIVO | Usuario multi-rol actuando como Estudiante | Entrar a Foros / Mensajes | NO aparecen acciones de staff (crear foro, difundir a curso, moderar, programar). Al cambiar a Docente sí aparecen |
| ROLE-08 | Cuenta desactivada (is_active=false) | Cuenta desactivada por Admin con sesión viva residual | Cargar el app | Pantalla bloqueante "Cuenta desactivada" con botón `Cerrar sesión` |
| ROLE-09 | Estudiante retirado/aplazado bloqueado | Estudiante con `estado` retirado o aplazado | Ingresar | Pantalla "Acceso restringido" indicando el estado, con `Cerrar sesión`; el staff nunca se bloquea |
| ROLE-10 | Estudiante graduado en solo-lectura | Estudiante con `estado=graduado` | Ingresar y navegar | Banner ámbar de solo-lectura; puede ver notas/certificados pero RLS bloquea entregas |
| ROLE-11 | Menú de opciones (⋯) del usuario | Sesión iniciada | Abrir el menú ⋯ del sidebar | Ítems: Editar perfil, Cambiar contraseña, Preferencias de notificación, (Ver tour guiado si rol tourable), submenú Tema, submenú Idioma, Política de privacidad |
| ROLE-12 | Cerrar sesión pide confirmación | Sesión iniciada | Pulsar el ícono de salir | Confirmación (tono warning); al confirmar audita `user.logged_out` y cierra sesión |

**Checks UI/UX (ROLE)**
- 375px: role-switcher también disponible dentro del drawer móvil; ítems del drawer con tap targets grandes (`py-3`); bottom-nav con 5 destinos prioritarios por rol y `min-h-[56px]`.
- Claro/oscuro: acentos por rol (indigo/ámbar/esmeralda/rosa) visibles en ambos temas.
- Estados: pantallas bloqueantes (desactivada/retirada) centradas y con `p-6` responsive.
- Toasts/confirm en español; la confirmación de salir usa `useConfirm` (no `window.confirm`).
- Accesibilidad: `aria-label`/`title` en botones ícono del footer (ocultar menú, salir); truncado seguro de nombre/correo largo.

### Módulo: Sidebar, branding por tenant y aislamiento (TEN)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| TEN-01 | Branding del tenant en el sidebar | Sesión en Demo Global Corp | Ver el bloque de marca del sidebar | Muestra el logo del tenant (o `GraduationCap` si no hay) + el nombre de la institución; los colores primarios/secundarios del tenant tiñen sidebar, botones primary y focus rings |
| TEN-02 | Contraste de íconos/texto con branding | Tenant con color de marca claro y oscuro | Comparar sidebar en cada caso | El foreground se calcula por luminancia (texto blanco/oscuro legible); si el tenant define `icon_color`/`text_color`, ganan sobre el derivado |
| TEN-03 | SuperAdmin cross-tenant oculta branding | Rol activo = SuperAdmin, sin "Ver como" | Ver sidebar (desktop + drawer + header móvil) | Se oculta logo y nombre del tenant; muestra ícono genérico + "Plataforma de Gestión Educativa"; se ocultan cuotas; el tema vuelve al default OKLCH (sin tinte de tenant) |
| TEN-04 | Banner "Viendo como institución X" | SuperAdmin eligió "Ver como" un tenant | Activar el override | Banner azul sticky "Viendo como institución <X>" con botón `Salir del modo institución`; el branding del tenant se aplica |
| TEN-05 | Salir del modo institución | Banner de override visible | Pulsar `Salir del modo institución` | El banner desaparece, el branding vuelve a default cross-tenant, `useTenant` se refresca por evento |
| TEN-06 | Override stale se limpia solo | localStorage con slug de tenant renombrado/eliminado | Cargar el app como SuperAdmin | El override inválido se limpia automáticamente y cae al tenant del perfil / cross-tenant, sin error visible |
| TEN-07 | Aislamiento de datos entre tenants (RLS) | Sesión en Demo Global Corp | Recorrer Cursos, Usuarios, Exámenes | Solo se ven datos de Demo Global Corp; no aparecen entidades de otras instituciones |
| TEN-08 | Soft-delete invisible en todo flujo | Un curso/examen/taller enviado a Papelera | Buscarlo en listados, calendario, dashboard, gradebook, tutor | NO aparece en ningún flujo ni rol hasta restaurarlo; solo es visible en `/app/trash` |
| TEN-09 | Orden y visibilidad de módulos | Admin configuró orden/visibilidad de módulos | Cambiar entre roles | El nav respeta el `display_order` configurado; el Admin ve todos los ítems (bypass), Docente/Estudiante respetan los toggles |
| TEN-10 | Toggle global "Banco de preguntas" | Admin desactivó el banco globalmente | Ver sidebar como Docente | El ítem "Banco de preguntas" desaparece y la ruta redirige a `/app` |
| TEN-11 | Auto-colapso del sidebar en examen | Estudiante inicia un examen (fullscreen) | Comenzar examen | El sidebar se colapsa; los ítems del nav quedan no funcionales (disparan `navAttempt`, no navegan) |
| TEN-12 | La landing pública no hereda branding | SuperAdmin vio un tenant, luego cierra sesión | Ir a `/` | La home muestra los colores originales de plataforma, aunque quede override viejo en localStorage |

**Checks UI/UX (TEN)**
- 375px: sidebar se reemplaza por drawer (`<md`) y header + bottom-nav; sin scroll horizontal de página.
- Claro/oscuro: el branding se recalcula al alternar tema (fondo tinte de marca en light = wash; en dark = variante oscura del secundario); no queda "pegado" al tema anterior.
- Loading/empty/error: fallback de logo (`GraduationCap`) y "Plataforma de exámenes" cuando el tenant carga o no está configurado.
- Filtros cross-tenant: en módulos compartidos aparece el `Select` "Todas las instituciones / Por institución" solo para SuperAdmin; con tenant sin filas, la lista queda vacía (no debe mostrar todo).
- Touch targets ≥32px en botón hamburguesa, botón "Salir del modo institución" y campanas.
- Accesibilidad: `alt` del logo con el nombre del tenant; nombre del tenant truncado sin romper layout.

### Módulo: Tema claro/oscuro (THEME)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| THEME-01 | Default claro | Cuenta sin preferencia guardada, localStorage limpio | Ingresar por primera vez | La app arranca en tema **claro** aunque el SO esté en oscuro (no lee `prefers-color-scheme`) |
| THEME-02 | Alternar a oscuro desde el menú | Sesión iniciada | Menú ⋯ → `Tema` → `Oscuro` | Toda la app pasa a oscuro; el ítem `Oscuro` queda con ✓; el ícono del submenú cambia a luna |
| THEME-03 | Preferencia persiste entre dispositivos | Usuario que eligió oscuro en un equipo | Ingresar en otro equipo/navegador | Tras el post-mount se aplica la preferencia del perfil (`theme_preference`); en el primer load puede haber un breve flash claro→oscuro, en loads siguientes no |
| THEME-04 | Sin opción "Sistema" | Menú de tema | Abrir el submenú Tema | Solo existen `Claro` y `Oscuro` (la opción "Sistema" fue removida) |
| THEME-05 | Sincronización entre instancias | Sesión con sidebar y toggle móvil disponibles | Alternar tema desde un switcher | Todas las instancias (branding, toggles) se sincronizan sin recargar (evento `examlab:theme-changed`) |
| THEME-06 | Sin flash de fondo en recarga con oscuro | Tema oscuro guardado en el equipo | Recargar `/app` | El fondo aparece oscuro desde el primer paint (script inline pre-paint aplica `.dark` desde localStorage) |

**Checks UI/UX (THEME)**
- Claro/oscuro: verificar contraste de texto/badges/cards en ambos; el branding de tenant respeta el tema.
- Hidratación (React #418): el estado de tema inicia determinístico en "light"; no debe verse mismatch en el `ThemeToggle` (sol vs luna) ni error en audit_logs.
- Fechas es-CO y toasts en español no dependen del tema.
- Touch targets ≥32px en el `ThemeToggle` del drawer móvil.
- Persistencia: el RPC `set_theme_preference` es fire-and-forget; un fallo de red no rompe el cambio local.

### Módulo: Tour de onboarding (TOUR)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| TOUR-01 | Auto-disparo en primer login del rol | Rol activo NO está en `onboarding_completed_roles` (Admin/Docente/Estudiante) | Ingresar y esperar ~1s | Aparece el tour guiado (driver.js) anclado al sidebar, con overlay; botones `← Anterior`, `Siguiente →`, `Finalizar`, `Saltar tour` y progreso "{{current}} de {{total}}" |
| TOUR-02 | No se repite tras completarlo | Tour ya completado para el rol | Recargar y volver a entrar con ese rol | El tour NO se dispara automáticamente |
| TOUR-03 | Re-disparo manual | Rol tourable | Menú ⋯ → `Ver tour guiado` | El tour se muestra en modo manual; al cerrarlo NO marca como completado (se puede ver cuantas veces se quiera) |
| TOUR-04 | SuperAdmin sin tour | Rol activo = SuperAdmin | Ver menú ⋯ y observar el arranque | NO existe ítem `Ver tour guiado` ni auto-disparo |
| TOUR-05 | No arranca en móvil | Viewport < 768px | Ingresar con rol tourable en móvil | El tour no se inicia (los anclajes del sidebar no existen en el drawer) |
| TOUR-06 | Espera al cambio de contraseña forzado | `must_change_password=true` | Primer login con clave temporal | El tour NO arranca hasta que el usuario cambie la contraseña |
| TOUR-07 | Pasos sin ancla se saltan | Un módulo del rol está oculto por visibilidad | Recorrer el tour | Los pasos cuyo selector no existe en DOM se filtran/saltan sin dejar popovers huérfanos |
| TOUR-08 | Cambio de rol y su tour | Usuario multi-rol con un rol ya visto y otro no | Cambiar al rol no visto | Al cambiar de rol, si ese rol no está completado, el tour puede dispararse para el nuevo rol activo |
| TOUR-09 | Cerrar el tour no deja diálogos flotando | Tour con pasos "cómo crear X" (abren formularios demo) | Cerrar el tour a mitad de un paso demo | Se cierra el formulario demo abierto (Esc programático) y no queda ningún dialog huérfano sobre la ruta |

**Checks UI/UX (TOUR)**
- Claro/oscuro: el popover usa las CSS vars del design system (`--popover`, `--primary`) y respeta tema + branding.
- 375px: no aplica (el tour no corre en móvil); verificar que no genere popovers centrados sin sentido.
- Textos en español; descripciones con HTML simple (`<ol>`) legibles y sin desbordar el popover.
- El botón `Siguiente →` se deshabilita mientras el ancla del paso carga (gate), evitando saltos.
- Accesibilidad: overlay no atrapa el foco de forma permanente; `Saltar tour` siempre accesible.

### Módulo: Notificaciones, push y campana de mensajes (NOTIF)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| NOTIF-01 | Campana de notificaciones + badge | Sesión con notificaciones no leídas | Ver el footer del sidebar (desktop) y el header (móvil) | La campana muestra badge con el conteo de no leídas; abre popover con la lista y "Marcar todo leído" |
| NOTIF-02 | Actualización en vivo | Sesión abierta | Generar una notificación (p.ej. desde otro rol/pestaña) | La campana refleja el nuevo aviso vía realtime/polling (≈15s) sin recargar; refetch al volver el foco a la pestaña |
| NOTIF-03 | Toast en primer arribo | Sesión abierta | Recibir una notificación nueva | Aparece un toast efímero (deduplicado entre instancias de la campana) |
| NOTIF-04 | Solicitud de permiso de push | Navegador soportado, permiso `default` | Cargar el app autenticado | Se solicita permiso de notificaciones; al aceptar se registra la suscripción (`push_subscriptions`, sin duplicados por recarga) |
| NOTIF-05 | Permiso denegado no re-pregunta | Permiso `denied` | Recargar el app | NO se vuelve a pedir permiso; la app sigue funcionando con realtime + polling |
| NOTIF-06 | Push con VAPID ausente | Sin `VITE_VAPID_PUBLIC_KEY` | Cargar el app | No hay push (sale silenciosamente); sin errores visibles para el usuario |
| NOTIF-07 | iOS requiere PWA instalada | Safari iOS fuera de PWA | Intentar habilitar push | No se suscribe (limitación de iOS); requiere "Agregar a inicio". No debe romper la app |
| NOTIF-08 | Campana de mensajes + badge | Conversaciones con mensajes no leídos | Ver la campana de mensajes | Badge con no leídos; popover con acceso a `/app/messages` |
| NOTIF-09 | Toast de mensaje entrante | Sesión NO ubicada en `/app/messages` | Recibir un mensaje 1-a-1 | Aparece toast efímero de mensaje; si el usuario ya está en `/app/messages`, NO se muestra el toast |
| NOTIF-10 | FAB de mensajes con sidebar oculto | Sidebar colapsado (desktop) o móvil | Observar la esquina inferior | Aparece el FAB de mensajes respetando `safe-area-inset-bottom` en iOS |
| NOTIF-11 | Restricción de mensajería al SuperAdmin | Actuando como Docente/Estudiante | Intentar iniciar chat con un SuperAdmin | No se permite (RLS + `can_message`); el canal Admin→SuperAdmin es el módulo Soporte, no mensajes directos |

**Checks UI/UX (NOTIF)**
- 375px: campanas y FAB accesibles sin scroll horizontal; el header móvil mantiene ambas campanas visibles.
- Claro/oscuro: badges y popovers legibles en ambos temas.
- Loading/empty: popovers con estado "sin notificaciones/mensajes" claro; conteo "0" no muestra badge.
- Fechas es-CO en las notificaciones/mensajes (vía helpers de `format.ts`, no `toLocaleString` directo).
- Toasts en español (`friendlyError`).
- Touch targets ≥32px en campanas y FAB; `safe-area-inset` en elementos fijos inferiores.
- Accesibilidad: `aria-label`/badge con conteo perceptible; el FAB no tapa el bottom-nav.

---

## Cursos, estructura académica, cortes/pesos y matrículas

Alcance: gestión de cursos (CRUD, ciclo de vida, duplicado, borrado con papelera), cortes y buckets de pesos con su regla de suma, estructura académica (carreras/asignaturas/periodos), matrículas + asignación de docentes + import de usuarios por CSV, tablero/sesiones del curso y correo de bienvenida. Todos los casos se ejecutan en el tenant **Demo Global Corp** con la cuenta multi-rol; el rol se cambia con el selector del sidebar.

### Módulo 1 — Cursos: CRUD y ciclo de vida (`CU`)

Rol activo: **Admin**. Ruta: `/app/admin/courses`. Botón "Nuevo curso"; acciones de fila vía menú "tres puntos" (`RowActionsMenu`).

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| CU-01 | Crear curso (happy path) | Existe ≥1 asignatura activa en la institución | Abrir "Nuevo curso" → elegir Asignatura del plan → confirmar/ajustar nombre → elegir periodo → definir escala 0–5, nota mínima 3, pesos 40/30/20/10 → Guardar | Toast "Curso guardado correctamente"; el curso aparece en el grid; nombre/programa/código/semestre quedan derivados de la asignatura |
| CU-02 | Asignatura obligatoria | — | Abrir "Nuevo curso" → dejar Asignatura sin elegir → Guardar | Bloqueado con toast "Debes elegir una asignatura del plan." No se inserta |
| CU-03 | Nombre requerido | Asignatura elegida pero nombre vaciado a mano | Borrar el nombre → Guardar | Toast "Nombre requerido"; no se guarda |
| CU-04 | Rango de fechas inválido | Modo crear | Fecha inicio 30/09/2026, fecha fin 01/09/2026 → Guardar | Toast "La fecha de fin no puede ser anterior a la fecha de inicio"; no se guarda (fechas iguales sí se permiten) |
| CU-05 | Pesos del curso sin cortes | Curso sin cortes definidos | Pesos exam/workshop/project/attendance = 40/30/20/20 (=110) → Guardar | Toast "Los pesos del curso deben sumar 100% (suma actual: 110%)"; no se guarda |
| CU-06 | Tolerancia de suma flotante | Curso sin cortes | Pesos 33,33 / 33,33 / 33,34 / 0 → Guardar | Se guarda (tolerancia 0,01 evita falso negativo) |
| CU-07 | Herencia de pesos/escala desde asignatura | Asignatura con `sistema_evaluacion` definido y escala | Crear curso desde esa asignatura (deep-link "Crear curso") | El form abre pre-rellenado con pesos y escala de la asignatura; editables |
| CU-08 | Editar curso existente | Curso creado | Menú fila → "Editar" → cambiar descripción y periodo → Guardar | Toast de guardado; cambios persisten; se conservan cortes y matrículas |
| CU-09 | Eliminar curso SIN contenido | Curso recién creado, sin exámenes/talleres/etc. | Menú fila → "Eliminar" | Diálogo indica "sin contenido"; muestra matrículas ocultas si las hay; confirmar → toast, curso desaparece del grid y aparece en `/app/trash` |
| CU-10 | Eliminar curso CON contenido — cascada | Curso con ≥1 examen/taller/sesión | "Eliminar" → el diálogo lista conteos por entidad → elegir "Enviar todo a papelera" → confirmar | Curso y todo su contenido van a papelera con el mismo timestamp (restaurable en bloque) |
| CU-11 | Eliminar curso CON contenido — solo curso | Igual a CU-10 | Elegir "Solo el curso" → confirmar | Solo el curso va a papelera; el contenido queda huérfano/oculto (documentado) |
| CU-12 | Borrado masivo (bulk) | ≥2 cursos seleccionados con checkbox | Toolbar de selección → Eliminar → confirmar | Bulk usa cascada por defecto; toast "N curso(s) y su contenido enviados a papelera" |
| CU-13 | Bulk delete con error parcial | Bulk sobre cursos donde uno falla (RLS/FK) | Ejecutar bulk | Toast muestra "X ok, Y con error. Primero: …" con `friendlyError`, no solo el conteo |
| CU-14 | Publicar (borrador → en curso) | Curso en estado borrador | Menú fila → "Publicar" → confirmar | RPC `set_course_status`; toast; estado pasa a "En curso"; StatusBadge cambia |
| CU-15 | Finalizar (en curso → finalizado) | Curso en curso | Menú → "Finalizar" → confirmar (tono warning) | Estado "Finalizado"; el curso deja de verse con filtro default "Activos y borradores" |
| CU-16 | Reabrir (finalizado → en curso) | Curso finalizado | Menú → "Reabrir" → confirmar | Vuelve a "En curso" |
| CU-17 | Filtro por estado (default) | Existen cursos finalizados y activos | Cargar la vista sin tocar filtros | Filtro por defecto "Activos y borradores": los finalizados NO se listan; el empty state (si todo está finalizado) sugiere "prueba Todos/Finalizados", no "crea tu primer curso" |
| CU-18 | Filtros académicos combinados | Institución con programas/asignaturas/periodos | Filtrar por Programa → luego Asignatura → luego Periodo + búsqueda por texto | Filtros se combinan (AND); al cambiar Programa, la Asignatura incompatible se limpia; la paginación vuelve a página 1 |
| CU-19 | Docente ve solo sus cursos | Rol activo **Docente**, asignado a 1 curso | Cambiar a rol Docente y abrir `/app/teacher/courses` | Solo lista los cursos donde figura en `course_teachers`; no ve el resto del tenant |
| CU-20 | Diagnóstico de curso | Curso con calificaciones/errores IA | Menú fila → "Diagnóstico" | Dialog escanea pendientes de calificar, errores IA, conversaciones y asistencia, con acciones de remediación |

**Checks UI/UX (Módulo 1):**
- Responsive 375px: el grid hace scroll horizontal DENTRO del Card (no del viewport); columnas secundarias (Periodo/Escala/Fechas/Actividad) se ocultan progresivamente; el diálogo de curso usa `max-w-[calc(100vw-2rem)]`.
- Modo claro/oscuro: StatusBadge, StatCards y el diálogo legibles en ambos.
- Loading/empty/error: `TableSkeleton`/spinner al cargar, `TableEmpty` con CTA "Crear primer curso" (solo si no hay filtros), `ErrorState` con "Reintentar" si falla la query.
- Toasts en español vía `friendlyError` (nunca mensaje técnico en inglés).
- Touch targets ≥32px en el menú de acciones y checkboxes de selección.
- Fechas es-CO ("30 sep 2026") vía `DateCell`; sin bug UTC −1 día en columnas DATE.
- Paginación (25/pág), orden por columna (Nombre/Periodo/Estado/Escala/Fechas/Actividad) persistido, filtros persistentes; multi-select opera sobre TODO el filtrado (todas las páginas).
- Guard de "cambios sin guardar" (`useDirtyDialog`) al cerrar el diálogo con cambios.

### Módulo 2 — Cortes y pesos / buckets (`CW`)

Editor de cortes dentro del diálogo de curso. Reglas: `Σ cut.weight = 100`; por corte `exam+workshop+project+attendance = cut.weight`.

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| CW-01 | Crear cortes y distribuir pesos | Diálogo de curso abierto | Fijar 3 cortes → pesos 40/30/30 → en cada corte distribuir sub-pesos que sumen su peso → Guardar | Se guardan `grade_cuts` + sub-buckets; toast de guardado |
| CW-02 | Suma de cortes ≠ 100 | Con cortes | Pesos de cortes 40/40/30 (=110) → Guardar | Toast "Los pesos de los cortes deben sumar 100% (suma actual: 110%)"; no guarda |
| CW-03 | Sub-pesos no cuadran con el corte | Corte con peso 40 | Sub-pesos exam/workshop/project/attendance = 10/10/10/5 (=35) → Guardar | Toast "Sub-pesos no cuadran con el peso del corte: …"; los cortes con error se auto-expanden |
| CW-04 | Rango de fechas de un corte | Con cortes | Corte con fin < inicio → Guardar | Toast 'En el corte "X" la fecha de fin no puede ser anterior a la de inicio' |
| CW-05 | Reducir número de cortes con items | Corte que ya tiene `grade_cut_items` en BD | Bajar el contador de cortes | Confirm destructivo indicando cuántos items se perderán; al confirmar se eliminan cortes + items |
| CW-06 | Aumentar número de cortes | Con N cortes | Subir el contador | Se agregan cortes vacíos con peso sugerido `round(100/N)`; sub-pesos en 0 |
| CW-07 | Nombres de corte duplicados | Dos cortes con mismo nombre en el mismo curso | Guardar | Se traduce la violación única a mensaje humano (`friendlyUniqueViolation`); toast "Curso guardado, pero falló la sincronización de cortes: …" |
| CW-08 | Curso sin cortes | — | Dejar 0 cortes; pesos de curso suman 100 | Guarda; el cálculo de nota usa los pesos del curso directamente |
| CW-09 | Asistencia atada a corte por `cut_id` | Curso con cortes y sesiones | Crear sesiones y asignarles un corte (selector "Corte") | La nota de asistencia del corte = presentes/sesiones del corte escalado; sesiones sin `cut_id` caen en "Sin corte" y NO aportan a la nota |
| CW-10 | Item con nota null cuenta como 0 | Curso con examen calificable sin entrega | Consultar la nota (gradebook/notas del estudiante) | El item sin score cuenta como 0 con su peso original (no se reescala); "—" solo si NINGÚN item tiene score |

**Checks UI/UX (Módulo 2):**
- Responsive 375px: los inputs de sub-pesos (grid) pasan a 1–2 columnas; sin scroll horizontal de página.
- Estados: al fallar la validación, los cortes con error se expanden automáticamente y el toast lista los detalles (multilínea).
- Decimales de peso con coma es-CO ("33,33") vía `formatPercent`/`DecimalInput`.
- Toasts en español; mensajes de suma muestran el total actual formateado con coma.
- Accesibilidad: el contador de cortes y los toggles de expandir/colapsar son operables por teclado.

### Módulo 3 — Duplicar curso (`CD`)

Menú de fila → "Duplicar" (icono `Copy`). Diálogo con checkboxes de qué copiar.

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| CD-01 | Duplicar con todo (default) | Curso con exámenes, talleres, tablero y matrículas | "Duplicar" → dejar marcados exámenes/talleres/tablero/estudiantes → Duplicar | Curso nuevo "(copia)"; copia exámenes+preguntas, talleres (status draft), sesiones del tablero (fecha/hora/título/enlace) y matrículas; toast con "(N estudiante(s) copiado(s))" |
| CD-02 | Nombre requerido | Diálogo de duplicar abierto | Vaciar el nombre → Duplicar | Toast "Nombre requerido"; no duplica |
| CD-03 | Docentes opt-in | Curso con docentes asignados | Dejar "Copiar docentes" DESMARCADO (default) → Duplicar | El curso nuevo NO copia docentes |
| CD-04 | No copia entregas ni asignaciones | Curso con submissions | Duplicar con exámenes/talleres | Solo estructura/preguntas; sin submissions ni assignments; talleres nacen en `draft` |
| CD-05 | Idempotencia de matrículas | Reintentar duplicado (doble click / retry) | Ejecutar duplicado dos veces | `upsert ignoreDuplicates` evita 23505; no aborta la copia; sin matrículas duplicadas |
| CD-06 | Fallo parcial al copiar tablero/matrículas | Simular error en copia de sesiones/enrollments | Duplicar | Toast específico ("No se pudo copiar el tablero/matrículas: …") pero el curso base ya queda creado |
| CD-07 | Duplicado no incluye contenido en papelera | Curso con un examen/sesión en papelera | Duplicar con exámenes/tablero | El item en papelera NO se copia (filtro `deleted_at`) |

**Checks UI/UX (Módulo 3):**
- Responsive 375px: diálogo y checkboxes legibles; sin overflow.
- Loading: botón "Duplicar" muestra spinner/disabled durante la operación (`dupLoading`).
- Toasts en español, incluyendo el sufijo con conteo de estudiantes copiados.
- Modo claro/oscuro correctos en el diálogo.

### Módulo 4 — Estructura académica: Programas, Asignaturas, Periodos (`AP` / `AS` / `PE`)

Rol activo **Admin**, sección Universidad/Estructura académica. Cada panel usa `RowActionsMenu`.

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| AP-01 | Crear carrera | — | Panel Carreras → "Nueva" → nombre + código + facultad → Guardar | Toast "creada"; aparece en la tabla |
| AP-02 | Nombre requerido | — | "Nueva" → dejar nombre vacío → Guardar | Toast de nombre requerido; no guarda |
| AP-03 | Toggle activo/inactivo | Carrera existente | Cambiar el Switch "Activo" | Carrera inactiva deja de aparecer en el dropdown del form de curso; no se borran cursos previos; badge "Inactiva" |
| AP-04 | Duplicar carrera | Carrera existente | Menú → "Duplicar" | Form de creación pre-llenado con "(copia)" en el nombre; el usuario ajusta y guarda; no copia asignaturas |
| AP-05 | Eliminar carrera | Carrera existente | Menú → "Eliminar" → confirmar | Toast "eliminada" |
| AS-01 | Crear asignatura con sílabo | Carrera creada | Panel Asignaturas → "Nueva" → nombre, código, programa, semestre, créditos + objetivos/contenidos/bibliografía/intensidad + pesos + escala → Guardar | Toast "creada"; `sistema_evaluacion` persistido |
| AS-02 | Pesos de evaluación deben sumar 100 | Diálogo abierto | Poner pesos que suman 90 (>0 y ≠100) → Guardar | Toast "los pesos de evaluación deben sumar 100"; no guarda |
| AS-03 | Pesos en 0 (opcional) | Diálogo abierto | Dejar los 4 pesos en 0 → Guardar | Se guarda con `sistema_evaluacion` NULL; el curso instanciado usará defaults del sistema |
| AS-04 | Escala inválida | Diálogo abierto | Nota mínima ≥ nota máxima → Guardar | Toast "La nota mínima de la escala debe ser menor que la máxima" |
| AS-05 | Duplicar asignatura (sílabo completo) | Asignatura con sílabo | Menú → "Duplicar" | Form pre-llenado con TODO el sílabo + pesos + escala; nombre "(copia)"; no copia cursos instanciados |
| AS-06 | Crear curso desde asignatura | Asignatura activa | Menú → "Crear curso" | Navega a `/app/admin/courses` con el diálogo abierto y campos derivados de la asignatura |
| AS-07 | Ver cursos asociados | Asignatura con `course_count > 0` | Menú → "Ver cursos (N)" | Navega a `/app/admin/courses?subjectFilter=<id>` mostrando solo esos cursos; la columna "Cursos: N" refleja el conteo |
| AS-08 | Eliminar asignatura con cursos | Asignatura con cursos | Menú → "Eliminar" | El confirm advierte cuántos cursos dependen; al confirmar se elimina |
| PE-01 | Crear periodo | — | Panel Periodos → "Nuevo" → código + nombre + fechas + estado → Guardar | Toast "creado"; badge de estado (planificado/activo/cerrado) |
| PE-02 | Código requerido | — | "Nuevo" sin código → Guardar | Toast de código requerido |
| PE-03 | Rango de fechas inválido | Diálogo abierto | Fecha fin < inicio → Guardar | Toast "la fecha de inicio no puede ser posterior a la de fin" |
| PE-04 | Cerrar periodo | Periodo activo | Menú → "Cerrar" → confirmar (warning) | Estado "cerrado"; se registra `closed_at`/`closed_by`; badge ámbar |
| PE-05 | Reabrir periodo | Periodo cerrado | Menú → "Reabrir" → confirmar | Vuelve a "activo"; `closed_at`/`closed_by` se limpian |
| PE-06 | Duplicar periodo | Periodo existente | Menú → "Duplicar" | Form pre-llenado; código "(copia)"; estado forzado a "planificado" |
| PE-07 | Eliminar periodo asociado a cursos | Periodo usado por ≥1 curso | Menú → "Eliminar" → confirmar | Se borra; los cursos quedan con `period_id` NULL (ON DELETE SET NULL) preservando `period` texto para display |
| PE-08 | Periodos cerrados no se ofrecen en curso nuevo | Existe periodo cerrado | Abrir "Nuevo curso" → dropdown periodo | El periodo cerrado no se ofrece para asociar (sí en modo edición si ya estaba) |

**Checks UI/UX (Módulo 4):**
- Responsive 375px: las 3 tablas hacen scroll interno; columnas Código/Programa/Facultad/Créditos ocultas en pantallas chicas; diálogos `max-w-[calc(100vw-2rem)]`.
- Modo claro/oscuro: badges de estado de periodo con clases duales (light/dark).
- Loading/empty/error: `Spinner` al cargar, `TableEmpty` con hint, `ErrorState` con "Reintentar" (`retryNonce`).
- Toasts en español vía `friendlyError`; confirmaciones destructivas terminan con advertencia de irreversibilidad.
- Fechas es-CO vía `DateCell variant="date"`.
- Guard de cambios sin guardar en los 3 diálogos.
- Accesibilidad: switches y menús operables por teclado; `Label required` con asterisco.

### Módulo 5 — Matrículas y asignación de docentes (`MT`)

Desde `/app/admin/courses`: acción de fila "Estudiantes" (icono `Users`) y "Docentes" (icono `UserCog`).

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| MT-01 | Matricular un estudiante | Curso creado, perfiles de estudiante existentes | Fila → gestionar Estudiantes → marcar checkbox de un alumno | `upsert` en `course_enrollments`; toast "Estudiante matriculado correctamente" |
| MT-02 | Desmatricular | Alumno matriculado | Desmarcar el checkbox | Toast "Estudiante desmatriculado correctamente"; se elimina la fila |
| MT-03 | Matrícula masiva (visibles) | Lista filtrada de alumnos | "Seleccionar/agregar todos los visibles" | Inserta solo los aún no matriculados; toast "N estudiante(s) matriculados correctamente" |
| MT-04 | Desmatrícula masiva | Varios matriculados | Quitar todos los visibles | Toast "N estudiante(s) desmatriculados correctamente" |
| MT-05 | Idempotencia matrícula | Alumno ya matriculado | Volver a marcar (o retry) | `onConflict ignoreDuplicates`; sin duplicados ni error 23505 |
| MT-06 | Asignar docente | Curso creado; usuarios con rol Docente | Fila → gestionar Docentes → marcar un docente | Insert en `course_teachers`; toast "Docente asignado correctamente" |
| MT-07 | Docente no puede auto-asignarse | Rol activo Docente | Intentar auto-asignarse en el diálogo de docentes | Bloqueado por RLS + filtro del diálogo |
| MT-08 | Asignación/quita masiva de docentes | Varios docentes | Asignar/quitar todos los visibles | Toasts "N docente(s) asignados/desasignados correctamente" |
| MT-09 | Aislamiento por tenant en matrícula | Cuenta de Demo Global Corp | Abrir diálogo de estudiantes | Solo aparecen perfiles del tenant Demo Global Corp (RLS); no se ven usuarios de otras instituciones |

**Checks UI/UX (Módulo 5):**
- Responsive 375px: diálogos de estudiantes/docentes con buscador; lista con scroll interno.
- Loading/empty: mensaje claro cuando el curso no tiene estudiantes/docentes candidatos.
- Toasts en español; touch targets ≥32px en checkboxes de fila.
- Buscador filtra por nombre/correo; "seleccionar todos" abarca solo los visibles del filtro.

### Módulo 6 — Import de usuarios y matrículas por CSV (`IU`)

Rol activo **Admin**, `/app/admin/users` → "Nuevo usuario" / import CSV (edge `bulk-import-users`).

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| IU-01 | Alta individual de usuario | — | "Nuevo usuario" → nombre + correo institucional + rol(es) → crear | Usuario creado con contraseña temporal fija **Temporal#123** y `must_change_password=true`; forzará cambio en el primer login |
| IU-02 | Import CSV (happy path) | CSV válido con columna `roles` separada por `|` | Importar CSV | Usuarios creados en el tenant Demo Global Corp; roles múltiples parseados desde el string `Docente\|Estudiante` |
| IU-03 | Roles como string, no array | CSV con `roles` mal formado | Importar | La edge espera string `|`-separado; un array rompe con `split is not a function` — validar mensaje friendly |
| IU-04 | SuperAdmin en payload por Admin común | Rol activo Admin (no SA) | Importar CSV con rol `SuperAdmin` | El rol SuperAdmin se ignora silenciosamente (solo un SA puede asignarlo) |
| IU-05 | Correo duplicado / reimport | Reimportar un usuario ya existente | Importar de nuevo | No revienta con "Database error creating new user"; re-vincula perfil huérfano (mig handle_new_user) |
| IU-06 | Matrícula vía import + curso | CSV que asigna curso | Importar con curso destino | Usuarios quedan matriculados; se dispara el correo de bienvenida (ver Módulo 8) |
| IU-07 | Aislamiento de tenant en import | Admin de Demo Global Corp | Importar | Todos los usuarios quedan con `tenant_id` de Demo Global Corp; audit log con `tenant_id` correcto (no NULL) |

**Checks UI/UX (Módulo 6):**
- Toasts/resultados de import en español (contadores creados/omitidos/error) vía `friendlyError`.
- Estados loading durante el import (deshabilitar botón); resultado con resumen accionable.
- Responsive 375px del diálogo de alta y del importador; sin overflow horizontal.
- La contraseña temporal se muestra/comunica de forma consistente (fija Temporal#123).

### Módulo 7 — Tablero / sesiones del curso (`TB`)

Rol activo **Docente**, `/app/teacher/attendance`. Botones "Nueva sesión", "Programar sesiones", menús "Clases" y "Asistencia" (import/export).

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| TB-01 | Crear sesión | Curso seleccionado | "Nueva sesión" → fecha + hora inicio/fin + título + corte → Crear | Toast "Sesión creada correctamente"; `duration_minutes` derivado de fin−inicio; aparece en el grid agrupado por corte |
| TB-02 | Fecha requerida | Diálogo abierto | Vaciar la fecha → Crear | Toast "Fecha requerida"; no crea |
| TB-03 | Hora fin ≤ inicio | Diálogo abierto | Inicio 10:30, fin 09:00 → Crear | Toast "La hora de fin debe ser posterior a la de inicio."; no crea |
| TB-04 | Solo hora de inicio | Diálogo abierto | Inicio 09:00, fin vacío → Crear | Se crea con duración default 90 min |
| TB-05 | Asignar contenido a sesión | Contenido `status=done` disponible | En la columna de la sesión → popover → elegir contenido (y CLASE_N si aplica) | Persiste `content_id`/`content_class_index`; el estudiante ve ese material en el tablero |
| TB-06 | Reasignar corte de sesión | Sesión sin corte o con corte | Selector "Corte" en el header de la columna | La sesión se re-agrupa; solo aporta a la nota de asistencia si tiene `cut_id` |
| TB-07 | Marcar todos presentes | Sesión con alumnos matriculados | Acción "Marcar todos presentes" | Toast "Todos los estudiantes marcados como presentes"; sobrescribe ausentes/vacíos |
| TB-08 | Reiniciar asistencia de sesión | Sesión con registros | Acción reiniciar → confirmar (warning) | Toast "Asistencia de la sesión reiniciada"; se borran los `attendance_records` |
| TB-09 | Duplicar sesión con opciones | Sesión con contenido/pizarra/snippets | Menú columna → "Duplicar sesión" → elegir copiar contenido/pizarra/snippets | Copia estructura + lo seleccionado; NUNCA copia asistencia, grabación/notas ni estado de check-in; título "(copia)" en la misma fecha |
| TB-10 | Programar varias sesiones | Curso seleccionado | "Programar sesiones" → fecha inicio + días de la semana → generar | Crea N sesiones "Sesión N" sin contenido pre-asociado |
| TB-11 | Import de clases (CSV 7 columnas) | Plantilla `SESSIONS_TEMPLATE` | Menú Clases → Importar CSV | Parsea `session_date,title,cut_name,start_time,duration_minutes,meeting_url,recording_url`; filas con fecha inválida se descartan; suffix si hay cortes sin match |
| TB-12 | Export de clases y asistencia | Sesiones y registros existentes | Menú Clases/Asistencia → Exportar | CSV round-trip de sesiones; matriz de asistencia con % por alumno |
| TB-13 | Check-in QR self-service | Sesión creada | Botón QR de la sesión → configurar duración/rotación → iniciar proyector | Se abre proyector fullscreen con QR rotativo + contador de presentes en vivo; una sola notif/correo por alumno (trigger DB, no cliente) |
| TB-14 | Cerrar check-in y marcar ausentes | Check-in abierto | Cerrar proyector → confirmar marcar pendientes ausentes | Toast "N estudiante(s) marcado(s) como ausentes" |
| TB-15 | Eliminar sesión (soft-delete) | Sesión existente | Eliminar → confirmar (destructivo, muestra conteo de registros) | Toast "Sesión eliminada"; va a papelera; desaparece del tablero |
| TB-16 | Sesión en papelera invisible en todo flujo | Sesión eliminada | Revisar tablero docente, calendario/agenda del estudiante, gradebook, ICS | La sesión NO aparece en ningún flujo ni rol hasta restaurarse desde `/app/trash` |

**Checks UI/UX (Módulo 7):**
- Responsive 375px: la matriz de asistencia hace scroll horizontal dentro del Card con columna de estudiante `sticky left-0`; `min-w` de la sticky reducido en mobile.
- Modo claro/oscuro: leyenda de estados (P/A) y bordes de corte legibles en ambos.
- Loading/empty/error: `ErrorState` con "Reintentar" (`retryNonce`) si falla la carga de cursos; mensaje amable si el curso no tiene sesiones/alumnos.
- Toasts en español; touch targets ≥32px en el botón QR y celdas de asistencia.
- Fechas/etiquetas de sesión es-CO (`formatSessionLabel`, `formatDateShort`).
- Guard de cambios sin guardar en el diálogo de nueva sesión; buscador de estudiante para cursos grandes.
- `max-h` con `dvh` en los diálogos (no `vh`) para iOS.

### Módulo 8 — Correo de bienvenida al curso (`BW`)

Trigger `trg_course_enrollment_welcome` (AFTER INSERT en `course_enrollments`) → notificación `kind='course_welcome'` → edge `send-email`.

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| BW-01 | Bienvenida al matricular | `email_settings.enabled_kinds.course_welcome = true` (default) y curso NO en papelera | Matricular un alumno (UI, import o RPC) | Se crea notificación `course_welcome` y se envía correo de bienvenida al alumno |
| BW-02 | No dispara si curso en papelera | Curso en papelera | Insertar matrícula sobre ese curso | NO se genera notificación ni correo (el trigger valida `deleted_at IS NULL`) |
| BW-03 | Idempotencia ante re-matrícula | Alumno ya matriculado | `upsert` de la misma matrícula (`ON CONFLICT DO NOTHING`) | No se duplica notificación/correo |
| BW-04 | Toggle apagado | Admin apaga "Bienvenida al curso" en `AdminEmailSettingsPanel` | Matricular un alumno | Se crea la notificación in-app pero NO se envía correo (kind excluido del envío) |
| BW-05 | Cobertura por construcción | — | Matricular vía los 3 caminos (UI cursos, import CSV, matrícula masiva) | En todos se dispara el flujo de bienvenida (trigger a nivel tabla, no por UI) |

**Checks UI/UX (Módulo 8):**
- El switch "Bienvenida al curso" en configuración de correos es legible en claro/oscuro y su estado persiste.
- La notificación in-app usa formato/fecha es-CO y enlaza al curso.
- Sin errores huérfanos si el envío de correo falla (best-effort; la matrícula no se revierte).

### Módulo 9 — Aislamiento por tenant (RLS) y soft-delete transversal (`IS`)

Casos de seguridad/consistencia que cruzan todos los módulos anteriores.

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| IS-01 | Cursos acotados al tenant | Cuenta de Demo Global Corp (rol Admin) | Listar cursos y abrir diálogos de matrícula/docentes | Solo se ven cursos/perfiles del tenant Demo Global Corp; nada de otras instituciones |
| IS-02 | Estructura académica por tenant | Rol Admin | Abrir Carreras/Asignaturas/Periodos | Solo la estructura de Demo Global Corp; RLS impide leer/escribir la de otro tenant |
| IS-03 | Sin fuga por REST directo | — | (Prueba de RLS) consultar `courses`/`grade_cuts`/`attendance_sessions` de otro tenant vía token del tenant actual | La RLS devuelve 0 filas; ninguna tabla hija con `USING (true)` |
| IS-04 | Curso en papelera invisible en flujos derivados | Curso eliminado (papelera) | Revisar gradebook, agenda/dashboard, calendario del estudiante, notas | El curso y su contenido no aparecen en NINGÚN flujo ni rol hasta restaurarse |
| IS-05 | Restaurar desde papelera | Curso enviado a papelera con cascada | `/app/trash` → restaurar el curso | Se restaura el curso y su contenido asociado (bloque con mismo timestamp) y reaparece en los listados |
| IS-06 | Purga a 30 días (documental) | Item en papelera | Verificar el badge "días restantes" | Badge colorado (rojo ≤3d, ámbar ≤7d); el cron `purge-deleted-items-daily` borra a los 30 días |
| IS-07 | Filtro cross-tenant solo SuperAdmin | Rol activo SuperAdmin con override | En `/app/admin/courses` usar el selector de institución | Aparece filtro "Todas/Por institución"; con tenant sin cursos, el listado sale vacío (no todos) |

**Checks UI/UX (Módulo 9):**
- El filtro de institución solo se renderiza para SuperAdmin; oculto para Admin normal (la RLS ya acota).
- Toasts en español ante intentos denegados por RLS (`friendlyError` traduce 42501/permission denied).
- Papelera: responsive 375px, orden/paginación/búsqueda; bulk restore/hard-delete muestran el primer error real, no solo el conteo.
- Modo claro/oscuro y fechas es-CO en la vista de papelera.

---

## Exámenes (creación, tipos de pregunta, toma, proctoring, monitor, revisión)

Cubre el ciclo completo del examen en el tenant **Demo Global Corp**: creación/edición (interno y externo), los 9+ tipos de pregunta, la toma del estudiante (timer, navegación, session lock, offline), el proctoring (advertencias, pantalla completa), el monitor en vivo del docente, la revisión de resultados y la calificación con IA + detección de fraude. El rol se cambia con el selector del sidebar (Admin/Docente/Estudiante) usando la misma cuenta.

### 1. Creación y edición de examen (`EX`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| EX-01 | Crear examen interno (happy path) | Rol Docente; existe ≥1 curso con estudiantes matriculados | Exámenes → "Nuevo examen" → título, curso, Inicio/Fin, Duración, navegación "libre", Estado "Publicado" → "Crear" | Toast de éxito en español; redirige a `/app/teacher/exams/$examId`; el examen aparece en la lista con StatusBadge "Publicado"; se auto-asignan todos los matriculados y se notifica a los estudiantes |
| EX-02 | Crear examen externo (solo registro de notas) | Rol Docente | "Nuevo examen" → activar toggle "Actividad externa" | Desaparecen Fin, Duración, Navegación, Proctoring/advertencias, Tipo de horario, Reintentos, Examen padre; solo queda Fecha de la actividad; al guardar `end_time = start_time` (ventana 0s), no se notifica ni asigna para tomar; el editor abre en la pestaña "Notas externas" |
| EX-03 | Validación campos obligatorios | Dialog "Nuevo examen" abierto | Dejar título vacío o ningún curso seleccionado → "Crear" | Toast de error en español ("Completa los campos"); no se crea el examen |
| EX-04 | Fin anterior a Inicio | Dialog abierto, examen interno | Poner Fin < Inicio → "Crear" | Toast `common.endDateBeforeStart` en español; no se crea (misma validación en editar) |
| EX-05 | Externo sin fecha | Toggle externo ON | Dejar Fecha de la actividad vacía → "Crear" | Toast "Indica la fecha de la actividad"; no se crea |
| EX-06 | Fin capado al fin del curso | Curso con `end_date` definido | Elegir Fin posterior al fin del curso → "Crear" | El `end_time` se topa automáticamente a la fecha de fin del curso (o del curso que termina antes si son varios) |
| EX-07 | Creación multi-curso | Docente dicta ≥2 cursos | Seleccionar 2+ cursos en el CoursePicker → configurar corte+peso por curso → "Crear" | Se crea UN examen por curso (una fila cada uno); toast "creado en N cursos"; cada uno auto-asigna sus matriculados; navega al primero |
| EX-08 | Peso excede el bucket del corte (single) | Corte con `exam_weight` ya consumido por otros exámenes | Asignar corte → poner peso > disponible → "Crear" | Toast que indica peso solicitado vs disponible restante; no se guarda. La ayuda muestra "te queda X% disponible" |
| EX-09 | Peso excede bucket por curso (multi) | Multi-curso, un curso con bucket lleno | Poner peso > disponible en uno de los cursos | Toast con el nombre del curso + peso vs disponible; no se guarda ninguno |
| EX-10 | Peso deshabilitado sin corte | Dialog abierto | No asignar corte | El input de peso queda disabled; el examen se crea sin aportar peso |
| EX-11 | Estados draft/published/closed | — | Crear con Estado "Borrador" | No se notifica a estudiantes; StatusBadge "Borrador"; el estudiante NO ve ni puede tomar el examen (draft oculto) |
| EX-12 | Reabrir examen cerrado | Editar un examen con estado "Cerrado" | Editor → banner "Reabrir" → botón | Estado pasa a "Publicado"; si `end_time` ya pasó, se fija a +7 días; se debe Guardar para persistir |
| EX-13 | Editar y mover de curso | Examen existente con asignaciones | Editor → cambiar Curso → Guardar | Aviso ámbar de cambio de curso; `useConfirm` tono warning; al confirmar limpia `exam_assignments` viejas y re-asigna matriculados del nuevo curso; cortes/peso se recalculan al bucket del nuevo curso |
| EX-14 | Examen supletorio (parent_exam) | Curso con un examen original | Crear examen con "Examen padre" = original | Badge "Supletorio" con ícono GitBranch en la lista; el supletorio no aporta peso al resumen del bucket |
| EX-15 | Reintentos y max_attempts | Examen interno | Configurar `max_attempts`=3 y Reintentos "Mayor nota" | Se persiste; el estudiante ve badge "Intento X de Y" al tomar; la nota efectiva sigue el modo (last/average/highest) |
| EX-16 | Tipo de horario relativo | Examen interno | Elegir "Relativo" | El timer del alumno cuenta desde su `started_at`+límite (no desde `end_time` global) |
| EX-17 | max_warnings personalizado | Examen interno | Poner Advertencias máx. = 5 | Se acepta rango 1-50; el estudiante ve "Advertencia N/5"; valores fuera de rango se clampean |
| EX-18 | Importar/Exportar CSV | Menú Importar/Exportar | Exportar plantilla; importar CSV con filas válidas e inválidas | Exporta CSV; import reporta "X creados, Y omitidos"; filas sin curso/título/fechas se omiten sin abortar |
| EX-19 | Filtros (búsqueda/curso/corte/estado) | Lista con varios exámenes | Buscar por título; filtrar por curso, corte y estado | Filtra en vivo; por defecto muestra activos + borradores y **oculta cerrados**; botón "Limpiar"; el subtítulo muestra "X de Y" |
| EX-20 | Resumen de pesos por corte | Filtrar por un corte | Ver el badge de suma | Muestra `suma% / bucket%`; verde si cuadra, destructive si excede, "faltan X%" si por debajo; excluye supletorios |
| EX-21 | Eliminar → Papelera (soft-delete) | Examen existente | RowActionsMenu → "Eliminar" (tono destructive) → confirmar | `useConfirm` tono warning con texto "queda en papelera 30 días"; toast "enviado a papelera"; desaparece de la lista |
| EX-22 | Soft-delete invisible en TODO flujo | Examen enviado a papelera con asignaciones | Como Estudiante: revisar lista de exámenes, calendario, agenda del dashboard; intentar abrir la URL `/app/student/take/$examId` | El examen NO aparece en ningún listado/calendario; la toma se bloquea (query filtra `deleted_at IS NULL`) con toast "no encontrado" |
| EX-23 | Bulk delete | Varios exámenes seleccionados | Checkbox de selección → toolbar → "Eliminar" | BulkDeleteDialog con conteo + preview; envía todos a papelera; si hay error muestra el primero real (friendlyError) |
| EX-24 | Duplicar examen parametrizable | Examen con preguntas y proctoring | RowActionsMenu → "Duplicar" → elegir curso destino + título + flags (copiar preguntas / proctoring) | Clona vía RPC `clone_exam`; nace en estado "Borrador"; NO copia asignaciones/entregas; si se desmarca proctoring → navegación libre/sin mezcla/3 advertencias |
| EX-25 | Aislamiento por tenant (RLS) | Existe otro tenant con exámenes | Estando en Demo Global Corp, intentar consultar/abrir un examen de otro tenant (REST directo o URL) | RLS bloquea; no aparece ni es accesible; ningún examen de otra institución es visible |

**Checks UI/UX (módulo EX):**
- Responsive 375px: dialog `max-w-[calc(100vw-2rem)]`, sin scroll horizontal de página; la tabla scrollea dentro del Card; columnas secundarias ocultas (`hidden md/lg:table-cell`).
- Modo claro/oscuro: StatCards, StatusBadge, dialog y tabla legibles en ambos.
- Estados loading (PageLoader/TableSkeleton), empty ("Crea el primer examen" con CTA), error (ErrorState con "Reintentar").
- Toasts siempre en español vía `friendlyError`; nunca mensaje técnico de Postgres.
- Touch targets ≥32px en RowActionsMenu y checkboxes.
- Fechas es-CO (DateCell, "30 sep 2026, 14:30"); columnas "Inicio"/"Fin" sin prefijo "Fecha".
- Paginación (25/pág), orden por columna (SortableHead, vacíos al final) y filtros persisten; "seleccionar todo" abarca todo lo filtrado, no solo la página.
- Redimensionado de columnas (desktop) y accesibilidad (labels, `required` con asterisco, aria en RowAction).

### 2. Tipos de pregunta (`QT`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| QT-01 | Abierta con rúbrica | Editor, pestaña Preguntas | Tipo "Abierta" → enunciado + puntos, sin rúbrica → guardar | Toast "Rúbrica requerida…"; con rúbrica guarda OK |
| QT-02 | Cerrada (opción única) | — | Tipo "Cerrada" → 4 opciones + marcar correcta → guardar | Guarda `options.choices` + `correct_index`; el alumno ve radio buttons |
| QT-03 | Cerrada múltiple (cerrada_multi) | — | Tipo "Opción múltiple" → marcar ≥1 correcta + min/max selecciones | Sin correcta → toast "Marca al menos una"; min>max → toast "Mínimo no puede ser mayor al máximo"; guarda `correct_indices` + `min/max_selections` |
| QT-04 | Código (codigo) | — | Tipo "Código" → elegir lenguaje (Java/Python/JavaScript) + enunciado + rúbrica | Guarda con `language` y `starter_code` según lenguaje; el alumno ve el editor Monaco con plantilla |
| QT-05 | Diagrama (Mermaid) | — | Tipo "Diagrama" → enunciado + rúbrica | Rúbrica obligatoria; el alumno resuelve en el DiagramEditor (Mermaid) |
| QT-06 | Java GUI (swing/javafx) | — | Tipo "Java GUI" → elegir framework Swing o JavaFX + rúbrica | Guarda `options.java_framework`; `starter_code` = plantilla del framework; al cambiar Swing↔JavaFX en edición actualiza la plantilla si no fue tocada |
| QT-07 | Python GUI (tkinter) | — | Tipo "Python GUI" → enunciado + rúbrica | `language=python`, plantilla `PYTHON_GUI_STARTER`; runner solo `aws_screenshot` |
| QT-08 | Red consola / Red GUI (escenario JSON) | — | Tipo "Red (consola)" o "Red (diagrama)" → editar escenario JSON | JSON inválido (falta devices/links/targetDeviceId/assertions) → toast "escenario no válido"; válido guarda `options.network`; auto-calificable por assertions |
| QT-09 | Generación local de preguntas de red | — | Panel IA → tipo red_consola/red_gui + cantidad → "Generar" | Se generan localmente (sin IA/gate) e insertan directo; toast "N pregunta(s) de Red generadas" |
| QT-10 | codigo_zip NO disponible en examen | — | Revisar el Select de tipo de pregunta | `codigo_zip` NO aparece como tipo de pregunta de examen (es exclusivo de Proyectos); si se intenta por API no está en el CHECK de `questions` |
| QT-11 | Generación con IA (modo sync) | `ai_model_settings.processing_mode=sync` | Panel "Generar con IA" → temas + filas de tipo/cantidad → "Generar preguntas" | LoadingOverlay; inserta N preguntas; toast "N generadas"; requiere ≥1 tipo con cantidad>0 y temas no vacíos |
| QT-12 | Generación con IA encolada (async) | modo async sin código IA activo | "Generar preguntas" | Gate IA ofrece "Activar IA inmediata / Encolar / Cancelar"; al encolar → filas en `ai_generation_queue`; toast explica que aparecerán al procesar; visibles en Cola IA |
| QT-13 | Reordenar / editar / eliminar pregunta | ≥2 preguntas | Flechas arriba/abajo; lápiz para editar; papelera para eliminar | Reordena por `position`; editar carga el form (scroll al top); eliminar con `useConfirm` destructive |
| QT-14 | Evaluar tiempo con IA | ≥1 pregunta | Config → botón "Evaluar tiempo" (Sparkles) | Deshabilitado sin preguntas; devuelve veredicto (HOLGADA/AJUSTADA/CORTA/INSUFICIENTE) + minutos sugeridos; "Aplicar" actualiza duración (recuerda guardar) |
| QT-15 | Importar del banco de preguntas | Banco con preguntas del curso | Botón importar banco → seleccionar | Inserta las preguntas seleccionadas en el examen |
| QT-16 | Límite de caracteres respuesta abierta | `app_settings.max_open_answer_chars` (default 500) | Como alumno, responder abierta | El Textarea limita a los caracteres configurados |

**Checks UI/UX (módulo QT):**
- Responsive 375px: pares Tipo/Puntos y Tipo/Lenguaje apilan (`grid-cols-1 sm:grid-cols-2`); Selects no se truncan.
- Claro/oscuro: editor Monaco, DiagramEditor y textareas legibles.
- Loading en generación IA (LoadingOverlay + Spinner), empty (sin preguntas), error (toast friendlyError con detalle del edge).
- Toasts en español; el error del edge se muestra con `extractEdgeError`.
- Touch targets ≥32px en flechas de orden y botón X de fila de IA.
- Resumen de preguntas (chips #, tipo, pts) y conteo de puntos totales.
- Accesibilidad: labels `required`, HelpHint (`?`) en horario/reintentos/advertencias/peso.

### 3. Toma del examen — estudiante (`TK`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| TK-01 | Iniciar y tomar (happy path) | Rol Estudiante; examen publicado, asignado, dentro de ventana | Exámenes → abrir → "Iniciar" (entra a pantalla completa) → responder → "Entregar" | Entrada a fullscreen; responde todos los tipos; entrega en ~300ms; toast "entregado correctamente"; redirige a lista |
| TK-02 | Gate: no publicado (draft/closed) | Examen en Borrador o Cerrado | Intentar abrir `/take/$examId` | Toast "aún no publicado" o "cerrado por el docente"; redirige a lista |
| TK-03 | Gate: fuera de ventana | Examen con ventana pasada/futura | Abrir take | Toast "no está disponible ahora"; redirige |
| TK-04 | Gate: no asignado | Examen no asignado al alumno | Abrir take | Toast "No estás asignado a este examen"; redirige |
| TK-05 | Gate: intentos agotados | `max_attempts` alcanzado (intentos calificados) | Abrir take | Toast "Ya usaste tus N intentos" (o "Ya completaste"); redirige |
| TK-06 | Timer cuenta atrás + tiempo agotado | Examen en curso con duración corta | Dejar correr el timer a 0 | Estado low-time visible; al llegar a 0 auto-guarda, hace merge de plantillas de código y entrega automáticamente (sin modal) |
| TK-07 | Navegación secuencial | Examen navigation_type "secuencial" | "Siguiente" | "Anterior" siempre disabled; "Siguiente" abre modal de confirmación (no podrás regresar) cada vez; una sola pregunta visible |
| TK-08 | Navegación libre | navigation_type "libre" | Navegar adelante/atrás | "Anterior" disabled solo en la primera; sin modal |
| TK-09 | Mezcla determinística (shuffle) | Examen con `shuffle_enabled` | Recargar la página mid-examen | El orden de preguntas se mantiene estable entre recargas (seed por examen+alumno) y difiere entre alumnos |
| TK-10 | Session lock (otro dispositivo) | Intento en_progreso reciente (<10s) en otro dispositivo/pestaña | Abrir el mismo examen en 2ª pestaña e "Iniciar" | La 2ª queda `blockedBySession` (mensaje de examen abierto en otro dispositivo); no puede tomar el control salvo tras >10s de inactividad |
| TK-11 | Autosave + heartbeat | Examen en curso | Responder y esperar | Autosave debounce 1.5s + heartbeat 5s refrescan `updated_at` aunque no se escriba |
| TK-12 | Entregar con respuestas en blanco | Examen con preguntas sin responder | "Entregar" | Modal de confirmación tono warning listando preguntas en blanco; confirmar entrega igual; cancelar vuelve |
| TK-13 | Reanudar entrega sin calificar | Entrega `completado` aún SIN nota | Volver a abrir el examen | Se reabre a `en_progreso`, limpia `submitted_at`, cancela jobs IA pendientes; toast informativo; conserva respuestas y última pregunta |
| TK-14 | No reanudar sospechoso | Entrega marcada `sospechoso` | Abrir take | Cuenta como intento gastado; no reanudable (queda para revisión del docente) |
| TK-15 | Ejecutar y cancelar código | Pregunta tipo código | "Ejecutar"; luego "Cancelar" mid-run | Muestra salida; "Cancelar" libera la UI (CheerpJ/edge no se matan pero se abandona la respuesta); toast informativo |
| TK-16 | Override de runner por pregunta | Pregunta código; varios providers | Cambiar el runner en el selector de la pregunta | Chip "Override"; usa el provider elegido; persiste por (submission, question) en refresh |
| TK-17 | Offline durante examen | Examen en curso | Simular desconexión (DevTools offline) → responder → reconectar | Banner offline; respuestas se guardan en IndexedDB; al reconectar sincroniza sin toast engañoso; entrega con fallo de servidor mantiene respaldo local y muestra error accionable |
| TK-18 | Timer controlado por docente | Examen en curso; docente en monitor | Docente pausa/reanuda/añade tiempo | Toasts en español (⏸ pausado, ▶ reanudado, +N min); el timer se sincroniza por realtime; cambios de horario del docente se reflejan en vivo |
| TK-19 | Notas de apoyo (chuletas) aprobadas | `allow_exam_notes` ON; nota aprobada por docente | Tomar examen | Se muestra la nota aprobada; con toggle OFF no aparece la sección |
| TK-20 | Idioma del curso forzado | Curso con `language` distinto | Tomar examen | La UI del examen usa el idioma del curso; se restaura al salir |

**Checks UI/UX (módulo TK):**
- Responsive 375px: una pregunta por pantalla; el contenedor `max-w-3xl` o maximizado; dialogs con `dvh` (no `vh`) para no cortar footer en iOS.
- Claro/oscuro: editor de código, badges de timer/advertencias, overlays.
- Loading (Spinner mientras carga examen; reintento silencioso ante blip de red sin expulsar), empty, error.
- Toasts en español (gates, entrega, timer, offline).
- Touch targets ≥32px en botones Iniciar/Entregar/Anterior/Siguiente/Ejecutar/Cancelar.
- Timer con `tabular-nums`; fechas es-CO.
- Accesibilidad: overlay de re-entrada a fullscreen con botón claro; badge "Intento X de Y".

### 4. Proctoring (`PR`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| PR-01 | Salida de pestaña/ventana suma strike | Examen en curso, en fullscreen | Alt+Tab o click fuera (blur) | Advertencia N/max en toast ("Salida de pestaña/ventana"); `focus_warnings`++; evento registrado |
| PR-02 | Pestaña oculta (visibility) | Examen en curso | Minimizar / cambiar de app (mobile) | Strike `visibility_hidden`; deduplica con blur en 500ms |
| PR-03 | Salida de pantalla completa | fullscreen requerido ON | Pulsar Esc / salir de fullscreen | El navegador sale de FS (JS no lo intercepta); `fullscreenchange` dispara strike `fullscreen_exit`; overlay de re-entrada aparece |
| PR-04 | Umbral → suspensión automática | max_warnings=3 (default) | Acumular 3 strikes | Toast "Has superado el límite… se suspende"; entrega automática con status `sospechoso`; se notifica al docente (fire-and-forget) |
| PR-05 | max_warnings configurable | Examen con max_warnings=5 | Acumular strikes | Suspende recién al 5º; el toast muestra "N/5" |
| PR-06 | Copiar/pegar/cortar fuera del editor = alerta blanda | Examen en curso, foco en textarea | Ctrl+C/V/X | Bloqueado (preventDefault) + toast "no permitido"; **NO suma strike**; evento registrado para el monitor |
| PR-07 | Copiar/pegar permitido en editor de código | Pregunta código (Monaco) | Ctrl+C/V dentro del editor | Permitido; sin alerta ni strike |
| PR-08 | Intento de pantallazo = alerta blanda | Examen en curso | PrintScreen / Win+Shift+S / Cmd+Shift+3-5 | Toast "no permitido tomar pantallazos"; **NO suma strike**; evento `screenshot_attempt` registrado (best-effort, SO puede interceptar) |
| PR-09 | Esc bloqueado en la app | Examen en curso, algún dialog | Pulsar Esc | No cierra dialogs del SPA ni cancela defaults (preventDefault + stopPropagation); no suma strike por sí mismo |
| PR-10 | Zoom / atajos bloqueados | Examen en curso | Ctrl +/-/0, Ctrl+rueda, F11, Alt+Tab, Alt+F4 | Interceptados (no hay zoom que provoque salida de FS falsa) |
| PR-11 | Botón "Atrás" del navegador | Examen en curso | Pulsar Atrás | Modal de confirmación de salida; al confirmar hace `await update` antes de navegar (no se pierden respuestas ni strikes) |
| PR-12 | Cerrar pestaña (beforeunload) | Examen en curso | Cerrar/recargar la pestaña | Diálogo nativo "¿Salir del sitio?"; keepalive fetch persiste respuestas + strike (suspende si cruza el umbral) |
| PR-13 | Grace period al reanudar | Reanudar intento aún sin entrar a fullscreen | Recargar; antes de "Reanudar" hacer blur/cerrar | NO suma strike (antesala del examen); una vez en FS, el proctoring queda estricto |
| PR-14 | Fullscreen obligatorio desactivado (Admin) | `app_settings.require_exam_fullscreen=false` | Iniciar examen | Corre en ventana normal; no pide FS ni overlay; `fullscreen_exit` no aplica; blur/copy sí siguen activos |
| PR-15 | iOS sin soporte de Fullscreen | Dispositivo iOS Safari pre-16.4 | Iniciar examen | Toast guía (PWA / toggle WebKit) con duración larga; no inicia si no puede entrar a FS; se audita `exam_fullscreen_denied` |
| PR-16 | Evento anclado a la pregunta (secuencial) | Examen secuencial | Provocar strike en la pregunta 3 | El evento registra `questionIdx=2` (índice actual real, no stale); el monitor lo ancla a la pregunta correcta |

**Checks UI/UX (módulo PR):**
- Toasts de advertencia en español con formato "Advertencia N/max: {etiqueta}" (`warningLabel`).
- Overlay de re-entrada a FS visible en claro/oscuro; botón "Reanudar" ≥32px.
- No hay scroll horizontal ni parpadeo al entrar/salir de fullscreen en 375px.
- Los eventos blandos (copy/screenshot) no penalizan pero se registran (verificable en el monitor).
- Accesibilidad: mensajes claros y no bloqueantes salvo el modal de salida.

### 5. Monitor en vivo — docente (`MON`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| MON-01 | Estado en vivo por estudiante | Examen con intentos en curso; docente en `/monitor/$examId` | Abrir monitor mientras un alumno toma | Tabla realtime con estado por alumno (StatusBadge en_progreso/completado/sospechoso); actualización por canal Supabase con debounce |
| MON-02 | "Pregunta X de Y" en curso | Alumno tomando examen secuencial | Ver fila del alumno | Muestra la pregunta actual (leída de `answers.__current_idx`, persistida cada 1.5s) |
| MON-03 | Advertencias y eventos | Alumno con strikes | Abrir detalle de la submission | Badge `N/3` (destructive si >0); lista de eventos con `warningLabel` + timestamp es-CO + pregunta |
| MON-04 | Pausar/Reanudar (individual) | Alumno en_progreso | Botón pausa/reanuda en su fila | Inserta en `exam_timer_controls`; el timer del alumno se pausa/reanuda por realtime; el estado de pausa se refleja en el monitor |
| MON-05 | Añadir tiempo | Alumno en_progreso | Acción "añadir tiempo" | `extra_seconds` acumulados; el alumno ve "+N min extra"; en examen relativo extiende su deadline personal |
| MON-06 | Reabrir sospechoso/entregado | Submission `sospechoso` o `completado` | Acción "Reabrir" | Vuelve a `en_progreso`, limpia `submitted_at`; el alumno puede retomar |
| MON-07 | Perdonar todas las advertencias | Submission con strikes | "Borrar advertencias" | `focus_warnings=0`, limpia `__warning_events`; queda auditado |
| MON-08 | Perdonar una advertencia | Submission con ≥2 eventos | Borrar un evento puntual | Elimina solo ese evento; `focus_warnings` se recalcula |
| MON-09 | Override de nota + feedback | Submission calificada por IA | Editar nota manual + feedback | Persiste `final_override_grade` + `teacher_feedback`; el override gana a la nota IA en la revisión del alumno |
| MON-10 | Re-calificar con IA (preview) | Submission calificada | Acción re-calificar | Muestra preview con nota previa vs nueva antes de aplicar |
| MON-11 | Soft-delete no aparece en monitor | Examen enviado a papelera | Intentar abrir su monitor | No accesible / sin datos (filtro `deleted_at`) |
| MON-12 | RBAC SuperAdmin/Admin | Rol Admin | Abrir monitor de un examen del tenant | Admin/SuperAdmin acceden a la pantalla docente para soporte (isStaffRole); no reciben "Necesitas rol Docente" |

**Checks UI/UX (módulo MON):**
- Responsive 375px: la matriz de monitor scrollea dentro del Card; columna de estudiante con `min-w` reducido.
- Claro/oscuro: StatusBadge, badges de advertencias, controles de timer.
- Loading/empty (sin intentos aún)/error visibles; realtime con debounce (sin refresh-storm).
- Toasts en español (pausa/reanuda/tiempo, reabrir, perdonar).
- Touch targets ≥32px en RowAction de pausar/reanudar y acciones del detalle.
- Fechas/tiempos es-CO y `tabular-nums`; `extra_seconds` mostrado en minutos.

### 6. Revisión de resultados — estudiante (`REV`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| REV-01 | Ver resultado calificado | Entrega calificada (IA o docente) | Estudiante → Exámenes → "Ver resultado" | Muestra `finalGrade = final_override_grade ?? ai_grade` sobre la escala del curso (`grade_scale_max`); desglose por pregunta con rúbrica y feedback |
| REV-02 | Pendiente de calificación IA | Entrega sin nota (`ai_grade` null) | Abrir revisión | Banner "pendiente de calificación IA"; no muestra nota final |
| REV-03 | Override del docente prioriza | Entrega con nota IA + override manual | Abrir revisión | Se muestra la nota override (no la IA); se aclara la diferencia |
| REV-04 | Nota efectiva multi-intento | ≥2 intentos, retry_mode highest/average | Abrir revisión | Nota global según el modo (`retryModeLabel`); el detalle muestra el ÚLTIMO intento con nota aclaratoria |
| REV-05 | Feedback del docente visible | Submission con `teacher_feedback` | Abrir revisión | Se muestra el feedback por pregunta / global |
| REV-06 | Cálculo de nota del corte | Examen con peso y corte | Comparar con vista de Notas del estudiante | El examen aporta su `weight` (% de la nota final, cap = bucket `exam_weight`); items sin score cuentan como 0 con su peso (no se reescalan) |

**Checks UI/UX (módulo REV):**
- Responsive 375px: desglose por pregunta sin overflow; imágenes/diagramas `max-w-100%`.
- Claro/oscuro: banners (pendiente IA), rúbricas y feedback legibles.
- Loading/empty (sin entrega)/error.
- Toasts en español; notas con coma decimal (es-CO) y escala del curso.
- Accesibilidad: jerarquía clara "Resultado global" vs detalle del intento.

### 7. Calificación IA + detección de fraude (`IA`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| IA-01 | Calificación automática al entregar (sync) | `processing_mode=sync` | Alumno entrega examen con preguntas abiertas/código | Fire-and-forget a `ai-grade-submission`; nota aparece en ~5-15s; el alumno no espera |
| IA-02 | Encolado (async) | `processing_mode=async` sin código IA | Alumno entrega | Se encola en `ai_grading_queue`; toast al alumno "Por calificar"; el worker hourly drena; visible en Cola IA con `course_id` (docente lo ve) |
| IA-03 | Detección IA por entrega | Entrega calificada | Ver `ai_detected_score`/razones | Threshold 0.6 marca `ai_detected` y status `sospechoso`; StatusBadge destructive con AlertTriangle |
| IA-04 | Plagio entre estudiantes | ≥2 entregas del examen | Monitor → "Detectar plagio" | Gate IA (consume cuota); `detect-plagiarism` compara pares y persiste en `similarity_pairs`; FraudPanel muestra pares con score+razones |
| IA-05 | Failover de API keys | Fila con keys de respaldo configuradas | Provocar fallo de la key principal (429/5xx) | Rota a la siguiente key; la IA no se cae; error 400 NO rota; en la última key hace retry con backoff |
| IA-06 | Auto-suspensión notifica al docente | Alumno supera max_warnings | Ver notificación del docente | Notif `🎫`/📢 con quién+qué y link `/app/teacher/monitor/$examId`; el detalle vive en el monitor |
| IA-07 | Aislamiento de cola por tenant | Cola IA con jobs de varios cursos | Docente revisa Cola IA | Solo ve jobs de sus cursos (RLS); no ve jobs de otro tenant |

**Checks UI/UX (módulo IA):**
- Toasts/errores del edge en español (`extractEdgeError` + friendlyError), no JWT/HTTP técnicos crudos.
- Panel de cola preserva el error: preview truncado siempre visible + expandible con "Copiar al portapapeles".
- Claro/oscuro y responsive 375px en FraudPanel y Cola IA.
- Estados loading (Spinner/overlay), empty (sin jobs) y error.
- Touch targets ≥32px en acciones de la cola (Zap/RefreshCw/Cancelar); fechas es-CO.

---

## Talleres y Proyectos (creación, grupos, entrega, calificación, sustentación)

Alcance: verifica el ciclo completo de talleres y proyectos en Demo Global Corp — creación (interno/externo), preguntas prácticas, grupos, entrega del alumno, calificación con IA + rúbrica + detección de fraude, sustentación de proyectos y registro de notas externas. Cambia de rol con el selector del sidebar (Docente para crear/calificar, Estudiante para entregar).

### TW — Talleres: creación y configuración (Docente)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| TW-01 | Crear taller interno mínimo | Rol Docente; ≥1 curso activo | 1. `/app/teacher/workshops` → "Nuevo taller". 2. Escribir título. 3. Dejar curso primario preseleccionado. 4. Guardar | Toast "Taller creado correctamente"; aparece en el grid; "Visible desde" viene precargado en AHORA y "Fecha límite" a +7 días; `max_score` heredó el `grade_scale_max` del curso |
| TW-02 | Validación: título obligatorio | Dialog abierto | 1. Dejar título vacío. 2. Guardar | Toast "Completa los campos"; no se crea |
| TW-03 | Validación: al menos un curso | Dialog abierto | 1. Deseleccionar todos los cursos. 2. Guardar | Toast "Selecciona al menos un curso" |
| TW-04 | Fecha límite anterior a "Visible desde" | Taller interno | 1. Poner `start_date` posterior a `due_date`. 2. Guardar | Toast de error (endDateBeforeStart); no guarda |
| TW-05 | Cap de fecha por fin de curso | Curso con `end_date` cercano | 1. Poner `due_date` posterior al `end_date` del curso. 2. Guardar | `due_date` se recorta automáticamente al día de fin del curso (más temprano si hay varios cursos) |
| TW-06 | Peso dentro del bucket del corte | Curso con corte cuyo `workshop_weight` ya está parcialmente asignado | 1. Elegir corte. 2. Poner peso mayor al disponible del bucket. 3. Guardar | Toast "El peso del taller (X%) supera el bucket disponible del corte (Y% restantes)…"; no guarda. El campo peso se auto-ajusta al máximo disponible al cambiar de corte |
| TW-07 | Taller externo oculta campos | Dialog abierto | 1. Activar toggle "Actividad externa". 2. Observar | Se ocultan campos de proctoring/grupo/preguntas; al guardar queda `status=closed` y `group_mode=individual` |
| TW-08 | Taller multi-curso con peso/corte por curso | ≥2 cursos con cortes | 1. Marcar 2 cursos. 2. Asignar corte+peso distintos por curso. 3. Guardar | Toast "Taller creado en 2 cursos (1 registro compartido)"; valida bucket por curso independientemente; matriculados de ambos cursos quedan asignados |
| TW-09 | Publicar notifica a estudiantes | Taller borrador | 1. Editar → estado "Publicado". 2. Guardar | Estudiantes matriculados reciben notificación (kind `workshop`); el taller aparece en su lista |
| TW-10 | Override de intentos máximos | Dialog abierto | 1. Poner `max_attempts=2`. 2. Guardar | Se persiste 2; vacío/0 → hereda default global |
| TW-11 | Eliminar → Papelera (soft-delete) | Taller existente | 1. Menú de fila → Eliminar → confirmar (tono destructivo). 2. Ir a `/app/trash` | Toast de envío a papelera; desaparece del grid; aparece en Papelera con "días restantes"; NO visible para el estudiante ni en calendario/gradebook |
| TW-12 | Bulk delete | ≥2 talleres | 1. Seleccionar varios con checkbox. 2. Toolbar → Eliminar → confirmar | Todos pasan a papelera; conteo correcto; "seleccionar todo" abarca todas las páginas del filtro activo |
| TW-13 | Importar talleres por CSV | Menú Importar/Exportar | 1. Descargar plantilla. 2. Cargar CSV con `course_name,title,...`. 3. Confirmar | Filas válidas se crean; filas con curso inexistente/fecha inválida se reportan sin abortar el lote |
| TW-14 | Duplicar taller parametrizable | Taller con preguntas y grupos | 1. Menú → Duplicar. 2. Elegir curso destino + título. 3. Desmarcar "Copiar preguntas". 4. Confirmar | Copia nace `draft`, sin preguntas (por flag), sin entregas; grupos según flag `_copy_groups` |
| TW-15 | Reabrir taller cerrado | Taller `closed` | 1. Filtro estado "Cerrados"/"Todos". 2. Editar → estado "Publicado" | Banner de reapertura visible; vuelve a estar activo |

**Checks UI/UX (TW):** responsive 375px sin scroll horizontal (dialog usa `max-w-[calc(100vw-2rem)]`, tabla scrollea dentro del Card); claro/oscuro en grid, dialog y StatCards; estados loading (TableSkeleton), empty ("Sin datos"/crear primero) y error (ErrorState + "Reintentar"); toasts en español vía `friendlyError`; fechas es-CO en columnas Inicio/Fin (DateCell, sin bug UTC −1 día); paginación (25/pág), orden por columna (default Fin desc) y filtros (búsqueda + curso + corte + estado) persistentes; touch targets ≥32px; encabezado con `PageHeader` (conteo en subtítulo, sin "Volver").

### TQ — Preguntas de taller (editor Docente)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| TQ-01 | Agregar pregunta abierta manual | Taller abierto → editor de preguntas | 1. Tab "Manual". 2. Tipo "Abierta". 3. Enunciado + rúbrica + puntos. 4. "Agregar pregunta" | Toast "Pregunta agregada"; aparece en la lista con badge de tipo y puntos |
| TQ-02 | Validación: enunciado obligatorio | Tab Manual | 1. Dejar enunciado vacío. 2. Guardar | Toast "Escribe el enunciado" |
| TQ-03 | Cerrada de opción única | Tab Manual | 1. Tipo "Cerrada". 2. Llenar opciones + marcar correcta (radio). 3. Guardar | Se guarda con `correct_index` |
| TQ-04 | Cerrada múltiple: requiere ≥1 correcta | Tipo cerrada_multi | 1. No marcar ninguna correcta. 2. Guardar | Toast "Marca al menos una opción correcta en opción múltiple" |
| TQ-05 | Cerrada múltiple: min>max inválido | cerrada_multi con ≥2 correctas | 1. Min seleccionadas = 3, Max = 2. 2. Guardar | Toast "Mínimo de marcadas no puede ser mayor al máximo" |
| TQ-06 | Pregunta de código con lenguaje | Tipo "Código" | 1. Elegir lenguaje (Java/Python/JS). 2. Guardar | Se guarda con starter code por lenguaje |
| TQ-07 | Java GUI con framework | Tipo java_gui | 1. Elegir Swing o JavaFX. 2. Guardar. 3. Editar → cambiar framework | Se persiste `options.java_framework`; al cambiar framework el starter se refresca solo si coincidía con el default del otro |
| TQ-08 | Diagrama (Mermaid) | Tipo diagrama | 1. Enunciado + rúbrica. 2. Guardar | Pregunta tipo diagrama creada |
| TQ-09 | Red (consola) con escenario JSON válido | Tipo red_consola | 1. Usar plantilla por defecto (o editar JSON). 2. Guardar | Se guarda con `options.network` parseado |
| TQ-10 | Red (consola): JSON inválido | Tipo red_consola | 1. Corromper el JSON (borrar `assertions`). 2. Guardar | Toast "El escenario de red no es válido…"; no guarda |
| TQ-11 | codigo_zip modo ZIP único vs multi-archivo | Tipo codigo_zip | 1. Elegir lenguaje. 2. Alternar toggle "modo ZIP único". 3. Guardar | Se persiste `zip_single` según toggle |
| TQ-12 | Reordenar preguntas | ≥2 preguntas | 1. Flechas subir/bajar en una fila | Cambia `position`; el orden se refleja |
| TQ-13 | Eliminar pregunta | ≥1 pregunta | 1. Icono eliminar → confirmar | Toast "Pregunta eliminada"; desaparece |
| TQ-14 | Generar con IA (sync) | Modo IA `sync` | 1. Tab "IA". 2. Temas + fila (tipo/cantidad). 3. "Generar" | Toast "N preguntas generadas"; se insertan en la lista |
| TQ-15 | Generar IA sin temas / sin filas | Tab IA | 1a. Sin temas → generar. 1b. Con cantidad 0 → generar | 1a. "Indica los temas". 1b. "Configura al menos un tipo con cantidad > 0" |
| TQ-16 | Red generada localmente (sin IA) | Tab IA, fila tipo red_consola | 1. Generar solo filas de red | Preguntas de red se insertan de inmediato sin pasar por el gate/cola de IA |
| TQ-17 | Generación en modo async → cola | Modo IA `async` sin código inmediato | 1. Generar tipos que usan IA | Gate ofrece encolar; toast "jobs de generación encolados"; visibles en Cola IA |
| TQ-18 | Importar del banco de preguntas | Curso con banco poblado | 1. "Importar del banco". 2. Elegir preguntas. 3. Importar | Preguntas agregadas al taller |

**Checks UI/UX (TQ):** responsive 375px (grid de campos `grid-cols-1 sm:grid-cols-2`); claro/oscuro; loading (Spinner) y empty ("No hay preguntas"); LoadingOverlay durante generación IA; toasts es-CO; touch targets ≥32px en RowAction (subir/bajar/editar/eliminar); tabs List/Manual/IA legibles; HelpHint con tooltip en framework Java y whitelist de codigo_zip.

### TE — Entrega de taller (Estudiante)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| TE-01 | Entregar taller con respuestas completas | Rol Estudiante; taller publicado asignado | 1. `/app/student/workshops` → abrir taller. 2. Responder todas las preguntas. 3. "Entregar" | Se crea `workshop_submission`; calificación IA inmediata; muestra nota final |
| TE-02 | Confirmación con respuestas en blanco | Taller con preguntas | 1. Dejar ≥1 pregunta vacía. 2. "Entregar" | Modal `useConfirm` tono warning listando las preguntas en blanco; al confirmar entrega (las vacías → 0 pts); al cancelar sigue editando |
| TE-03 | Gate de videos introductorios | Taller con videos intro | 1. Abrir taller sin ver videos. 2. Intentar entregar | Bloqueado hasta ver TODOS los videos (a diferencia de proyectos, aplica a cualquier entrega); progreso persiste en sesión reanudada |
| TE-04 | Enforcement de intentos máximos | Taller `max_attempts=1`, entrega previa calificada | 1. Intentar re-entregar | Bloqueado; mensaje de intentos agotados. Con `max_attempts=N` permite hasta N; una re-edición del intento no calificado es libre |
| TE-05 | Pregunta de código: ejecutar | Taller con pregunta `codigo` | 1. Escribir código. 2. "Ejecutar" (runner default o override). 3. Cancelar un run en curso | Muestra salida; el selector de runner permite override por pregunta; "Cancelar" libera la UI |
| TE-06 | Cerrada múltiple guarda selección | Pregunta cerrada_multi | 1. Marcar varias opciones. 2. Entregar. 3. Reabrir | La selección (array) se persiste y rehidrata |
| TE-07 | Red (consola) resuelve por asserts | Pregunta red_consola | 1. Configurar el dispositivo desde la consola tipo IOS. 2. Entregar | Auto-calificación por aserciones (hostname/ip/connectivity, etc.) |
| TE-08 | Entrega grupal compartida | Taller grupal, alumno en grupo | 1. Miembro A responde y entrega. 2. Miembro B abre el taller | B ve la MISMA entrega (por `group_id`); cualquier miembro edita la fila compartida; card "Tu grupo: X" arriba |
| TE-09 | Modo mixto: alumno sin grupo entrega individual | Taller `teacher_assigned`, alumno sin grupo | 1. Abrir y entregar | Entrega individual normal, sin warnings de "espera a tu grupo" |
| TE-10 | Taller en papelera no visible | Docente envió el taller a papelera | 1. Estudiante abre su lista de talleres/calendario | El taller NO aparece en ningún flujo hasta que se restaure |

**Checks UI/UX (TE):** responsive 375px (una pregunta a la vez cabe sin scroll horizontal); claro/oscuro; loading al cargar preguntas; empty ("Este taller no tiene preguntas"); toasts es-CO (`friendlyError`); StatusBadge para estado de la entrega; touch targets ≥32px; fechas de entrega es-CO; confirmación destructiva/warning vía `useConfirm` (no `window.confirm`).

### TG — Calificación de taller: IA + rúbrica + fraude (Docente)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| TG-01 | Abrir modal de calificación | Taller con entregas | 1. Menú de fila → Calificar (o icono correspondiente) | Grid de estudiantes con estado; buscador por nombre/correo |
| TG-02 | Ver detalle pregunta por pregunta | Modal abierto | 1. "Ver" en un estudiante | Cambia del grid al detalle por pregunta del alumno (acordeón); vuelve al grid al cerrar el detalle |
| TG-03 | Recalificar una respuesta con IA | Detalle de un alumno | 1. "Recalificar con IA" en una respuesta | Actualiza `ai_grade`/`ai_feedback` de esa respuesta; gate IA aplica si async |
| TG-04 | Ajuste manual de nota + guardar | Detalle | 1. Editar nota de una pregunta. 2. Guardar | Persiste; recalcula la nota global del taller |
| TG-05 | Señal de IA por pregunta (likelihood) | Respuesta con `ai_likelihood ≥ 0.6` | 1. Observar la pregunta | Marca de sospecha de IA con razones inline; el docente puede marcarla "revisada" |
| TG-06 | Detección de copia entre estudiantes | ≥2 entregas similares | 1. "Detectar copias" | Se pueblan `similarity_pairs`; sugerencia de penalización por par de estudiantes/pregunta |
| TG-07 | Conversación con el estudiante | Entrega con hilo | 1. Abrir hilo de una pregunta | Muestra count/pending; deep-link `?workshop=&submission=&question=` salta al detalle y resalta |
| TG-08 | Deep-link a taller inexistente | URL con `?workshop=<id borrado>` | 1. Navegar | Toast "El taller referenciado… ya no existe o no tienes acceso"; limpia la URL |
| TG-09 | Contador de errores IA por taller | Taller con jobs IA fallidos | 1. Observar el grid | Badge/indicador de errores IA del taller |

**Checks UI/UX (TG):** responsive 375px (dialog ancho `max-w-5xl+`, tabla scrollea internamente); claro/oscuro; loading al cargar entregas; empty ("sin entregas"); error visible del último job IA (preview 1 línea + expandible + Copiar); toasts es-CO; DecimalInput con coma para notas; touch targets ≥32px; buscador con botón limpiar.

### PP — Proyectos: creación y configuración (Docente)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| PP-01 | Crear proyecto interno | Rol Docente; ≥1 curso | 1. `/app/teacher/projects` → "Nuevo proyecto". 2. Título + curso. 3. Guardar | Toast de creación; `start_date`=AHORA, `due_date`=+2 semanas; `max_score` hereda escala del curso; auto-asigna matriculados |
| PP-02 | Validación título + curso | Dialog abierto | 1. Sin título o sin curso. 2. Guardar | Toast "Título y al menos un curso son obligatorios" |
| PP-03 | Fecha entrega < inicio | Proyecto interno | 1. `due_date` < `start_date`. 2. Guardar | Toast endDateBeforeStart; no guarda |
| PP-04 | Cap de entrega por fin de curso | Curso con `end_date` | 1. `due_date` posterior al fin. 2. Guardar | Se recorta al fin del curso más temprano de los vinculados |
| PP-05 | Peso por curso dentro del bucket de proyecto | Curso con corte y `project_weight` | 1. Corte + peso mayor al disponible. 2. Guardar | Toast "El peso del proyecto (X%) supera el bucket disponible… (Y% restantes)"; no guarda |
| PP-06 | Multi-curso con self-heal de vínculos | Proyecto vinculado a 2 cursos | 1. Guardar. 2. Filtrar por curso secundario | El proyecto aparece; `project_courses` se sincroniza vía upsert (no queda huérfano si falla el INSERT) |
| PP-07 | Proyecto externo | Dialog | 1. Toggle "Actividad externa". 2. Guardar | Oculta link/instrucciones/video; solo registra fecha del evento; no notifica; usa ExternalGradesEditor para notas |
| PP-08 | Generar descripción con IA | Dialog abierto | 1. "Generar con IA" → tema. 2. Generar | Rellena la descripción (editable); gate IA aplica si async; sin tema → "Indica un tema…" |
| PP-09 | Video introductorio obligatorio | Interno | 1. Poner URL de video o elegir de biblioteca. 2. Guardar | Se persiste `code_intro_video_url`/`_id`; gatea la entrega de código en el alumno |
| PP-10 | Publicar notifica | Proyecto borrador interno | 1. Estado "Publicado". 2. Guardar | Notificación kind `project` (dispara correo) a los cursos vinculados |
| PP-11 | Quitar curso vinculado desasigna huérfanos | Proyecto multi-curso | 1. Editar → quitar un curso. 2. Guardar | Se borran assignments de alumnos que ya no pertenecen a ningún curso vinculado |
| PP-12 | Eliminar → Papelera | Proyecto existente | 1. Menú → Eliminar → confirmar | Soft-delete; invisible en lista/estudiante/calendario/gradebook; restaurable en `/app/trash` |
| PP-13 | Exportar CSV | ≥1 proyecto | 1. Menú Importar/Exportar → Exportar | Descarga CSV de la lista filtrada (no hay import de proyectos por diseño) |

**Checks UI/UX (PP):** responsive 375px; claro/oscuro; loading (ListSkeleton) + empty + ErrorState con "Reintentar"; toasts es-CO; StatCards (borradores/publicados/cerrados/externos) 2-col mobile/4-col desktop; fechas es-CO; orden (default Título asc) + paginación (25) + filtros (curso/corte/estado); touch targets ≥32px; `PageHeader` con conteo.

### PF — Archivos esperados del proyecto (editor Docente)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| PF-01 | Agregar archivo esperado (codigo_zip) | Proyecto → "Archivos" | 1. Tipo "Código completo (ZIP)". 2. Lenguaje + puntos + rúbrica. 3. Guardar | Slot creado; el alumno subirá ZIP/archivos de ese lenguaje |
| PF-02 | Alternar ZIP único / multi-archivo | Slot codigo_zip | 1. Toggle "modo ZIP único" | Se persiste `zip_single`; define si el alumno sube 1 .zip o N archivos sueltos |
| PF-03 | Otros tipos de entregable | Editor de archivos | 1. Crear tipos abierta/diagrama, etc. | Slots creados; conviven con el codigo_zip |
| PF-04 | Generar archivos con IA (regla 1+2-5) | Modo IA disponible | 1. Generar desde descripción | Genera 1 `codigo_zip` + 2-5 adicionales; async → encola |
| PF-05 | Reordenar / eliminar slots | ≥2 slots | 1. Flechas / eliminar | Cambia posición; elimina slot |

**Checks UI/UX (PF):** responsive 375px; claro/oscuro; loading/empty; toasts es-CO; touch targets ≥32px; HelpHint en whitelist de extensiones; se respeta que `max_files` no se envía en el payload (la cantidad sale de `project_files`).

### PS — Entrega de proyecto: repo + ZIP + código (Estudiante)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| PS-01 | Entregar con link a repo válido | Rol Estudiante; proyecto publicado asignado | 1. Abrir proyecto. 2. Responder + subir código. 3. Pegar URL `https://github.com/...`. 4. "Entregar" | Se crea la entrega; sube archivos a `project-files/<user\|group>/<sub>/<file>`; IA califica → `submission_grade`; `final_grade=null` con aviso "Falta sustentación" |
| PS-02 | Link a repo obligatorio | Proyecto con entrega | 1. Dejar URL vacía. 2. "Entregar" | Toast "El link al repositorio (GitHub o Drive) es obligatorio"; no entrega |
| PS-03 | Validación de URL | Entrega | 1. Poner "github.com/x" (sin http). 2. "Entregar" | Toast "Ingresa una URL válida (debe empezar con http:// o https://)" |
| PS-04 | ZIP único con extensión inválida | Slot codigo_zip `zip_single` | 1. Subir un archivo que no es `.zip`. 2. "Entregar" | Toast "el archivo no es un ZIP"; aborta SIN crear submission, sin subir, sin llamar a IA |
| PS-05 | ZIP único demasiado grande | Slot zip_single | 1. Subir .zip > límite. 2. "Entregar" | Toast de tamaño excedido; aborta sin efectos |
| PS-06 | ZIP con archivos fuera de whitelist | zip_single, lenguaje Java | 1. .zip con `.exe`/`.png`. 2. "Entregar" | preValidate detecta y bloquea; toast con detalle; no se guarda |
| PS-07 | Multi-archivo: extensión no permitida | Slot multi-archivo, lenguaje Python | 1. Subir `.java`. 2. "Entregar" | Toast "archivos no permitidos … permitidos: .py"; aborta sin efectos |
| PS-08 | Multi-archivo: excede conteo/tamaño | Multi-archivo | 1. Subir más de `MAX_CODE_FILES_COUNT` o superar bytes totales. 2. "Entregar" | Toast correspondiente; aborta sin efectos |
| PS-09 | Gate de video solo con pregunta de código | Proyecto con video intro + slot codigo_zip | 1. No ver video. 2. Entregar | Bloqueado hasta ver el video (el gate SOLO aplica si hay pregunta codigo_zip) |
| PS-10 | Confirmación con respuestas en blanco | Proyecto con varios slots | 1. Dejar ≥1 en blanco (URL y ZIP OK). 2. "Entregar" | Modal warning con las preguntas #N; confirmar entrega (0 pts a las vacías) o seguir respondiendo |
| PS-11 | Intentos agotados | `max_attempts=1`, entrega calificada | 1. Intentar re-entregar | Toast "Ya consumiste tus N intento(s)…"; bloqueado |
| PS-12 | Entrega grupal | Proyecto grupal, alumno en grupo | 1. Miembro A entrega. 2. Miembro B abre | B ve la entrega del grupo (por `group_id`); comparten nota; `group_required` sin grupo → bloqueado con mensaje |
| PS-13 | Revisión de entrega + descarga | Entrega hecha | 1. `/app/student/project/$id` | Muestra archivos entregados; descarga de código/ZIP vía signed URL (60s); estado y fecha de entrega es-CO |

**Checks UI/UX (PS):** responsive 375px (inputs de archivo y URL sin desbordar); claro/oscuro; loading al cargar; empty ("no tiene preguntas"); toasts es-CO con duración amplia en errores de archivo; StatusBadge; touch targets ≥32px; confirmación vía `useConfirm`; que las pre-validaciones NO tengan side effects (no fila en `project_submissions`, no upload, no IA) al fallar.

### PD — Calificación y sustentación de proyecto (Docente)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| PD-01 | Abrir modal + link a repo prominente | Proyecto con entregas | 1. Menú → Calificar | Acordeón por entrega; el `repository_url` se muestra con borde ámbar y aviso "verificar fechas vs entrega" |
| PD-02 | Recalificar un archivo con IA | Entrega expandida | 1. "Recalificar con IA" en un archivo | Actualiza `ai_grade`/`ai_feedback`/`ai_likelihood`+razones; recalcula `submission_grade` y (si hay factor) `final_grade` sin dejar valores stale |
| PD-03 | Recalificar todo con IA (bulk) | Varias entregas | 1. "Recalificar" masivo (respeta buscador) | Progreso X/Y visible; itera entregas × archivos |
| PD-04 | Sustentación: factor 0..1 y preview | Entrega con `submission_grade` | 1. En DefensePanel poner factor (ej. 0,8). 2. Observar preview | Preview muestra `final = submission_grade × 0,8`; input fuera de 0..1 → mensaje "factor debe estar entre 0 y 1", botón deshabilitado |
| PD-05 | Guardar sustentación | Factor válido | 1. Poner factor + notas. 2. "Guardar sustentación" | `final_grade = submission_grade × factor`; estado `calificado`; toast "Guardado · final: … (entrega X × sustentación Y)"; notifica al alumno/grupo |
| PD-06 | Sin sustentación = Falta sustentación | Entrega calificada por IA, factor null | 1. Observar header de la entrega | Muestra `submission_grade` con indicador; `final_grade=null`; alumno ve "Falta sustentación" |
| PD-07 | Reabrir entrega | Entrega calificada | 1. "Reabrir entrega" → confirmar | Limpia `ai_grade`/`submission_grade`/`defense_factor`/`defense_notes`; vuelve a `entregado`; queda auditado |
| PD-08 | Importar sustentaciones por CSV (bulk) | Proyecto con entregas | 1. "Importar sustentaciones" → CSV | Aplica factor/notas por estudiante en lote |
| PD-09 | Panel de fraude por archivo | Entrega con señal IA | 1. Expandir FraudPanel | Muestra `ai_likelihood ≥ 0.6` + razones + copia entre estudiantes |
| PD-10 | Nota grupal a todos los miembros | Entrega grupal calificada | 1. Guardar sustentación | Notificación de calificación a CADA miembro del grupo |
| PD-11 | Deep-link a proyecto inexistente | URL `?project=<borrado>` | 1. Navegar | Toast "El proyecto referenciado… ya no existe o no tienes acceso"; limpia URL |

**Checks UI/UX (PD):** responsive 375px; claro/oscuro; loading/empty; error IA visible (preview + expandible + Copiar); toasts es-CO; DecimalInput con coma para nota de entrega y factor; touch targets ≥32px; buscador con conteo filtrado; acordeón y preview de nota legibles en ambos temas.

### GR — Grupos: teacher_assigned y modo mixto (Docente)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| GR-01 | Activar grupos con un clic | Taller/Proyecto interno `individual` | 1. Grid → "Activar grupos" (icono UsersRound) | Cambia a `teacher_assigned` automáticamente; toast "grupo activado"; abre el editor de grupos |
| GR-02 | Crear grupo + drag & drop | Editor de grupos abierto | 1. Crear grupo. 2. Arrastrar alumno de "Sin grupo" al grupo | Alumno se mueve; ring visual en drop target; queda como miembro |
| GR-03 | Un alumno no puede estar en 2 grupos | Alumno ya en un grupo | 1. Arrastrarlo a otro grupo del mismo taller | Se mueve (trigger impide pertenencia doble en el mismo taller/proyecto) |
| GR-04 | Modo mixto coexiste | Grupos activos + alumnos sin grupo | 1. Ver lista del estudiante para ambos casos | Con grupo → entrega/nota compartida; sin grupo → entrega individual, sin bloqueos |
| GR-05 | Externo no expone grupos | Actividad externa | 1. Abrir el form | Toggle de grupo oculto; `group_mode=individual` forzado |

**Checks UI/UX (GR):** responsive 375px (columnas de grupos apilan); claro/oscuro; loading/empty ("sin grupos"); toasts es-CO; touch targets ≥32px; drag & drop nativo con feedback visual accesible.

### NX — Notas de actividades externas (ExternalGradesEditor)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| NX-01 | Registrar nota externa individual | Taller/Proyecto `is_external`, curso con matriculados | 1. Abrir editor de notas externas. 2. Poner nota a un alumno. 3. "Guardar" (fila) | Crea/actualiza `workshop_submissions.final_grade`/`project_submissions.final_grade` con estado `calificado`; icono de check verde |
| NX-02 | Escala = escala del curso | Curso escala 0..5 | 1. Observar el tope del input | El máximo es `grade_scale_max` del curso (no `max_score` del item); un "5" no se interpreta como 5/100 |
| NX-03 | Validación de nota fuera de rango | Editor abierto | 1a. Nota negativa. 1b. Nota > máximo | Toast de error correspondiente (negativa / supera el máximo); no guarda esa fila |
| NX-04 | Guardar todo (solo filas modificadas) | Varias filas editadas | 1. "Guardar todo (N)" | Guarda solo las dirty; toast con conteo ok/fallidas; filas vacías sin cambios se saltan |
| NX-05 | Observación por estudiante | Editor abierto | 1. Escribir observación + nota. 2. Guardar | Persiste en `teacher_feedback` |
| NX-06 | Buscar estudiante | ≥1 matriculado | 1. Buscar por nombre/correo | Filtra la grilla; "Guardar todo" sigue operando sobre todas las filas; botón limpiar |
| NX-07 | Curso sin matriculados | Curso vacío | 1. Abrir editor | Empty state "sin estudiantes" |

**Checks UI/UX (NX):** responsive 375px (columna Observación `hidden sm:table-cell`, tabla scrollea en el Card); claro/oscuro; loading (TableSkeleton) + empty; toasts es-CO (`friendlyError`); DecimalInput con coma; badge "calificados/total"; touch targets ≥32px; búsqueda con conteo filtrado.

### AT — Aislamiento por tenant y soft-delete (transversal)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| AT-01 | RLS de talleres/proyectos por tenant | Datos en Demo Global Corp y otro tenant | 1. Consultar/listar como docente de Demo Global Corp | Solo se ven talleres/proyectos de su tenant; ninguno de otra institución |
| AT-02 | RLS de tablas hijas | Preguntas/archivos/grupos/entregas de otro tenant | 1. Intentar leer `workshop_questions`/`project_files`/grupos/submissions ajenas por REST | Sin acceso (scoping por `course_in_my_tenant`/helpers); nada visible de otro tenant |
| AT-03 | Soft-delete invisible en TODO flujo | Taller/Proyecto enviado a papelera | 1. Revisar lista estudiante, calendario, agenda del dashboard, gradebook, ICS | La entidad NO aparece en ningún flujo ni rol hasta restaurarse |
| AT-04 | Restaurar desde Papelera | Item en papelera dentro del TTL | 1. `/app/trash` → Restaurar | Vuelve a estar visible/usable en todos los flujos |
| AT-05 | Cálculo de nota: score null cuenta como 0 | Corte con talleres/proyectos, alumno sin entregar | 1. Ver notas del estudiante/gradebook | El item sin nota computa 0 con su peso original (no se reescala); "—" solo si NINGÚN item del set tiene score |
| AT-06 | Bucket por tipo respeta el corte | Corte con `workshop_weight`/`project_weight`/pesos por ítem | 1. Verificar consolidado del corte | La suma por tipo no excede el bucket; la nota del corte = weighted avg correcto |

**Checks UI/UX (AT):** verificación empírica con la cuenta multi-rol (Admin/Docente/Estudiante) alternando con el role-switcher; toasts de error en español; badges de "días restantes" en Papelera colorados (rojo ≤3d, ámbar ≤7d); sin fugas cross-tenant en filtros/paginación (un `.in()` con lista vacía NO debe devolver todo).

---

## Calificaciones/gradebook, asistencia (QR) y certificados

Sección de pruebas funcionales para el módulo de notas consolidadas del docente, la vista de notas del estudiante, el motor de cálculo ponderado (`computeWeightedGrade`), asistencia con self check-in por QR rotativo (TOTP-like), certificados con verificación pública y snippets de código por sesión. Ejecutar como el usuario multi-rol de **Demo Global Corp**, cambiando de rol con el selector del sidebar.

Regla de negocio transversal verificada en todos los casos: **paridad docente ↔ estudiante ↔ certificado** (los tres consumen el mismo consolidado) y **soft-delete invisible** (nada en papelera / borrador debe pesar en ningún cálculo o vista).

---

### Módulo 1 — Gradebook docente (`/app/teacher/gradebook`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|-------------|-------|--------------------|
| GB-01 | Carga del consolidado por corte | Rol Docente; curso con ≥2 cortes, exámenes/talleres/proyectos y estudiantes matriculados | 1. Entrar a Gradebook. 2. Seleccionar el curso en el `Select` | Aparecen tarjetas/tabla con una columna de nota por corte (con su `%`) + columna Nota final. Cada fila = un estudiante ordenado por nombre |
| GB-02 | Cambio de curso recarga datos | Curso A cargado | Cambiar el `Select` al curso B | La grilla, columnas, estudiantes y notas se recargan para el curso B; `edits` pendientes se descartan |
| GB-03 | Exámenes en borrador NO cuentan | Curso con 1 examen `status='draft'` con peso asignado | Abrir Gradebook del curso | El examen en borrador no aparece como columna ni arrastra la nota final hacia abajo (paridad con la vista del estudiante) |
| GB-04 | Item en papelera invisible | Taller soft-deleted (papelera) con peso | Abrir Gradebook | El taller no aparece como columna ni afecta ninguna nota |
| GB-05 | Taller compartido (secundario) visible con cut_id/weight del curso | Taller compartido a 2 cursos vía `workshop_courses`, con corte/peso distintos por curso | Abrir Gradebook en el curso secundario | El taller aparece como columna con el `cut_id`/`weight` **de este curso** (no el legacy global) |
| GB-06 | Entrega grupal se refleja para todos los miembros | Taller/proyecto en modo grupo; 1 miembro editó la entrega | Ver la fila de OTRO miembro del grupo | La nota grupal aparece para todos los miembros (resuelta por `group_id`, no solo por el "último editor") |
| GB-07 | Exámenes con `retry_mode` | Examen con `retry_mode='highest'` y 2 intentos del alumno | Ver la nota consolidada del examen | Se usa `computeAttemptGrade` según el modo (highest/last/average) — no un intento arbitrario |
| GB-08 | Recuperación (parent_exam_id) como fallback | Alumno sin intento en el examen original pero con entrega en la recuperación | Ver la celda del examen | Toma la nota de la recuperación; en export se marca con el sufijo de habilitación |
| GB-09 | Editar nota de examen inline y guardar | Examen con entrega existente | 1. Editar la celda (`DecimalInput`, coma decimal). 2. Clic en **Guardar** | Toast "N calificación(es) guardada(s)"; `final_override_grade` persistido; audit `grade.manual_override`; grilla recargada |
| GB-10 | Editar nota de taller inline | Taller con entrega existente | Editar celda y **Guardar** | `workshop_submissions.final_grade` actualizado + `status='calificado'` |
| GB-11 | Guardar sin cambios | Sin ediciones pendientes | Clic en **Guardar** | Toast informativo "No hay cambios para guardar" (sin escritura) |
| GB-12 | Editar celda sin entrega existente | Alumno sin submission en ese item | Escribir nota y **Guardar** | Cuenta como error: toast "N error(es) — solo se pueden editar entregas existentes" |
| GB-13 | Proyecto no editable inline | Proyecto con entrega | Intentar editar la celda de proyecto y guardar | La celda de proyecto es read-only (no trae `subId`); si se fuerza, entra al conteo de errores |
| GB-14 | Valor no numérico | — | Escribir texto en una celda editable y **Guardar** | Se cuenta como error, no rompe el batch de los válidos |
| GB-15 | Export CSV | Estudiantes + columnas presentes | **Exportar → CSV** | Descarga `.csv` con Nombre, (Cohorte si aplica), emails, item por item con `%`, notas por corte, Nota final; toast "Archivo exportado" |
| GB-16 | Export XLSX con fila de grupo por corte | Curso con items asignados a cortes | **Exportar → XLSX** | Descarga `.xlsx`; encabezado en negrita+gris, fila de grupo "Corte N (peso%)" con celdas combinadas contiguas, notas de corte/final/asistencia pintadas verde/rojo según `passing_grade` |
| GB-17 | XLSX: columnas de item crudas NO se colorean | Taller con `max_score=100`, nota cruda 40 | Exportar XLSX | La columna de item (crudo "40") NO se pinta verde/rojo (solo se colorean columnas en la escala del curso: asistencia por corte, cortes y final) |
| GB-18 | Export respeta lista completa aunque haya filtro de búsqueda | Filtro de estudiante activo en pantalla | Exportar CSV | El archivo incluye a TODOS los estudiantes (no solo los filtrados en pantalla) |
| GB-19 | Agrupación por cohorte en export | ≥1 estudiante con `cohorte` | Exportar | Aparece columna Cohorte (2ª) y las filas se agrupan por cohorte (orden es-CO, sin cohorte al final) |
| GB-20 | Columna de asistencia solo si `attendance_weight>0` | Corte con `attendance_weight=0` | Exportar | No se agrega columna "Asistencia (0%)" espuria para ese corte |
| GB-21 | Filtro de búsqueda de estudiantes | Curso con muchos alumnos | Escribir nombre/email en el buscador | Se filtra el consolidado en pantalla; totales del header y export usan la lista completa |
| GB-22 | Consolidado con item sin score = 0 | Alumno con 1 examen sin entregar (peso >0) | Ver su nota final | El examen sin nota cuenta como 0 con su peso original (NO se reescala); la final baja acorde |
| GB-23 | Modal "Ver detalle" por corte | Corte con varios items | Clic en el ícono ojo del corte | Abre modal con los items del corte; desde ahí el ojo por fila abre el detalle por estudiante |
| GB-24 | Emitir certificado individual (aprobado) | Alumno con final ≥ `passing_grade`, sin cert vigente | Clic en **Emitir** en su fila | RPC `issue_certificate`; toast "Certificado emitido"; badge de certificado se refresca |
| GB-25 | Emitir bloqueado si reprueba | Alumno con final < `passing_grade` | Intentar **Emitir** | Toast "La nota final es menor al mínimo de aprobación"; no se emite |
| GB-26 | Regenerar certificado | Alumno con cert vigente | Clic **Regenerar** → confirmar (tono warning) | Revoca el vigente (`revoke_certificate`) + emite uno nuevo con la nota actual; toast "Certificado regenerado" |
| GB-27 | Regenerar sin cert vigente | Alumno aprobado sin cert | Clic **Regenerar** | Toast informativo "No hay certificado vigente para regenerar — usa Emitir" |
| GB-28 | Emisión masiva | Varios aprobados sin cert | **Emitir certificados** → confirmar | Emite solo a los aprobados sin cert; toast "Emitidos N (· M fallaron)" |
| GB-29 | Emisión masiva sin pendientes | Todos los aprobados ya tienen cert | **Emitir certificados** | Toast "Sin estudiantes pendientes: todos los aprobados ya tienen certificado" |
| GB-30 | Generar y descargar ZIP | Aprobados en el curso | **Generar y descargar** → confirmar | Emite pendientes + descarga ZIP con todos los vigentes (no re-emite los ya emitidos) |
| GB-31 | Regenerar todos (ZIP) | Aprobados con certs | **Regenerar todos** → confirmar | Revoca y re-emite todos los aprobados (snapshot nuevo: logo/firma/nota) + ZIP |
| GB-32 | Aislamiento por tenant (RLS) | Curso de Demo Global Corp | Verificar que solo aparecen cursos/estudiantes/entregas del tenant activo | Ningún dato de otra institución es visible ni exportable |
| GB-33 | Estado de error de carga | Simular fallo de query (p.ej. sin conexión) | Recargar | Se muestra `<ErrorState>` con "Reintentar" (no una tabla vacía ambigua); reintentar recarga |

**Checks UI/UX (Gradebook):**
- Responsive 375px: la tabla ancha hace scroll horizontal **dentro** del Card (nunca la página); columnas secundarias ocultas en `<sm`.
- Modo claro/oscuro: verde/rojo de aprobado/reprobado y badges legibles en ambos temas.
- Estados loading (`Spinner`/skeleton) / empty (curso sin datos) / error (`ErrorState` con Reintentar).
- Toasts en español vía `friendlyError` (nunca mensajes SQL crudos en inglés).
- Touch targets de acciones (ojo, Emitir/Regenerar) ≥32px.
- Fechas es-CO; notas con coma decimal en inputs (`DecimalInput`) y `tabular-nums` en columnas numéricas.
- Filtro de búsqueda y (para SuperAdmin) filtro por institución con `Limpiar`.
- Accesibilidad: `RowAction`/menús con `aria-label`; encabezados de tabla asociados.

---

### Módulo 2 — Vista de notas del estudiante (`/app/student/grades`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|-------------|-------|--------------------|
| NA-01 | Carga de notas por corte | Rol Estudiante matriculado con notas | Entrar a Calificaciones | Tarjetas resumen (una por corte + Nota final), escala del curso, y detalle por corte agrupado por tipo (Talleres/Exámenes/Proyectos/Asistencia) |
| NA-02 | Selector de curso | Alumno en ≥2 cursos | Cambiar el `Select` de curso | Recarga notas del curso elegido; ordena cursos por periodo desc + nombre |
| NA-03 | No matriculado | Alumno sin cursos | Entrar | Mensaje "No estás matriculado…" (empty state), sin error |
| NA-04 | Nota final = weighted avg (null=0) | Alumno con 1 taller entregado (5.0) y 1 examen sin entregar (peso >0) | Ver Nota final | El examen sin nota cuenta como 0 con su peso; final < 5.0. Card de aprobación en verde/rojo según `passing_grade` |
| NA-05 | Card de corte muestra promedio de lo calificado (skip null) | Corte con items pendientes | Ver el número grande del card de corte | El card muestra el promedio SOLO de lo ya calificado (no penaliza con 0 los pendientes) — a diferencia de la Nota final global |
| NA-06 | Asistencia sin sesiones NO deflacta la final | Corte con `attendance_weight>0` pero sin sesiones asignadas | Ver Nota final | La fila de asistencia se muestra ("sin sesiones registradas") pero se OMITE del cálculo final (paridad con gradebook/certificado) |
| NA-07 | Asistencia con sesiones | Corte con sesiones y records | Ver fila Asistencia | Muestra "N/T sesiones" y nota escalada `min + pct*(max-min)`; `tarde` cuenta como presente |
| NA-08 | Actividad externa (`is_external`) en escala del curso | Taller externo con nota ingresada | Ver su fila | La nota se toma ya en escala del curso (no se re-escala por `max_score`); columna Puntaje normalizada a la escala |
| NA-09 | Paridad con el docente | Curso ya cargado en gradebook | Comparar Nota final del alumno vs consolidado docente | Coinciden exactamente (mismo item set, mismos pesos, mismo trato de null e items sin corte) |
| NA-10 | Draft/papelera invisibles | Examen borrador + taller en papelera con peso | Ver notas | No aparecen ni afectan la final (mismo criterio que el docente) |
| NA-11 | Items sin corte asignado | Item con `cut_id=null` y peso | Ver | Aparecen en card "Sin corte asignado" y SÍ entran a la Nota final (paridad con gradebook/certificado) |
| NA-12 | Link "Ver detalle" de examen | Examen con intento finalizado | Clic en el ícono de detalle | Navega a `/app/student/review/$examId` con params correctos (navegación TanStack, no URL interpolada) |
| NA-13 | Link "Ver detalle" de taller | Taller con entrega | Clic en detalle | Navega a `/app/student/workshop/$workshopId` |
| NA-14 | Entrega grupal visible para todos | Alumno miembro de grupo (no fue el editor) | Ver la nota del taller/proyecto grupal | Ve la nota grupal (fusión por `group_id`, grupal precede a individual) |
| NA-15 | Sin ninguna nota | Alumno recién matriculado | Ver | Nota final "—" (no "0"); estado "Sin calificaciones" |
| NA-16 | Error de carga | Fallo de query | Recargar | `<ErrorState>` con Reintentar (bumpea `retryNonce`), no tabla vacía |

**Checks UI/UX (Notas estudiante):**
- Responsive 375px: grid de cards `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`; mini-tablas con scroll interno.
- Claro/oscuro: card de aprobación (verde/rojo) y `StatusBadge` legibles.
- Loading (`TableSkeleton`), empty (no matriculado / sin cortes), error (`ErrorState`).
- Toasts/errores en español (`friendlyError`).
- Fechas es-CO en rangos de corte; `tabular-nums` en notas.
- Accesibilidad: `RowAction asChild` con `Link` para detalle; badges con texto.

---

### Módulo 3 — Cálculo ponderado (motor `src/modules/grading/grade.ts`)

Validación funcional del núcleo de notas (verificable end-to-end en pantalla y contra el suite `bun test`).

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|-------------|-------|--------------------|
| CP-01 | `computeWeightedGrade`: null cuenta como 0 sin reescalar | Set de items con score y con null | Comparar nota | Los null suman 0 con su peso original; el total pondera sobre TODOS los pesos (no solo los con score) |
| CP-02 | Devuelve null si NINGÚN item tiene score | Todos los scores null | — | Retorna `null` → UI muestra "—", no 0 |
| CP-03 | Ignora peso 0 | Item con `weight=0` | — | No participa; si todos son peso 0 → null |
| CP-04 | Redondeo a 2 decimales | Notas que dan >2 decimales | — | Resultado a 2 decimales |
| CP-05 | `computeCutGrade`: componentes null = 0 | Corte con exam=null, workshop=4.0, pesos definidos | — | El componente null pesa 0; retorna null solo si todos los componentes son null |
| CP-06 | `computeCourseFinalGrade`: cortes null = 0 | Corte con grade null y peso | — | El corte null cuenta 0 con su peso; null solo si todos los cortes son null |
| CP-07 | `countsAsPresent`: presente y tarde | Records con distintos status | — | `'presente'` y `'tarde'` → true; `'ausente'`, `'justificado'`, null → false |
| CP-08 | Consistencia de etiqueta de tardanza (edge case) | Record con status `'tardanza'` (UI del alumno usa esa etiqueta) vs helper que valida `'tarde'` | Verificar si una tardanza cuenta como presente en la nota | Confirmar el valor de status realmente persistido y que gradebook, `app.student.grades` y el acta SQL coincidan; reportar cualquier divergencia `'tarde'`/`'tardanza'` |
| CP-09 | `scaleAttendance` usa min | Escala 1–5, 80% presente | — | Resultado = `1 + 0.8*(5-1)` (respeta el min; no `pct*max`) |
| CP-10 | Invariante cross-file de asistencia | — | Comparar `countsAsPresent` con `generate_course_acta` (SQL) y `report-context.ts` | Los tres cuentan presente = `('presente','tarde')` |
| CP-11 | Nota final ≠ promedio de cortes | Curso con items en varios cortes | Comparar final calculada vs promediar notas de cortes | La final se calcula sobre TODOS los items+asistencias (evita doble redondeo/reescala) |

**Checks UI/UX (Cálculo):** N/A visual directo — validar reflejo consistente en gradebook, notas del alumno, acta/boletín y snapshot del certificado (mismo número en los cuatro).

---

### Módulo 4 — Asistencia: self check-in con QR rotativo

Docente proyecta el QR/código (`AttendanceCheckInProjector`), el estudiante se marca solo (`AttendanceQRScanner` + código manual). Código TOTP-like: `sha256(seed:period)[:7hex] % 1e6`, padding 6 dígitos.

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|-------------|-------|--------------------|
| AS-01 | Abrir check-in (docente) | Rol Docente en `/app/teacher/attendance`, sesión creada | Iniciar check-in con duración + rotación desde el dialog | RPC `teacher_open_attendance_check_in`; se abre el proyector; `check_in_open=true` |
| AS-02 | Validación de parámetros | Dialog de check-in | Duración fuera de 1–240 min o rotación fuera de 15–600 s | El campo acota/rechaza el valor fuera de rango |
| AS-03 | Proyector: QR + código + rotación | Check-in abierto | Observar el proyector | QR grande (deep-link `?session=&code=`), código "123 456", barra "rota en N s", countdown de cierre |
| AS-04 | Rotación del código | Proyector abierto | Esperar a que pase un período de rotación | El código y el QR cambian automáticamente al nuevo período (recalculado en cliente, sin llamar al server) |
| AS-05 | Contador de presentes en vivo | Proyector abierto | Marcar a un alumno desde otra sesión/dispositivo | El contador "X / Y" sube en tiempo real (canal realtime sobre `attendance_records`) |
| AS-06 | Pantalla completa | Proyector | Clic **Pantalla completa** / **Salir de pantalla completa** | Alterna Fullscreen API sin cerrar el check-in |
| AS-07 | Cerrar check-in | Proyector abierto | Clic **Cerrar check-in** | RPC de cierre; sale de fullscreen; luego confirm "marcar pendientes como ausentes" |
| AS-08 | Marcar pendientes ausentes | Cierre de check-in | Confirmar el diálogo (tono warning) | RPC `teacher_mark_pending_absent`; toast "N estudiante(s) marcado(s) como ausentes"; grilla recargada |
| AS-09 | No marcar ausentes | Cierre de check-in | Cancelar el confirm | No se marca a nadie; check-in queda cerrado |
| AS-10 | Auto-cierre por expiración | Ventana a punto de vencer | Dejar correr hasta `closes_at` | Toast "La ventana de check-in expiró"; se cierra la DB (`check_in_open=false` + delete state) y el overlay — sin loop al reabrir |
| AS-11 | Estudiante escanea QR | Rol Estudiante, sesión con check-in abierto, matriculado | Card "Check-in de asistencia disponible" → **Escanear QR** → escanear | RPC `student_check_in_attendance`; toast "¡Marcado como presente!"; la card desaparece |
| AS-12 | Código manual | Check-in abierto | **Tengo el código** → escribir 6 dígitos → **Marcar presente** | Marca presente; acepta espacios ("123 456") que se limpian |
| AS-13 | Validación de formato de código | Dialog manual | Escribir <6 o >6 dígitos / letras | Toast "El código debe tener 6 dígitos"; input bloquea no-numéricos |
| AS-14 | Gracia de rotación (período anterior) | Código generado, rotación justo ocurrida | Enviar el código del período inmediatamente anterior | El server acepta el período actual **y el anterior** (gracia) |
| AS-15 | Código inválido/expirado | Check-in abierto | Enviar un código incorrecto | Error mapeado a español (`invalid_code` → mensaje es-CO), no marca presente |
| AS-16 | Check-in cerrado | Sesión con check-in cerrado | Enviar código | Error `check_in_closed` en español |
| AS-17 | No matriculado | Alumno no inscrito al curso de la sesión | Enviar código válido | Error `not_enrolled` en español |
| AS-18 | Sesión inexistente | session id inválido | Enviar | Error `session_not_found` |
| AS-19 | Deep-link auto check-in | QR abierto con cámara nativa → `/app/student/attendance?session=&code=` | Abrir el enlace estando logueado | Auto check-in; la URL se limpia (`history.replaceState`); card se refresca |
| AS-20 | Doble detección evitada (scanner) | Scanner escaneando (fps 10) | Mantener el QR frente a la cámara | Un solo `onDetected` / un solo toast (guard `detectedRef`) |
| AS-21 | Cámara denegada | Permiso de cámara bloqueado | Abrir el scanner | Mensaje de error de cámara en español (no `NotAllowedError` crudo); fallback manual disponible |
| AS-22 | Sesión ya marcada oculta la card | Alumno ya con record (por QR o marcado por docente) | Ver la vista de asistencia | La card "Check-in disponible" y el QR NO aparecen para esa sesión |
| AS-23 | Seed nunca llega al cliente del alumno | — | Inspeccionar payloads de red del estudiante | La `seed` de `attendance_check_in_state` no se expone (RLS docente-only); solo el server valida |
| AS-24 | Stats de asistencia del alumno | Sesiones con records | Ver los 4 stats | Sesiones, Presentes, Ausencias, % asistencia (sobre registradas); "—" si sin registradas |

**Checks UI/UX (Asistencia/QR):**
- Responsive 375px: proyector con QR que se ajusta por ancho y alto (no se sale en portrait); botones del top-bar colapsan texto en móvil.
- Claro/oscuro: overlay con `bg-background`/`text-foreground`; barra de rotación con `--primary` del tenant.
- Estados loading (activando cámara, `Spinner`), empty ("El docente aún no ha marcado…"), error (cámara / error de carga con Reintentar).
- Toasts en español (`friendlyError` + mapa `CHECK_IN_ERROR_MESSAGES`).
- Touch targets: botones "Escanear QR" / "Tengo el código" / "Marcar presente" ≥32px; input de código con hit zone amplia.
- Fechas es-CO (`formatDateOnly`, sin bug UTC -1).
- Accesibilidad: `aria-label` en botones fullscreen/cerrar; input numérico `inputMode="numeric"`.

---

### Módulo 5 — Certificados (`/app/certificates` + verificación pública `/verify/$shortCode`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|-------------|-------|--------------------|
| CE-01 | Listado por rol (RLS) | Rol Docente / Admin | Entrar a Certificados | Docente ve los de sus cursos (`course_teachers`); Admin ve los del tenant; sin filtro `user_id` manual |
| CE-02 | Descargar PDF | Cert emitido | Menú de fila → **Descargar PDF** | Descarga el PDF con snapshot (logo/firma/mensaje/nota) |
| CE-03 | Copiar enlace de verificación | Cert emitido | Menú → **Copiar enlace de verificación** | Copia `/verify/<short_code>`; toast "Link de verificación copiado" |
| CE-04 | Abrir verificación pública | Cert emitido | Menú → **Abrir verificación pública** | Abre `/verify/<short_code>` (nueva pestaña/`href`) |
| CE-05 | Revocar certificado | Cert vigente | Menú → **Revocar** → escribir motivo (opcional) → confirmar (destructive) | RPC `revoke_certificate`; toast "Certificado revocado"; fila marcada, badge "Revocado", motivo visible |
| CE-06 | Cancelar prompt de revocación | Cert vigente | En el `prompt` de motivo, cancelar | No se revoca (prompt null aborta) |
| CE-07 | Acción Revocar oculta si ya revocado | Cert revocado | Abrir menú de fila | La opción "Revocar" no aparece |
| CE-08 | Filtro "Mostrar/Ocultar revocados" | Mezcla vigentes+revocados | Toggle **Mostrar revocados** | Alterna la visibilidad de revocados; por defecto ocultos |
| CE-09 | Filtro por curso + búsqueda | Certs de varios cursos | Usar `Select` de curso y buscador (nombre/código/identificación) | Filtra la lista; botón **Limpiar** resetea; contador "N / total" |
| CE-10 | Orden y paginación | >25 certs | Ordenar por columnas (`SortableHead`) + paginar | Orden es-CO estable; paginación persiste (25 por página); vacíos al final |
| CE-11 | Filtro por institución (SuperAdmin) | Rol SuperAdmin, ≥1 tenant | Seleccionar institución | Query 2-step (course_ids del tenant → `.in('course_id', ids)`); tenant sin cursos → lista vacía (NO todos) |
| CE-12 | Verificación pública — VÁLIDO | Cert vigente | Abrir `/verify/<code>` sin login | Card verde "Válido" con estudiante, curso, nota (`X.XX / max`), fecha (es-CO, `formatDateLong`), docentes, institución, código. Sin botón "Descargar PDF" |
| CE-13 | Verificación pública — REVOCADO | Cert revocado | Abrir `/verify/<code>` | Card roja "NO VÁLIDO / revocado" con motivo y fecha de revocación |
| CE-14 | Verificación pública — NO ENCONTRADO | Código inexistente | Abrir `/verify/XXXX` | Card "No encontrado" con el código mostrado |
| CE-15 | QR del PDF apunta a verificación | Cert descargado | Escanear el QR del PDF | Abre `/verify/<code>` con el resultado correcto |
| CE-16 | Emisión bloqueada bajo aprobación | Alumno reprobado | Emitir (desde Gradebook) | Rechazado (ver GB-25); nunca aparece cert de un reprobado en el listado |
| CE-17 | `noindex` en página pública | — | Inspeccionar `<head>` de `/verify/<code>` | Meta `robots: noindex, nofollow` presente |
| CE-18 | Aislamiento por tenant | Cert de otra institución | Como Docente/Admin de Demo Global Corp, buscarlo | No es visible en el listado (RLS) |

**Checks UI/UX (Certificados):**
- Responsive 375px: tabla con columnas progresivas (`hidden sm/md/lg:table-cell`); datos clave (curso/nota) inline en móvil; scroll dentro del Card.
- Claro/oscuro: cards de verify (verde/rojo/destructive) legibles en ambos temas.
- Estados loading (`Spinner`/`PageLoader`), empty (`TableEmpty` distinto para "sin certs" vs "sin resultados"), error (`ErrorState` + Reintentar).
- Toasts en español (`friendlyError`).
- Touch targets: `RowActionsMenu` (tres puntos) ≥32px.
- Fechas es-CO; `short_code` en `code`/monoespaciado; nota `tabular-nums`.
- Accesibilidad: menús con labels; página pública navegable sin auth.

---

### Módulo 6 — Snippets de código por sesión (`SessionCodeSnippets` / `SessionCodeSnippetsDialog`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|-------------|-------|--------------------|
| SC-01 | Docente crea snippet | Rol Docente en `/app/teacher/attendance`, sesión creada | Abrir "Snippets de código" → **Nuevo/Agregar** → título, lenguaje (java/python/javascript), código | Snippet persistido en `session_code_snippets`; autosave debounced (~1.5s) |
| SC-02 | Multi-archivo | Snippet creado | Agregar ≥2 archivos en la tab bar | Se guardan todos; al ejecutar Java la clase con `main` se deriva server-side |
| SC-03 | Ejecutar (docente) | Snippet con código válido | Clic **Run** | Llama edge `execute-code`; muestra stdout/stderr/exit y cachea en `last_*` |
| SC-04 | Compartir snippets con alumnos | Snippets creados | Activar el compartir de código (`code_shared=true`) | El botón "Código" aparece en la vista del alumno |
| SC-05 | Alumno ve snippets (read-only) | `code_shared=true`, alumno matriculado | En `/app/student/attendance` → **Código** en la fila de sesión | Dialog read-only: puede ver y ejecutar, NO editar/agregar/eliminar |
| SC-06 | Alumno ejecuta sin persistir | Alumno en dialog read-only | Clic **Run** | Ejecuta y muestra salida local; NO persiste en `last_*` |
| SC-07 | Botón "Código" oculto sin compartir | `code_shared=false` | Ver la fila de sesión del alumno | El botón "Código" NO aparece (RLS exige `code_shared=true`) |
| SC-08 | Snippets en papelera invisibles | Sesión soft-deleted | Vista del alumno | La sesión y sus snippets no aparecen |
| SC-09 | Sin snippets | Sesión compartida pero vacía | Abrir el dialog (alumno) | Mensaje friendly "sin snippets", no dialog vacío |
| SC-10 | Backward-compat legacy | Snippet solo con `source_code` (sin `session_snippet_files`) | Abrir | Se muestra como único archivo derivado de `source_code` |
| SC-11 | Aislamiento RLS | Snippet de curso de otro tenant | Como alumno de Demo Global Corp | No visible (RLS por matrícula/curso) |

**Checks UI/UX (Snippets):**
- Responsive 375px: editor Monaco y tab bar sin desbordar el dialog (`max-w-[calc(100vw-2rem)]`, `dvh`).
- Claro/oscuro: editor y salida (stdout/stderr) legibles.
- Estados loading (`Spinner` al cargar/ejecutar), empty (sin snippets), error (`friendlyError` en fallo de `execute-code`).
- Toasts en español.
- Touch targets ≥32px en Run/Agregar/Eliminar/Copiar.
- Fechas es-CO (`formatTime` de última ejecución).
- Accesibilidad: badges de lenguaje con texto; botones con label/ícono.

---

## Contenidos, pizarras, videos, Tutor IA y Asistente de plataforma

Alcance: generación y carga de material didáctico (IA + externo con carpeta recursiva), visor/editor de imagen y PDF, ejecución de código/notebooks, pizarras Excalidraw (privadas y compartidas en vivo), biblioteca de videos, Tutor IA por curso (alumno) y Asistente IA de plataforma (todos los roles). Tenant de pruebas: **Demo Global Corp**. El usuario `test-demo-global-corp@examlab.test` tiene los 3 roles; se alterna con el selector de rol del sidebar.

### 1. Contenidos — Generar con IA (`/app/teacher/contents` · rol Docente)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| CONT-01 | Crear contenido individual (happy path, modo sync) | Rol Docente; `processing_mode=sync` | Clic "Nuevo contenido" → nombre único, tema, modo "Material individual", tags Teórico+Práctico, curso destino → confirmar gate IA → "Crear" | Toast de creación en español; fila aparece con estado `queued`; polling cada 5s la lleva a `processing` → `done` sin recargar manualmente |
| CONT-02 | Crear "Curso completo" con N clases | Igual | Modo "Curso completo", N clases = 8, duración 60 | Se genera material con sufijos `_CLASE_<N>`; al abrir "Ver archivos por clase" quedan agrupados por sesión |
| CONT-03 | Validación: nombre único requerido | Dialog abierto | Dejar nombre vacío → "Crear" | Toast "Indica un nombre único para este contenido."; no inserta |
| CONT-04 | Validación: nombre > 120 caracteres | — | Nombre de 121+ chars → "Crear" | Toast "El nombre es demasiado largo (máx 120 caracteres)." |
| CONT-05 | Validación: tema requerido | — | Nombre OK, tema vacío → "Crear" | Toast de error; no inserta |
| CONT-06 | Validación: al menos un tag | — | Desmarcar los 3 tags → "Crear" | Toast "tags requerido"; no inserta |
| CONT-07 | Nombre duplicado (23505) | Existe un contenido con nombre X del mismo docente | Crear otro con nombre X | Toast `Ya tienes un contenido llamado "X". Usa un nombre distinto.` (no error SQL crudo) |
| CONT-08 | Modo async → encola en Cola IA | `processing_mode=async`, sin código de IA inmediata | Crear contenido → gate ofrece encolar | Toast "Generación encolada… Puedes verla en Cola IA → Generaciones"; NO se crea fila `queued` fantasma en el listado |
| CONT-09 | Duración: entrada multidígito no se corrompe | Dialog abierto | Teclear "185" en duración y hacer blur | Valor persiste clamp a rango válido (10–480); "185" no queda mutilado a "400"/"18" |
| CONT-10 | Publicar / despublicar (notifica al curso) | Contenido `done`, borrador, con curso | Cambiar selector de estado a "Publicado" | Toast "Contenido publicado. Los alumnos del curso recibirán notificación."; badge/estado cambia; el alumno del curso lo ve. Volver a "Borrador" → toast "despublicado" y el alumno deja de verlo |
| CONT-11 | Regenerar contenido completo (editar prompt) | Contenido `done` | Acciones → "Regenerar" → ajustar tema/instrucciones → confirmar | Vuelve a `queued`/`processing`; conserva el resto de clases; no borra la fila |
| CONT-12 | Regenerar UNA clase | Curso completo `done` | "Ver archivos por clase" → regenerar clase N (tema pre-cargado de esa clase) | Solo la clase N se re-genera; las demás intactas (merge, no pérdida) |
| CONT-13 | Ver error de generación fallida | Contenido en `failed` | Abrir el detalle del error | Dialog muestra el mensaje completo; texto copiable; estado `failed` en rojo (StatusBadge) |
| CONT-14 | Descargar archivo (.pptx desde pptx-source) | Contenido `done` con presentación | Descargar el archivo de tipo presentación | Se descarga un `.pptx` real (nombre amigable "…Clase 1 - Tema.pptx"), no `.pptx.txt` |
| CONT-15 | Borrar un archivo individual | Contenido `done` con varios archivos | "Ver archivos por clase" → eliminar 1 archivo → confirmar | Confirm destructivo; el archivo desaparece del bucket y del `files[]`; la fila del contenido permanece |
| CONT-16 | Duplicar contenido (copiar archivos + cursos) | Contenido `done` | Acciones → "Duplicar" → marcar copiar archivos y cursos → confirmar | Copia nace como borrador `Copia de <nombre>`; archivos copiados en Storage; asociaciones N-N replicadas; toast en español |
| CONT-17 | Duplicar con nombre ya existente | Ya existe "Copia de X" | Duplicar de nuevo | Error friendly de nombre duplicado; no crea fila huérfana |
| CONT-18 | Eliminar → Papelera (soft-delete) | Contenido cualquiera | Acciones → Eliminar → confirmar | Confirm con "no se puede deshacer"; sale del listado; aparece en `/app/trash`; se puede restaurar |
| CONT-19 | Contenido en papelera invisible en TODO flujo | Contenido soft-deleted, asignado a sesión/curso, publicado | Como alumno del curso, revisar tablero del curso, calendario y picker `#` del Tutor | El contenido NO aparece en ninguno de esos flujos hasta restaurarlo |
| CONT-20 | Filtro por curso + búsqueda | Varios contenidos en distintos cursos | Elegir un curso en el filtro + escribir texto | Solo aparecen los del curso que matchean texto; items sin curso se excluyen al filtrar por curso; "Limpiar" resetea |
| CONT-21 | Orden por columna + paginación | > 25 contenidos | Clic en encabezados (Tema, Estado, Archivos, Creado); cambiar "Por página" | Orden asc/desc estable (vacíos al final); paginación persiste; "seleccionar todos" abarca todas las páginas del filtro |
| CONT-22 | Vista Admin/SuperAdmin (todos del tenant) | Alternar a rol Admin | Abrir Contenidos como Admin | Ve todos los contenidos del tenant (RLS), no solo los propios; Docente ve solo los suyos |
| CONT-23 | Aislamiento por tenant (RLS) | — | Como Docente de Demo Global Corp, verificar contenidos | No se ve material de otra institución; ningún leak cross-tenant |

**Checks UI/UX (Generar con IA):** responsive 375px — los CTAs "Subir externo" + "Nuevo contenido" hacen wrap sin desbordar el header y sin scroll horizontal; el grid hace scroll dentro de su Card. Modo claro/oscuro en dialog, StatCards y tabla. Estados loading (TableSkeleton), empty ("crea tu primer contenido" vs "sin coincidencias" cuando el filtro recorta a 0) y error (ErrorState con "Reintentar"). Toasts en español vía `friendlyError`. Selector de estado publicación con `aria-label`; touch targets ≥32px. Fechas es-CO en columna "Creado" (DateCell). Filtros/orden/paginación persistidos.

### 2. Contenidos — Subir externo (`UploadExternalContentDialog`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| CONT-EXT-01 | Subir 1 archivo (material individual, happy path) | Rol Docente, ≥1 curso | "Subir externo" → nombre, tema, tags, modo individual, elegir 1 PDF, marcar 1 curso → "Subir y crear contenido" | Barra de progreso; contenido `done` publicado; toast de éxito en español; queda en el curso |
| CONT-EXT-02 | Modo individual fuerza 1 archivo | Modo individual | Seleccionar 2 archivos | Solo queda el último (reemplaza) |
| CONT-EXT-03 | Curso completo: multi-archivo | Modo curso completo | Seleccionar varios archivos con el picker de archivos | Se agregan todos (dedupe por ruta+tamaño); N clases ≥ 1 requerido |
| CONT-EXT-04 | **Carpeta recursiva** | Modo curso completo | Usar "…elegir una carpeta completa" con subcarpetas (una por sesión) | Recorre subcarpetas y toma solo los archivos de adentro; NO trae carpetas; archivos homónimos en distintas subcarpetas no colisionan en Storage |
| CONT-EXT-05 | Junk files del SO se ignoran en silencio | Carpeta con `.DS_Store`, `Thumbs.db`, `desktop.ini`, dotfiles | Elegir esa carpeta | Esos archivos se descartan sin toast; solo se listan los válidos |
| CONT-EXT-06 | Formato no soportado | — | Incluir un `.exe`/`.mp3` | Toast agregado "N archivo(s) omitido(s) por formato no soportado: …" (con preview de nombres) |
| CONT-EXT-07 | Archivo > 25 MB | — | Elegir un archivo de 30 MB | Toast "omitido(s) por superar 25 MB"; los demás siguen |
| CONT-EXT-08 | Total > 100 MB | — | Cargar archivos que sumen > 100 MB | Se detiene al superar el total; toast "Excede el total de 100 MB" |
| CONT-EXT-09 | Código inline ejecutable | — | Subir `.java`/`.py`/`.js` | Se guarda en Storage Y su texto inline en `files[].body` (≤ 500K) → luego ejecutable en la sesión |
| CONT-EXT-10 | Notebook `.ipynb` sin outputs | — | Subir un `.ipynb` con plots/outputs pesados | Se guarda con outputs limpiados (`stripNotebookOutputs`); body liviano, sigue ejecutable |
| CONT-EXT-11 | Validación: curso destino requerido | Sin curso marcado | Intentar "Subir y crear" | Botón deshabilitado / toast "Selecciona al menos un curso destino." |
| CONT-EXT-12 | Multi-curso (N-N) | ≥2 cursos | Marcar 2+ cursos (el 1º = ancla) | El material aparece en el tablero de cada curso; junction `content_course_assignments` con 1 fila por curso |
| CONT-EXT-13 | Nombre duplicado | Ya existe nombre X | Subir con nombre X | Toast `Ya tienes un contenido llamado "X". Usa otro nombre.`; no crea fila |
| CONT-EXT-14 | Upload parcial (algún archivo falla) | — | Simular fallo de un upload | Toast parcial "subidos X de Y, fallaron: …"; el contenido queda con los exitosos |
| CONT-EXT-15 | Todos los uploads fallan | — | Todos los archivos fallan | Se borra la fila (no queda huérfana); toast "No se pudo subir ningún archivo. Reintenta." |
| CONT-EXT-16 | Cambios sin guardar | Form con datos | Cerrar el dialog | Guard "cambios sin guardar" pide confirmación antes de descartar |

**Checks UI/UX (Subir externo):** responsive 375px — el DialogContent usa `max-w-[calc(100vw-2rem)]` + `max-h-[90dvh] overflow-y-auto` (no desborda ni corta el footer en iOS). Grids del form empiezan en 1 columna. Claro/oscuro. Empty state cuando no hay cursos disponibles (Alert). Toasts español; barra de progreso "N de M" durante upload. Tags como botones con `aria-pressed`; checkboxes de curso con touch target ≥32px; botón "quitar archivo" con `aria-label`. Duración con clamp solo al blur.

### 3. Contenidos — Ver/editar imagen y PDF

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| CONT-MED-01 | Ver imagen inline (docente) | Contenido con imagen raster | En "Ver archivos por clase", clic en chip de imagen | Se abre MediaViewerDialog con `<img>` + zoom; botón descargar disponible |
| CONT-MED-02 | Ver PDF inline | Contenido con PDF | Abrir el chip de PDF | PDF se renderiza en iframe (MIME forzado por extensión aunque venga como octet-stream); no solo descarga |
| CONT-MED-03 | Editar imagen raster | Docente dueño, imagen png/jpg/webp | Abrir visor → "Editar imagen" | Editor de canvas: lápiz (color+grosor), rotar 90° izq/der, voltear H/V, deshacer, restablecer |
| CONT-MED-04 | Guardar nueva versión (imagen) | En el editor | Dibujar → "Guardar nueva versión" | Upsert al mismo path (última gana); `updated_at` se toca; no hay historial de versiones |
| CONT-MED-05 | SVG / GIF: ver pero NO editar | Contenido con `.svg`/`.gif` | Abrir el chip | Se visualiza; NO ofrece el botón de editar (perdería vector/animación) |
| CONT-MED-06 | Reemplazar (nueva versión) valida tipo | Docente dueño | "Reemplazar" imagen con un PDF | Rechaza el mismatch (PDF↔PDF, imagen↔imagen); toast de error |
| CONT-MED-07 | Estudiante solo-ver | Alumno del curso, contenido publicado con media | Tablero del curso → abrir imagen/PDF | Visor sin "Editar" ni "Reemplazar" (canEdit=false) |
| CONT-MED-08 | bmp/avif visualizable no editable | Contenido con `.bmp`/`.avif` | Abrir | Se ve inline; sin opción de editar |

**Checks UI/UX (media):** claro/oscuro en el visor y editor; el canvas usa `bg-checkerboard` (utility) para transparencia, no inline style. Responsive 375px del dialog. Zoom con controles de touch target ≥32px. Descarga siempre disponible. Toasts español.

### 4. Contenidos — Ejecutar código y notebooks (tablero del alumno · `/app/student/courses`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| CONT-EXEC-01 | Ejecutar archivo de código | Alumno del curso; contenido con `.java`/`.py`/`.js` publicado + asignado a sesión | Tablero del curso → botón "Ejecutar" (Play) del archivo | Abre CodeFileRunnerDialog (visor + editor efímero) + Run vía `execute-code`; muestra stdout/stderr |
| CONT-EXEC-02 | Edición efímera no persiste | Runner abierto | Editar el código y ejecutar; cerrar y reabrir | Los cambios NO se guardan (playground efímero); el archivo original queda igual |
| CONT-EXEC-03 | Abrir notebook y ejecutar todo | Contenido con `.ipynb` | "Abrir notebook" (NotebookPen) → "Ejecutar todo el código" | Renderiza celdas (markdown + código); concatena celdas de código en 1 script Python y lo corre; muestra salida de texto |
| CONT-EXEC-04 | Notebook stateless (sin plots) | Notebook con matplotlib | Ejecutar | Avisa que es stateless (sin kernel persistente entre celdas); no renderiza figuras/plots; magics `%`/`!` descartados |
| CONT-EXEC-05 | Descargar código / notebook | — | Botón de descarga junto a Ejecutar/Abrir | Descarga el archivo original |

**Checks UI/UX (ejecución):** claro/oscuro del editor Monaco/visor; responsive 375px; spinner mientras corre; toasts español ante error del edge; touch targets ≥32px en Ejecutar/Cancelar.

### 5. Pizarras (`/app/teacher/whiteboards` · rol Docente)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| PIZ-01 | Crear pizarra (happy path) | Rol Docente | "Nueva pizarra" → nombre → "Crear y abrir" | Se crea y navega directo al editor `/app/teacher/whiteboards/$id` |
| PIZ-02 | Validación: nombre requerido | Dialog abierto | Nombre vacío → "Crear" | Toast "Dale un nombre a la pizarra"; no crea |
| PIZ-03 | Asociar a curso → se comparte por defecto | Docente con curso | Elegir curso al crear | `is_shared_with_course=true` por defecto (nota informativa visible); el alumno del curso la ve |
| PIZ-04 | Sesión requiere curso | Dialog | Elegir sesión sin curso | Toast "Si elegís una sesión, primero hay que elegir el curso." (validación previa al trigger) |
| PIZ-05 | Selector de sesión solo con curso con sesiones | Curso sin sesiones | Elegir ese curso | Muestra nota "sin sesiones"; el Select de sesión no aparece |
| PIZ-06 | Excalidraw + librerías predefinidas | Editor abierto | Abrir panel "Library" | Aparecen los 8 items curados (flowchart, UML clase, data structures) |
| PIZ-07 | Viewport persistente | Editor abierto | Hacer pan/zoom → cerrar → reabrir | Recupera scrollX/scrollY/zoom (localStorage `examlab_wb_view:page:<id>`) |
| PIZ-08 | Duplicar (copiar contenido + curso) | Pizarra con hojas | Acciones → "Duplicar" → marcar copiar contenido y curso | Copia `Copia de <nombre>`; hojas (`whiteboard_pages`) copiadas; NO copia vínculo a sesión ni el flag de compartida |
| PIZ-09 | Cerrar / Reabrir | Pizarra published | Acciones → "Cerrar" | Sale del listado activo (docente y alumno) sin borrarla; "Reabrir" la restaura; StatusBadge refleja el estado |
| PIZ-10 | Columna Curso (papelera oculta nombre) | Pizarra con curso soft-deleted | Ver el grid | Columna "Curso" muestra "—" cuando el curso está en papelera; nombre real cuando el curso está activo |
| PIZ-11 | Eliminar → Papelera | Pizarra cualquiera | Acciones → Eliminar → confirmar | Confirm destructivo; sale del listado; aparece en `/app/trash`; restaurable |
| PIZ-12 | Bulk delete | ≥2 pizarras | Seleccionar varias → toolbar → eliminar | BulkDeleteDialog con conteo + preview; `.in('id', ids)` atómico; abarca todo el filtro (no solo página actual) |
| PIZ-13 | Filtro de estado (activos por defecto) | Mix published/closed | Ver el listado y cambiar el filtro | Por defecto oculta las cerradas; "Todos" las muestra |
| PIZ-14 | Pizarra compartida en vivo (realtime) | Pizarra de sesión con "Pizarra compartida" ON | Docente y alumno abren la misma pizarra a la vez; dibujar en una | Cambios se propagan (~200ms debounce); badge "Compartida en vivo" al conectar; last-write-wins |
| PIZ-15 | Acceso del alumno solo si compartida | Sesión con `whiteboard_shared=true` | Alumno abre `/app/student/attendance` | Botón "Pizarra" (azul) visible solo cuando shared=true; abre en `studentMode` (sin toggle) |
| PIZ-16 | Aislamiento por tenant | — | Como Docente de un tenant vacío, verificar | No ve pizarras de otras instituciones (fix leak `whiteboards`/`whiteboard_pages` rama Admin scopeada) |
| PIZ-17 | Orden por columna + paginación | > 25 pizarras | Clic encabezados (Nombre, Curso, Estado, Visibilidad, Actualizado); cambiar página | Orden estable; paginación 25 default persistida |

**Checks UI/UX (pizarras):** responsive 375px — columnas secundarias (Curso `sm`, Estado `sm`, Visibilidad `md`, Actualizado `lg`) se ocultan progresivamente; sin scroll horizontal de página. Claro/oscuro en grid y editor Excalidraw. Loading (spinner), empty (con CTA "Crear pizarra" vs "sin coincidencias"), error (ErrorState + Reintentar). Fechas es-CO (DateCell datetime). Toasts español. Guard "cambios sin guardar" en el dialog. Touch targets ≥32px en RowActionsMenu.

### 6. Biblioteca de videos (`/app/videos` · rol Docente/Admin)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| VID-01 | Agregar por URL (YouTube/Vimeo) | Rol Docente/Admin | "Agregar" → pegar URL de YouTube | Detecta provider automáticamente del host; se registra |
| VID-02 | Agregar por URL MP4 directo | — | Pegar URL `.mp4` de CDN | provider=`direct`; queda registrado |
| VID-03 | Subir archivo | — | Subir un MP4/WebM/MOV (< 500MB) | Se sube al bucket `videos`; `storage_path` guardado; barra de progreso |
| VID-04 | Rechazo por tamaño/MIME | — | Subir archivo > 500MB o MIME no aceptado | Rechazo con toast en español |
| VID-05 | Video global de plataforma | Existe video con `tenant_id=NULL` (subido por SuperAdmin) | Ver el listado como Docente | Badge "🌐 Global plataforma"; visible/referenciable desde el tenant |
| VID-06 | Eliminar es permanente (NO papelera) | Cualquier video | Acciones → Eliminar → confirmar | Borrado físico (videos NO está en el set de 8 entidades soft-delete); confirm "no se puede deshacer"; si es `direct`, borra también del Storage |
| VID-07 | Sin archivados | — | Revisar UI | NO existe botón "Ver/Ocultar archivados", stat "Archivados", ni acción Archivar; stats son 3 (Total · En curso · Globales); la query no filtra `is_archived` |
| VID-08 | Filtro por curso + búsqueda + orden + paginación | > 25 videos | Filtrar, ordenar por columna, cambiar página | Comportamiento estándar de grid de listado |
| VID-09 | Aislamiento por tenant | — | Verificar como Docente | Ve videos del tenant + globales de plataforma; no de otras instituciones |

**Checks UI/UX (videos):** responsive 375px (grid con scroll interno en Card); claro/oscuro; loading (TableSkeleton/PageLoader), empty (TableEmpty), error (ErrorState). Toasts español. Fechas es-CO. `formatFileSize` para tamaños. Touch targets ≥32px. Enlace externo con icono claro.

### 7. Tutor IA por curso (alumno · `/app/student/tutor/$courseId`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| TUT-01 | Chat único por curso, creación on-demand | Alumno matriculado; sin conversación previa | Abrir Tutor del curso → enviar 1er mensaje | Se crea la sesión al primer envío (UNIQUE user+course); respuesta del tutor en burbuja; historial persiste al reingresar |
| TUT-02 | El tutor lee el CONTENIDO del material | Curso con material `done` publicado (md/txt/código/**docx**/**pptx**/**ipynb**) | Preguntar sobre algo específico del material | Responde con el texto real (no "solo tengo el título"); office binario se extrae vía unzip server-side y se cachea |
| TUT-03 | Referenciar archivo con `#` | Curso con archivos referenciables | Escribir `#` → autocomplete estilo Slack → elegir un archivo | Inserta chip + token; se manda `referencedFiles`; el edge prioriza ese archivo en el budget del material; chips se limpian tras cada envío |
| TUT-04 | Navegación del autocomplete con teclado | Dropdown `#` abierto | Flechas ↑/↓, Enter/Tab para seleccionar, Esc para cerrar | Navegación correcta; Enter sin dropdown envía el mensaje (Shift+Enter = salto de línea) |
| TUT-05 | Material solo-docente excluido | Curso con soluciones/claves/guía docente | Abrir el picker `#` y preguntar | Esos archivos NO aparecen en `#` ni entran al contexto (el edge también los salta) |
| TUT-06 | Contenido en papelera no se referencia | Material soft-deleted | Abrir el picker `#` | No aparece; la query filtra `deleted_at` |
| TUT-07 | Curso en papelera | Curso soft-deleted | Abrir la ruta del tutor de ese curso | El curso no resuelve (query filtra `deleted_at`); estado coherente sin exponer el curso |
| TUT-08 | Limpiar conversación | Conversación con mensajes | "Limpiar conversación" → confirmar | Confirm destructivo; borra mensajes, conserva la sesión; toast "Conversación limpiada" |
| TUT-09 | Error del edge (API key/cuota) | Simular fallo del edge | Enviar mensaje | Se remueve el mensaje optimista; toast con el error real accionable (extractEdgeError), no genérico |
| TUT-10 | Síncrono por diseño | — | Enviar y esperar | El alumno espera la respuesta en vivo (no encola aunque `processing_mode=async`); spinner "El tutor está pensando…" |
| TUT-11 | Límite de longitud | — | Pegar > 4000 chars | Textarea limita a `maxLength=4000` |

**Checks UI/UX (Tutor):** responsive 375px (Card `max-h-[70dvh]`, chat con scroll interno; hint de atajos oculto en `<sm`). Claro/oscuro en burbujas (`dark:prose-invert`, colores indigo). Loading (spinner "Cargando…"), empty (EmptyChat con disclaimer), error (ErrorState + Reintentar). Fechas es-CO en cada mensaje (formatDateTime). Toasts español. Chips de referencia con botón quitar (`aria-label`); autoscroll al último mensaje.

### 8. Asistente IA de plataforma (todos los roles · `/app/assistant`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|---|---|---|---|---|
| ASIS-01 | Disponible para todos los roles | Cualquier rol activo | Abrir `/app/assistant` | El chat carga para Admin, Docente y Estudiante (ruta universal; la vieja `/app/admin/support-assistant` redirige aquí) |
| ASIS-02 | Sesión única por usuario, on-demand | Sin conversación previa | Enviar 1er mensaje | Se crea la sesión (UNIQUE user_id); persiste al reingresar |
| ASIS-03 | KB adaptada al ROL ACTIVO | Usuario multi-rol | Como Estudiante preguntar "¿cómo entrego un taller?"; alternar a Docente y preguntar "¿cómo creo un examen?" | El edge adapta la KB + prompt al rol activo enviado en el body; respuestas coherentes con lo que ese rol puede hacer |
| ASIS-04 | Sin curso (a diferencia del Tutor) | — | Revisar la UI | No hay selector de curso ni tag `#`; responde sobre uso general de ExamLab según `platform_kb_docs` |
| ASIS-05 | Distinción Tutor vs Asistente | — | Comparar `/app/student/tutor/$courseId` (material del curso) vs `/app/assistant` (uso de la plataforma) | Tutor = contenido académico del curso (solo alumno); Asistente = cómo usar la app (todos los roles). No se confunden |
| ASIS-06 | Limpiar conversación | Con mensajes | "Limpiar conversación" → confirmar | Confirm destructivo; borra mensajes, conserva sesión; toast "Conversación limpiada" |
| ASIS-07 | Error del edge | Simular fallo | Enviar mensaje | Mensaje optimista se remueve; toast con error real; no rompe la UI |
| ASIS-08 | Rol no poseído | Usuario sin ese rol activo (caso borde) | Enviar | El edge cae a su rol de mayor alcance; responde sin error |

**Checks UI/UX (Asistente):** responsive 375px (Card `max-h-[70dvh]`, scroll interno). Claro/oscuro (burbujas indigo, `dark:prose-invert`). Loading (spinner "Cargando…"), empty (EmptyChat con disclaimer "si algo no está en la documentación, te sugeriré a quién consultar"), error (ErrorState + Reintentar). Fechas es-CO. Toasts español. Enter envía / Shift+Enter salto; `maxLength=4000`; botón "Enviar" deshabilitado sin texto; autoscroll.

### Checks transversales de la sección
- **Soft-delete invisible en TODO flujo:** un contenido/pizarra en papelera no debe verse ni usarse en tablero del alumno, calendario, agenda, gradebook, Tutor IA (`#`) ni realtime, hasta restaurarse.
- **Aislamiento por tenant / RLS:** ningún módulo (contenidos, pizarras, videos, tutor, asistente) expone datos de otra institución; validar que un Docente/Admin de un tenant vacío no vea filas ajenas.
- **Consistencia de estados:** loading/empty/error presentes en cada grid y chat; nunca "toast.error + pantalla en blanco" sin ErrorState.
- **es-CO uniforme:** toda fecha visible pasa por los helpers de `format.ts`; ningún `toLocaleString` crudo.

---

## Encuestas, Reto en vivo, foros y mensajería

Alcance: verificación funcional de encuestas (single/multiple/slot Doodle/mixta), Reto en vivo (Kahoot), asociación a sesión de clase, foros por curso, mensajería 1-a-1, difusión multi-curso, mensajes programados, etiquetado de contenido con `#` y el gating por rol ACTIVO (`isStaffActive`). Todos los casos se ejecutan en el tenant **Demo Global Corp** con la cuenta multi-rol; salvo indicación, se opera desde `/app/teacher/*` (rol Docente) y `/app/student/*` (rol Estudiante) alternando con el selector de rol del sidebar.

### Encuestas (`/app/teacher/polls` · `/app/student/polls`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| POLL-01 | Crear encuesta de opción única (single) publicada | Rol Docente, ≥1 curso dictado | "Nueva encuesta" → título + descripción → tipo "Opción única" → agregar 2+ opciones → activar "Publicar" → Guardar | Encuesta creada, aparece en el grid con badge tipo "Opción única", estado "Abierta"; se dispara notificación + correo al curso (trigger de publicación); toast de éxito en español |
| POLL-02 | Crear encuesta de opción múltiple (multiple) | Rol Docente | Igual a POLL-01 pero tipo "Opción múltiple" | El alumno podrá marcar varias opciones; la columna "Respuestas" cuenta selecciones totales |
| POLL-03 | Crear como borrador (no publicada) | Rol Docente | Crear encuesta con "Publicar" en OFF | Fila con badge "Borrador"; stat "Borradores" +1; el estudiante NO la ve en su vista; no se envía notif/correo |
| POLL-04 | Encuesta multi-curso | Docente dicta ≥2 cursos | En el create seleccionar 2+ cursos | Se persiste el ancla + junction `poll_courses`; en el grid la columna Curso muestra "Curso A +N más" con tooltip; aparece al filtrar por cualquiera de sus cursos |
| POLL-05 | Slot Doodle en modo Auto | Docente, curso con N matriculados | Tipo "Cupos (Doodle)" → agregar fechas + ventana horaria (inicio/fin) + paso → dejar cupo en "Auto" | Cupo = ceil(matriculados/slots); panel resumen "N fechas × M slots/día = Z slots · Capacidad total X/Y" en verde si alcanza; labels tipo "mié, 10 de jun · 9:00 AM" |
| POLL-06 | Slot Doodle en modo Manual y cupo insuficiente | Como POLL-05 | Editar el cupo a un valor menor al sugerido | Badge cambia a "Manual"; panel resumen se pone ámbar "faltan cupos"; botón "← Volver a auto" recalcula |
| POLL-07 | Slot: agregar slot manual (fecha + hora + cupo) | Create/edit de tipo slot | Usar el composer de slot manual → agregar | El slot se añade a la lista sin romper la generación previa |
| POLL-08 | Visibilidad de resultados | Rol Docente | Crear con visibilidad "Al cerrar" → publicar → votar como Estudiante | El alumno NO ve conteos hasta que la encuesta cierre; con "Siempre" los ve al instante; con "Nunca" jamás |
| POLL-09 | Votar como estudiante | Encuesta single publicada y abierta | Rol Estudiante → `/app/student/polls` → seleccionar opción | Voto registrado; se refleja el conteo según la política de visibilidad |
| POLL-10 | Quitar mi respuesta (allow_change=ON) | Encuesta abierta con `allow_change_response`=ON, alumno ya votó | Rol Estudiante → botón "Quitar mi respuesta" | Voto eliminado (RPC `clear_poll_response`); en slot libera el cupo; el botón solo aparece si abierta Y permite cambios |
| POLL-11 | Quitar mi respuesta bloqueada (allow_change=OFF) | Encuesta con `allow_change_response`=OFF | Rol Estudiante intenta quitar/cambiar voto | La acción no está disponible / el RPC rechaza; no permite recambio |
| POLL-12 | Auto-cierre cuando todos responden | Encuesta con "Cerrar al responder todos"=ON | Que todos los matriculados voten | El trigger cierra la encuesta automáticamente; pasa a estado "Cerrada" |
| POLL-13 | Cerrar y reabrir manualmente | Encuesta abierta | Menú de fila → "Cerrar" → confirmar (tono warning) → luego "Reabrir" | Cierra (badge "Cerrada"); "Reabrir" limpia `closes_at` si estaba vencida por tiempo y vuelve a "Abierta"; toasts "Encuesta cerrada"/"reabierta" |
| POLL-14 | Reabrir encuesta vencida por tiempo | Encuesta con `closes_at` en el pasado | Menú → acción muestra "Reabrir" (no "Cerrar") | La acción deriva del estado EFECTIVO (cerrada por tiempo o manual); tras reabrir queda realmente abierta |
| POLL-15 | Editar encuesta con votos ya emitidos (single) | Encuesta single con ≥1 voto | Menú → "Editar" | Los campos de config son editables pero las OPCIONES quedan read-only (proteger `poll_responses`) |
| POLL-16 | Editar slot con reservas (vote-safe) | Encuesta slot con reservas | Menú → "Editar" → agregar/quitar slots | Los slots quedan editables; el sync es vote-safe (actualiza/inserta/borra solo los sin reservas); no rompe reservas existentes |
| POLL-17 | Ver resultados y borrar voto por alumno | Encuesta con respuestas | Menú → "Ver resultados" | Chips por opción con NOMBRE del alumno (resuelto en 2 queries, no embed); botón borrar por alumno libera su cupo |
| POLL-18 | Duplicar encuesta (parametrizable) | Encuesta existente | Menú → "Duplicar" → elegir "Copiar opciones" + "Copiar cursos" → confirmar | Copia nace como borrador "(copia)", sin respuestas, sin `closes_at` ni sesión; copia solo lo tildado |
| POLL-19 | Duplicar encuesta mixta | Encuesta tipo mixta | Menú → "Duplicar" → toggle "Copiar preguntas" | El diálogo ofrece "preguntas" (no "opciones"); copia `poll_questions` sin respuestas |
| POLL-20 | Compartir enlace | Encuesta publicada | Menú → "Compartir enlace" | Copia `/app/student/polls?poll=<id>` al portapapeles; toast en español; si navegador bloquea clipboard, muestra el enlace en toast largo |
| POLL-21 | Compartir enlace de borrador | Encuesta en borrador | Menú → "Compartir enlace" | Además del enlace, toast de advertencia "es un borrador, publícala..." |
| POLL-22 | Deep-link a encuesta desde estudiante | Enlace de POLL-20 | Rol Estudiante → abrir el enlace | La `PollCard` que matchea se resalta (ring) + `scrollIntoView`; RLS sigue aplicando (no expone a no matriculados) |
| POLL-23 | Enviar a papelera (soft-delete) | Encuesta existente | Menú → "Eliminar" → confirmar (destructive) | `softDelete('polls')`; toast "Encuesta enviada a papelera"; desaparece del grid; recuperable en `/app/trash` |
| POLL-24 | Encuesta en papelera invisible en TODO flujo | Encuesta enviada a papelera (POLL-23) que estaba publicada | Rol Estudiante → `/app/student/polls`; revisar calendario/dashboard | La encuesta NO aparece en ninguna vista del alumno ni en Kahoot join; regla universal soft-delete |
| POLL-25 | Filtro de estado por defecto | Grid con encuestas abiertas y cerradas | Entrar a `/app/teacher/polls` | Filtro por defecto "Abiertas" (oculta cerradas); cambiar a "Cerradas"/"Todas" ajusta el listado |
| POLL-26 | Filtro por curso | Docente con >1 curso | Usar el Select de curso | Solo el Select aparece con >1 curso; filtra por curso ancla o linkeado |
| POLL-27 | Aislamiento por tenant (RLS) | Encuesta de Demo Global Corp | Consultar como usuario/rol de otro tenant | No es visible; la RLS acota a cursos del tenant; sin fuga cross-tenant |
| POLL-28 | "Nueva encuesta" deshabilitado sin cursos | Docente sin cursos en `course_teachers` | Entrar al módulo | Botón "Nueva encuesta" disabled; empty state con texto "no tienes cursos" |

**Checks UI/UX (Encuestas)**
- Responsive 375px: grid con `overflow-x-auto` dentro del Card (sin scroll horizontal de página); columnas Curso/Ventana ocultas en `<md`/`<lg`; modal create `max-w-[calc(100vw-2rem)]`.
- Modo claro/oscuro: StatCards, badges de tipo/estado y panel resumen de slots legibles en ambos.
- Estados: loading (Spinner "Cargando…"), empty (distinto "sin cursos" vs "crea la primera"), error (`ErrorState` con "Reintentar").
- Toasts en español vía `friendlyError`; nunca mensaje técnico de Postgres.
- Touch targets ≥32px en el menú de acciones de fila (`RowActionsMenu`) y botones.
- Fechas es-CO vía `DateCell`/`formatDateTime` (ventana Inicio→Fin); orden por columna (`SortableHead`) persistido; filtros estado/curso/(institución SA).
- Accesibilidad: `RowActionsMenu` con aria-label; `Label required` con asterisco.

### Reto en vivo — Kahoot (`/app/teacher/kahoot/$gameId` · `/app/student/kahoot/$gameId`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| KAH-01 | Editar preguntas de un Kahoot | Encuesta tipo Kahoot creada | Menú de fila → "Preguntas" | Abre `KahootQuestionsEditor`; se agregan preguntas con texto, tiempo, puntos, `multi_select` y opciones con marca de correcta |
| KAH-02 | Hospedar juego en vivo | Kahoot con ≥1 pregunta | Menú → "Hospedar en vivo" | `kahoot_create_game`; navega a `/app/teacher/kahoot/$gameId`; muestra el PIN de 6 dígitos y QR en el lobby |
| KAH-03 | Unirse por PIN (estudiante) | Juego en lobby, alumno matriculado | Rol Estudiante → `/app/student/polls` → tarjeta "En vivo" → teclear PIN de 6 dígitos → "Unirme" | `kahoot_join_game` valida matrícula + tenant; entra al juego; se lista en jugadores del host |
| KAH-04 | PIN inválido | Tarjeta de join visible | Teclear PIN erróneo / <6 dígitos | Toast "PIN inválido"; input se limpia; NO navega al juego (el PIN es el control de acceso) |
| KAH-05 | El PIN nunca se expone al alumno | Juego en vivo | Inspeccionar el estado del alumno (`kahoot_get_state`) | `game.pin` llega `null` al alumno; solo el host lo recibe; unirse a juego nuevo exige teclear/QR |
| KAH-06 | Unirse por QR (deep-link) | QR proyectado por el docente | Escanear → aterriza en `/app/student/polls?kahootPin=…` (login si hace falta) | Auto-join una sola vez; navega al juego; la seguridad la enforza el RPC (matrícula + poll no borrado + host presente) |
| KAH-07 | Reconectar sin PIN | Alumno YA es jugador de un juego activo | Rol Estudiante → tarjeta muestra "Reconectar" | Entra directo sin PIN (persistencia server-side por usuario); recargar/cambiar de dispositivo no lo duplica ni re-pide PIN |
| KAH-08 | Kahoot en borrador es hospedable y reconectable | Kahoot NO publicado, juego en vivo | Alumno mira la tarjeta de join | `kahoot_my_live_games` (RPC SECURITY DEFINER) lista el juego aunque el poll sea borrador; `hasLive`=true |
| KAH-09 | Flujo de pregunta y scoring | Juego con jugadores | Host avanza a pregunta → alumnos responden a distinto tiempo | Puntos = `maxPoints * (1 - (t/limite)/2)` (más rápido = más puntos, correcto; incorrecto=0); el server y el cliente calculan igual |
| KAH-10 | Multi-select | Pregunta con `multi_select`=true | Alumno marca varias opciones | Acierta solo si marca el set correcto exacto |
| KAH-11 | Reveal, leaderboard y podio | Juego en curso | Host recorre estados lobby→question→reveal→leaderboard→…→podium→ended | El ranking se actualiza por puntaje; al final se muestra podio; estado "ended" cierra el juego |
| KAH-12 | Splash "¡Prepárate!" | Host avanza pregunta | Observar antes de que abra la pregunta | Cuenta regresiva previa (`question_started_at` en futuro); el cronómetro real inicia con el límite completo al abrir |
| KAH-13 | Host ausente (heartbeat stale) | Juego en vivo, host cierra pestaña >25s | Alumno observa su vista | `host_present`=false → "Esperando al docente…" SIN sacarlo de la sesión |
| KAH-14 | Kahoot en papelera bloquea el ingreso | Kahoot enviado a papelera con juego stale | Alumno intenta unirse por PIN/deep-link | `kahoot_join_game` rechaza con el mismo error que un PIN inválido (guard soft-delete server-side); `KahootJoinCard` no lista el juego |
| KAH-15 | Duplicar Kahoot (re-jugar) | Kahoot existente | Menú → "Duplicar" → toggle "Copiar preguntas" | Copia clona `kahoot_questions` + opciones (con `is_correct`), nace borrador; si falla a mitad borra la copia (sin quedar vacía) |
| KAH-16 | Aislamiento por tenant al unirse | PIN de un juego de otro tenant | Alumno de Demo Global Corp intenta unirse | Rechazado (validación tenant/matrícula) |

**Checks UI/UX (Reto en vivo)**
- Responsive 375px: input de PIN centrado `tabular-nums tracking-widest`; formas/colores de Kahoot legibles; vista host y jugador sin scroll horizontal.
- Claro/oscuro: las 4 formas (triángulo/rombo/círculo/cuadrado) con colores de marca visibles en ambos.
- Estados: tarjeta de join no se renderiza cuando no hay nada en vivo ni reconexión; loading con Spinner; error de join con toast.
- Toasts en español (`friendlyError` sobre errores del RPC, ya localizados).
- Touch targets ≥32px en botones "Unirme"/"Reconectar".
- Fechas/tiempos: cronómetro derivado de reloj local (`secondsLeft`), consistente.
- Accesibilidad: input PIN `inputMode="numeric"`, `maxLength=6`.

### Asociar encuesta / foro a sesión de clase (`/app/teacher/attendance`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| SES-01 | Crear encuesta asociada a una sesión | Curso con sesiones | En el create de encuesta usar el Select "Asociar a sesión (opcional)" | La encuesta se liga a `attendance_session_id`; aparece destacada en la pantalla de esa sesión |
| SES-02 | Lanzar encuesta desde la sesión | Sesión con encuesta asociada | En `/app/teacher/attendance` → dropdown de sesión → `LaunchPollDialog` | La encuesta se lanza/queda visible en el contexto de la sesión |
| SES-03 | Crear foro asociado a sesión | Curso con sesiones no borradas | En crear foro seleccionar sesión en el Select | El foro muestra badge de sesión (fecha + título) en su fila |
| SES-04 | Sesión en papelera no aparece en pickers | Sesión enviada a papelera | Abrir create de encuesta y de foro | La sesión borrada NO aparece en el Select "Asociar a sesión" (filtro `deleted_at`) |
| SES-05 | Badge de sesión oculto si la sesión fue borrada | Foro con sesión que luego se borró | Ver la fila del foro | El badge de sesión NO se muestra (`session.deleted_at` presente → skip en JS) |

**Checks UI/UX (Asociar a sesión)**
- Select de sesión con label es-CO (`formatSessionLabel`: fecha + título) y opción "Sin sesión" por defecto.
- Estados vacíos: sin sesiones el Select solo muestra "Sin sesión".
- Aislamiento soft-delete verificado en pickers y badges.

### Foros por curso (`/app/forum/$courseId`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| FOR-01 | Crear foro (happy path) | Rol Docente en el curso | "Nuevo foro" → título (≥3 chars) + descripción → Crear | Foro creado, aparece en estado "Abierto"; toast "Foro creado" |
| FOR-02 | Validar título mínimo | Diálogo de creación abierto | Título con <3 caracteres → Crear | Toast "El título debe tener al menos 3 caracteres"; no se crea |
| FOR-03 | Validar apertura < cierre | Diálogo abierto | Fecha de apertura ≥ fecha de cierre → Crear | Toast "La fecha de apertura debe ser anterior a la de cierre"; no se crea |
| FOR-04 | Foro programado (opens_at futuro) | Docente | Crear con apertura en el futuro | Badge "Programado (fecha)"; el estudiante aún no puede postear (RLS `is_forum_open`=false); el botón de acción del docente ofrece "Cerrar" (no "Reabrir") |
| FOR-05 | Cierre automático por fecha | Foro con `closes_at` pasado | Cargar la lista | Badge "Cerrado (auto, fecha)"; alumnos no pueden postear |
| FOR-06 | Cerrar manualmente | Foro abierto, rol Docente | Botón candado "Cerrar" → confirmar (warning) | `toggle_forum_closed`; badge pasa a "Cerrado"; toast en español |
| FOR-07 | Reabrir con nuevo plazo | Foro cerrado | Botón "Reabrir" → mini-dialog prefijado a +7 días → confirmar | `manually_closed_at`=null + nuevo `closes_at`; vuelve a "Abierto"; toast "Foro reabierto" |
| FOR-08 | Reabrir con fecha pasada rechazado | Dialog de reapertura | Fijar `closes_at` en el pasado → confirmar | Toast "la fecha debe ser futura"; no reabre |
| FOR-09 | Reabrir sin plazo (vacío) | Dialog de reapertura | Dejar el campo vacío → confirmar | Reabre sin fecha de cierre (permanece abierto) |
| FOR-10 | Eliminar foro | Foro con hilos, rol Docente | Botón papelera → confirmar (destructive, muestra conteo de hilos) | Foro eliminado; toast "Foro eliminado" |
| FOR-11 | Estudiante NO ve acciones de staff | Rol Estudiante (mismo usuario multi-rol) | `/app/forum/$courseId` como Estudiante | NO aparecen "Nuevo foro", candado ni papelera; solo "Entrar" (gating por `isStaffActive`, no por roles poseídos) |
| FOR-12 | Consistencia UI vs RLS (foro abierto) | Foro abierto | Como Estudiante intentar postear | El estado "abierto" del cliente (`computeForumState`) coincide con `is_forum_open()` server-side; el INSERT no es rechazado |
| FOR-13 | Curso en papelera bloquea deep-link | Curso enviado a papelera | Abrir `/app/forum/<courseId>` de ese curso | `ErrorState` "Este curso no está disponible (no existe o fue movido a la papelera)"; no resuelve el foro |
| FOR-14 | Aislamiento por curso/tenant | Foro de un curso ajeno | Estudiante de otro curso intenta acceder | No visible (RLS); sin fuga entre cursos ni tenants |
| FOR-15 | Orden del listado | Varios foros en distintos estados | Cargar la lista | Abiertos arriba, luego programados, luego cerrados; dentro de cada grupo por `created_at` desc |

**Checks UI/UX (Foros)**
- Responsive 375px: filas de foro con `flex-wrap`, acciones `shrink-0`; modal de creación `max-w-[calc(100vw-2rem)] sm:max-w-2xl`; sin scroll horizontal.
- Claro/oscuro: badges de estado (open emerald, scheduled ámbar, closed neutro) legibles en ambos.
- Estados: loading (Spinner), empty distinto para staff vs estudiante, `ErrorState` con "Reintentar".
- Toasts en español vía `friendlyError`.
- Touch targets ≥32px en candado/papelera/"Entrar".
- Fechas es-CO (`formatDate`/`formatDateTime`) en badges y "Creado el".
- Accesibilidad: botones con `title` (Cerrar/Reabrir/Eliminar/Entrar).

### Mensajería 1-a-1 (`/app/messages`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| MSG-01 | Iniciar conversación nueva | Contactos disponibles | Botón "Nuevo" → elegir contacto → escribir → enviar | Se crea/abre la conversación (orden canónico `user_a<user_b`); mensaje aparece; el destinatario recibe notif in-app + toast realtime |
| MSG-02 | Enviar con adjuntos | Conversación activa | Adjuntar 1..N archivos válidos → enviar | Sube a `message-attachments/<user>/<msg>/<file>`; el bubble muestra los adjuntos; respeta `MESSAGE_ATTACHMENT_MAX_COUNT` |
| MSG-03 | Validación de adjuntos | Composer | Adjuntar archivo inválido / exceder el máximo | Toast por archivo con el error; excedente recortado con toast "Máximo N archivos por mensaje" |
| MSG-04 | Editar mensaje propio no leído | Mensaje propio que el otro NO leyó | Editar bubble → guardar | Se actualiza; muestra "(editado)"; realtime propaga el UPDATE |
| MSG-05 | No editar mensaje ya leído por el otro | Mensaje propio que el otro YA leyó | Intentar editar | Botón oculto; si se fuerza el handler, toast "Ya no puedes editar: el otro lo leyó"; la RLS también lo rechaza |
| MSG-06 | Eliminar mensaje propio | Mensaje propio no leído | Eliminar → confirmar (destructive) | Se borra + remueve adjuntos del bucket; realtime propaga DELETE |
| MSG-07 | Borrado masivo (modo selección) | Conversación con varios propios elegibles | Activar modo selección → marcar → "Eliminar" | Solo borra los elegibles (predicado `canEditOrDeleteMessage`); toast con "N eliminados · M omitidos (ya leídos)" si aplica |
| MSG-08 | Marcar leído al abrir | Conversación con no leídos | Abrir la conversación | `mark_conversation_read`; el badge de no leídos baja a 0; llegada de mensaje estando adentro también marca leído |
| MSG-09 | "Eliminar para mí" (soft delete asimétrico) | Conversación con historial | Eliminar conversación para mí | Setea mi `cleared_at`; mis mensajes previos se ocultan; la conversación desaparece de mi lista (filtro cliente `cleared && sin lastMessage`); el otro la sigue viendo |
| MSG-10 | Resurrección de conversación | Conversación "eliminada para mí" (MSG-09) | El otro usuario me envía un mensaje nuevo | La conversación reaparece con SOLO los mensajes nuevos (los viejos siguen ocultos por RLS) |
| MSG-11 | Restricción de mensajería al SuperAdmin | Rol Estudiante/Docente | Intentar iniciar chat con un SuperAdmin | Bloqueado por `can_message` (UI + RLS); el SA solo chatea con Admins/SA |
| MSG-12 | Deep-link a conversación | Enlace/notif con `?conv=<id>` | Abrir la URL | Auto-selecciona la conversación si está en la lista; limpia el querystring (`replaceState`) para no re-disparar |
| MSG-13 | Buscar dentro de la conversación | Conversación con historial | Usar el buscador local | Resalta los matches (`splitByMatch`) |
| MSG-14 | Etiquetar contenido con `#` (inline) | Composer de chat, curso con talleres/exámenes/proyectos | Escribir `#` → autocomplete → seleccionar | Inserta token `[[T:type:id:label]]`; preview con nombre humano; en el bubble se renderiza como Link (`tagRoute` según rol) |
| MSG-15 | Etiquetar con botón `#` (picker) | Composer | Botón `#` → `MessageTagPicker` por tabs → elegir | Anexa el token al final del body; se renderiza igual como chip |
| MSG-16 | Error de módulo no publicado | (Entorno sin la migración) | Abrir "Nuevo" con RPC ausente | Mensaje "módulo de mensajería no publicado" (PGRST202/42883), no "sin contactos" falso |

**Checks UI/UX (Mensajería 1-a-1)**
- Responsive 375px: layout lista↔chat colapsa (botón "Atrás" en mobile); `MessagesFab` con safe-area iOS; sin scroll horizontal.
- Claro/oscuro: badges de rol (Admin/Docente/Estudiante) con colores legibles en ambos.
- Estados: loading (Spinner), empty (sin contactos honesto), `ErrorState` para fallo de conversaciones con "Reintentar".
- Toasts en español (`friendlyError`); mensajes de edge por `extractEdgeError`.
- Touch targets ≥32px en adjuntar/`#`/enviar/editar/eliminar; el scroll salta al fondo (raf + timeout) al abrir.
- Fechas es-CO (`formatDateTime`, `formatMessageTime`); agrupación por día.
- Accesibilidad: checkboxes de selección; iconos con etiqueta.

### Difusión multi-curso, mensajes programados y permisos por rol (`/app/messages`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| BRC-01 | Difundir a un curso | Rol Docente/Admin | "Difundir a curso" → seleccionar 1 curso → asunto + mensaje → "Enviar ahora" | 1 notif `📢` por alumno + 1 correo (todos en BCC) + replicación como mensaje 1-a-1; toast con conteo de notificados/con correo |
| BRC-02 | Difundir a varios cursos con dedup | Alumno matriculado en 2 cursos seleccionados | Seleccionar 2+ cursos / "Seleccionar todos" → enviar | El alumno recibe UNA sola notif/correo/mensaje (dedup por `user_id` en la edge) |
| BRC-03 | Conteo de destinatarios excluye al creador | Curso cuyo único matriculado es el propio docente | Abrir el diálogo | Muestra "0 est." (recipient_count con `.neq(creator)`); enviar no llega a nadie |
| BRC-04 | Validaciones de difusión | Diálogo de difusión | Enviar sin curso / sin asunto / sin mensaje | Toasts "Selecciona al menos un curso" / "Asunto y mensaje son obligatorios" |
| BRC-05 | Autorización de difusión (docente) | Docente que NO dicta uno de los cursos | Seleccionar un curso ajeno + enviar | 403 (edge exige dictar TODOS los cursos); sin difusión parcial; Admin bypassa |
| BRC-06 | Difusión con etiquetas `#` humanizadas | Composer de difusión con tokens `[[T:...]]` | Enviar difusión con contenido etiquetado | En inbox se replica como chip; en notif/correo se humaniza a `#label` (`humanizeTags`) |
| BRC-07 | Programar difusión | Diálogo de difusión | Elegir fecha/hora en "Programar envío" → botón pasa a "Programar" | Inserta en `scheduled_messages` (kind broadcast); toast "Difusión programada para (fecha es-CO)"; el cron la envía al vencer |
| BRC-08 | Programar mensaje directo | Chat 1-a-1 activo | Botón reloj → fijar fecha → programar | Inserta `scheduled_messages` (kind direct); toast "Mensaje programado para …" |
| BRC-09 | Validar fecha futura (≥1 min) | Programar difusión/directo | Elegir fecha en el pasado o < 1 min | `validateScheduledSend` → toast de error; no programa |
| BRC-10 | Límite de 4000 chars en directo programado | Composer directo | Programar un mensaje >4000 chars | Toast "no puede superar los 4000 caracteres" (iguala el CHECK de envío inmediato; evita truncado silencioso) |
| BRC-11 | Listar y editar programados pendientes | ≥1 mensaje programado pending | "Programados" → editar inline (body + fecha) → guardar | Re-valida fecha; UPDATE con guard `status='pending'` (TOCTOU); toast "Cambios guardados"; si ya se despachó, toast info "ya no está pendiente" |
| BRC-12 | Cancelar programado | Programado pending | "Cancelar" | `status='cancelled'`; toast "Programación cancelada" |
| BRC-13 | Ver historial de programados | Enviados/cancelados/fallidos existentes | Toggle "Ver historial" | Muestra sent/cancelled/failed (auditoría) además de pending; por defecto solo pending |
| BRC-14 | Forzar despacho ahora | Programados vencidos, cron atrasado | Botón forzar dispatch | `request_dispatch_scheduled_messages` re-valida autorización por fila; toast "N mensajes despachados" o "no había vencidos" |
| BRC-15 | Curso en papelera no aparece en difusión | Curso enviado a papelera | Abrir el selector de difusión | El curso NO aparece (filtro `deleted_at`) |
| PERM-01 | Multi-rol como Estudiante NO ve difusión/programados | Usuario multi-rol, rol activo = Estudiante | Entrar a `/app/messages` como Estudiante | NO aparecen "Difundir a curso" ni "Programados" (gate `isStaffActive` por rol ACTIVO, no por roles poseídos) |
| PERM-02 | Mismo usuario como Docente SÍ ve las acciones | Cambiar a rol Docente con el selector | Recargar `/app/messages` | Aparecen "Difundir a curso" + "Programados" |
| PERM-03 | Multi-rol como Estudiante NO crea foros | Rol activo = Estudiante | `/app/forum/$courseId` | Sin "Nuevo foro"/candado/papelera (aunque posea rol Docente) |
| PERM-04 | Nota de seguridad: gate solo cliente | Cualquier rol staff poseído | Verificación conceptual | El gate por rol activo es UX; la RLS usa `has_role()` (rol poseído) — documentado, no bloquea DB |

**Checks UI/UX (Difusión / programados / permisos)**
- Responsive 375px: diálogo de difusión con lista de cursos scrolleable; `DateTimePicker` usable a 375px; sin scroll horizontal.
- Claro/oscuro: checkboxes de cursos y lista de programados legibles.
- Estados: loading al cargar cursos/programados; empty "no hay pendientes"; toasts de éxito/error diferenciados.
- Toasts en español (`friendlyError` + `extractEdgeError` para la edge `broadcast-course-message`).
- Touch targets ≥32px en toggles de curso, botones editar/cancelar/enviar.
- Fechas es-CO (`formatDateTime`) en confirmaciones de programación y lista de programados.
- Accesibilidad: labels en checkboxes de curso; el conteo de destinatarios visible por curso.

---

## Administración y SuperAdmin (usuarios, config, soporte, papelera, auditoría, cron, tenants, calculadora)

Alcance: gestión de usuarios y roles, configuración de plataforma/institución (IA, correos, módulos, compilador), colas de IA y cron, soporte PQRS, papelera con soft-delete, auditoría, estadísticas y los paneles cross-tenant del SuperAdmin (instituciones, diagnósticos, calculadora de precios). Todo se prueba en la institución **Demo Global Corp** con la cuenta multi-rol (Admin + Docente + Estudiante) alternando rol desde el selector del sidebar.

> Notas de precondición transversales: (a) los casos marcados **[SA]** requieren una sesión **SuperAdmin** — la cuenta multi-rol de Demo Global Corp NO tiene ese rol, así que se ejecutan con credenciales SuperAdmin aparte; (b) los casos de **aislamiento por tenant/RLS** requieren una 2ª institución con datos propios para verificar que no se filtran; (c) la contraseña temporal de usuarios nuevos es fija: `Temporal#123`.

---

### Usuarios (`/app/admin/users`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| USR-01 | Crear estudiante (happy path) | Sesión Admin | "Nuevo usuario" → nombre, email institucional, contraseña ≥8, rol Estudiante, `student_code`, opcional inscribir a curso → Guardar | Toast "Usuario creado correctamente"; aparece en la tabla; queda con `must_change_password=true`; si se eligió curso, queda matriculado |
| USR-02 | Validación nombre/email obligatorios | Dialog crear abierto | Dejar nombre o email institucional vacío → Guardar | Toast "Nombre y email institucional son requeridos"; no se crea |
| USR-03 | Validación contraseña mínima | Dialog crear | Contraseña de <8 caracteres → Guardar | Toast "Contraseña requerida (mínimo 8 caracteres)"; no se crea |
| USR-04 | Email institucional duplicado (case-insensitive) | Existe usuario con email X | Crear otro con el mismo email en otra capitalización | Toast "El email institucional \"…\" ya está en uso por otro usuario"; no se crea (validación `check_email_taken` previa) |
| USR-05 | Email personal vacío no rompe segundo alta | Un usuario ya creado sin email personal | Crear un 2º usuario también sin email personal | Ambos se crean sin error 500 (personal_email se envía como NULL, no `""`) |
| USR-06 | Crear usuario existente → matricular a curso | Estudiante ya existe, no matriculado | Crear con el mismo email + elegir curso | Toast "El usuario ya existía; se matriculó al curso seleccionado"; no duplica el usuario |
| USR-07 | Editar roles (agregar Docente) | Usuario Estudiante | Editar → marcar Docente → Guardar | Toast actualizado; badge de roles refleja ambos; auditoría registra `user.roles_updated` severidad warning (rol sensible) |
| USR-08 | Cambio de correo de acceso | Usuario existente | Editar → cambiar email institucional → Guardar | El cambio pasa por edge `admin-update-email`; el login queda con el nuevo correo; si el correo está tomado o fuera de tenant, toast de error y aborta sin tocar el resto |
| USR-09 | Resetear contraseña de otro usuario | Usuario existente | Editar → tipear nueva contraseña → Guardar | Toast "…(contraseña incluida)"; el usuario queda con `must_change_password=true` (cambio forzado en su próximo login) |
| USR-10 | Ver contraseña temporal | Usuario recién creado, no ha cambiado su clave | Menú de fila → "Ver contraseña" → revelar/copiar | Muestra la temporal desde `admin_visible_passwords`; botón copiar → toast "Contraseña copiada"; si el usuario ya la cambió, no hay valor |
| USR-11 | Impersonar (Iniciar como) usuario no-Admin | Usuario Estudiante/Docente | Menú → "Iniciar como" → confirmar (tono warning) | Redirige a la app impersonando; el ícono usa `var(--brand-primary)` |
| USR-12 | No se puede impersonar a un Admin | Usuario con rol Admin | Menú → "Iniciar como" | Toast "No se puede impersonar a otro administrador"; no impersona |
| USR-13 | Desactivar usuario | Usuario activo | Menú → Desactivar → confirmar (destructive) | Toast "Usuario desactivado"; no puede iniciar sesión; libera cupo de licencia; auditoría `user.deactivated` |
| USR-14 | Reactivar sin cupo de licencia | Cuota de docentes al tope (ej. 5/5) | Reactivar un docente desactivado | Toast con el motivo real de la edge (ej. "No hay cupo de docentes (5/5)…"), extraído de `FunctionsHttpError.context` |
| USR-15 | Eliminar usuario (cascade) | Usuario existente | Menú → Eliminar → confirmar destructive | Toast "Usuario eliminado"; se borra vía `admin-delete-user` (cascade a profiles/user_roles/auth.users); recrear con el mismo email luego NO reporta colisión |
| USR-16 | Bulk delete con error parcial | Selección múltiple, uno con FK bloqueante | Seleccionar varios → eliminar en bulk | Toast warning "X eliminados, Y fallaron — revisá la consola"; los OK se van, el resto queda |
| USR-17 | Checkbox SuperAdmin oculto para Admin | Sesión Admin (no SA) | Abrir dialog crear/editar | La opción de rol "SuperAdmin" NO aparece; si se colara vía payload, la edge la ignora silenciosamente |
| USR-18 | Guardrail anti-huérfano [SA] | Sesión SuperAdmin | Editar usuario no-SuperAdmin dejando "Sin institución" | Toast "Solo el rol SuperAdmin puede no tener institución…"; no guarda |
| USR-19 | Filtro por institución [SA] | Sesión SuperAdmin, ≥1 tenant | Cambiar el Select de institución (Todas / una / "Sin institución") | La query recarga con `.eq('tenant_id',…)`/`.is(null)`; el grid muestra solo ese alcance; stats coherentes |
| USR-20 | Import masivo CSV | Sesión Admin | ImportExportMenu → descargar plantilla → subir CSV con `roles` separados por `\|` + `course_name` | Crea usuarios y los matricula; filas con `course_name` inexistente se rechazan con mensaje claro |
| USR-21 | Buscar + filtrar rol/estado | Grid con datos | Escribir en búsqueda; cambiar filtro de rol y de estado activo/inactivo | Filtra por nombre/emails/rol; multi-select sigue operando sobre TODO el filtrado (todas las páginas), no solo la página visible |
| USR-22 | Orden + paginación persistente | Grid con >25 usuarios | Ordenar por columna, cambiar de página, recargar | Orden y página persisten (localStorage); al filtrar vuelve a página 1; vacíos al final del orden |

**Checks UI/UX (Usuarios):** 375px sin scroll horizontal (columnas email/institución `hidden sm/md`, tabla scrollea dentro del Card); claro/oscuro; loading (`TableSkeleton`), empty (`TableEmpty`), error (`ErrorState` con Reintentar); toasts en español vía `friendlyError`; botón "ojo" de contraseña y acciones de fila con hit zone ≥32px; fechas creado/último acceso en es-CO (`DateCell`); `BadgeOverflow` en columna Roles con `+M`; a11y (labels con asterisco requerido, aria-labels en `RowActionsMenu`).

---

### Configuración → Modelo IA + failover (`/app/admin/settings` tab "Modelo IA")

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| AIM-01 | Guardar provider + modelo (tenant) | Sesión Admin, tenant con key | Elegir provider (Gemini/OpenAI), modelo, pegar API key → Guardar configuración | Toast "Configuración del modelo actualizada"; badge muestra provider · modelo; auditoría `ai_model.activated` warning |
| AIM-02 | Bloqueo por key faltante (tenant) | Tenant sin API key del provider activo | Cambiar provider sin pegar key → Guardar | Alert destructive "Falta la API key…"; botón Guardar disabled; toast bloqueante si se intenta |
| AIM-03 | Sentinel "__keep" no borra key | Key ya guardada | Abrir panel sin tocar la key → cambiar solo el modelo → Guardar | La key existente se conserva (placeholder `••••XXXX`); no se sobrescribe |
| AIM-04 | Failover: agregar/quitar claves de respaldo | Provider activo | "Agregar clave de respaldo" ×2 con la misma clave repetida → Guardar | Se guardan limpias (trim + dedup, sin vacíos); badge "N configurada(s)"; lista vacía → null |
| AIM-05 | Scope global permite key vacía [SA] | Sesión SuperAdmin cross-tenant | Editar la fila platform-default → dejar la key vacía → Guardar | Permite guardar; banner violeta "Default global de la plataforma"; aclara que las instituciones NO heredan |
| AIM-06 | Cambio de scope recarga | [SA] con "Ver como" | Alternar SuperAdmin ↔ "Ver como tenant" | El panel recarga la fila correcta (global vs tenant); banner cambia de color/texto |
| AIM-07 | Aislamiento RLS de secretos | 2ª institución con key propia | Como Admin del tenant A, intentar leer la fila de IA del tenant B por REST | RLS lo impide (SELECT solo Admin del tenant + SA); no se filtran API keys |
| AIM-08 | Botón Cancelar (descartar draft) | Cambios sin guardar | Modificar campos → Cancelar | Vuelve a los valores guardados; botón sólo visible cuando hay cambios |

**Checks UI/UX (Modelo IA):** 375px; claro/oscuro (banners violeta/indigo); loading/error (`ErrorState` con Reintentar); toasts español; `PasswordInput` con ojo (hit ≥32px) en key principal y de respaldo; key nunca se muestra completa (solo últimos 4); a11y (Label `required` cuando falta key en tenant, `HelpHint` en provider/modelo).

---

### Configuración → Correos SMTP (`/app/admin/settings` tab "Correos")

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| MAIL-01 | Kill switch global apaga todo | Sesión Admin | Apagar "Envío de correos habilitado" → Guardar cambios | Badge "Correos desactivados globalmente"; los toggles por categoría quedan disabled; ningún correo sale (in-app/push siguen) |
| MAIL-02 | Toggle por categoría | Envío global ON | Apagar "Bienvenida al curso" (`course_welcome`) → Guardar | Toast "Configuración guardada"; deja de enviarse el correo de bienvenida al inscribir; el resto de categorías intactas |
| MAIL-03 | Botón Guardar sólo con cambios | Sin modificar | Abrir panel | "Guardar cambios" disabled hasta que `dirty=true` |
| MAIL-04 | Lista de supresión: agregar | Panel cargado | En "Direcciones suprimidas" escribir un correo válido → Suprimir | Toast "Dirección agregada a la lista de supresión"; fila con badge de motivo (Manual); no se le envían correos |
| MAIL-05 | Supresión: email inválido | — | Escribir texto sin formato de email → Suprimir | Toast "Ingresa un correo válido"; no agrega |
| MAIL-06 | Supresión: reactivar (quitar) | Dirección suprimida | Acción quitar → confirmar (warning) | Toast "Dirección reactivada"; vuelve a recibir correos |
| MAIL-07 | SuperAdmin edita config global [SA] | Sesión SuperAdmin | Abrir panel de correos | Puede leer/editar (RLS `email_settings_update_admin OR is_super_admin`); supresión que agrega es global (`tenant_id=null`) |

**Checks UI/UX (Correos):** 375px (fila email + botón envuelve sin romper); claro/oscuro (Card destructive cuando global OFF); loading/error; toasts español; `RowAction` de quitar ≥32px; "Última actualización" con fecha es-CO (`formatDateTime`); a11y (Switch con Label asociada por `htmlFor`).

---

### Configuración → Módulos / Visibilidad (`AdminModuleVisibilityPanel`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| MOD-01 | Toggle de visibilidad por rol persiste al instante | Sesión Admin | Apagar un módulo para Estudiante | Toggle optimista + upsert; el ítem desaparece del sidebar del estudiante; si falla hace rollback + toast |
| MOD-02 | Módulo unificado "Calificaciones" | — | Togglear Calificaciones para Docente/Estudiante | Escribe los physical keys correctos (`gradebook`/`grades`); el sidebar respeta el toggle |
| MOD-03 | Reordenar (drag + flechas) → Guardar orden | — | Arrastrar/subir/bajar módulos → "Guardar orden" | Badge "cambios sin guardar" mientras hay diff; toast "Orden de módulos guardado"; sidebar refleja el nuevo orden; "Descartar" recarga desde DB |
| MOD-04 | "Ver como rol" + "Solo habilitados" | — | Elegir un rol en el filtro y activar "Solo habilitados" | Muestra sólo la columna del rol y sólo módulos ON (preview del sidebar); el reorder se deshabilita en ese modo |
| MOD-05 | Scope global vs override [SA] | Sesión SuperAdmin | Editar en scope global; luego "Ver como" tenant y sobrescribir | Global = default de todas; override aplica sólo a esa institución sobre el default; columna SuperAdmin sólo en scope global |
| MOD-06 | Módulos SuperAdmin-only ocultos en tenant | Sesión Admin | Abrir panel | "Instituciones" y "Sistema" NO aparecen (togglearlos sería no-op) |
| MOD-07 | Configuración accesible aunque oculta | Módulo "Configuración" apagado | Navegar por URL a `/app/admin/settings` | La ruta sigue accesible (escape hatch); sólo se ocultó del sidebar |
| MOD-08 | Admin siempre ve todo | — | Apagar un módulo Admin | El toggle afecta el sidebar; el Admin conserva acceso por `has_role` (nota informativa en el panel) |

**Checks UI/UX (Módulos):** 375px (matriz scrollea con `min-w-[480px]`, labels no se truncan); claro/oscuro (banner scope); loading (Spinner)/error (`ErrorState`); toasts español; grip/flechas ≥32px (`RowAction`); a11y (Switch por celda alineado con header, `HelpHint` de ayuda); persistencia via upsert `onConflict tenant_id,module_key,role`.

---

### Configuración → Compilador (`AdminCodeExecutionPanel`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| COMP-01 | Cambiar provider de código (tipo `codigo`) | Sesión Admin | Tab "Texto/Consola" → elegir AWS Lambda → Guardar configuración | Toast "Configuración de ejecución actualizada"; badge del provider activo; auditoría `code_execution.provider_changed` warning |
| COMP-02 | Provider Java GUI | — | Tab "Java GUI" → CheerpJ ↔ AWS screenshot → Guardar | Persiste `java_gui_provider`; lista de secrets requeridos actualizada en el Alert |
| COMP-03 | Provider Python GUI (único) | — | Tab "Python GUI" | Sólo "AWS Lambda + Xvfb"; sin alternativa (no hay Pyodide+tkinter en WASM) |
| COMP-04 | Secrets requeridos por selección | — | Cambiar provider y mirar el Alert | Lista los secrets exactos (`AWS_RUNNER_URL`, `ONLINE_COMPILER_API_KEY`, `JDOODLE_*`, etc.) según lo elegido |
| COMP-05 | Cancelar cambios | Draft modificado | Cancelar | Restaura el provider activo; botón sólo visible con cambios |
| COMP-06 | Configuración es global | 2 tenants | Verificar que no hay override por tenant | La config es única a nivel plataforma (advertencia "Configuración global para toda la plataforma") |

**Checks UI/UX (Compilador):** 375px (tabs con label corto en mobile); claro/oscuro (borde indigo/amber/sky por selección); loading/error; toasts español; radios con hit ≥32px (tarjeta clickeable completa); a11y (`RadioGroupItem` con Label `htmlFor`, `HelpHint`).

---

### Cola IA + Cron (`/app/admin/ai-cron`, tab Supabase)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| QUE-01 | Ver stats + filtrar cola de grading | Jobs en cola | Tab "Jobs" → filtrar por estado (pending/processing/failed/done/cancelled/todos) | Stats (pendientes/en proceso/fallados 24h/último éxito) coherentes; tabla filtrada; hasta 100 jobs |
| QUE-02 | Procesar un job ahora | Job pending | Expandir fila → "Procesar este job ahora" | Invoca `ai-grading-worker` con `{jobId}`; el job pasa a processing/done; realtime refresca (debounce ~800ms) |
| QUE-03 | Reintentar job fallido | Job failed | Botón "Reintentar" (icono RefreshCw) | Re-encola a pending (`requeue_ai_grading_job`); ícono distinto al de "procesar" |
| QUE-04 | Cancelar job | Job pending | "Cancelar" | `cancel_ai_grading_job`; estado cancelled |
| QUE-05 | Procesar todos (drain) | Varios pending | Botón global "Procesar ahora"/"Procesar todos" | Invoca worker sin jobId; drena la cola |
| QUE-06 | Detalle de error visible + copiar | Job failed con `last_error` | Ver preview 1 línea; expandir | Preview del error SIEMPRE visible sin click; panel expandible con error completo + botón "Copiar al portapapeles" |
| QUE-07 | Cola de generación (debajo) | Job de generación pending | Zap "Procesar ahora" / RefreshCw "Reintentar" según estado | El panel de generación (`ai_generation_queue`) se renderiza bajo el de grading; incluye `body` en el detalle |
| QUE-08 | Título resuelto correctamente | Jobs de examen/proyecto | Mirar la columna de título | Muestra examen/proyecto + estudiante (lookups en 3 pasos, sin embed `profiles`); nunca "Examen / Examen" |
| QUE-09 | Navegar al detalle | Job de examen (Docente) | Click "ver detalle" | `navigate({to:"/app/teacher/monitor/$examId", params})`; para Admin devuelve `null` (detalle vive en el panel expandible) |
| CRON-01 | Listar jobs pg_cron | Tab "Supabase" (Admin) | Abrir la tab | Lista `cron.job` con nombre, schedule (traducido a lenguaje natural), descripción, último run + status |
| CRON-02 | Pausar / reactivar job | Job activo | Switch active → pausar | `cron.alter_job` (UPDATE síncrono); toast + banner aclara "próximo tick ~1 min"; tras toggle re-verifica contra DB |
| CRON-03 | Editar schedule | Job existente | Ícono Pencil → nuevo cron expr → guardar | `admin_update_cron_job_schedule`; requiere `has_role Admin` + audita; no permite editar el command |
| CRON-04 | Editar descripción | Job existente | Ícono FileText → texto → guardar | Persiste en `cron_job_descriptions` |
| CRON-05 | processing_mode sync vs async | — | En tab "Modelo" cambiar `processing_mode` | `sync`: generación inline + cron drena; `async`: encola / pide código, cron NO drena (worker se autoexcluye) |

**Checks UI/UX (Cola/Cron):** 375px (tabla scrollea, jobname/schedule en `font-mono` con truncado); claro/oscuro; loading/empty/error; toasts español; realtime con debounce sin refresh-storm; touch ≥32px en acciones e íconos; fechas es-CO; filtros por estado; a11y (Switch pausa con label, íconos con tooltip/aria).

---

### Soporte / PQRS (`/app/admin/support` Admin → `/app/superadmin/support` SA)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| SUP-01 | Admin abre ticket | Sesión Admin | "Nuevo ticket" → categoría (petición/queja/reclamo/sugerencia/otro), asunto, mensaje → enviar | Ticket creado con status `open`; dispara notif "🎫 Nuevo ticket de soporte" a todos los SuperAdmins con link al ticket |
| SUP-02 | Admin ve sólo sus tickets | Tickets de otro Admin del mismo tenant existen | Listar mis tickets | Sólo aparecen los `created_by = yo` (RLS); no ve los de otros |
| SUP-03 | Chat realtime | Ticket abierto | Escribir mensaje (Ctrl+Enter) | Mensaje aparece en vivo (suscripción INSERT filtrada por ticket_id); notifica a la contraparte |
| SUP-04 | Adjuntar archivo | Ticket abierto | Adjuntar archivo ≤25 MB | Sube a bucket `support-attachments` con path `<ticket_id>/…`; descarga vía signed URL (60s); >25MB rechazado |
| SUP-05 | SA bandeja cross-tenant [SA] | Tickets de varios tenants | `/app/superadmin/support` con filtros | Ve todos los tenants; filtros por estado/tenant/búsqueda; default filter `active` (open + in_progress + waiting_admin) |
| SUP-06 | Auto-asignación al responder [SA] | Ticket `open` sin asignar | SA responde por primera vez | Pasa a `in_progress` y `assigned_to = SA`; notifica al `created_by` |
| SUP-07 | Cambio de status notifica | Ticket en curso | SA mueve a resolved/closed | Notif "🎫 Ticket actualizado" al creador con label humano del status; `resolved_at` se setea por trigger |
| SUP-08 | Admin no puede tocar campos SA | Ticket propio | Intentar editar `resolution_notes`/`assigned_to` vía UI/REST | RLS lo impide; Admin sólo puede cerrar o cambiar prioridad |
| SUP-09 | Canal correcto vs mensajes directos | Sesión Admin (no puede mensajear a SA) | Verificar que soporte reemplaza el chat directo Admin→SA | El chat 1-a-1 hacia un SuperAdmin está bloqueado (`can_message`); soporte es el canal PQRS |

**Checks UI/UX (Soporte):** 375px (dialog `max-w-[calc(100vw-2rem)]`, chat scrollea); claro/oscuro; loading/empty/error; toasts español; composer y botones ≥32px; fechas es-CO; stats 4-card (Admin); filtros SA; a11y (Ctrl+Enter para enviar, foco en composer).

---

### Papelera (`/app/trash`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| TRA-01 | Listar items borrados | Entidades soft-deleted (curso/examen/etc.) | Abrir Papelera | Lista unificada de las 8 entidades (+ tenants para SA); columnas nombre/tipo/eliminado por/fecha/purga en; stats 4-card |
| TRA-02 | Restaurar item | Un examen en papelera | Acción "Restaurar" | RPC `trash_restore_item`; toast "…restaurado"; el examen reaparece en su listado normal |
| TRA-03 | Restaurar curso cascadea | Curso borrado con hijos | Restaurar el curso | Restaura el curso + hijos (mismo timestamp) vía `restore_*_cascade`; la lista se recarga (no quedan filas fantasma) |
| TRA-04 | Eliminar definitivo | Item en papelera | "Eliminar definitivo" → confirmar destructive | RPC `trash_hard_delete_item`; borra físico con cascade; toast "Eliminado definitivamente"; irreversible |
| TRA-05 | Bulk restaurar / eliminar con error parcial | Selección múltiple, uno con FK RESTRICT | Seleccionar varios → bulk hard-delete | Toast "X eliminado(s), Y con error. Primero: \"nombre\" — <friendlyError>" (12s); los OK se van |
| TRA-06 | Badge de días para purga | Items con distinta antigüedad | Mirar columna "Purga en" | ≤3d en rojo, ≤7d en ámbar, resto muted; tooltip explica purga automática a 30 días |
| TRA-07 | **Soft-delete invisible en TODO flujo** | Taller de un estudiante enviado a papelera | Como Estudiante revisar calendario, dashboard/agenda, lista de talleres, notas, Tutor IA, y unirse a Reto en vivo por PIN de un poll borrado | El taller/examen/poll NO aparece en NINGÚN flujo ni rol; el join por PIN de un poll borrado devuelve error como PIN inválido |
| TRA-08 | Filtro por tipo + búsqueda | Papelera con varias entidades | Cambiar Select de tipo; buscar por nombre/eliminado por | Filtra; el conteo por tipo del Select es absoluto (sobre todos los items); multi-select abarca todas las páginas |
| TRA-09 | Aislamiento por rol/tenant | 2ª institución con items borrados | Como Admin del tenant A abrir Papelera | Sólo ve items de su tenant; Docente sólo de sus cursos; Estudiante no accede (RBAC) |
| TRA-10 | Soft-delete de institución [SA] | Institución con cursos | Enviar tenant a papelera desde `/app/superadmin/tenants` | Cascadea a las 8 entidades; los profiles pierden acceso (Select de institución en /auth filtra `deleted_at`); restaurable 30d |

**Checks UI/UX (Papelera):** 375px (columnas `hidden sm/md`, tipo repetido como badge en mobile); claro/oscuro; loading (Spinner)/empty (`TableEmpty` distingue vacío vs filtrado)/error (`ErrorState` con Reintentar); toasts español; `RowAction` restaurar/eliminar ≥32px; fechas es-CO (`DateCell` datetime); paginación 25; orden por columna (vacíos al final); `LoadingOverlay` durante bulk; a11y (checkboxes `MultiSelect`).

---

### Auditoría (`/app/admin/audit-logs`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| AUD-01 | Listar y expandir eventos | Eventos existentes | Abrir Auditoría → expandir una fila | Muestra actor/acción/categoría/severidad/entidad + `metadata` completo al expandir |
| AUD-02 | Filtros (curso, severidad, fechas, búsqueda) | Datos variados | Aplicar filtro por curso, severidad, rango de fechas (`DatePicker`), texto | La lista se acota; el filtro por curso sólo en modo admin; limpiar filtros funciona |
| AUD-03 | Exportar CSV / XLSX | Lista filtrada | Menú Descargar → CSV y XLSX | Descarga con separador/encoding correctos; contenido = filas visibles |
| AUD-04 | Etiquetas de acción en español | Eventos con acciones conocidas | Ver columna acción | Muestra label traducido (`audit.actionLabels.*`); acciones desconocidas caen al slug crudo sin romper |
| AUD-05 | Modo docente RLS | Sesión Docente | Abrir Auditoría del docente | Sólo eventos de sus cursos (RLS); sin filtro cross-tenant |
| AUD-06 | Logs de edge visibles al Admin del tenant | Evento generado por edge (bulk import) | Como Admin buscar ese evento | Aparece con `tenant_id` correcto (la edge pasa `tenantId` del destino; sin eso lo vería sólo el SA) |
| AUD-07 | Aislamiento cross-tenant | 2ª institución | Como Admin del tenant A | No ve eventos del tenant B (RLS exige `tenant_id = current_tenant_id()`) |

**Checks UI/UX (Auditoría):** 375px (tabla scrollea, columnas progresivas); claro/oscuro (íconos de severidad); loading (`TableSkeleton`)/empty/error; toasts español; íconos de expandir/descargar ≥32px; fechas es-CO; orden + paginación persistente; a11y (chevrons con estado, `DropdownMenu` navegable).

---

### Estadísticas (`/app/admin/statistics`)

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| EST-01 | Cargar KPIs/gráficos | Sesión Admin con datos | Abrir Estadísticas | Renderiza métricas del tenant sin errores; números coherentes con `course_enrollments`/cursos |
| EST-02 | Estado vacío | Tenant sin actividad | Abrir Estadísticas | Empty state claro (no gráficos rotos ni NaN) |
| EST-03 | Filtro cross-tenant [SA] | Sesión SuperAdmin | Cambiar filtro "Todas las instituciones / Por institución" | Recalcula por tenant; con `ids.length===0` corta antes del `.in()` (no devuelve todo) |
| EST-04 | Aislamiento | 2ª institución | Como Admin del tenant A | Sólo ve métricas de su tenant (RLS) |

**Checks UI/UX (Estadísticas):** 375px (grids `grid-cols-1 sm:grid-cols-2 …`); claro/oscuro (colores de gráficos legibles en ambos); loading/empty/error; toasts español; fechas/números es-CO; a11y (ejes/leyendas con contraste).

---

### SuperAdmin → Instituciones / Tenants (`/app/superadmin/tenants`) **[SA]**

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| TEN-01 | Crear institución (happy path) | Sesión SuperAdmin | "Nueva institución" → slug, nombre, dominio, branding, cuotas → Guardar | Toast "Institución creada"; luego dialog con credenciales del usuario de prueba (se muestran UNA sola vez) |
| TEN-02 | Slug inválido | Dialog crear | Slug con mayúsculas/espacios o <3 chars → Guardar | Toast "Slug inválido: usa minúsculas, números y guiones (3-50)…"; no crea |
| TEN-03 | Slug/nombre obligatorios | Dialog crear | Dejar slug o nombre vacío → Guardar | Toast "Slug y nombre son obligatorios" |
| TEN-04 | Cuota inválida | Dialog crear | `max_students` = -1 o decimal → Guardar | Toast "Cuota inválida para …. Debe ser entero ≥ 0 (o vacío = ilimitado)"; aborta |
| TEN-05 | Cuota vacía = ilimitado | — | Dejar cuotas en blanco → Guardar | Se persisten como NULL (ilimitado); el trigger `tg_check_tenant_user_quota` no bloquea |
| TEN-06 | Subir logo (validación) | Dialog crear/editar | Subir archivo >2MB o formato no soportado | Toast "El logo no puede pesar más de 2 MB." / "Formato no soportado. Usa PNG, JPG, SVG o WebP."; en crear se stashea y sube al guardar |
| TEN-07 | Ver como institución | Institución existente | Menú → "Ver como" | Toast "Viendo como: X"; banner azul + branding del tenant aplicado in-place (sin recarga) |
| TEN-08 | Salir del modo institución | Override activo | Botón "Salir del modo institución" (clearViewAs) | Toast "Volviste al modo cross-tenant"; branding default OKLCH restaurado |
| TEN-09 | Iniciar sesión como Admin | Tenant con ≥1 Admin | Menú → "Iniciar sesión como" → confirmar warning | Reemplaza la sesión por la del Admin más antiguo; recarga; ícono usa el primary del tenant |
| TEN-10 | Tenant sin Admin | Tenant sin usuario Admin | Menú → "Iniciar sesión como" | Toast "X no tiene Admin asignado. Crea o asigna uno…"; no impersona |
| TEN-11 | Gestionar usuarios | Institución existente | Menú → "Gestionar usuarios" → marcar/desmarcar → guardar | Diff aplica `profiles.tenant_id`; quitar con confirm destructive; el trigger rechaza usuarios con cursos activos en el tenant viejo (error friendly, sigue el batch) |
| TEN-12 | Configurar correo del tenant | — | Menú → "Configurar correo" | Abre `TenantEmailSettingsDialog` (SMTP propio del tenant; si no, usa el global) |
| TEN-13 | Duplicar institución | Institución con branding/cuotas | Menú → "Duplicar institución" | Abre form de creación pre-llenado con branding + cuotas; slug/nombre/logo/dominio en blanco; no crea hasta guardar |
| TEN-14 | Pausar / reactivar | Institución activa | Menú → Pausar → confirmar warning | Toast; badge cambia Activa↔Pausada (`is_active`) |
| TEN-15 | Enviar a papelera | Institución existente | Menú → Eliminar → confirmar destructive | `soft_delete_tenant`; toast "X fue enviada a la papelera"; aparece en `/app/trash` (30d) |
| TEN-16 | Gate de rol | Sesión no-SuperAdmin | Navegar por URL a `/app/superadmin/tenants` | Redirige a `/app`; y aunque llegara, la RLS de `tenants` rechaza INSERT/UPDATE/DELETE |
| TEN-17 | Orden + paginación | ≥25 tenants | Ordenar por nombre/slug/estado, paginar | Orden persistente; vacíos al final |

**Checks UI/UX (Tenants):** 375px (dialog `max-w-[calc(100vw-2rem)] sm:max-w-lg`, columna dominio `hidden sm`); claro/oscuro (`HexColorInput`, preview de logo); loading (`SectionLoader`)/empty (`TableEmpty` con CTA)/error (`ErrorState`); toasts español; botones copiar credenciales ≥32px; a11y (Label `required` en slug/nombre, `RowActionsMenu` con hints); guard de cambios sin guardar (`useDirtyDialog`).

---

### SuperAdmin → Diagnósticos (`SystemDiagnosticsPanel`, `/app/superadmin/system` / `/app/admin/system`) **[SA/Admin]**

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| DIAG-01 | Refrescar diagnóstico | Panel abierto | Botón "Refrescar diagnóstico" | Corre health-check + DB + push en paralelo; cada card muestra verde/ámbar/rojo con latencia |
| DIAG-02 | Card IA sin secret | Provider activo sin su secret | Refrescar | Card AI en rojo "…API key falta"; el resto de cards independientes |
| DIAG-03 | Card SMTP | Secrets SMTP parciales | Refrescar | Valida los 5 (`SMTP_HOST/PORT/USER/PASSWORD`, `EMAIL_FROM`); ok si todos, error si ninguno, warning si faltan algunos |
| DIAG-04 | Card Web Push + prueba | Config push + suscripción | "Push de prueba" | Encola notification (chain trigger→send-push); botón disabled si config o secrets VAPID/PUSH_TRIGGER_SECRET faltan |
| DIAG-05 | Dispositivos Míos / Todos | Suscripciones existentes | Tab "Todos" | Carga vía RPC `admin_list_push_subscriptions` (Admin acotado a tenant, SA cross-tenant) |
| DIAG-06 | Cards Cron / Extensiones / Edge functions | health-check OK | Revisar cards | Cron: warning si jobs inactivos/fallidos; Extensiones: warning si falta `pg_net/pgcrypto/uuid-ossp`; edge functions con última invocación |
| DIAG-07 | Deploy viejo del edge | health-check sin algún campo | Refrescar | Los cards degradan a "no disponible" sin romper el render (lecturas defensivas) |

**Checks UI/UX (Diagnósticos):** 375px (grid `lg:grid-cols-2`, un card por fila en mobile); claro/oscuro (bordes verde/ámbar/rojo, `UsageBar`); loading (`Spinner` por card)/idle ("Click refrescar")/error; toasts español; botones ≥32px; fechas es-CO (`formatDateTime`); a11y (badges de estado con ícono + texto).

---

### SuperAdmin → Calculadora de precios (`/app/superadmin/pricing-calculator`) **[SA]**

| ID | Caso | Precondición | Pasos | Resultado esperado |
|----|------|--------------|-------|--------------------|
| PRC-01 | Gate de rol | Sesión no-SuperAdmin | Navegar por URL | Redirige a `/app` (no herencia desde Admin en esta ruta) |
| PRC-02 | Auto-sugerir plan por volumen | Panel cargado | Cambiar "Matrículas activas" (ej. 250 → 5000) | El plan se autoselecciona (Starter/Pequeña/…); al elegir plan manual deja de auto-sugerir |
| PRC-03 | Cálculo de cotización | Inputs completos | Ajustar modelo, margen, storage extra, add-ons | Hero (precio sugerido/final, costo total) + desglose + $/matrícula recalculan en vivo |
| PRC-04 | Aislamiento add-on por modelo | Modelo = 3 | Intentar activar "Aislamiento dedicado" | El toggle queda disabled (ignorado en modelo 3) |
| PRC-05 | Margen limitado a 99% | — | Escribir margen 150 | Se limita a 99; `DecimalInput` con coma (ej. "90") |
| PRC-06 | Warnings | Config que dispara warning | Ajustar parámetros que produzcan advertencia | Card ámbar con las advertencias del motor |
| PRC-07 | Exportar escala CSV | Panel con datos | "Exportar escala (CSV)" | Descarga `examlab-escala-precios-modeloN.csv` con separador `;`, decimales con coma y BOM; toast "Escala exportada a CSV" |
| PRC-08 | Fuente de supuestos | Tabla `pricing_assumptions` vacía | Abrir panel | Subtítulo "Supuestos por defecto (tabla no configurada)"; usa `FALLBACK_ASSUMPTIONS` sin romper |

**Checks UI/UX (Calculadora):** 375px (grid `lg:grid-cols-[340px_1fr]` colapsa a 1 columna, tablas scrollean); claro/oscuro; loading (`SectionLoader`); toasts español; `DecimalInput` con coma y `HelpHint`; moneda/porcentaje/números en es-CO (`toLocaleString('es-CO')`); a11y (Label `required` en matrículas/margen, `Switch` con label en `ToggleRow`).
