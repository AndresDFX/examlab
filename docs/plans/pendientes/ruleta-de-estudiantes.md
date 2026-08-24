# Ruleta visual de estudiantes — plan de diseño

> Producido por el workflow `ruleta-de-estudiantes` (mapeo + frente de ataque + síntesis).
> **NO implementado todavía.** Las afirmaciones están verificadas por los agentes contra
> el código; las que sostienen decisiones grandes conviene re-verificarlas antes de
> ejecutar.

No hay tokens `--chart-*` en `styles.css`, así que los sectores van con `--primary` a opacidades alternas (respeta P3 y la marca de la institución). Plan:

---

# Ruleta de estudiantes — plan de implementación

## 1. La decisión de fondo: HERRAMIENTA, no `poll_type`

**Elegido: herramienta del docente, sin fila en `polls`.** La evidencia es asimétrica, no un empate.

**Lo que arrastra `poll_type='ruleta'`** (todo verificado):

- **Publicarla notifica y hace push a todo el curso.** `_tg_poll_publish_notify` es `AFTER INSERT OR UPDATE ON polls` y es **agnóstico del tipo**: si `is_published` nace o pasa a `true`, hace fan-out por `poll_courses` con el copy fijo *"Nueva encuesta publicada"* → `/app/student/polls`, y `notify_send_push` lo convierte en web push por dispositivo. En Paradigmas de Programación-2682V son **96 teléfonos vibrando** hacia una pantalla donde el ítem no se puede usar. Evitarlo obliga a dejarla `is_published=false` para siempre: una encuesta que nunca llega a ser encuesta.
- **El alumno ve una card rota con el texto equivocado.** La query del alumno filtra por **lista negra** (`.neq("poll_type","kahoot")`, `app.student.polls.tsx:312`), así que un tipo nuevo **pasa por construcción**. Hoy no crashea (`TYPE_ICONS[…] ?? ListChecks`), falla peor: `getTypeHint` termina en `return i18n.t("studentPolls.typeHintSlot")` **sin rama default**, o sea el alumno lee la ayuda de un Doodle de cupos sobre una tarjeta vacía. Con kahoot este mismo movimiento produjo React #130 y tumbó la pantalla completa.
- **TypeScript no avisa.** `PollType` está escrito a mano **cuatro veces** con cuatro sets distintos (teacher 5 · student 4 · LaunchPollDialog 3 · poll-results 3) y `types.ts` sigue en `"single"|"multiple"|"slot"`. El único `Record<PollType,…>` que rompe el build es el del docente, y solo si alguien edita esa unión.
- **≥2 migraciones**: `poll_type` es un ENUM de Postgres y `ALTER TYPE … ADD VALUE` no puede usarse en la misma transacción.
- **Hereda Papelera** rotulada *"Encuestas"* con badge de días y purga a 30 días — semántica sin sentido para un sorteo.
- **Hereda el scoping propio del módulo Encuestas** (`isSuperAdminCaller ? todos : course_teachers`), que **no** es el canónico `scopedCourseIds` → un usuario con rol activo Admin vería el selector de cursos vacío.
- **El modelo no encaja**: una encuesta existe para recoger respuestas de N personas; la ruleta tiene 0 respondientes y 1 actor. Meter el roster en `poll_options` lo congela (read-only en cuanto hay votos) y lo desactualiza en cada matrícula.

**Lo que `poll_type` regalaría** — y hay que decirlo: una RLS ya endurecida (6+ migraciones: `is_admin_of_course_tenant`, `_poll_admin_in_tenant`, `_poll_in_papelera`, rama de alumno con `is_published AND deleted_at IS NULL`), papelera, y ciclo publicar/cerrar. **Nada de eso es algo que la ruleta necesite.**

**La vía herramienta es casi gratis**: colgada del dropdown de la sesión en Asistencia no necesita módulo del catálogo, ni ítem de nav, ni **regla RBAC** (no es una ruta nueva: es un componente dentro de una ruta ya gateada), y los datos ya están en memoria — `students` cargado en `app.teacher.attendance.tsx:476-491` y `records` de todas las sesiones del curso en `:494-506`. **Cero queries nuevas.** El precedente de registro está claro: `/app/teacher/board` y `/app/teacher/kahoot/$gameId` tienen regla RBAC pero **no** están en `PREFIX_TO_MODULE` ni en `MODULE_CATALOG` — a una herramienta se entra desde una fila, no desde el sidebar.

### La pregunta que solo el dueño puede contestar

**No es "poll o herramienta"** — eso lo resuelve la evidencia de arriba. Es esta:

> **¿El resultado tiene que quedar registrado, de forma que la clase pueda ver que hubo 4 giros antes del que quedó?**

Porque el único ataque real a la ruleta **no es el PRNG**: es el botón **"Girar otra vez"**. Si al docente no le gusta quién salió, gira hasta que salga el que quería, y cada giro individual es limpio. Ninguna criptografía toca ese ataque; solo lo toca un registro que el docente no pueda descartar.

**Default propuesto (v1)**: sin tabla, **pero con el contador de giros de la ronda y la lista de los ya salidos VISIBLES en el overlay proyectado** ("Giro 4 · ya salieron: Ana, Luis, Sofía"). Eso ataja el 90% del ataque —la clase *ve* el contador— al 0% del costo de migración, y no promete una inmutabilidad que un cliente no puede dar. Si el dueño responde "sí, quiero registro", la §6 ya tiene la tabla diseñada.

**Qué se resigna con la herramienta**: la memoria no cruza clases (reabrir la ruleta el martes no recuerda a quién le tocó el jueves), no hay auditoría server-side, no aparece en Papelera. **Qué se gana**: 0 migraciones, 0 notificaciones, 0 superficie RLS nueva —y por lo tanto 0 riesgo del modo de falla más común del repo, la tabla hija que nace con `USING (true)` o `has_role()` suelto (20260929, 20260945 *"creé una pizarra y se ve en UNIAJ"*, 20261045-48 con un leak confirmado con datos)—, 0 queries nuevas.

---

## 2. Alcance de v1

**Hace:**
1. Ítem **"Ruleta"** en el dropdown de cada sesión (entre *Pizarra* y *Duplicar sesión*) → abre con alcance **sesión**.
2. Botón **"Ruleta"** en el header del curso (`variant="outline"`, junto a *Programar clases*) → abre con alcance **curso**.
3. Overlay proyectable `fixed inset-0 z-[100]` con fullscreen best-effort.
4. Conmutador de alcance **dentro** del overlay: *Todo el curso* / *Solo presentes de esta clase*. "Solo presentes" es **opt-in** y queda deshabilitado con el motivo a la vista cuando la sesión no tiene registros.
5. Elegibilidad explícita: matriculados − docentes del curso − `is_active=false` − `estado ∈ {retirado, aplazado, graduado}`. Contador **"23 elegibles de 25"** con el desglose en `HelpHint`.
6. Giro con transición CSS + tarjeta de ganador grande.
7. No-repetición: **enfriamiento suave** (excluye los últimos k, con k derivado del tamaño) por default + interruptor *"Azar puro"*. Las exclusiones se **muestran**.
8. Contador de giros de la ronda + lista de los ya salidos + botón *Reiniciar ronda*.
9. Excluir a un estudiante de la ronda con un clic (efímero; no persiste nada).
10. Degradación por tamaño: rueda con etiquetas hasta 24 nombres; arriba de eso, sectores sin etiqueta + la tarjeta como resultado real.
11. `prefers-reduced-motion` → sin rotación, crossfade.
12. Resultado anunciado en `role="status" aria-live="polite"`.

**No hace:** nada persiste en la base; **no escribe en ningún camino de calificación** (ni `submissions`, ni `ExternalGradesEditor`, ni gradebook, ni un ítem de `computeWeightedGrade`); no hay vista para el alumno ni enlace público; nadie más que el anfitrión gira; sin sonido; sin grupos; sin pesos; no entra a calendario/ICS/Papelera; sin módulo del sidebar; sin regla RBAC nueva.

---

## 3. Archivos

### Nuevos

| Path | Qué va |
|---|---|
| `src/modules/roulette/pick.ts` | Helper **PURO** de selección + `cooldownFor`. Sin React, sin `Math.random`, sin `Date`. §4 |
| `src/modules/roulette/pick.test.ts` | 14 casos de §4 |
| `src/modules/roulette/eligibility.ts` | **PURO**: `isEligible(student)`, `eligibleForCourse(...)`, `eligibleForSession(...)`, `EligibilitySummary` (total / elegibles / excluidos por motivo) |
| `src/modules/roulette/eligibility.test.ts` | ~14 casos (ver abajo) |
| `src/modules/roulette/wheel-geometry.ts` | **PURO**: `sliceAngle(n)`, `sectorPath(i,n,r)`, `labelTransform(i,n,r)`, `wheelMode(n)`, `targetAngle(i,n,turns,jitter01)` |
| `src/modules/roulette/wheel-geometry.test.ts` | ~12 casos (n=0/1/2/6/24/96, path bien formado, ángulo acumulativo nunca decreciente, jitter dentro del sector) |
| `src/modules/roulette/RouletteWheel.tsx` | El SVG + el puntero. Presentacional puro: recibe `names`, `rotation`, `mode`, `spinning`, `durationMs` |
| `src/modules/roulette/RouletteOverlay.tsx` | El overlay: estado de ronda, fullscreen, conmutador de alcance, tarjeta de ganador, lista de exclusiones |

### Modificados

| Path | Cambio |
|---|---|
| `src/routes/app.teacher.attendance.tsx` | (a) `type Student` += `is_active: boolean \| null; estado: string \| null`; (b) el `select` de `profiles` en `loadCourse` (`:477`) pasa a `"id, full_name, institutional_email, is_active, estado"` — **misma query, dos columnas más**; (c) cargar los `course_teachers` del curso al `Promise.all` de `loadCourse` (`select("user_id").eq("course_id", courseId)`) → `teacherUserIds`; (d) `const [rouletteFor, setRouletteFor] = useState<{ scope: "course" \| "session"; session: Session \| null } \| null>(null)`; (e) `DropdownMenuItem` con `Dices` en el menú de sesión; (f) `Button variant="outline"` en el header; (g) render de `<RouletteOverlay …/>` al final, junto a `<SessionWhiteboardDialog>` (~`:2379`) |
| `src/i18n/locales/es.json` · `en.json` | namespace `roulette` + 1 clave en `teacherAttendance` (§7) |

### Design system que se usa (del catálogo de CLAUDE.md)

`Button` · `Badge` · `Switch` · `Select` · `Spinner` · `EmptyState` · `HelpHint` · `RowAction` (`iconOnly`, para excluir a alguien de la ronda) · `DropdownMenuItem` · `formatDateShort` (`src/shared/lib/format.ts`, para el label de la sesión).

**Deliberadamente NO se usan** (y por qué, para que no se "corrija" después):
- **`useConfirm()`**: en fullscreen el diálogo de Radix se portalea a `document.body`, **fuera** del elemento en fullscreen → queda invisible y el botón parece colgado. Está documentado en `AttendanceCheckInProjector.tsx:201-206`, que resolvió el problema **eliminando** el confirm. *Reiniciar ronda* y *excluir* son reversibles, así que van sin confirmación.
- **`Dialog`/`DialogContent`**: el overlay **no** es un modal; es `fixed inset-0`, igual que el proyector. Un `DialogContent` con `max-w-*` no proyecta.
- **`StatusBadge`**: mapea estados de exam/workshop/project/submission; un sorteo no es ninguno.

### ¿Módulo nuevo del sidebar? **No aplica**

No hay ruta nueva, así que no hay `PREFIX_TO_MODULE`, ni `ALL_MODULE_KEYS`, ni seed de `module_visibility`, ni clave `nav.*`, ni regla RBAC. El acceso lo gatea la ruta que ya lo contiene (`/app/teacher/attendance`). **Único disparador del checklist de 10 pasos**: si el dueño después pide "Ruleta" como ítem propio del sidebar. Ahí sí van los 10 pasos, y el guardrail es `src/shared/lib/module-catalog.test.ts` + el check de compile-time `_exhaustiveModuleKeys` — **no editar el test para que pase**.

### Ícono: `Dices`

Verificado con 0 usos en todo `src/` (igual que `Disc3` y `CircleDot`). **No** `Sparkles` (26 archivos, es el marcador de IA), **no** `RotateCw` (ya significa "rotar imagen" en `ImageEditorDialog` y "reiniciar" en `V86Console`), **no** `Shuffle`/`Target`. `Dices` va idéntico en el ítem del menú, el botón del header y el encabezado del overlay. Color en el `DropdownMenuItem`: `text-amber-500` (los vecinos usan `text-sky-500` para encuesta y `text-violet-500` para pizarra; ámbar queda libre y es el mismo lenguaje visual de esa lista).

---

## 4. El helper PURO

`src/modules/roulette/pick.ts`

```ts
/** Fuente de azar inyectada: devuelve [0,1). El test pasa una secuencia fija. */
export type RouletteRng = () => number;

export interface PickInput<T extends { id: string }> {
  /** Elegibles YA filtrados (eligibility.ts). El orden no afecta la uniformidad. */
  pool: readonly T[];
  /** Ids ya sorteados en la ronda, MÁS RECIENTE PRIMERO. */
  recent: readonly string[];
  /** Cuántos de `recent` excluir. 0 = azar puro. */
  cooldown: number;
  rng: RouletteRng;
}

export interface PickResult<T> {
  winner: T | null;
  /** Índice del ganador en `pool` (para el ángulo de la rueda). -1 si no hay. */
  index: number;
  /** Ids excluidos por enfriamiento en ESTE giro (se muestran en pantalla). */
  excluded: string[];
  /** Candidatos reales tras el enfriamiento. */
  candidateCount: number;
  /** true si hubo que ignorar el enfriamiento porque no quedaba nadie. */
  cooldownRelaxed: boolean;
}

export function pickOne<T extends { id: string }>(input: PickInput<T>): PickResult<T>;

/** Enfriamiento por default según el tamaño del pool. */
export function cooldownFor(n: number): number;
```

**Reglas del cuerpo** (cada una es un caso de test):

- `pool` vacío → `{winner:null,index:-1,excluded:[],candidateCount:0,cooldownRelaxed:false}` y **no llama `rng`**.
- Selección uniforme: `candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))]`. El `min` es el guard defensivo para un `rng()` que devuelva 1 exacto. **Prohibido `sort(() => rng() - 0.5)`** — el repo ya se quemó con eso (`shuffle.ts:8`) y el orden de partida es alfabético por `full_name`, así que el sesgo caería sistemáticamente sobre los mismos apellidos.
- `excluded` = los primeros `cooldown` ids de `recent` **que estén en `pool`** (un id ya excluido a mano no debe gastar cuota de enfriamiento).
- Si tras excluir no queda nadie → **relajar**, no devolver `null`: `cooldownRelaxed=true` y se sortea sobre todo el `pool`. Una rueda que se niega a girar se lee como una rueda rota.
- `index` se calcula contra `pool` (no contra `candidates`), porque es el índice del **sector** de la rueda.
- No muta `pool` ni `recent`.
- `cooldownFor(n)`: `n < 4 ? 0 : Math.min(3, Math.ceil(n / 4))`. Debajo de 4 el enfriamiento vuelve el resultado **determinista** (con 2 personas y k=1 alterna A,B,A,B), que es exactamente la coerción que se quiere evitar.
- **No hay `reset()`**: la ronda es el array `recent`, que lo posee el componente. Reiniciar = `setRecent([])`, y el test cubre que `recent: []` se comporta como `cooldown: 0`.

**Casos de test (`pick.test.ts`)** — los 14, en orden:

1. `pool: []` → winner `null`, index `-1`, `candidateCount: 0`; `rng` **no** se invoca (spy con contador en 0).
2. `pool` de 1, `recent: []` → devuelve ese, `index: 0`.
3. `pool` de 1, `recent: [ese]`, `cooldown: 1` → `cooldownRelaxed: true` y devuelve ese (nunca `null`).
4. `cooldown: 0` → `excluded: []` y el `rng` recorre el pool completo.
5. `rng` fijo en `0` → primer candidato. `rng` fijo en `0.9999` → **último** candidato (sin off-by-one).
6. `rng` fijo en `1` exacto → último candidato, nunca `undefined`.
7. `pool` de 10, `recent` de 5, `cooldown: 3` → `excluded` son exactamente los 3 primeros de `recent`, `candidateCount: 7`.
8. `recent` con ids que ya **no** están en `pool` (alumno excluido a mano) → no cuentan contra el enfriamiento; `candidateCount` correcto.
9. Agotamiento parcial: `pool` 4, `recent` = los 4, `cooldown: 3` → excluye 3, queda 1, **sin** relax.
10. Agotamiento total: `pool` 3, `recent` = los 3, `cooldown: 3` → relax, pool completo, `cooldownRelaxed: true`.
11. Inmutabilidad: `pool` y `recent` idénticos (por valor) después de llamar.
12. `cooldownFor`: `0→0`, `1→0`, `3→0`, `4→1`, `8→2`, `12→3`, `21→3`, `96→3`.
13. **Uniformidad**: `rng` determinista que barre `i/10000`, 10.000 tiradas sobre `pool` de 8 con `cooldown: 0` → cada índice cae en `[1150, 1350]`. Es el test que ataja el sesgo alfabético.
14. El ganador **nunca** está en `excluded` (property test sobre 500 combinaciones con un rng determinista).

### `eligibility.ts` — el otro helper puro (igual de importante)

```ts
export interface RouletteStudent {
  id: string;
  full_name: string;
  institutional_email: string | null;
  is_active: boolean | null;
  estado: string | null;
}
export type ExclusionReason = "docente" | "inactivo" | "retirado" | "graduado" | "ausente";

export function displayName(s: RouletteStudent): string;      // full_name → email → t(unknown)
export function looksLikeIdentifier(fullName: string, email: string | null): boolean;
export function eligibleForCourse(
  students: readonly RouletteStudent[],
  teacherUserIds: readonly string[],
): { eligible: RouletteStudent[]; excluded: Array<{ id: string; reason: ExclusionReason }> };
export function eligibleForSession(
  students: readonly RouletteStudent[],
  teacherUserIds: readonly string[],
  records: readonly { session_id: string; user_id: string; status: string }[],
  sessionId: string,
): { eligible: RouletteStudent[]; excluded: […]; hasAttendance: boolean };
```

Tres reglas que **no se inventan**, se reusan:

- **Presencia**: `countsAsPresent(status)` de `src/modules/grading/grade.ts` → `presente ∪ tarde`. Es la invariante cross-file que ya comparte el acta SQL (`generate_course_acta`: `status IN ('presente','tarde')`) y `report-context.ts`.
- **`justificado` queda FUERA de la ruleta.** Ojo: es lo *contrario* de la regla de notas, donde `justificado` sale del **denominador** para no castigar. Acá la pregunta no es una tasa, es pertenencia: quien tiene ausencia justificada **no está en el salón**, y sacarlo al tablero es la injusticia que hay que evitar. Comentar esta asimetría en el archivo — es exactamente el tipo de WHY que el código no dice.
- **"Sin registro" NO es ausente** (`early-alert.ts:107-112`). Si la sesión tiene 0 registros, `hasAttendance: false` y el overlay **no** cae en silencio al curso: deshabilita "Solo presentes" y nombra la causa.
- **Estados desconocidos se ignoran** (la columna es `TEXT` sin enum, y el repo tiene dos grafías muertas — `tarde` y `tardanza`; no inventar una tercera).
- **Restar `course_teachers` es obligatorio, no opcional**: hay 16 filas medidas donde el docente está además matriculado como alumno del mismo curso, y son las cuentas del propio dueño. Un filtro por rol **no** lo tapa (esas cuentas *tienen* el rol Estudiante).

Casos de test: docente matriculado se excluye · `is_active=false` se excluye · `retirado`/`aplazado`/`graduado` se excluyen · `estado=null` y `activo` pasan · `is_active=null` pasa (columna vieja) · `estado` desconocido pasa · sesión con 0 registros → `hasAttendance:false` y `eligible` vacío · `presente` y `tarde` entran · `ausente` y `justificado` no · registro de OTRA sesión no cuenta · el desglose de `excluded` no pierde a nadie (`eligible.length + excluded.length === students.length`) · `displayName` cae a email y luego a la clave i18n · `looksLikeIdentifier("2024101234", "2024101234@x.edu")` → `true`.

---

## 5. El dibujo

**Con qué**: SVG a mano en `RouletteWheel.tsx`, con toda la geometría en `wheel-geometry.ts` (puro y testeado). Precedente de SVG hand-authored: `NetworkTopologyEditor.tsx:139`. **Sin dependencias nuevas** (el lockfile es `bun.lock`). **`recharts` descartado a propósito** aunque ya sea dependencia: su `Pie` es para datos —trae leyenda, tooltip y su propia animación— y no expone el ángulo de rotación acumulado ni el puntero, que es justamente lo que la ruleta necesita controlar.

```ts
sliceAngle(n)                    // 360 / n
sectorPath(i, n, r)              // "M 100 100 L x1 y1 A r r 0 0 1 x2 y2 Z"
labelTransform(i, n, r)          // rotate + translate para el <text>
wheelMode(n)                     // "empty" | "single" | "labeled" | "unlabeled"
targetAngle(i, n, turns, jitter) // ángulo destino ACUMULATIVO
```

**Cómo se anima**: un solo `<g>` envuelve todos los sectores.

```tsx
<g style={{
  transform: `rotate(${rotation}deg)`,
  transformOrigin: "50% 50%",
  transition: reduced ? "none" : `transform ${durationMs}ms cubic-bezier(.17,.67,.12,1)`,
}}>
```

El navegador compone la interpolación: **no** se re-renderiza React 60 veces por segundo con 96 nombres en un overlay a pantalla completa. El precedente exacto de "transición CSS + transform/dimensión inline" está en el propio proyector (`AttendanceCheckInProjector.tsx:328`: `transition-all duration-1000 ease-linear` + `style={{width}}`), y CLAUDE.md permite el inline style para el caso **(b) dimensiones/transformaciones runtime**.

**El azar decide el ganador; la animación solo lo muestra.** `pickOne` corre primero, y `targetAngle(index, n, turns, jitter)` calcula dónde frenar:

- `turns = 4` vueltas completas + el offset del sector ganador, **acumulativo** (nunca se resetea a 0 — si se resetea, el segundo giro gira hacia atrás).
- `jitter` dentro de `±0.35 × sliceAngle` para que no frene siempre clavado en el centro del sector. El jitter viene **por parámetro** (`jitter01: number` en `[0,1)`), así el helper sigue siendo puro y testeable.
- Duración `3200ms`, tope duro `3000-3500ms`.
- Fin del giro por `onTransitionEnd` **+ un `setTimeout(durationMs + 300)` de respaldo**: `transitionend` no dispara si la pestaña estaba oculta, y sin el respaldo la ruleta queda colgada en "girando".
- Puntero fijo (triángulo `--foreground`) arriba al centro; la rueda gira debajo.

**Comportamiento por tamaño** — el umbral vive en `wheelMode(n)`, testeado, **no** hardcodeado en el componente:

| n | Modo | Render |
|---|---|---|
| 0 | `empty` | **No se dibuja rueda.** `EmptyState` con el motivo ("todavía no tomaste asistencia en esta clase") + botón *Usar todo el curso*. Una rueda vacía se lee como que la app está rota. |
| 1 | `single` | **No se anima.** Se dice "solo hay un elegible" y se muestra la tarjeta. Girar teatralizaría un azar que no existe y señalaría a la única persona posible. |
| 2-24 | `labeled` | Sectores con etiqueta radial. En 6 nombres el sector mide 60° y el texto va casi horizontal (`text-lg`); en 24 mide 15°, texto rotado y truncado a ~14 caracteres (`text-2xs`). |
| >24 | `unlabeled` | Sectores alternando `--primary` a opacidad `0.85 / 0.45`, **sin texto**. El resultado vive **entero** en la tarjeta. Cubre los 4 cursos reales de 57, 61, 64 y 96 alumnos, donde un sector mide 3,75° y un nombre de 27 caracteres (la mediana medida) es indibujable. |

**El nombre del ganador siempre es el `full_name` completo, en la tarjeta.** Nunca el nombre de pila: hay 25 "juan", 10 "jhon" y 9 "cristian" entre los 476 perfiles, y en un curso de 21 tener tres Juanes es normal. Nunca el correo, el código ni el documento en la rueda proyectada. Si `looksLikeIdentifier` da `true` (el `full_name` es el local-part del correo, porque `handle_new_user` lo rellena con `split_part(email,'@',1)`), se muestra la etiqueta neutra `roulette.unnamedStudent` — proyectar el código de matrícula de alguien frente al salón, y en la grabación de la videollamada, es una fuga que la rueda no debe causar.

**Tamaño**: la rueda es cuadrada y se cotiza con el cálculo del proyector, cap por alto **y** por ancho:
`size = Math.max(200, Math.min(viewport.h * 0.6, viewport.w - 48, 640))`.
**El `viewport` se inicializa determinista** (`{ w: 1024, h: 768 }`) y se setea en un `useEffect` post-mount + listener de `resize`. **No copiar el initializer del proyector** (`:69`), que lee `window.innerWidth` dentro de `useState(() => …)` — ahí no se manifiesta porque solo monta tras un gesto, pero es exactamente el React #418 que CLAUDE.md prohíbe.

**Fullscreen**: copiar el molde **de `WhiteboardEditor.tsx:388-445`**, no el del proyector. O sea: `fullscreenSupported = document.fullscreenEnabled ?? document.webkitFullscreenEnabled` (y si no hay soporte, **ocultar el botón**), `requestFullscreen ?? webkitRequestFullscreen` con `typeof req === "function"` antes de llamar, `exitFullscreen ?? webkitExitFullscreen`, y **los dos** listeners (`fullscreenchange` + `webkitfullscreenchange`). El proyector tiene el bug (solo API sin prefijo, un solo listener): no crashea, pero en Safari sin soporte sin prefijo nunca entra y `isFullscreen` queda mintiendo. Como el contenedor ya es `fixed inset-0 z-[100]`, un fullscreen fallido es **degradación** (se ve el chrome del navegador), no rotura. Y dos salidas separadas, como el proyector: *salir de pantalla completa* ≠ *cerrar la ruleta*.

**Nota de contexto que reordena prioridades**: de las 119 sesiones en producción, 115 son `virtual`, 4 `autonoma` y **0 `presencial`**. La ruleta se va a ver por pantalla compartida en una videollamada, no proyectada en un aula. Por eso la **tarjeta de ganador legible en un screen-share 1080p** es el requisito y el fullscreen es el extra.

---

## 6. Si persiste algo

**v1: nada.** Cero migraciones, cero tablas, cero RPC, cero columnas.

**v2 (solo si el dueño responde "sí" a la pregunta de §1)** — el diseño ya cerrado, para no volver a investigar:

```sql
-- supabase/migrations/<ts>_roulette_spins.sql
CREATE TABLE IF NOT EXISTS public.roulette_spins (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id             UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  attendance_session_id UUID REFERENCES public.attendance_sessions(id) ON DELETE SET NULL,
  picked_user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pool_size             INT  NOT NULL CHECK (pool_size > 0),
  spun_by               UUID NOT NULL REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_roulette_spins_course ON public.roulette_spins(course_id, created_at DESC);
ALTER TABLE public.roulette_spins ENABLE ROW LEVEL SECURITY;

-- SELECT: docente del curso o Admin del tenant DEL CURSO. Nunca `has_role()` suelto
-- (es un rol GLOBAL: una rama sin scope expone el registro de TODAS las instituciones).
CREATE POLICY roulette_spins_select ON public.roulette_spins FOR SELECT TO authenticated
USING (
  public.course_in_my_tenant(course_id)
  AND (EXISTS (SELECT 1 FROM public.course_teachers ct
               WHERE ct.course_id = roulette_spins.course_id AND ct.user_id = auth.uid())
       OR public.is_admin_of_course_tenant(course_id))
);

-- Escritura SOLO por RPC: un log escribible por el cliente es un log falsificable,
-- y sin eso "verificable" no significa nada. Patrón de `poll_responses`.
CREATE POLICY roulette_spins_no_direct_insert ON public.roulette_spins FOR INSERT TO authenticated WITH CHECK (FALSE);
CREATE POLICY roulette_spins_no_direct_update ON public.roulette_spins FOR UPDATE TO authenticated USING (FALSE);
CREATE POLICY roulette_spins_no_direct_delete ON public.roulette_spins FOR DELETE TO authenticated USING (FALSE);
```

RPC `record_roulette_spin(_course_id, _session_id, _picked_user_id, _pool_size)` `SECURITY DEFINER`, con **todos** los guards en el cuerpo y en este orden:

1. `IF auth.uid() IS NULL THEN RAISE EXCEPTION` (en español — P0001 pasa el mensaje al cliente).
2. Docente del curso **o** `is_admin_of_course_tenant(_course_id)`.
3. Papelera: `courses.deleted_at IS NULL` **y**, si `_session_id` no es null, `attendance_sessions.deleted_at IS NULL` **y** que la sesión pertenezca a `_course_id`. (Regla universal del proyecto; hoy 8 de 119 sesiones están en papelera.)
4. `_picked_user_id` matriculado en `_course_id`.
5. `REVOKE EXECUTE ON FUNCTION … FROM anon;` **explícito** — Supabase otorga EXECUTE por `ALTER DEFAULT PRIVILEGES` y el `REVOKE ALL … FROM PUBLIC` de la convención **no** borra esa entrada del ACL (256 de 305 funciones `SECURITY DEFINER` del proyecto tienen `anon=X`).
6. **El log NO es legible por estudiantes en v1 de la v2**: "a quién le tocó y cuántas veces" es un registro de conducta sobre una persona nombrada.
7. `ALTER TABLE` envuelto en el guard `DO $$ … IF to_regclass('public.X') IS NOT NULL …` si toca una tabla existente.

---

## 7. i18n

Namespace nuevo `roulette` (top-level, junto a `attendance`). Todo por `t(...)` con `defaultValue` inline, y **en los dos locales** — `locale-parity.test.ts` compara es↔en y `keys-registered.test.ts` exige que la clave exista en ambos JSON. Vocabulario: nada de "poll", "session_id", "roulette", UUID ni estados sin traducir (P6).

| Clave | es | en |
|---|---|---|
| `teacherAttendance.roulette` | Ruleta | Roulette |
| `roulette.title` | Ruleta de estudiantes | Student roulette |
| `roulette.spin` | Girar | Spin |
| `roulette.spinning` | Girando… | Spinning… |
| `roulette.spinAgain` | Girar de nuevo | Spin again |
| `roulette.winner` | Le toca a | It's up to |
| `roulette.scopeCourse` | Todo el curso | Whole course |
| `roulette.scopeSession` | Solo presentes de esta clase | Only students present today |
| `roulette.scopeSessionNoAttendance` | Todavía no tomaste asistencia en esta clase | You haven't taken attendance for this class yet |
| `roulette.useWholeCourse` | Usar todo el curso | Use the whole course |
| `roulette.eligibleCount` | {{eligible}} elegibles de {{total}} | {{eligible}} eligible out of {{total}} |
| `roulette.eligibleHint` | Se excluyen quienes dictan el curso y quienes ya no están cursando. | Course teachers and students who are no longer enrolled are excluded. |
| `roulette.excludedTeacher` | Dicta el curso | Teaches the course |
| `roulette.excludedInactive` | Cuenta desactivada | Account deactivated |
| `roulette.excludedWithdrawn` | Ya no está cursando | No longer enrolled |
| `roulette.excludedGraduated` | Graduado | Graduated |
| `roulette.excludedAbsent` | No está en esta clase | Not in this class |
| `roulette.avoidRepeats` | Evitar repetir | Avoid repeats |
| `roulette.pureChance` | Azar puro | Pure chance |
| `roulette.avoidRepeatsHint` | Deja fuera a los últimos que salieron, para que a nadie le toque dos veces seguidas. | Skips the most recent picks so nobody gets called twice in a row. |
| `roulette.cooldownExcluded` | {{count}} en espera por turno reciente | {{count}} on hold from a recent turn |
| `roulette.cooldownRelaxed` | Ya salieron todos: la ruleta vuelve a incluir a todo el mundo. | Everyone has come up: the roulette includes everybody again. |
| `roulette.spinCount` | Giro {{n}} de esta clase | Spin {{n}} this class |
| `roulette.alreadyPicked` | Ya salieron | Already picked |
| `roulette.resetRound` | Reiniciar ronda | Reset round |
| `roulette.removeFromRound` | Quitar de esta ronda | Remove from this round |
| `roulette.restoreToRound` | Volver a incluir | Include again |
| `roulette.onlyOneEligible` | Solo hay un elegible | Only one eligible student |
| `roulette.emptyPool` | No hay nadie para sortear | Nobody to draw from |
| `roulette.unnamedStudent` | Estudiante sin nombre | Unnamed student |
| `roulette.notForGrading` | Sirve para elegir a quién le toca, no para calificar. | It's for choosing whose turn it is, not for grading. |
| `roulette.close` | Cerrar ruleta | Close roulette |
| `roulette.enterFullscreen` | Pantalla completa | Full screen |
| `roulette.exitFullscreen` | Salir de pantalla completa | Exit full screen |
| `roulette.reduceMotion` | Sin animación | No animation |
| `roulette.announce` | Le toca a {{name}} | It's up to {{name}} |

---

## 8. Accesibilidad

- **`prefers-reduced-motion`**: sería la primera animación con riesgo vestibular del producto (0 hits de `prefers-reduced-motion`/`motion-reduce` en `src/`, y `styles.css` no tiene un solo `@keyframes` propio), y se proyecta a pantalla completa ante gente que no eligió mirar. Implementación: `useReducedMotion()` local en `RouletteOverlay` — `window.matchMedia("(prefers-reduced-motion: reduce)")` leído en un **effect post-mount** (nunca en el initializer de `useState`) + listener de `change`. Cuando está activo: `transition: "none"`, el ángulo salta al destino y la tarjeta entra con un fade de ~300ms. Además un **interruptor visible** *"Sin animación"* en la barra del overlay, porque mucha gente nunca configuró el ajuste del SO. Tope de 3,5s al giro. Sin flashes ni parpadeos.
  **Trampa a no cometer**: CLAUDE.md prohíbe media queries de `prefers-color-scheme` (para sostener el claro forzado). Esa prohibición **no** se extiende a `prefers-reduced-motion` — y alguien la va a sobre-aplicar.
- **Anuncio del resultado**: la rueda comunica su ganador *quedándose quieta*, lo que no existe para un lector de pantalla ni para quien miró para otro lado. Por eso:
  - `<div role="status" aria-live="polite" aria-atomic="true">` con `t("roulette.announce", { name })`, poblado **al terminar** el giro (no durante).
  - El SVG entero es `aria-hidden="true"` — es decoración del mismo dato que ya está en la tarjeta.
  - "Girar" es un `<button>` real (`Button` del design system), con `aria-busy` mientras gira y `disabled` durante el giro.
  - El foco pasa a la tarjeta del ganador al terminar (`tabIndex={-1}` + `focus()`).
  - `Esc` cierra el overlay (listener propio; no hay `Dialog` que lo dé).
- **Tamaño tipográfico de la tarjeta**: es requisito de accesibilidad, no gusto — tiene que leerse en un screen-share. `text-3xl sm:text-6xl` con `break-words` (no hay CHECK de longitud sobre `full_name`; el máximo medido es 37 caracteres).
- **Toques ≥32px** en el botón de excluir por fila (`RowAction` ya cumple: `h-8 w-8`).

---

## 9. Fuera de v1, y por qué

1. **Persistencia del historial entre clases.** Pendiente de la pregunta de §1. Diseño ya cerrado en §6, así que sumarla es una migración, no un rediseño.
2. **Ruleta compartida en vivo / que gire el alumno.** El patrón de realtime broadcast existe (`whiteboard_shared`) pero es **last-write-wins sin OT**: dos clientes girando muestran ganadores distintos durante ~1,5s, y un sorteo con dos ganadores simultáneos es el fallo que destruye la confianza de una vez. La ruleta es un artefacto de un solo anfitrión.
3. **Enlace público / anónimo.** El precedente es explícito y estructural: `chk_polls_public_only_mixed` deja tipos fuera del camino público por CHECK, no por disciplina. Un sorteo público es un bot quemando giros.
4. **Sortear grupos** (`workshop_groups`/`project_groups`). El modelo existe, pero duplica la superficie del predicado de elegibilidad justo donde está lo más delicado del diseño.
5. **Probabilidad ponderada ("llamar más a los callados").** Necesita datos de participación que la ruleta no tiene, y una rueda con pesos invisibles **es** la acusación de "está trucada", implementada a propósito.
6. **Sonido.** `kahoot-sound.ts` es copiable (Web Audio, sin archivos, sin CSP) y `useKahootMuted()` ya sincroniza el mute entre instancias, pero en una clase virtual el tic es intrusivo y no aporta información que la tarjeta no dé. Si se agrega, **reusar el módulo** (no clonar 230 líneas para tener una segunda clave de mute que el docente tenga que descubrir).
7. **Calendario / ICS.** `poll_calendar_events` es slot-only por diseño; un sorteo no es un evento agendable.
8. **"No quiero aparecer" persistido.** `profiles` no tiene columna de consentimiento de exhibición y `course_enrollments` es solo `(course_id, user_id)`. En v1 la exclusión es **por ronda, del lado del docente y efímera**: guardar "este alumno pidió no aparecer" crea un registro sensible sobre él, y hacerlo visible a otros sería la exposición misma que quería evitar. Si el caso se repite, el hogar correcto es una lista de exclusión **por curso** en manos del docente, nunca una columna de perfil.
9. **Realtime Presence ("sortear entre los conectados").** No existe en el repo: 0 hits de `presenceState` / `.track(` / `'presence'` en todo `src/`. Es un feature nuevo, no un dato disponible.

### Barrera explícita que hay que escribir en el código

**La ruleta no escribe nada en ningún camino de calificación**: ni `submissions.final_override_grade`, ni `ExternalGradesEditor`, ni un ítem de `computeWeightedGrade`, ni un evento del gradebook, y no aparece en el vocabulario de Calificaciones. La consecuencia de salir sorteado es social (pasás al tablero), no académica — y esta plataforma construyó todo un aparato de actas inmutables (`20260619000000_immutable_acta_grades.sql`) sobre la premisa de que las notas son trazables. La clave `roulette.notForGrading` lo dice en pantalla, nombrando la tarea y no el mecanismo (P6).

---

## Validación al cerrar

```
npx vitest run src/modules/roulette src/i18n
npx tsc --noEmit        # único error esperado: vite.config.ts(79,3) TS2769 (PREEXISTENTE)
```
Más los checks de P1 (el overlay es `fixed inset-0`, no toca el padding de la ruta), P3 (`Dices` sin color crudo en `PageHeader`; el color solo en el `DropdownMenuItem`, igual que sus vecinos), P4 (el header de Asistencia ya tiene su primaria en *Nueva sesión* → el botón de la ruleta va `variant="outline"`), y el agente `consistencia` antes de commitear.

**Baseline verificado en esta sesión** (read-only, sin editar nada): `seededShuffle` + sus 8 tests están verdes; `Dices`/`Disc3`/`CircleDot` tienen 0 usos; `prefers-reduced-motion` tiene 0 hits en `src/`; `aria-live` aparece en 5 archivos; no hay tokens `--chart-*` en `styles.css`; el `select` de `profiles` en `app.teacher.attendance.tsx:477` hoy trae solo `id, full_name, institutional_email`.
