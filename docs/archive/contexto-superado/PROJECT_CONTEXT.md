# ExamLab — Contexto Técnico del Proyecto

> Resumen de arquitectura y decisiones vigentes de ExamLab. Complementa a
> [EXAMLAB-CONTEXT.md](./EXAMLAB-CONTEXT.md) (referencia exhaustiva de rutas y
> migraciones) y a [docs/PLAN-PRUEBAS-QA.md](./docs/PLAN-PRUEBAS-QA.md) (plan QA
> manual). Este documento sirve de _onboarding_ técnico y de fuente única para
> responder "¿cómo está armado esto y por qué?".

---

## 1. Propósito del producto

Plataforma web de exámenes y talleres en línea con:

- **Roles**: Administrador, Docente, Estudiante (tabla `user_roles`; un usuario
  puede tener varios y cambiar el rol activo desde el sidebar).
- **Exámenes**: preguntas abiertas, cerradas, de código (Monaco + ejecución
  remota) y de diagramas (Mermaid). Proctoring básico, temporizador
  sincronizado, autoguardado y calificación asistida por IA.
- **Talleres**: entregas con archivos, calificación manual o por IA.
- **Admin**: CRUD de usuarios y cursos, importación CSV, matrículas.

---

## 2. Stack

| Capa                | Tecnología                                                        |
| ------------------- | ----------------------------------------------------------------- |
| Frontend            | React 19 + TanStack Router (rutas por archivo) + TanStack Query   |
| UI                  | Tailwind CSS 4 + shadcn/ui (`new-york` style) + lucide-react      |
| Build               | Vite 7 con `@lovable.dev/vite-tanstack-config` (**no modificar**) |
| Backend             | Supabase — PostgreSQL, Auth, Realtime, Edge Functions, Storage    |
| Edge runtime        | Deno (carpeta `supabase/functions/`)                              |
| IA                  | Lovable AI Gateway → Gemini 2.5 Flash                             |
| Ejecución de código | JDoodle (Java / Python / JavaScript)                              |
| Editor de código    | Monaco (`@monaco-editor/react`)                                   |
| Diagramas           | `mermaid`                                                         |
| Notificaciones      | Supabase Realtime + `sonner` (toasts)                             |
| Persistencia local  | `idb-keyval` para respaldo offline del examen                     |
| Deploy              | Cloudflare Workers (`wrangler`)                                   |
| Package manager     | npm (lockfile de bun también presente)                            |
| Tests               | Vitest + React Testing Library + jsdom                            |

### Comandos

```bash
npm install          # instalar dependencias
npm run dev          # dev server
npm run build        # build producción
npm run test         # vitest en watch
npm run test:run     # vitest una vez (CI)
npx tsc --noEmit     # type check
supabase db push     # aplicar migraciones
```

---

## 3. Modelo de datos (resumen)

Tablas principales (ver `supabase/migrations/` para el detalle exacto):

- `profiles`, `user_roles` (enum `admin | docente | estudiante`).
- `courses`, `course_enrollments`, `course_teachers`.
- `exams` — `start_time`, `end_time`, `time_limit_minutes`, `navigation_type`,
  `parent_exam_id` (supletorios).
- `questions` — `type` (`abierta | cerrada | codigo | diagrama`), `points`,
  `language`, `starter_code`, `test_cases`.
- `exam_assignments` — asignación por estudiante o por curso.
- `submissions` — `status` (`en_progreso | completado | sospechoso`),
  `answers` (JSON), `final_override_grade`, `focus_warnings`.
- `exam_timer_controls` (Realtime) — pausa/reanudar/añadir tiempo.
- `workshops`, `workshop_assignments`, `workshop_submissions`.
- `notifications` (Realtime).

### Campos JSON relevantes en `submissions.answers`

| Llave                | Uso                                                                   |
| -------------------- | --------------------------------------------------------------------- |
| `<questionId>`       | Respuesta del estudiante (string / objeto según tipo).                |
| `__breakdown`        | Array `{ qid, points, earned, feedback }` escrito por la IA al final. |
| `__manual_overrides` | Objeto `{ [qid]: { score, feedback } }` escrito por el docente.       |
| `__warning_events`   | Array `{ type, at, questionIdx? }` producido por el proctoring.       |

`computeFinalGrade()` (ver §6) reconcilia IA + overrides y escribe
`final_override_grade` en la misma fila — los overrides manuales siempre ganan
sobre la calificación IA.

---

## 4. Estructura del repositorio

```
src/
├── routes/                        # rutas file-based (TanStack Router)
│   ├── app.student.take.$examId.tsx     # presentación del examen (proctoring)
│   ├── app.student.review.$examId.tsx   # retroalimentación al estudiante
│   ├── app.student.exams.tsx            # listado con estados por fecha
│   ├── app.teacher.monitor.$examId.tsx  # monitor en vivo + calificación
│   └── ...
├── components/                    # UI reutilizable (AppLayout, CodeEditor,…)
├── hooks/                         # use-auth, use-notifications, use-realtime-timer,…
├── utils/                         # helpers puros (ver §6) — 100% testeados
├── integrations/supabase/         # cliente + types generados
├── test/                          # setup de Vitest e integraciones
└── routeTree.gen.ts               # auto-generado en build

supabase/
├── migrations/                    # SQL en orden temporal
└── functions/                     # edge functions (Deno)

docs/
└── PLAN-PRUEBAS-QA.md             # plan QA manual por rol / módulo
```

---

## 5. Decisiones de arquitectura vigentes

### 5.1 Temporizador absoluto

El timer siempre cuenta hacia `exam.end_time`, no hacia
`time_limit_minutes` desde el inicio. Un estudiante que entra 10 min tarde a
una ventana 17:00→18:00 tiene 50 minutos, no 60. Esto evita el bug de
"reset al recargar" y mantiene equidad entre estudiantes.

Implementación: [src/utils/exam-time.ts](src/utils/exam-time.ts) —
`computeSecondsLeft`, `isExamOpen`, `getExamAccessState`, `formatTimerMMSS`.

### 5.2 Proctoring

- Umbral único: `MAX_WARNINGS = 3`. Se cruza a `sospechoso` al llegar al umbral.
- Claves de advertencia conviven en **dos conjuntos** por compatibilidad con
  datos históricos:
  - Español (take flow actual): `pestaña`, `copiar`, `pegar`, `cortar`, `menu`.
  - Inglés (monitor antiguo): `blur`, `visibility_hidden`, `fullscreen_exit`,
    `copy`, `paste`, `context_menu`.
- `warningLabel()` unifica ambos a etiquetas en español.
- `warningEventTimestamp()` acepta tanto `ev.at` (ISO o ms) como `ev.ts` (ms).

Implementación: [src/utils/proctoring.ts](src/utils/proctoring.ts).

### 5.3 Calificación

- **IA al final**: el edge function `ai-grade-submission` se invoca **al enviar**
  el examen (`submitExam`), no por pregunta ni en cada tick, para minimizar
  costo/latencia. También acepta `questionId` para recalificar una sola
  pregunta desde el monitor.
- **Manual por pregunta**: `answers.__manual_overrides[qid] = { score, feedback }`.
- **Agregación**: `computeFinalGrade(questions, breakdown, overrides)` →
  escala 0-10, con overrides ganando sobre IA; devuelve `null` cuando no hay
  ningún dato todavía (UI muestra "—").

Implementación: [src/utils/grade.ts](src/utils/grade.ts).

### 5.4 Monitor restringido a estados finales

En [src/routes/app.teacher.monitor.$examId.tsx](src/routes/app.teacher.monitor.$examId.tsx)
el botón de "ver respuestas" solo se habilita cuando
`status ∈ {completado, sospechoso}`. Mientras el estudiante está `en_progreso`,
el docente ve la fila, puede controlar tiempos y recibir actualizaciones
realtime, pero **no** abre el visor de respuestas (evita interferir con la
entrega y con el autoguardado).

El monitor combina **dos mecanismos de actualización**:

1. Realtime: canal `postgres_changes` sobre `submissions` filtrado por `exam_id`.
2. Polling cada 10 s como _fallback_.

### 5.5 Revisión del estudiante

[src/routes/app.student.review.$examId.tsx](src/routes/app.student.review.$examId.tsx)
renderiza, por pregunta, la respuesta, la nota, y **el feedback combinado**
(override manual si existe, si no el breakdown de IA). Esto cierra el bucle
didáctico sin exponer datos de otros estudiantes.

### 5.6 Offline backup

El take flow guarda cada respuesta en `idb-keyval` cada ~1.5 s además del
autosave al servidor. Si el estudiante recarga o pierde conexión, se reanuda
desde Supabase y se reconcilia con lo que haya en IndexedDB.

---

## 6. Utilidades compartidas

Tres módulos puros, todos con tests en `src/utils/*.test.ts` (42 casos
unitarios al momento de escribir este doc).

| Módulo                                             | API pública                                                                                                          | Consumidores                               |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [src/utils/exam-time.ts](src/utils/exam-time.ts)   | `computeSecondsLeft`, `isExamOpen`, `getExamAccessState`, `formatTimerMMSS`                                          | take flow, listado del estudiante, monitor |
| [src/utils/proctoring.ts](src/utils/proctoring.ts) | `MAX_WARNINGS`, `warningLabel`, `shouldMarkSuspicious`, `warningEventTimestamp`, tipos `WarningType`, `WarningEvent` | take flow, monitor                         |
| [src/utils/grade.ts](src/utils/grade.ts)           | `computeFinalGrade`, tipos `QuestionPoints`, `BreakdownItem`, `ManualOverride`                                       | monitor, revisión del estudiante           |

Si tienes que añadir lógica compartida entre monitor y take, primero revisa si
cabe en una de estas (o en una cuarta) antes de duplicar.

---

## 7. Pruebas automatizadas

### Herramientas

- **Vitest 4** (entorno `jsdom`, globals habilitados).
- **React Testing Library** + `@testing-library/jest-dom/vitest`.
- Setup: [src/test/setup.ts](src/test/setup.ts) ejecuta `cleanup()` tras cada test.
- Configuración: [vitest.config.ts](vitest.config.ts) — independiente del
  `vite.config.ts` bloqueado por `@lovable.dev/vite-tanstack-config`.

### Qué está cubierto (hoy)

- `exam-time.test.ts` — cálculo de segundos restantes, estado de acceso
  (`upcoming | open | closed`), formato MM:SS, "no reset" al recalcular en
  ticks sucesivos.
- `proctoring.test.ts` — etiquetas bilingües, umbral de sospechoso, timestamps
  `at` / `ts`, simulación del loop de advertencias.
- `proctoring-integration.test.ts` — listeners reales (`window.blur`,
  `document.visibilitychange`) sobre jsdom con autosave mockeado.
- `grade.test.ts` — agregación 0-10, prioridad de overrides sobre IA,
  redondeo, casos borde (sin datos, puntos totales 0).

### Cómo correrlas

```bash
npm run test         # watch
npm run test:run     # una pasada (CI)
```

### Qué falta (deuda consciente)

- Tests de render para `app.student.take.$examId.tsx` (requieren mock del
  cliente de Supabase y del `use-realtime-timer`). Los helpers puros ya
  cubren la lógica crítica; esto sumaría cobertura de integración UI.
- Edge functions (Deno) — se prueban manualmente según el plan QA.

---

## 8. Convenciones de código

- **Imports ordenados**: externos → alias `@/` → relativos. Prettier 3 ya
  aplica estas reglas; `npm run format` resuelve.
- **Manejo de errores con Supabase**: toda mutación termina con
  `toast.success(...)` o `toast.error(error.message)`. No dejes mutaciones
  silenciosas.
- **`console.log`** fuera de debug sessions. `console.error` **solo** dentro
  de `try/catch` cuando el error no va a un toast.
- **Inputs numéricos**: `value={val || ""}` para evitar leading zeros y
  `onChange={e => set(e.target.value === "" ? 0 : Number(e.target.value))}`.
- **Tablas de acciones**: `flex items-center justify-end gap-0.5` con
  `Button variant="ghost" size="sm"` y tooltip vía `title`.

---

## 9. Variables de entorno

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Edge functions requieren secretos adicionales (`LOVABLE_API_KEY`,
`JDOODLE_CLIENT_ID`, etc.) configurados vía `supabase secrets set`.

---

## 10. Notas operativas

- **Sin registro público**: la ruta `/auth` solo tiene login; los usuarios se
  crean desde admin.
- **Service Worker**: el build incluye PWA; tras deploy puede hacer falta hard
  refresh (Ctrl+Shift+R) o _clear site data_ para invalidar el cache.
- **`routeTree.gen.ts`** se regenera en build; no editar a mano.
- **Tipos de Supabase** (`src/integrations/supabase/types.ts`): actualizar
  manualmente al agregar tablas o columnas.
- **Dark mode**: variables OKLch en `src/styles.css`, toggle vía `use-theme.ts`.

---

## 11. Dónde empezar según el tipo de cambio

| Necesito tocar…                  | Empezar por                                                          |
| -------------------------------- | -------------------------------------------------------------------- |
| Temporizador o ventana de acceso | `src/utils/exam-time.ts` (+ tests)                                   |
| Reglas de proctoring             | `src/utils/proctoring.ts` (+ tests)                                  |
| Cálculo de nota                  | `src/utils/grade.ts` (+ tests)                                       |
| UI del examen                    | `src/routes/app.student.take.$examId.tsx`                            |
| UI del docente                   | `src/routes/app.teacher.monitor.$examId.tsx`                         |
| Retroalimentación del estudiante | `src/routes/app.student.review.$examId.tsx`                          |
| Modelo de datos                  | `supabase/migrations/` (migración nueva, no editar pasadas)          |
| IA                               | `supabase/functions/ai-grade-submission/` o `ai-generate-questions/` |
