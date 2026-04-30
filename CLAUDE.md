# ExamLab — Claude Context

> Notas de arquitectura, decisiones de diseño y convenciones para que un agente
> retome la sesión sin redescubrir cosas. Mantener cortas y específicas:
> describir **qué hay** y **por qué**, no replicar el README.

---

## 1. Plataforma y despliegue

ExamLab vive en dos entornos paralelos:

- **Lovable.dev** (producción principal). Lovable gestiona Supabase
  automáticamente. El usuario NO tiene acceso al dashboard de Supabase.
  - Flujo: `git push origin main` → click en **Publish** en Lovable.
  - Las migraciones se aplican en Publish desde `supabase/migrations/*.sql`.
- **AWS self-hosted** (opcional, manual). Carpeta
  [`lovable-aws-deployment/`](lovable-aws-deployment/) — agnóstica al proyecto.
  Despliega EC2 + Supabase Docker con un único `bash deploy.sh`.

Remote git: `git@github-vivetori:vivetori/examlab.git` (alias `origin`).

---

## 2. Stack

| Área | Lo que se usa |
|------|---------------|
| Frontend | React 19 + TypeScript + Vite 7 |
| Routing | TanStack Router v1 (file-based) + TanStack Start (SSR/SSG) |
| Estado servidor | TanStack Query |
| UI | shadcn/ui sobre Tailwind v4, lucide-react, sonner (toasts) |
| Editor de código | Monaco Editor |
| Diagramas | mermaid (lazy import) |
| i18n | react-i18next (`es` / `en`) |
| Offline | idb-keyval para autosave en IndexedDB |
| Backend | Supabase (PostgreSQL 15 + Auth + Realtime + Storage + Edge Functions Deno) |
| IA | Lovable AI Gateway en Lovable; Google Gemini OpenAI-compatible en AWS |

---

## 3. Mapa de archivos clave

### Examen estudiantil
| Archivo | Propósito |
|---------|-----------|
| `src/routes/app.student.take.$examId.tsx` | Pantalla de toma de examen |
| `src/routes/app.student.exams.tsx` | Lista de exámenes del estudiante |
| `src/routes/app.student.review.$examId.tsx` | Revisión de resultados |
| `src/hooks/use-realtime-timer.ts` | Timer (inicializa una sola vez con `initialSeconds > 0`) |
| `src/lib/offline-sync.ts` | `clearLocalAnswers`, `setupOfflineSync` (IndexedDB) |
| `src/utils/proctoring.ts` | `MAX_WARNINGS=3`, `warningLabel`, `shouldMarkSuspicious` |

### Proyectos (caja por archivo + Mermaid)
| Archivo | Propósito |
|---------|-----------|
| `src/components/ProjectFiles.tsx` | `TeacherProjectFilesEditor` y `StudentProjectTaker`. Textarea por archivo + preview Mermaid |
| `src/components/MermaidPreview.tsx` | Renderer Mermaid (lazy import) + helper `looksLikeMermaid(text)` |
| `src/routes/app.student.projects.tsx` | Listado del estudiante con modal de entrega |
| `src/routes/app.student.project.$projectId.tsx` | Vista de revisión post-calificación |
| `src/routes/app.teacher.projects.tsx` | Editor docente (CRUD + asignación + cortes) |
| `supabase/migrations/20260428000000_projects.sql` | Schema: `project_files`, `project_assignments`, `project_submission_files` |

### UI compartida
| Archivo | Propósito |
|---------|-----------|
| `src/components/DatePicker.tsx` | `DatePicker` y `DateTimePicker` shadcn (Popover + Calendar). Reemplazos de `<input type="date">`/`type="datetime-local">` |
| `src/components/ui/label.tsx` | `<Label required>` agrega asterisco rojo + texto sr-only "(obligatorio)" |
| `src/components/DiagramEditor.tsx` | Editor Mermaid completo con templates (clase distinta a `MermaidPreview` que solo renderiza) |

### Datos generados
- `src/integrations/supabase/types.ts` — tipos generados de Supabase. Se hace
  cast `as any` cuando una tabla es nueva y aún no se regeneraron tipos
  (común en `projects`/`project_files`).

---

## 4. Decisiones de diseño — examen estudiantil

### Session lock (sin migración DB)
Usa `answers.__session_id` dentro del JSONB existente + `updated_at` como
heartbeat implícito (autosave cada 1.5s). Ventana de expiración: 10s.
No se necesitan columnas adicionales. Localstorage key:
`examlab_exam_session_${examId}`.

### Proctoring — `recordWarning(type)`
Definida dentro del proctoring `useEffect` con deps `[started, performSubmit]`.
Usa `blurLockUntil` (debounce 500ms) para evitar strikes rápidos. Hace
fire-and-forget a Supabase + el autosave de 1.5s recoge lo que falle.

**Crítico:** para el botón "Atrás" del navegador, el modal de confirmación
hace `await supabase.update(...)` **antes** de `navigate()` — el componente
se desmonta al navegar y el autosave timer se cancela.

### Navegación secuencial (forzada)
```ts
const visible = [questions[currentIdx]].filter(Boolean); // siempre 1 pregunta
```
Los botones son siempre Anterior / Siguiente / Finalizar, sin importar
`exam.navigation_type`.

### Timer
Solo `computeSecondsLeft(exam?.end_time)`. El hook `useRealtimeTimer`
inicializa una sola vez cuando `initialSeconds > 0`. **No intentar calcular
tiempo efectivo por estudiante** — el timer es absoluto a `end_time`.

### Offline sync
`clearLocalAnswers(examId)` debe llamarse **antes** de crear una nueva fila
de submission, para evitar el toast "X respuesta(s) sincronizada(s)" cuando
el docente borra la sesión anterior.

---

## 5. Decisiones de diseño — proyectos

### Modelo
- `projects` ya existía (basado en ZIP).
- La migración `20260428000000_projects.sql` añade:
  - `project_files` — un slot/caja por archivo esperado (con `expected_rubric`)
  - `project_submission_files` — la respuesta de texto del estudiante por slot,
    con `ai_grade`, `ai_feedback`, `ai_likelihood`, `ai_reasons`
  - `project_assignments` — asignación a estudiantes
- `projects.max_files` se reusa como "número de archivos esperados".
- `grade_cut_items.project_id` (FK opcional) reemplaza a `project_title` libre.

### Calificación inmediata
La calificación se hace **en el cliente** al enviar (no por job): por cada
slot se invoca `ai-grade-submission` con `projectFileGrading: true`. La nota
final se consolida con `(totalEarned / totalPoints) * max_score`.

### Detección Mermaid
`looksLikeMermaid(text)` retorna `true` si la primera palabra coincide con
una keyword de Mermaid (`graph`, `flowchart`, `sequenceDiagram`, etc.). Se
muestra preview cuando:
- `f.language === "mermaid"` o `"diagrama"`, **o**
- el contenido pegado pasa `looksLikeMermaid(content)`.

`MermaidPreview` carga `mermaid` dinámicamente (`await import`) y renderiza
con `securityLevel: "strict"`. Si falla, muestra mensaje rojo pero deja el
textarea editable.

---

## 6. Convenciones de UI

### Date pickers
**Nunca** usar `<input type="date">` ni `<input type="datetime-local">`.
En Chrome y Safari el calendario nativo no abre confiablemente dentro de
modals Radix. Usar `DatePicker` (solo fecha) o `DateTimePicker` (fecha + hora)
de `@/components/DatePicker`. Aceptan/emiten strings en el mismo formato que
los inputs nativos (`yyyy-MM-dd` o `yyyy-MM-dd'T'HH:mm`).

### Campos obligatorios
Para que un campo aparezca como obligatorio:
1. Pasar `required` al `<Label>` (agrega asterisco rojo y `sr-only`).
2. Pasar `required` al input/textarea/picker correspondiente (HTML5
   validation).

Ejemplo:
```tsx
<Label required>Título</Label>
<Input required value={...} onChange={...} />
```

### Tipos generados de Supabase
Para tablas nuevas (`projects`, `project_files`, etc.) que aún no están en
`types.ts` generado, hacer cast lazo:
```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;
```
Es el patrón en `ProjectFiles.tsx` y rutas de proyectos. **No** regenerar
tipos manualmente — Lovable lo hace en Publish.

---

## 7. Despliegue AWS (lovable-aws-deployment)

> Solo relevante si trabajas en la carpeta `lovable-aws-deployment/`.

- **Carpeta agnóstica al proyecto**. Pasar `PROJECT_NAME` al ejecutar
  `deploy.sh` cambia todos los recursos AWS (stack, EC2, buckets, paths,
  servicios) y permite copiar la carpeta a cualquier proyecto Lovable.
- **No tocar el código fuente del repo** para hacer self-hosted funcionar.
  El bootstrap aplica transformaciones en runtime sobre las edge functions
  copiadas a la EC2:
  - `sed`: `ai.gateway.lovable.dev` → `generativelanguage.googleapis.com`,
    `google/gemini-` → `gemini-`.
  - **Wrapper de `fetch`** inyectado al inicio de cada `index.ts` que llama a
    Gemini: si responde 429/503, reintenta automáticamente con
    `gemini-2.0-flash` → `2.0-flash-lite` → `1.5-flash` → `1.5-flash-8b`.
- **`LOVABLE_API_KEY` en self-hosted recibe valor de Gemini** (no de
  Lovable Gateway). El nombre se mantiene para no tocar código.
- **Storage actual**: disco local de la EC2 dentro del container. El bucket
  S3 `<proyecto>-storage-*` está creado pero no conectado (mejora futura).

---

## 8. Notas de git y desarrollo

### Archivos con `$` en el nombre
TanStack Router usa `$paramName` en filenames. Bash interpreta `$` como
expansión, así que **comillas simples** al hacer `git add`:
```bash
git add 'src/routes/app.student.take.$examId.tsx'
```

### Sin acceso a Supabase dashboard
Como Lovable gestiona Supabase, **no se puede** debuggear migraciones ni RLS
desde el dashboard. Cuando algo falla con permisos, leer el SQL de la
migración correspondiente en `supabase/migrations/` y revisar las policies
ahí.

### Cuando Lovable reescribe archivos
Lovable a veces reformatea archivos al hacer Publish. Si tras un Publish ves
cambios que no escribiste, hacer `git pull` antes de seguir editando.

---

## 9. Documentación complementaria

| Documento | Contenido |
|-----------|-----------|
| [`README.md`](README.md) | Visión general del proyecto (qué es ExamLab, stack, características) |
| [`docs/PLAN-PRUEBAS-QA.md`](docs/PLAN-PRUEBAS-QA.md) | Casos de prueba pendientes para nuevas funcionalidades |
| [`docs/QA-RESULTADOS.md`](docs/QA-RESULTADOS.md) | Resultados de sesiones QA pasadas + bugs corregidos |
| [`lovable-aws-deployment/README.md`](lovable-aws-deployment/README.md) | Manual paso a paso de despliegue en AWS |
| [`lovable-aws-deployment/DEPLOYMENT_GUIDE.md`](lovable-aws-deployment/DEPLOYMENT_GUIDE.md) | Detalle técnico del despliegue (recursos, secuencia de boot, fallback IA) |

---

_Última actualización: 2026-04-30. Mantén este archivo corto y específico —
detalle profundo va en docs especializadas._
