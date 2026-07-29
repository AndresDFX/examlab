# Plan de mejoras UX — ExamLab

> Auditoría de código (sin navegador): todo lo que se afirma del estado actual sale de leer el JSX y
> las clases Tailwind, con `file:line`. Lo que es cuestión de gusto está marcado como tal.
> Fecha: 2026-07-29.

---

## 1. Diagnóstico (5 líneas)

1. **Falta un nivel de navegación.** El curso es un ítem entre 22 del sidebar (`AppLayout.tsx:142-481`), no el contenedor de los demás; el sustituto degradado es el mismo `<Select>` de curso repetido en **14 pantallas** (`ListFilters`, 27 usos en 14 archivos de `src/routes`).
2. **El inicio informa y no permite trabajar.** Los 7 `<Button>` de `app.index.tsx` son `variant="ghost" size="sm" text-xs` (`:631, 688, 1216, 1255, 1677, 2138, 2198`): cero acciones primarias, y las filas de agenda no tienen destino (`EventRow`, `:1860-1893`, sin `onClick` ni `Link`).
3. **No hay escala compartida.** El theme define 40+ tokens de color y ninguno de `font-size` (`src/styles.css:9-48`) → **1.108** tamaños en px escritos a mano y **9 sistemas de padding de página** conviviendo.
4. **Una consola de operaciones se envió como feature del docente**: "Target" con `submissions/a3f2b1c8…` y "Body del request" con el JSON crudo (`UnifiedAiQueuePanel.tsx:1872-1911`), más "job/worker/drenar" en 150 claves de i18n.
5. **Un molde para toda tarea.** `PageHeader + ListFilters + Table + sort + paginación + RowActionsMenu` es correcto para 13 listados y se aplicó igual a "calificar 40 entregas" y "revisar mis notas". El contraejemplo interno prueba que el equipo sabe diseñar por tarea: el Reto en vivo (`app.teacher.kahoot.$gameId.tsx:373-467`) tiene fullscreen, PIN `text-7xl` y countdown `h-28 w-28` porque su tarea no se parece a ninguna otra.

**Resumen:** el problema no es que falte design system — existe y está documentado. Es que hay **capas de decisiones locales encima de un sistema que ya estaba bien**, y falta la estructura (navegación por curso) que evitaría la repetición.

---

## 2. Los 10 problemas priorizados

Ordenados por impacto/esfuerzo. Esfuerzo: **S** ≤ 1 día · **M** 2-5 días · **L** ≥ 2 semanas.

| # | Problema | Evidencia (`file:line`) | Qué le cuesta al usuario | Esf. | Imp. |
|---|---|---|---|---|---|
| 1 | **29 iconos de encabezado pisan el color de la institución.** `PageHeader` ya envuelve el icono en `text-primary` (= color del tenant); 29 rutas lo sobreescriben con un hue crudo | `app.videos.tsx:747` cyan-500 · `app.messages.tsx` cyan-**400** · `app.certificates.tsx:418` amber · `app.teacher.students.tsx:254` violet · `app.admin.ai-prompts.tsx:44` indigo **vs** `app.teacher.ai-prompts.tsx:378` amber (mismo módulo, distinto rol) | Una institución con marca roja ve indigo, pink, violet y dos cianes distintos en sus encabezados: el feature estrella del producto no funciona donde más se mira. Un usuario multi-rol ve el mismo módulo de otro color al cambiar de rol | S | Alto |
| 2 | **Doble padding de página en 17 rutas.** El shell ya aplica `px-4 md:px-8 py-5 md:py-8`; 17 rutas suman `container mx-auto p-4 sm:p-6` encima | Shell: `AppLayout.tsx:1722-1727`. Ofensoras: `app.certificates.tsx:391`, `app.preferences.tsx:320`, `app.student.calendar.tsx:344`, `app.student.certificates.tsx:278`, `app.admin.system.tsx:20`, `app.admin.email-settings.tsx:35/43/68`, `app.forum.$courseId.tsx:421`, `app.forum.$courseId.$forumId.tsx:281`, `app.forum…$threadId.tsx:446/458/470/481`, `app.teacher.question-bank.tsx:719/734`, `app.student.tutor.$courseId.tsx:287` | Al navegar Cursos → Certificados el contenido salta 24px; en monitores anchos unas pantallas van full-width y otras capean a 1536px. El fix y su justificación ya están escritos en `AuditLogsView.tsx:532-538` — nunca se propagó | S | Alto |
| 3 | **Jerga de infraestructura en el módulo "Cola" del docente.** "Target" → `submissions/<uuid>`; "Body del request" → `JSON.stringify` en `<pre>` a 10px | `UnifiedAiQueuePanel.tsx:1872-1875` y `:1906-1908`. Claves: "job/jobs" ×126, "worker" ×12, "drenar/drain" ×12. Se filtra fuera: `toast.routes_app_teacher_monitor_examId.jobsQueued` = "{{count}} job(s) encolado(s)…" | El docente entra a este módulo justo cuando algo falló — el peor momento para leer un nombre de tabla, un UUID y un JSON. Tiene una pregunta ("¿se calificó?, si no ¿por qué?") y recibe 13 campos | S | Alto |
| 4 | **La pantalla de login muestra opciones internas.** El `<Select>` de institución lista `— SuperAdmin: vista cross-tenant —` y debajo `URL: /t/fesna` en `<code>` | `auth.index.tsx:527-546`; el rechazo asociado es `auth.crossTenantOnlySuperAdmin` | Todo estudiante y docente ve, en la primera pantalla del producto, una opción para la que será rechazado y un `slug` técnico. Único lugar donde "cross-tenant" llega a usuarios finales, y el de más tráfico | S | Medio-alto |
| 5 | **El inicio no tiene una sola acción primaria y las filas están muertas.** 4 tiles iguales cuyas etiquetas dicen todas "pendientes"; la acción real vive en modal-dentro-de-modal | Tiles: `app.index.tsx:1103-1149` (docente) y `:1587-1619` (estudiante), render común en `:1738-1753`. Único camino a calificar: tile → `Dialog` (`:1280-1320`) → `CourseDiagnosticDialog.tsx:816` (6 tabs, 5 StatPills) → botón real en `:964-975`. `EventRow` (`:1860-1893`) sin destino. Estudiante: 1 solo enlace saliente (`:1676`) | El docente lee "Pendientes de calificación: 37" y no hay botón para calificar; aprende en 5 s que el inicio no sirve y usa el sidebar. El alumno hace click en un examen que dice "En curso" y no pasa nada, mientras el calendario de al lado **sí** navega (`StudentEventsCalendar.tsx:829-832`) | M | Alto |
| 6 | **Gradebook: 93 alumnos sin encabezado fijo, sin orden y sin paginación.** No hay `sticky top` en el archivo ni en `components/ui/table.tsx`; el archivo no importa `usePagination`/`useTableSort` (los 13 grids restantes sí) | `app.teacher.gradebook.tsx:2145`, `:2230`, `:3065`, `:3128-3190` (`sticky left-0` sí, `sticky top` no). Fila ≈ 60px (`DecimalInput h-8` + `min-h-[1.125rem]`) × 93 ≈ **5.600px de scroll**. Tinte de corte que se cicla en 4 tonos (`:2153-2158`) | Pasada la fila ~12 se capturan notas en columnas anónimas; con 5 cortes el 1 y el 5 son del mismo color. Sin orden por columna, saber quién pierde el curso es leer 93 celdas. Celda de nombre 192px (`max-w-48`) con nombre+email truncados: dos homónimos no se distinguen | M | Alto |
| 7 | **Grid de exámenes: 1.224px de columnas para ~960px de ancho, y la acción diaria enterrada.** 12 columnas fijas; las dos que sirven para actuar (Estado, Acciones) son las últimas | Columnas y anchos: `app.teacher.exams.index.tsx:873-910` (`w-10+w-48+w-32+w-24+w-16+w-28+w-28+w-24+w-24+w-24+w-28+w-20`). 4 StatCard que duplican el filtro de abajo y no son clickeables (`:776-798` vs `ActivityStatusSelect.tsx:23-27`; `stat-card.tsx:44` acepta `onClick`, ninguna lo pasa). Talleres: **Calificar** es el 4º label de 7 en el menú de tres puntos (`app.teacher.workshops.tsx:3196-3280`); Contenidos: **14** items (`app.teacher.contents.tsx:1643-1786`) | ~250px de cromo antes de la primera fila (≈6 filas menos). `table-fixed` comprime el título a ~18 caracteres — el dato que identifica la fila. En Contenidos, con 4 badges `shrink-0` el nombre queda con ~30px (`:1451-1520`): la jerarquía está invertida en el CSS. Y calificar cuesta 2 clicks + escanear 7 labels | M | Medio-alto |
| 8 | **No hay tokens de tamaño de texto.** `@theme` define 40+ tokens de color/radio/fuente y **cero** `--text-*` | `src/styles.css:9-48`. A mano: `text-[11px]`×548, `text-[10px]`×497, `text-[9px]`×55, `text-[12px]`×6 (idéntico a `text-xs`), `text-[8px]`×2 → **7 tamaños bajo 16px**. `app.teacher.monitor.$examId.tsx` mezcla tres en la misma tabla: `:2115` (11px), `:2890` (10px), `:2948` (9px) | Tres badges de estado con letra de 9, 10 y 11px en la misma tabla no leen como jerarquía: leen como azar. Es la **causa raíz** — sin token, cada pantalla nueva vuelve a inventar su tamaño | M | Alto |
| 9 | **Crear examen: 17 controles en pila plana en un modal de 512px, ordenados como el `INSERT`.** Cero agrupación (un solo `space-y-3`) | `app.teacher.exams.index.tsx:1085-1602`; el `<div className="space-y-3">` de `:1089` es el único contenedor. 8 condicionales `{!is_external && …}` sueltos (`:1242, 1252, 1291, 1320, 1347, 1359, 1577`). Mismo patrón en `app.teacher.workshops.tsx:3303-3865` | Scroll de ~1.400px para crear un examen, decidiendo sobre 6 campos de motor que ya vienen con default (`openNew`, `:420-434`), y al terminar el examen **no tiene preguntas** (`save()` navega al detalle, `:651`). El patrón de agrupación ya existe en el repo y no se aplicó: `app.admin.users.tsx:2340` (`rounded-md border p-3` con título + `HelpHint`) | M | Medio |
| 10 | **Navegación de un solo nivel: 22 ítems planos, sin grupos ni búsqueda, y el hub de curso escondido.** El tablero por curso existe (1938 líneas) y no está en el nav | Nav: `AppLayout.tsx:1132-1197` (`space-y-0.5`, filas ≈38px → **~836px** de lista; los últimos ítems del docente quedan bajo el pliegue en 768px de alto). 22 iconos monocromos (`NAV_ICON_BASE_CLASS`, `:581`, aplicado en `:1175` y `:1191`). Sin búsqueda: `cmdk` existe (`src/components/ui/command.tsx`) y se usa en **1** lugar (`app.teacher.attendance.tsx`). Tablero: `app.teacher.board.$courseId.tsx` — `grep 'teacher/board'` en `AppLayout.tsx` = **0 hits**; única puerta es una acción de fila (`app.admin.courses.tsx:2276`). La prioridad real por rol ya está escrita (`BOTTOM_NAV_PRIORITY`, `:495-524`) y se usa **solo en móvil** | Escaneo lineal sobre 22 etiquetas monocromas, parte fuera de pantalla, en cada navegación. La pieza más valiosa del producto es la menos alcanzable. Y es la causa raíz de los 14 `<Select>` de curso duplicados | L | Alto |

**Nota de causalidad:** los problemas 5, 7 y 9 comparten origen con el 10. El patrón rígido "4 stats + 2 cards" (documentado como invariante en CLAUDE.md) se aplicó igual a los 4 roles: para que las tareas encajaran hubo que colgar acciones de modales, inventar un cuarto contador donde solo importaban tres ("Cola (pendientes)" en Docente; el duplicado "Próximos exámenes" en Estudiante — el tile `:1591` y la card `:1650` muestran el mismo array `upcomingExams`) y dejar las listas sin navegación para que la altura calzara en `lg:h-[calc(100dvh-5rem)] lg:overflow-hidden` (`:133`).

---

## 3. Principios de diseño a fijar

Pocos, con regla verificable. La idea es que se puedan comprobar con `grep` o en un code review de 30 segundos, y que entren a CLAUDE.md.

### P1 — El padding de página lo provee el shell
`AppLayout.tsx:1722-1727` ya aplica `px-4 md:px-8 py-5 md:py-8`.
**Regla verificable:** el `<div>` raíz de una ruta solo lleva `space-y-*` (y `flex`/`grid` si hace falta). Prohibido `p-*`, `px-*`, `py-*`, `container`, `mx-auto`, `max-w-screen-*`.
**Check:** `grep -n 'container mx-auto' src/routes/*.tsx` → 0 resultados.

### P2 — Tres tamaños de texto bajo `text-sm`, todos con nombre
Agregar a `src/styles.css` (`@theme`):
```css
--text-2xs: 0.625rem;   /* 10px — metadata de fila, badges dentro de celda */
--text-3xs: 0.5625rem;  /* 9px  — solo sub-badges anidados */
```
**Regla verificable:** la escala completa es `text-3xs · text-2xs · text-xs · text-sm · text-base · text-lg · text-xl · text-2xl`. Prohibido `text-[Npx]`.
**Check:** `grep -rn 'text-\[[0-9]*px\]' src/` → 0 resultados.

### P3 — El color de acento pertenece a la institución, no a la pantalla
`PageHeader` pinta su icono con `text-primary` (CSS var del tenant, `page-header.tsx`).
**Regla verificable:** el icono pasado a `icon=` de `PageHeader` lleva **solo** `className="h-6 w-6"`. Los estados usan los tokens semánticos (`--success`, `--warning`, `--destructive`), no hues crudos.
**Check:** `grep -rn 'PageHeader' -A3 src/routes | grep -E 'text-(cyan|indigo|violet|pink|amber|sky|rose|emerald)'` → 0 resultados.
*Excepción legítima:* colores por dato (picker hex del tenant, dots por tipo de evento en el calendario) y los tiles del dashboard si se decide mantener el código de color por entidad — eso es gusto, decide el dueño.

### P4 — Una acción primaria por pantalla, y tiene que ser un botón primario
**Regla verificable:** toda pantalla de trabajo tiene exactamente **un** `<Button>` sin `variant` (o `variant="default"`) por encima del pliegue, y es la tarea que el usuario vino a hacer. Los tiles de conteo no cuentan como acción.
**Check:** en `app.index.tsx` hoy: 7 `<Button>`, **0** primarios.

### P5 — Si una fila representa algo, la fila entera es la puerta
**Regla verificable:** una fila de lista que muestra una entidad es `<Link>` (o `<button>` con `role`/`tabIndex`) con estado `hover:bg-accent`. Nunca un `<div>` con `border` que parece clickeable y no lo es. Si un tile de conteo abre algo, es un `<button>` alcanzable por teclado — hoy `Stat` pasa `onClick` a `Card`, que renderiza un `<div>` sin `role` ni `tabIndex` (`card.tsx:5-12`).
**Check:** ningún `onClick` sobre `Card`/`div` sin `role="button"` + `tabIndex={0}`.

### P6 — La etiqueta nombra la tarea del usuario, no el mecanismo
**Regla verificable:** un texto visible no contiene: nombre de tabla o columna (`submissions`, `session_date`, `period_id`), UUID, `job`, `worker`, `drain/drenar`, `pending/processing/failed/done` sin traducir, `cron`, `edge function`, `slug`, `tenant`, `cross-tenant`. Si el dato técnico es necesario para soporte, va detrás de un "Detalle técnico" visible solo para Admin/SuperAdmin.
**Check:** `grep -iE '"(.*)(job|worker|drenar|slug|cross-tenant|target)' src/i18n/locales/es.json` → solo claves internas.

### P7 — Una columna de grid existe si sirve para decidir sobre la fila
La configuración que el docente fijó una vez al crear (duración, navegación, tipo, modo) va al detalle, no a la lista.
**Regla verificable:** ≤ 8 columnas visibles en `lg`; la suma de `w-*` declarados ≤ 900px; el identificador de la fila (título/nombre) es la única celda con `flex-1`, y ningún adorno de la misma celda es `shrink-0` cuando el nombre puede truncar.
**Check:** en Exámenes hoy 12 columnas / 1.224px; en Contenidos 8 columnas y **0** con `hidden *:table-cell`.

### P8 — Un formulario con más de 8 campos se agrupa
**Regla verificable:** ≥ 9 controles ⇒ secciones con título (`rounded-md border p-3 space-y-3`, el patrón que ya usa `app.admin.users.tsx:2340`), y todo lo que tenga un default razonable va en una sección colapsada "Opciones avanzadas". El orden de las secciones es el orden de las decisiones del usuario, no el del `INSERT`.

### P9 — Cada tarea larga tiene un estado intermedio con expectativa
Las operaciones caras del producto (calificar con IA 5-15 s, bulk import de 93 alumnos, generación encolada) no se sirven con spinner + toast final.
**Regla verificable:** toda operación > 3 s muestra progreso (n de N) o, si es asíncrona, la promesa explícita ("Te avisamos cuando esté; podés seguir trabajando"). El instinto correcto ya existe en un lugar: `performSubmit` del examen await solo la entrega y dispara notificación e IA con `void` (300 ms percibidos en vez de 10 s).

---

## 4. Propuesta por pantalla (4 de mayor impacto)

Las 4: **Inicio del Docente**, **Inicio del Estudiante**, **Sidebar / navegación**, **Grid de Exámenes** (canónico de los 13 listados).

---

### 4.1 Inicio del Docente — `src/routes/app.index.tsx:1095-1270` (`TeacherDashboard`)

#### Antes (lo que se renderiza hoy)

- Wrapper `flex flex-col gap-4 lg:h-[calc(100dvh-5rem)] lg:overflow-hidden` (`:133`) → el inicio nunca hace scroll de página; todo scrollea dentro de las cards.
- **Bloque 1 — saludo:** `<h1 className="text-2xl md:text-3xl font-semibold">` con "Hola, {nombre}" (`:135-137`) + `<p className="text-muted-foreground">` con "Panel docente" (`:139-146`). Es el elemento tipográficamente más grande de la pantalla (30px) y no contiene información; el subtítulo repite lo que el selector de rol dice a 15 cm (`AppLayout.tsx:1089-1119`).
- **Bloque 2 — 4 tiles** en `grid grid-cols-2 md:grid-cols-4 gap-3` (`:1102-1150`). Cada uno: `Card` + `CardContent p-4`, label `text-xs line-clamp-2`, valor `text-2xl font-semibold tabular-nums`, caja de icono `h-9 w-9 rounded-lg bg-muted/50` (`:1738-1753`). Alto ≈ 90px. Etiquetas en orden: "Notas de examen pendientes" (violet) · "Cola (pendientes)" (indigo) · "Comentarios pendientes por respuesta" (rose) · "Pendientes de calificación" (blue). Los cuatro con el mismo peso; ninguno destacado; el #2 es infraestructura y el #1 se solapa con el #4. Al click: modal / navegación / modal / modal — el aspecto no predice el comportamiento. No son alcanzables por teclado (`card.tsx:5-12`).
- **Bloque 3 — 2 cards** en `grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1 min-h-0`: "Próximas clases" (`CalendarClock` cyan) y "Próximos exámenes" (`FileText` violet), títulos `text-base`, padding heredado `p-6` (24px, contra los 16px de los tiles de arriba). Dentro, `EventRow` = `div flex items-start gap-2 p-2 rounded-md border` (`:1878`) — borde dentro de borde, sin `hover`, sin destino. Pie de cada card: `<Button variant="ghost" size="sm" className="w-full text-xs">` con la palabra **"Gestionar"** en las dos (`:1216` y `:1255`).
- **Vacío:** dos `<p className="text-sm text-muted-foreground py-6 text-center">` ("No tienes sesiones próximas programadas.", "Sin exámenes próximos"). `EmptyState` se usa **0 veces** en el archivo (`grep -c` = 0), aunque el componente soporta `action`.
- **Ausencias:** ningún enlace a Calificaciones aunque sea uno de los 4 números; ningún enlace al tablero de curso.

#### Después

El inicio deja de ser un informe y pasa a ser **una cola de trabajo con un titular**. Tres bloques:

1. **Titular accionable** (reemplaza el saludo de 30px): una franja con la tarea más urgente y **un botón primario**. Ej. "37 entregas esperan nota — 12 vencen hoy" + `[Calificar ahora]`. Si no hay nada urgente, la franja dice lo próximo del día ("Clase de Paradigmas a las 14:00, salón 302") con `[Ver clase]`.
2. **3 colas navegables** (no 4 contadores): "Por calificar", "Esperan mi respuesta", "Clases de hoy". Cada una es un **panel con las primeras 3-4 filas reales**, cada fila con destino directo, y pie "Ver las 37". Se elimina el tile "Cola (pendientes)" del inicio: es infraestructura y vive en su módulo.
3. **Agenda de la semana** (una card, no dos): clases y exámenes en una sola línea de tiempo, cada fila `<Link>`, con separadores "Hoy / Mañana / Esta semana".

Vacío: `EmptyState` con `action` — "Todavía no tienes evaluaciones. Crea la primera y genera preguntas con IA" + botón primario.

#### SPEC DE MAQUETA — Inicio del Docente

Lienzo: **1280 × 800**. Sidebar de 256px a la izquierda (dibujar como bloque gris, sin detalle). Área de contenido: x=256, ancho 1024, padding interno 32px → **contenido útil 960px**. Fondo `#FAFAFA` (light).

**ANTES** (reproducir lo actual, de arriba a abajo):
- `y=32`: texto "Hola, Julián Castaño" — 30px, semibold, `#18181B`.
- `y=70`: "Panel docente" — 16px, `#71717A`.
- `y=108`: fila de **4 tarjetas** de 231×90, gap 12, radio 12, borde 1px `#E4E4E7`, fondo blanco. Cada una: label 12px `#71717A` en dos líneas arriba-izquierda, número 24px semibold debajo, cuadrado 36×36 radio 8 `#F4F4F5` a la derecha con un icono de 18px. Textos exactos y números de ejemplo:
  1. "Notas de examen pendientes" / **8** / icono documento violeta
  2. "Cola (pendientes)" / **3** / icono lista indigo
  3. "Comentarios pendientes por respuesta" / **5** / icono responder rosa
  4. "Pendientes de calificación" / **37** / icono portapapeles azul
- `y=214`: **2 tarjetas** de 474×510, gap 16, radio 12, borde 1px. Título 16px semibold con icono 16px a la izquierda: izquierda "Próximas clases" (icono cian), derecha "Próximos exámenes" (icono violeta). Padding interno 24px.
  - Dentro, **4 filas** por tarjeta de 426×58: borde 1px `#E4E4E7`, radio 6, padding 8. Punto gris de 8px a la izquierda; título 14px medium; subtítulo 12px `#71717A`; fecha 12px `#71717A`. En la 1ª fila de exámenes, pill verde 10px "En curso" a la derecha.
  - Al pie de cada tarjeta, texto gris 12px centrado: **"Gestionar →"** (mismo texto en las dos). Sin fondo, sin borde.
- Anotaciones sobre la maqueta (globos rojos, fuera del lienzo): "ningún botón primario en toda la pantalla", "misma palabra en los dos pies", "estas filas no se pueden clickear", "el texto más grande no informa nada", "16px de padding arriba, 24px abajo".

**DESPUÉS**:
- `y=32`: **Franja de titular**, 960×96, radio 12, fondo `#F4F4F5` con borde izquierdo de 4px en el color de la institución (usar `#DC2626` para dejar visible que el color viene de la marca, no de la pantalla).
  - Izquierda (padding 20): línea 1 en 20px semibold: **"37 entregas esperan nota"**; línea 2 en 14px `#71717A`: **"12 vencen hoy · Paradigmas de Programación, Bases de Datos"**.
  - Derecha: **botón primario** 168×40, radio 8, fondo color de institución, texto blanco 14px medium: **"Calificar ahora"**. Debajo, link 12px gris: "Ver por curso".
- `y=152`: **3 paneles** de 310×280, gap 15, radio 12, borde 1px, fondo blanco, padding 16.
  - Panel A — título 14px semibold "Por calificar" + pill gris "37". Tres filas de 278×52, radio 6, **fondo `#FAFAFA` (no borde)**, con chevron `›` de 12px a la derecha: "Parcial 2 · Paradigmas / 14 entregas", "Taller 5 · Bases de Datos / 12 entregas", "Proyecto final · Paradigmas / 11 entregas". Pie: link 12px "Ver las 37 →".
  - Panel B — "Esperan mi respuesta" + pill "5". Tres filas iguales: "María Restrepo · Taller 3", "Andrés Gil · Parcial 1", "Laura Mesa · Proyecto". Pie: "Ver los 5 →".
  - Panel C — "Clases de hoy" + pill "2". Dos filas: "14:00 · Paradigmas — Salón 302" y "16:00 · Bases de Datos — Lab 4"; en la primera, **botón secundario** de 96×28 "Abrir tablero". Pie: "Ver calendario →".
- `y=448`: **una** card de 960×300 titulada "Esta semana", radio 12, borde 1px, padding 20. Dentro, tres grupos con encabezado 11px mayúsculas `#A1A1AA`: "HOY", "MAÑANA", "JUE 31". Cada ítem es una fila de 920×44, **sin borde**, fondo `#FAFAFA` en hover (dibujar la 1ª en estado hover), con: cuadradito de 4×24 a la izquierda en el color del tipo (examen violeta / clase cian), título 14px medium, curso 12px gris a continuación separado por "·", hora 12px gris alineada a la derecha, chevron `›`. Ítems: "Parcial 2 — Paradigmas · 14:00" (con pill verde "En curso"), "Clase — Bases de Datos · 16:00", "Taller 5 cierra — Paradigmas · 23:59", "Clase — Paradigmas · 14:00".
- **Se elimina de la maqueta:** el saludo de 30px, el subtítulo "Panel docente", los 4 tiles de conteo, el tile "Cola (pendientes)", el segundo "Gestionar", y los bordes de las filas de agenda.
- Anotaciones (globos verdes): "un titular, una acción primaria", "los contadores ahora son colas con destino", "una sola agenda en vez de dos listas", "las filas llevan a algún lado".

---

### 4.2 Inicio del Estudiante — `src/routes/app.index.tsx:1580-1690` (`StudentDashboard`)

#### Antes

- Mismo wrapper de altura capada; mismo saludo de 30px "Hola, {nombre}" + "Tu espacio de estudio".
- **4 tiles** idénticos en forma a los del docente (`:1588-1619`): "Próximos exámenes" (violet, `value={upcomingExams.length}`) · "Talleres pendientes" (amber) · "Proyectos pendientes" (rose) · "Conversaciones pendientes" (sky). **Solo el 4º tiene `onClick`** (`:1618`); los otros tres se ven exactamente igual y no hacen nada. El 1º duplica literalmente la card de abajo: mismo rótulo "Próximos exámenes" y mismo array `upcomingExams` (`:1591` vs `:1650`).
- **Región `flex-1` en 2 columnas** (`:1628`): izquierda `StudentEventsCalendar` (mes completo; los eventos son dots de `h-1.5 w-1.5` = 6px, y la celda del día es un `<button>` que abre `Popover` donde cada evento **sí** es `<Link to={e.href}>`, `StudentEventsCalendar.tsx:786-792` y `:829-832`); derecha, dos cards apiladas: "Próximos exámenes" (con `EventRow` sin destino y pie "Ver todos" → `/app/student/exams`, `:1676`) y `StudentKahootRanking`.
- **Todo el inicio del alumno tiene 1 enlace saliente** (`:1676`). "Talleres pendientes" y "Proyectos pendientes" no tienen puerta en ninguna parte de la pantalla.
- No hay progreso por curso ni reanudación, aunque el estado `in_progress` de un intento existe y se usa en otra pantalla (`app.student.exams.tsx:83-111`).

#### Después

Del inicio del alumno se espera una sola cosa: **saber qué hacer ahora y entrar de un click**.

1. **Continuar** — si hay un intento `in_progress`, una franja con "Retomá: Parcial 2 — Paradigmas · te quedan 42 min" y botón primario `[Continuar]`. Si no hay intento abierto, la franja muestra el vencimiento más próximo con `[Empezar]`.
2. **Pendientes en una sola lista, ordenada por vencimiento y con estado nombrado** (`Por entregar` / `Vence hoy` / `Vencido` / `Entregado`). Reemplaza los 3 contadores mudos: cada fila lleva a la entrega. El estado "Vencido" hoy no se nombra en ninguna parte de la UI (el modelo lo trata como 0 con su peso en `computeWeightedGrade`, decisión correcta a nivel cálculo, invisible a nivel UI).
3. **Mi avance por curso** — una barra por curso con "% del peso del curso ya calificado" (dato ya computado por `computeCourseFinalGrade`) y la nota actual. Es más honesto que un progreso de contenidos inventado.
4. **Calendario** se conserva, pero como columna secundaria y con los ítems del día visibles en texto, no solo en dots de 6px.

#### SPEC DE MAQUETA — Inicio del Estudiante

Lienzo **1280 × 800**, mismo shell y ancho útil 960px.

**ANTES**:
- `y=32`: "Hola, María Restrepo" 30px semibold; `y=70`: "Tu espacio de estudio" 16px gris.
- `y=108`: **4 tarjetas** de 231×90 idénticas en forma a las del docente. Textos/números: "Próximos exámenes" / **3** (violeta) · "Talleres pendientes" / **4** (ámbar) · "Proyectos pendientes" / **1** (rosa) · "Conversaciones pendientes" / **2** (celeste). Dibujar las cuatro visualmente idénticas — importa que en la maqueta no se distinga cuál es clickeable.
- `y=214`: dos columnas de 474 con gap 16, alto 510.
  - Izquierda: **calendario de mes**, encabezado "julio 2026" con flechas, grilla 7×5 de celdas ~64×72, números 12px, y **dots de 6px** bajo algunos números (violeta/ámbar/cian). Sin texto de evento.
  - Derecha: dos tarjetas apiladas de 474×247. Arriba "Próximos exámenes" (icono violeta) con 3 filas de 58px con borde (idénticas a las del docente) y pie gris "Ver todos →". Abajo "Ranking del curso" con un `<select>` de curso y 4 filas "1º/2º/3º/4º" con nombre y puntos.
- Anotaciones (rojas): "el mismo dato dos veces: tile y tarjeta", "3 de los 4 tiles no hacen nada y se ven igual que el que sí", "un solo enlace saliente en toda la pantalla", "para entrar a un examen hay que acertarle a un punto de 6px", "no dice en qué anda ni cómo va".

**DESPUÉS**:
- `y=32`: **Franja "Continuar"** 960×104, radio 12, fondo blanco, borde 1px, borde izquierdo 4px color institución.
  - Izquierda: etiqueta 11px mayúsculas `#A1A1AA` "EXAMEN EN CURSO"; línea 14px gris "Paradigmas de Programación"; título 20px semibold "Parcial 2 — Estructuras".
  - Derecha: contador 24px semibold tabular **"42:17"** con "restantes" en 11px gris debajo, y **botón primario** 152×40 "Continuar".
- `y=168`: dos columnas: izquierda 624, derecha 320, gap 16.
  - **Izquierda — "Pendientes"** (card 624×420, radio 12, borde 1px, padding 20). Título 16px semibold + pill "8". Filas de 584×64, sin borde, separadas por línea de 1px `#F4F4F5`; primera en hover `#FAFAFA`. Cada fila: barra vertical 4×36 del color del tipo; **título 15px medium**; segunda línea 12px gris "Curso · tipo"; a la derecha, **pill de estado** 11px y debajo "vence" en 11px gris. Filas:
    1. "Taller 5 — Normalización" / "Bases de Datos · Taller" / pill rojo suave **"Vence hoy"** / "23:59"
    2. "Parcial 2 — Estructuras" / "Paradigmas · Examen" / pill verde **"Abierto ahora"** / "cierra 16:00"
    3. "Proyecto final — Entrega 1" / "Paradigmas · Proyecto" / pill gris **"Por entregar"** / "3 ago"
    4. "Taller 4 — Índices" / "Bases de Datos · Taller" / pill ámbar **"Vencido"** / "hace 2 días"
    5. "Quiz 3" / "Paradigmas · Examen" / pill gris "Por entregar" / "7 ago"
    Pie: link 12px "Ver los 8 →".
  - **Derecha — "Mi avance"** (card 320×420). Título 16px semibold. Dos bloques de curso, cada uno: nombre 14px medium, línea 12px gris "Nota actual 4,1 · 62% del curso calificado", **barra de progreso** 280×8 radio 4 (fondo `#F4F4F5`, relleno color institución al 62%). Cursos: "Paradigmas de Programación" (4,1 / 62%) y "Bases de Datos" (3,6 / 45%). Pie: link "Ver mis notas →".
- `y=604`: **Calendario** en franja de 960×164: encabezado "julio 2026" + navegación; a la izquierda una tira horizontal de 7 días (cuadros de 96×96 con número 16px y hasta 2 dots de 6px); a la derecha, columna de 300px con **los eventos del día seleccionado en texto** (14px + hora 12px gris), cada uno como fila clickeable con chevron. Nota: el calendario de mes completo se mantiene en `/app/student/calendar`, no en el inicio.
- **Se elimina:** el saludo de 30px, los 4 tiles, la card duplicada "Próximos exámenes", el ranking Reto (se mueve a su módulo — decisión de producto, ver §5), y el calendario de mes completo en el inicio.
- Anotaciones (verdes): "una acción primaria: continuar donde ibas", "los contadores se convirtieron en una lista con estado nombrado", "'Vencido' ahora se dice", "avance = % del peso ya calificado (dato que ya existe)".

---

### 4.3 Sidebar y navegación — `src/shared/components/AppLayout.tsx`

#### Antes

- `NAV` declara 51 entradas `to: "/app…"` (`:142-481`); el filtro por rol activo deja **22 visibles al Docente** y 22 al Admin (SuperAdmin hereda las de Admin, `:946-953`), 12 al Estudiante.
- Render: **una lista plana sin secciones ni separadores** — `<nav className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-0.5">` (`:1132-1197`). Cada fila `px-3 py-2 rounded-md text-sm` ≈ 36px + 2px de gap → **22 × 38 ≈ 836px** solo de nav, más marca, selector de rol (`px-3 py-3` + `h-9`, `:1088-1120`) y pie de 4 items (`:1200-1224`). En un portátil de 768px de alto, los últimos ítems del docente (Auditoría, Estudiantes, Papelera, Asistente) quedan bajo el pliegue tras un scroll interno sin indicador.
- Los 22 iconos son monocromos: `NAV_ICON_BASE_CLASS = "text-sidebar-foreground"` (`:581`, aplicado en `:1175` y `:1191`). El icono no ayuda a escanear.
- Sin búsqueda: `cmdk` está instalado (`src/components/ui/command.tsx`) y solo se usa en `app.teacher.attendance.tsx`.
- El orden lo decide `module_visibility.display_order` (`:973-979`) — configuración de institución, no jerarquía de tarea. La jerarquía real por rol **ya está escrita** en `BOTTOM_NAV_PRIORITY` (`:495-524`) y se usa solo en la barra inferior de móvil.
- "Cursos" es un ítem entre 22, y `app.teacher.board.$courseId.tsx` (1938 líneas de tablero por curso) **no aparece en el nav** (0 hits de `teacher/board` en `AppLayout.tsx`): su única puerta es una acción de fila del grid de cursos (`app.admin.courses.tsx:2276`).

#### Después

Dos niveles, con el curso como contenedor (patrón Canvas), y ⌘K como mitigación inmediata.

- **Nivel global (siempre visible, 6 ítems):** Inicio · Mis cursos · Mensajes · Calendario · Notificaciones · Configuración. Es lo que es transversal a todos los cursos.
- **Nivel de curso (aparece al entrar a un curso):** el sidebar se reemplaza por el contexto del curso — nombre del curso arriba con **cambiador** (dropdown), y debajo los módulos de ese curso: Tablero · Contenidos · Exámenes · Talleres · Proyectos · Asistencia · Calificaciones · Encuestas · Pizarras · Foros. El destino natural del click en un curso es el **Tablero que ya existe**.
- **Nivel de administración (colapsado, "Gestión"):** Banco de preguntas, Certificados, Videos, Estadísticas, Reportes, Auditoría, Cola, Instrucciones IA, Papelera, Asistente. Son las 10 que hoy inflan la lista y se visitan una vez por semana.
- **⌘K** (`cmdk` ya instalado): resuelve "curso + módulo" en una línea ("parad tall" → "Paradigmas → Talleres"). Índice derivable de `MODULE_CATALOG` + cursos del usuario. Es la mitigación más barata del sidebar de 22 ítems **mientras** se hace el resto, y se puede entregar sola.
- Los 14 `<Select>` de curso (`ListFilters` en 14 archivos) pasan a ser un **breadcrumb con cambiador**: el curso se responde una vez.

#### SPEC DE MAQUETA — Sidebar

Lienzo **1280 × 900** (alto extendido para que se vea el desborde real). Dibujar solo el sidebar en detalle (256px) y el área de contenido como bloque gris con una etiqueta.

**ANTES**:
- Columna de 256px, fondo `#FAFAFA`, borde derecho 1px.
- `y=0-64`: marca — cuadrado 32×32 + "ExamLab" 16px semibold + debajo 11px gris "Fundación FESNA".
- `y=64-112`: selector de rol — `<select>` de 232×36, radio 6, borde 1px, texto "Docente".
- `y=112` en adelante: **22 filas** de 232×36 (gap 2), radio 6, padding-x 12: icono 16px **gris (todos del mismo color)** + etiqueta 14px. En orden: Dashboard · Cursos · Contenidos · Banco de preguntas · Exámenes · Talleres · Proyectos · Calificaciones · Asistencia · Encuestas · Pizarras · Videos · Certificados · Calendario · Foros · Estadísticas · Reportes · Prompts IA · Cron · Auditoría · Estudiantes · Papelera. La 1ª en estado activo (fondo blanco + borde).
- **Dibujar una línea de corte horizontal punteada en y=768** rotulada "pliegue en un portátil de 13\"": los ítems 18-22 (Prompts IA, Cron, Auditoría, Estudiantes, Papelera) quedan por debajo, atenuados al 40%.
- `y` al fondo: pie con 4 iconos en fila (usuario, campana, mensajes, tres puntos).
- Anotaciones (rojas): "22 filas, ningún grupo, ningún separador", "22 iconos del mismo color: hay que leer las 22 etiquetas", "sin buscador", "≈836px solo de nav", "el orden lo decide una tabla de configuración, no la tarea", "'Cursos' es un ítem entre 22", "el tablero de curso no está acá: 1938 líneas de producto sin puerta de entrada".

**DESPUÉS** — dibujar **dos estados lado a lado** en el mismo lienzo (dos columnas de 256 separadas por 48px, cada una con su rótulo arriba):

*Estado A — "Fuera de un curso"*
- Marca igual. Selector de rol igual.
- **Campo de búsqueda** de 232×34, radio 6, fondo blanco, borde 1px: icono lupa + placeholder "Buscar o ir a…" + badge `⌘K` 10px a la derecha.
- 6 filas de nav (mismo tamaño que antes), iconos **con el color de la institución** para el activo y gris para el resto: Inicio (activo) · Mis cursos · Mensajes · Calendario · Notificaciones · Configuración.
- Separador de 1px + encabezado 11px mayúsculas `#A1A1AA` **"GESTIÓN"** con chevron de colapso, en estado **cerrado**, con pill gris "10".
- Pie igual.
- Espacio blanco visible al fondo: la maqueta debe dejar claro que sobra pantalla.

*Estado B — "Dentro de un curso"*
- Marca igual.
- **Bloque de curso** de 232×56, radio 8, fondo blanco, borde 1px, borde izquierdo 3px color institución: etiqueta 10px mayúsculas gris "CURSO", nombre 14px semibold "Paradigmas de Programación" (una línea, truncado), chevron `⌄` a la derecha (es el cambiador).
- Link 12px con flecha izquierda "← Todos mis cursos".
- 10 filas del curso: **Tablero** (activo) · Contenidos · Exámenes · Talleres · Proyectos · Asistencia · Calificaciones · Encuestas · Pizarras · Foros.
- Separador + "GESTIÓN" colapsado (igual que en A).
- Pie igual.
- Junto a este estado, dibujar el **encabezado del área de contenido**: breadcrumb "Mis cursos › **Paradigmas de Programación** ⌄ › Talleres" en 13px, donde el nombre del curso lleva chevron.
- Anotaciones (verdes): "el curso se responde una vez, en el breadcrumb", "el tablero pasa a ser el destino natural del curso", "10 módulos de gestión colapsados: siguen accesibles, dejan de competir", "⌘K resuelve curso+módulo en una línea y se puede entregar solo, antes del resto".
- Anotación adicional apuntando al `<Select>` de curso que desaparece: "esto es el mismo `<Select>` que hoy se repite en 14 pantallas".

---

### 4.4 Grid de Exámenes (canónico de los 13 listados) — `src/routes/app.teacher.exams.index.tsx`

#### Antes

- `PageHeader` con título y conteo en el subtítulo (`:681-688`) + botón "Nuevo examen" e `ImportExportMenu` en `actions`.
- **4 StatCard** en `grid sm:grid-cols-2 md:grid-cols-4 gap-3` (`:775-798`): "Borradores" · "Publicados" · "Cerrados" · "Externos". `StatCard` es `p-4`, label `text-xs`, valor `text-2xl` (`stat-card.tsx:75`) → ≈86px de alto. **Acepta `onClick` (`stat-card.tsx:44`) y ninguna de las 4 lo pasa**: parecen filtros y no lo son. Los conteos se calculan sobre `exams`, no sobre `filteredExams` (`:176-189`), y el filtro arranca en `"activos"` (`status-filter.ts:36`), que excluye cerrados → "Cerrados: 7" cuenta filas que no están en la tabla.
- **`ListFilters`** justo debajo: search + `<Select>` de curso + `<Select>` de corte + `ActivityStatusSelect` con "Solo borradores / Solo publicados / Cerrados / Todos" (`ActivityStatusSelect.tsx:23-27`) — **la misma taxonomía que las 4 tarjetas, a 20px de distancia**.
- `MultiSelectToolbar` (aparece con selección) + resumen de pesos condicional.
- **Tabla de 12 columnas** `fixed resizable` (`:873-910`): checkbox `w-10` · Título `w-48` · Curso `w-32` · Corte `w-24` · Peso `w-16` · Inicio `w-28` · Fin `w-28` · Duración `w-24` · Tipo `w-24` · Estado `w-24` · Navegación `w-28` · Acciones `w-20` = **1.224px declarados** para ~960px de ancho útil (`AppLayout.tsx:1722` fija `md:ml-64`). Con `table-fixed` el título baja a ~150px ≈ 18 caracteres. Estado y Acciones son las dos últimas.
- Suma de cromo antes del `<thead>`: PageHeader + 86px de tarjetas + filtros + `space-y-5` ≈ **250px** (≈6 filas menos).
- El total aparece **3 veces**: subtítulo del header, tarjetas, y `DataPagination` ("X–Y de Z").
- Acciones de fila en `RowActionsMenu` (4 items acá; 7 en Talleres donde **Calificar** es el 4º label; 14 en Contenidos, `app.teacher.contents.tsx:1643-1786`).

#### Después

- **Se eliminan las 4 StatCard.** Su información pasa a **filtros con conteo** en la misma barra: `[Todos 24] [Borradores 6] [Publicados 11] [Cerrados 7] [Externos 2]` como chips clickeables. Un solo lugar para la taxonomía, y ahora sí es accionable. El conteo se calcula sobre el conjunto filtrado por curso/búsqueda.
- **8 columnas.** Se van al detalle: **Duración**, **Tipo**, **Navegación** (configuración fijada una vez, no sirve para decidir) y **Peso** (pasa a badge junto al título). **Corte** se plega como segunda línea del título. Entran las dos columnas que hoy faltan y son la razón de visitar la lista: **Preguntas** (`n`) y **Sin calificar** (`n`).
  Resultado: checkbox `w-10` · Examen `flex` · Curso `w-40` · Inicio `w-28` · Fin `w-28` · Preguntas `w-20` · Sin calificar `w-24` · Estado `w-24` · Acciones `w-20`.
- **La acción diaria sale del menú.** En cada fila, un botón secundario contextual: "Calificar (12)" cuando hay entregas sin nota; "Agregar preguntas" cuando `preguntas = 0`; "Monitorear" cuando está en curso. El menú de tres puntos queda para el resto.
- El conteo total queda **solo** en `DataPagination`.
- El `<Select>` de curso desaparece cuando se implemente §4.3 (el curso viene del contexto); hasta entonces se conserva.

*Nota de gusto (decide el dueño):* mantener o no el código de color por entidad en los iconos de los tiles del dashboard es estética; lo que **no** es gusto es el color del icono de `PageHeader`, porque ahí pisa la marca de la institución (P3).

#### SPEC DE MAQUETA — Grid de Exámenes

Lienzo **1280 × 800**. Sidebar 256px como bloque gris. Contenido útil 960px.

**ANTES**:
- `y=32`: fila de encabezado: icono 24px + "Exámenes" 24px semibold a la izquierda; debajo 14px gris "24 exámenes"; a la derecha, botón primario 140×36 "Nuevo examen" y botón secundario 40×36 con icono de importar.
- `y=100`: **4 tarjetas** de 231×86, radio 12, borde 1px: label 12px gris arriba, número 24px semibold, icono 16px. "Borradores/6" · "Publicados/11" · "Cerrados/7" · "Externos/2".
- `y=206`: barra de filtros de 960×40: input con lupa (300px, placeholder "Buscar examen…"), `<select>` "Todos los cursos" (200px), `<select>` "Todos los cortes" (180px), `<select>` "Activos" (150px).
- `y=266`: card de 960×470 con la tabla. Encabezado de tabla de 40px, fondo `#FAFAFA`, 12 celdas con texto 12px gris y chevron de orden: `☐ · Título · Curso · Corte · Peso · Inicio · Fin · Duración · Tipo · Estado · Navegación · Acciones`. Dibujar los anchos proporcionales al declarado (48 · 150 · 100 · 76 · 50 · 88 · 88 · 76 · 76 · 76 · 88 · 64) y **dejar la barra de scroll horizontal visible al pie de la card**, con "Estado", "Navegación" y "Acciones" parcialmente cortadas por el borde derecho.
- 6 filas de 56px. La columna Título muestra texto **truncado con elipsis** ("Parcial 2 — Estructuras de…"). Las celdas Tipo/Navegación llevan pills grises ("En línea", "Libre"). Estado lleva pill de color. Acciones: icono de tres puntos.
- Al pie, dentro de la card: "1–6 de 24" + selector "Por página" + flechas.
- Anotaciones (rojas): "250px antes de la primera fila", "estas 4 tarjetas repiten el `<select>` que está 20px abajo — y no son clickeables", "'Cerrados: 7' cuenta filas que el filtro por defecto no muestra", "1.224px de columnas en 960px de ancho", "el título —lo que identifica la fila— truncado a ~18 caracteres", "Estado y Acciones son las primeras en salirse", "el total dicho 3 veces", "para calificar: tres puntos → 4º label".

**DESPUÉS**:
- `y=32`: encabezado igual, pero el icono **sin color propio** (usar el color de la institución, `#DC2626`) y el subtítulo eliminado (el conteo vive en la paginación).
- `y=88`: **una** barra de 960×44: input con lupa (320px, "Buscar examen…"), y a la derecha una fila de **chips de filtro** de 32px de alto, radio 16, borde 1px: `Todos 24` (activo: fondo color institución al 10%, borde en color institución, texto en color institución) · `Borradores 6` · `Publicados 11` · `Cerrados 7` · `Externos 2`. Cada chip: etiqueta 13px + número 12px en pill interna gris.
- `y=148`: card de 960×560 con la tabla, radio 12, borde 1px, **sin scroll horizontal**.
  - Encabezado de 40px, 9 columnas con estos anchos: `☐` 40 · **Examen** 300 · Curso 150 · Inicio 100 · Fin 100 · Preguntas 80 · Sin calificar 90 · Estado 100 · `⋯` 40.
  - 7 filas de **64px** (más altas: la celda de Examen lleva dos líneas). Celda "Examen": línea 1 título 14px medium **sin truncar** ("Parcial 2 — Estructuras de datos"), línea 2 en 12px gris "Corte 2 · peso 20%". Preguntas y Sin calificar en 14px `tabular-nums` centrados; "Sin calificar" en color de institución cuando > 0, "—" gris cuando 0. Estado con pill.
  - **Botón contextual por fila**: en la celda "Sin calificar" de la fila 1, en lugar del número, un botón secundario de 104×28 radio 6 **"Calificar (12)"**. En la fila 3 (Preguntas = 0), en la celda Preguntas, botón secundario "Agregar preguntas". En la fila 2 (en curso), botón "Monitorear". Las demás filas muestran los números.
  - Pie de card: "1–7 de 24 · Por página 25 · ‹ ›".
- **Se elimina de la maqueta:** las 4 tarjetas, los `<select>` de corte y de estado, el subtítulo con el conteo, y las columnas Duración, Tipo, Navegación y Peso (esta última pasa a la 2ª línea del título).
- Anotaciones (verdes): "una sola taxonomía, y ahora se puede clickear", "8 columnas que caben: el título ya no trunca", "entraron las dos columnas por las que se visita esta pantalla: Preguntas y Sin calificar", "la acción diaria salió del menú de tres puntos", "el total se dice una vez".

---

## 5. Lo que NO hay que tocar

Verificado, no asumido. Rediseñar esto sería gasto puro o pérdida neta.

1. **El design system propio.** `RowAction`, `RowActionsMenu`, `StatusBadge`, `EmptyState`/`ErrorState`, `TableSkeleton`, `DataPagination`, `useTableSort`, `useMultiSelect`, `DecimalInput`, `PasswordInput`, `HelpHint`, `DateCell` — está bien pensado y documentado. **El problema es sub-uso, no diseño**: `EmptyState` se usa 0 veces en `app.index.tsx`, `StatCard.onClick` 0 veces en 16 tarjetas, `usePagination`/`useTableSort` 0 veces en el gradebook. La acción es aplicarlos, no reemplazarlos.
2. **`PageHeader`.** 58 rutas lo usan y los 14 `<h1>` inline restantes están justificados (Reto en vivo fullscreen, toma de examen, `unauthorized`, saludo del dashboard). Solo hay que quitarle el color al icono (P3) y unificar el `size` de la CTA.
3. **La iconografía sidebar ↔ encabezado.** 47 entradas de nav vs 52 encabezados: coinciden todas; los 3 aparentes desvíos son alias de import (`CalendarDays as CalendarIcon`, etc.). No tocar el mapeo concepto→icono.
4. **La cobertura i18n.** 8.856 claves con paridad es/en perfecta y **un solo** string visible hardcodeado en todo `src/routes` ("Google Calendar", `app.teacher.calendar.tsx:392`, nombre propio). El trabajo del punto 3 de la tabla es **reescribir valores**, no montar infraestructura.
5. **Los estados vacíos y de error de los grids.** No son genéricos: `hc_routesAppTeacherExamsIndex.emptyText/emptyHint` = "Aún no has creado ningún examen." + "Diseña tu primer examen — puedes generar preguntas con IA", con CTA, y copy distinto para "sin datos" vs "sin coincidencias del filtro" (`app.teacher.exams.index.tsx:916-936`, `app.teacher.contents.tsx:1407-1440`). Los errores usan `ErrorState` con motivo real + Reintentar (`:663-674`) y `friendlyError` en los catch. Esto está mejor que en la mayoría de productos comparables. **El déficit de vacíos está solo en `app.index.tsx`.**
6. **El Reto en vivo y los proyectores.** `app.teacher.kahoot.$gameId.tsx:373-467` (fullscreen, PIN `text-7xl tracking-[0.2em]`, QR, countdown `h-28 w-28`) y `AttendanceCheckInProjector` están diseñados para su tarea. No aplicarles el molde de listado. Al contrario: son el modelo a **exportar** al monitor de examen en vivo (`app.teacher.monitor.$examId.tsx`), que hoy está vestido de panel de administración con tres tamaños de badge (`:2115`, `:2890`, `:2948`).
7. **La arquitectura de módulos y su guardrail.** `MODULE_CATALOG` / `ALL_MODULE_KEYS` / `NAV_PATH_TO_MODULE` / `PREFIX_TO_MODULE` + `module-catalog.test.ts`. Cualquier cambio de navegación (§4.3) pasa por ahí sin romper el test — el guardrail es un activo, no un obstáculo.
8. **El modelo de pesos y cortes, y `computeWeightedGrade`.** Que un ítem sin nota cuente como 0 con su peso es correcto y refleja la realidad del alumno. La mejora es de UI: **nombrar** ese estado ("Vencido"), no cambiar el cálculo.
9. **`performSubmit` fire-and-forget.** Await solo la entrega; notificación e IA con `void`. 300 ms percibidos en vez de 10 s. Es el patrón a **generalizar** (P9), no a revisar.
10. **`lg:overflow-hidden` del dashboard** (`app.index.tsx:133`) como *intención*: que el inicio quepa en una pantalla es correcto. Lo que hay que quitar es la consecuencia — haber sacado navegación de las filas para que la altura calzara.

---

## 6. Orden de ejecución

### Tanda 1 — Borrar y renombrar (no rompe nada, ~3 días)

Todo lo de esta tanda es quitar clases o cambiar strings. Cero cambios estructurales, cero migraciones, cero riesgo de regresión funcional. Es también donde está la mejor relación impacto/esfuerzo del plan.

1. **Quitar el color de los 29 iconos de `PageHeader`** (problema 1). Es un reemplazo mecánico. Arregla de golpe el branding por institución en los encabezados, los dos cianes distintos, y las contradicciones Prompts (indigo vs amber) y Usuarios (marca vs violet).
2. **Quitar `container mx-auto p-4 sm:p-6` de las 17 rutas** (problema 2). Unifica 9 sistemas de padding en 1 y elimina el salto de 24px al navegar. La justificación ya está escrita en `AuditLogsView.tsx:532-538`.
3. **Reescribir el lenguaje del módulo "Cola"** (problema 3): "job"→"tarea"/"calificación", "Drenando"→"Procesando", "worker"→omitir, "Sin jobs"→"Sin calificaciones pendientes", `pending/processing/failed/done`→"En espera / Procesando / Con error / Lista". Mover "Target" y "Body del request" (`UnifiedAiQueuePanel.tsx:1870-1911`) detrás de un "Detalle técnico" visible solo para Admin/SuperAdmin. Mismo pase a `toast.…jobsQueued`. Y los sueltos: `nav.dashboard`→"Inicio", `nav.aiPrompts`→"Instrucciones IA", `nav.aiCron`→"Tareas de IA", `aiCronPage.tabJobs`→"Tareas", `adminSupport.entityPlural`→"solicitudes", `grading.items`→"Ítems".
4. **Limpiar el login** (problema 4): el `SelectItem` de cross-tenant solo tras un gesto deliberado ("Soy del equipo de plataforma"), y quitar el `URL: /t/<slug>` en `<code>` (`auth.index.tsx:527-546`).
5. **Definir `--text-2xs` y `--text-3xs` en `@theme`** y migrar los 1.108 `text-[Npx]` (problema 8): `[12px]`→`text-xs` (6), `[11px]`→`text-xs` (548), `[10px]`→`text-2xs` (497), `[9px]`→`text-3xs` (55), `[8px]`→`text-3xs` (2). Sin esto, cada pantalla nueva vuelve a inventar su tamaño.
6. **Fijar el `size` de la CTA** de `PageHeader` (hoy invertido entre `app.videos.tsx:749`/`:875` y `app.teacher.projects.tsx:2514`/`:2758`) y documentar la regla.
7. **Escribir los principios P1-P9 en CLAUDE.md** con sus checks. Sin esto, la tanda 1 se revierte sola en tres meses — el repo ya demostró que sabe detectar estos bugs (`AuditLogsView.tsx:532-538`) pero no propagar los fixes.

**Salida de la tanda:** el producto se ve como un sistema. Nada cambió de sitio, así que no hay que re-grabar videos ni re-entrenar a nadie.

### Tanda 2 — Rediseñar las 3 pantallas que se visitan todos los días (~2 semanas)

Cambia lo que el usuario ve y hace, sin tocar rutas ni el modelo de navegación.

8. **Inicio del Docente y del Estudiante** según §4.1 y §4.2. Los datos ya se consultan en `app.index.tsx`; el cambio es de jerarquía, destino del click y copy. Requiere decidir dos cosas de producto: si el ranking Reto sale del inicio del alumno, y si el calendario de mes completo se reduce a una tira de 7 días. **Es la mejor relación cambio/percepción del plan después de la tanda 1.**
9. **⌘K** con `cmdk` (ya instalado): índice derivado de `MODULE_CATALOG` + cursos del usuario, atajo global. Se entrega **solo**, sin depender de §4.3, y es la mitigación inmediata del sidebar de 22 ítems.
10. **Gradebook** (problema 6): `sticky top` en el `<thead>` (falta en `components/ui/table.tsx`), `useTableSort` + `usePagination` como en los otros 13 grids, y tinte de corte que no se cicle a los 4.
11. **Grid de Exámenes** según §4.4, y luego propagar a Talleres y Proyectos: chips de filtro con conteo en lugar de las 4 StatCard, ≤8 columnas, acción diaria fuera del menú de tres puntos. Aparte, Contenidos: partir los 14 items del menú de fila y arreglar la celda de nombre (`app.teacher.contents.tsx:1451-1520`, quitar `shrink-0` de los badges) + agregar `hidden md:table-cell` a sus 8 columnas.
12. **Agrupar el formulario de examen y de taller** (problema 9): tres secciones — "Qué evalúa" (título, descripción, curso, corte, peso) · "Cuándo" (inicio, fin, sesión) · "Cómo se toma" **colapsada** (duración, navegación, mezcla, advertencias, reintentos, supletorio). Usar el patrón que ya existe en `app.admin.users.tsx:2340`. Y encadenar: al guardar, llevar a agregar preguntas con el paso visible ("Paso 2 de 2").

**Salida de la tanda:** el inicio deja de ser decoración, calificar deja de costar 4 niveles, y el grid muestra lo que sirve para decidir.

### Tanda 3 — La corrección estructural (~4-6 semanas, incremental)

13. **Navegación de dos niveles anclada al curso** (problema 10, §4.3). Se puede hacer por partes y sin big bang:
    - **3a** — Meter el Tablero en el nav y hacerlo el destino del click en un curso (`app.teacher.board.$courseId.tsx` ya existe: 1938 líneas). Agregar `/app/teacher/board` a `NAV_PATH_TO_MODULE`, `PREFIX_TO_MODULE`, `MODULE_CATALOG` y la regla RBAC. El guardrail (`module-catalog.test.ts`) valida el registro.
    - **3b** — Colapsar los 10 módulos de gestión bajo "Gestión". No mueve rutas: solo agrupa el render de `AppLayout.tsx:1132-1197`. Respeta `module_visibility` para lo que la institución ocultó.
    - **3c** — Hacer que Exámenes, Talleres y Proyectos acepten el curso por ruta/contexto y reemplazar su `<Select>` por el breadcrumb con cambiador. **Empezar por estos tres**; dejar el resto en el nivel global hasta validar.
    - **3d** — Propagar a las 11 pantallas restantes con `ListFilters`.
14. **Modo "calificar de corrido"** (SpeedGrader): "Siguiente entrega" dentro del mismo panel, con atajo de teclado, sin volver a la lista. Base: `app.teacher.grading.$courseId.tsx`. El trabajo real es precargar el lote y avanzar sin perder cambios.
15. **Estados intermedios (P9)** en las operaciones caras: progreso n-de-N en el bulk import de 93 alumnos, y promesa explícita en la generación encolada y la calificación con IA.
16. **Monitor de examen en vivo** con el tratamiento del Reto en vivo: si el docente lo mira de pie frente a 40 personas, no puede tener tipografía de tabla ni tres tamaños de badge (`app.teacher.monitor.$examId.tsx:2115/2890/2948`).

**Riesgo de la tanda 3:** es la única que puede romper flujos (rutas, RBAC, `module_visibility`, bookmarks de usuarios) y la única que obliga a re-grabar videos demo. Por eso va al final, y por eso 3a y 3b —que son agrupar y registrar, no mover— van antes que 3c.

---

## Apéndice — Cuestiones de gusto (decide el dueño, no son usabilidad)

- **Código de color por entidad** en los iconos de tiles y cards del dashboard (violeta=examen, ámbar=taller, rosa=proyecto). Ayuda a escanear si es consistente en todo el producto; hoy no lo es. Mantenerlo o eliminarlo son ambas defendibles; lo que **no** es defendible es que el icono de `PageHeader` pise la marca de la institución (P3).
- **Sacar el ranking Reto en vivo del inicio del alumno.** Gamificación vs. foco en la tarea. Argumento a favor de sacarlo: compite con "qué tengo que hacer ahora". Argumento en contra: es lo único lúdico del inicio.
- **Reducir el calendario de mes completo a una tira de 7 días** en el inicio del alumno. El mes completo sigue en `/app/student/calendar`. Preferencia, no usabilidad — salvo el detalle que **sí** es usabilidad: los dots de 6px como único acceso al evento (`StudentEventsCalendar.tsx:786-792`).
- **Iconos de nav en color** (hoy monocromos, `AppLayout.tsx:581`). Con 22 ítems el color ayuda a escanear; con 6 + un grupo colapsado (§4.3) deja de hacer falta. Recomendación: no invertir acá hasta después de la tanda 3.
