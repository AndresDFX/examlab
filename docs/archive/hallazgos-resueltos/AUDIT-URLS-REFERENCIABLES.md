# Auditoría — ¿todo el contenido tiene una URL propia referenciable? (2026-07-15)

Objetivo: validar que cada tipo de contenido tenga una URL con su **id**, enlazable a un
**ítem específico** dentro de la plataforma (todas las rutas `/app/*` ya son auth-gated =
solo accesibles logueado). Auditoría de routing (el workflow no pudo correr por límite de
sesión; hecho inline contra `src/routes/` + `routeTree.gen.ts` + `message-tags.ts`).

## Matriz por entidad

| Entidad | URL propia por ítem | Patrón | Cómo se referencia hoy | Gap |
|---|---|---|---|---|
| **Exámenes** | ✅ sí | `/app/student/take/$examId` · `/review/$examId` · `/app/teacher/exams/$examId` · `/monitor/$examId` | ruta directa `$id` | el tag `#` no usa el id |
| **Talleres** | ✅ sí (est.) · 🟡 parcial (doc.) | est: `/app/student/workshop/$workshopId` · doc: `/app/teacher/workshops?workshop=<id>` | ruta `$id` (est) / query-param (doc) | el tag `#` no usa el id |
| **Proyectos** | ✅ sí (est.) · 🟡 parcial (doc.) | est: `/app/student/project/$projectId` · doc: `/app/teacher/projects?id=<id>` | idem | el tag `#` no usa el id |
| **Encuestas** | 🟡 parcial | `/app/student/polls?poll=<id>` (resalta + scroll) | query-param | ok (no requiere `$id`) |
| **Reto en vivo (kahoot)** | ✅ sí | `/app/{rol}/kahoot/$gameId` | ruta directa `$id` | — |
| **Pizarras** | ✅ sí | `/app/{rol}/whiteboards/$id` | ruta directa `$id` | — |
| **Foros** | ✅ sí | `/app/forum/$courseId/$forumId/$threadId` | ruta directa `$id` | — |
| **Certificados** | ✅ sí (público) | `/verify/$shortCode` | verificación pública | dentro de la app solo grilla |
| **Contenidos** | ❌ **no** | grilla `/app/teacher/contents` | tag **ROTO** | sin URL por ítem **+ tag roto** |
| **Videos** | ❌ **no** | grilla `/app/videos` | tag **ROTO** | sin URL por ítem **+ tag roto** |
| **Banco de preguntas** | ❌ no | grilla | — | sin URL por ítem |
| **Sesiones** | 🟡 parcial | `?session=&code=` (solo check-in) | deep-link check-in | sin referencia general |
| **Cursos** | ✅ sí | `/app/teacher/board/$courseId`, `/grading/$courseId`, tutor `$courseId` | ruta directa `$id` | — |

## Bugs encontrados (rutas rotas)

`src/modules/messaging/message-tags.ts` → `tagRoute()` (mapea los `#`-tags de mensajes):

1. **content** → devuelve `/app/{rol}/content`, pero **no existe** (la ruta real es
   `/app/teacher/contents`, plural; y **no hay ruta de contenidos para el estudiante** — el
   contenido vive dentro de `app.student.courses`). → el `#`-tag de contenido lleva a un link roto.
2. **video** → devuelve `/app/{rol}/videos`, pero la ruta real es `/app/videos` (compartida, sin
   prefijo de rol). → el `#`-tag de video lleva a un link roto.
3. **id descartado**: para workshop/exam/project, `tagRoute` va a la **grilla raíz** e ignora el
   `id` que el token SÍ carga (`[[T:type:id:label]]`), aunque las grillas de docente ya soportan
   `?workshop=<id>` / `?id=<id>` y existen rutas `$id` de detalle. El tag no enfoca el ítem.

## Veredicto

**La mayoría del contenido SÍ tiene URL propia referenciable** por `$id` (exámenes, talleres y
proyectos del estudiante, kahoot, pizarras, foros, cursos) o por query-param que enfoca el ítem
(encuestas). **Gaps reales**: **contenidos** y **videos** no tienen forma de enlazar a un ítem
específico y además su `#`-tag está roto; **banco de preguntas** y **sesiones** no tienen
referencia por ítem (menor prioridad).

## Recomendación (para cerrar los gaps, sin sobre-ingeniería)

1. **Arreglar `tagRoute`** (bug, bajo esfuerzo): corregir las rutas de content (`/app/teacher/contents`)
   y video (`/app/videos`), y **usar el id** — enviar al `$id` de detalle cuando existe, o al grid
   con `?<param>=<id>` cuando la grilla ya enfoca (patrón de encuestas). Esto hace que TODOS los
   `#`-tags deep-linkeen al ítem.
2. **Contenidos y videos**: agregar deep-link por query-param que resalte el ítem en su grilla
   (mismo patrón que `polls?poll=<id>`), en vez de crear rutas `$id` nuevas.
3. **Banco de preguntas / sesiones**: opcional, según necesidad de referenciarlos.
