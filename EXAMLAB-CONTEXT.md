# ExamLab — Contexto del Proyecto

## Descripción
Plataforma web de gestión y ejecución de exámenes online con IA, proctoring y talleres. Roles: Admin, Docente, Estudiante.

## Stack Tecnológico
- **Frontend**: React 19, TanStack Router (file-based), TanStack Query, Tailwind CSS 4, shadcn/ui (new-york style)
- **Backend**: Supabase (PostgreSQL, Auth, Realtime, Edge Functions, Storage)
- **Code Execution**: JDoodle API (Java/Python/JS)
- **AI**: Lovable AI Gateway (Gemini 2.5 Flash) para generación de preguntas y calificación
- **Diagramas**: Mermaid.js (UML integrado en exámenes)
- **Editor de código**: Monaco Editor (@monaco-editor/react)
- **Build**: Vite 7 con @lovable.dev/vite-tanstack-config
- **Deploy**: Cloudflare Workers (wrangler)
- **Package Manager**: npm/bun

## Comandos
```bash
npm install          # Instalar dependencias
npm run dev          # Dev server
npm run build        # Build producción
npx tsc --noEmit     # Type check
supabase db push     # Aplicar migraciones
```

## Estructura de Archivos Clave

### Rutas (TanStack Router — file-based)
```
src/routes/
├── __root.tsx              # HTML shell, meta, SW registration, Google Fonts
├── index.tsx               # Landing page pública
├── auth.tsx                # Login (sin registro — solo admin crea usuarios)
├── app.tsx                 # Layout wrapper con AppLayout
├── app.index.tsx           # Dashboard por rol (Admin/Docente/Estudiante)
├── app.admin.users.tsx     # CRUD usuarios, CSV import/export
├── app.admin.courses.tsx   # CRUD cursos, matrículas, docentes, duplicar
├── app.teacher.exams.index.tsx    # Lista exámenes, crear (multi-curso)
├── app.teacher.exams.$examId.tsx  # Editor examen, preguntas, asignaciones
├── app.teacher.monitor.$examId.tsx # Monitor en vivo (pause/resume/add time)
├── app.teacher.gradebook.tsx      # Calificaciones (exámenes + talleres)
├── app.teacher.workshops.tsx      # CRUD talleres, calificación IA + manual
├── app.student.exams.tsx          # Lista exámenes asignados
├── app.student.take.$examId.tsx   # Presentar examen (proctoring)
├── app.student.workshops.tsx      # Talleres, entregas con archivos
├── app.student.courses.tsx        # Cursos matriculados
```

### Componentes
```
src/components/
├── AppLayout.tsx        # Sidebar, role selector (context), nav, notifications
├── CodeEditor.tsx       # Monaco editor wrapper (Java/Python/JS)
├── DiagramEditor.tsx    # Mermaid.js editor con plantillas UML
├── NotificationBell.tsx # Popover de notificaciones con Realtime
├── ThemeToggle.tsx      # Light/Dark/System toggle
```

### Hooks
```
src/hooks/
├── use-auth.ts          # Auth state, profile, roles, signOut
├── use-active-role.ts   # React Context para rol activo del selector
├── use-notifications.ts # Notificaciones con Supabase Realtime
├── use-realtime-timer.ts # Temporizador sincronizado (pause/resume/add_time)
├── use-theme.ts         # Dark mode con localStorage
```

### Supabase Edge Functions
```
supabase/functions/
├── execute-code/        # Ejecuta Java/Python/JS via JDoodle API
├── ai-generate-questions/ # Genera preguntas con IA (Gemini)
├── ai-grade-submission/   # Califica respuestas con IA
├── bulk-import-users/     # Importa usuarios desde CSV
├── seed-data/             # Datos de prueba iniciales
```

## Base de Datos (Migraciones en orden)

### 1. `20260419051958` — Core
- `profiles`, `user_roles`, `courses`, `course_enrollments`
- `exams`, `questions`, `exam_assignments`, `submissions`
- RLS policies, `has_role()` function, auto-create profile trigger

### 2. `20260419060000` — Phase 2
- `exam_timer_controls` (Realtime enabled)
- `code_executions`
- `questions`: +language, +starter_code, +test_cases
- `workshops`, `workshop_assignments`, `workshop_submissions`

### 3. `20260419070000` — Workshop Storage
- Bucket `workshop-files` (50MB, tipos MIME permitidos)
- RLS: estudiantes own folder, docentes read all

### 4. `20260419080000` — Notifications
- `notifications` (Realtime enabled)
- `notify_course_students()` function

### 5. `20260419090000` — Course Dates
- `courses`: +period, +start_date, +end_date
- `course_teachers` table

### 6. `20260419100000` — Workshop Start Date
- `workshops`: +start_date

### 7. `20260423224445` — Reintentos de examen
- `courses`: +max_exam_attempts (int, NOT NULL, default 1)
- `exams`: +max_attempts (int, nullable → override puntual del curso)

### 8. `20260424015642` — Notas de apoyo en exámenes
- `exam_notes` (id, exam_id FK, user_id, content TEXT, status `pendiente|aprobada|rechazada`, rejection_reason, reviewed_by, reviewed_at)
- RLS: estudiante puede CRUD sólo sus propias notas (`auth.uid() = user_id`); docente/admin pueden leer todas y `UPDATE` para aprobar/rechazar
- Trigger `update_updated_at_column()` aplicado para mantener `updated_at`

## Patrones de UI Estandarizados

### Tablas de acciones
```tsx
<TableCell className="text-right">
  <div className="flex items-center justify-end gap-0.5">
    <Button variant="ghost" size="sm" title="Tooltip"><Icon className="h-4 w-4" /></Button>
  </div>
</TableCell>
```

### Modales de asignación
- Buscador (si aplica)
- Contador: "X de Y asignados"
- Botones: CheckSquare "Seleccionar todos" + XSquare "Deseleccionar todos"
- Lista con checkboxes, badges "Asignado"/"Matriculado"
- Toast en cada acción individual y masiva

### Inputs numéricos
- `value={val || ""}` para evitar leading zeros
- `onChange={e => set(e.target.value === "" ? 0 : Number(e.target.value))}`

### Toasts
- Toda mutación tiene `toast.success()` o `toast.error()`
- CSV downloads: "Archivo CSV descargado"
- Creación: "Usuario creado", "Examen creado", etc.
- Asignación: "Estudiante asignado al examen"

## Flujos Clave

### Examen (Estudiante)
1. Solo visible si `start_time <= now`
2. Fullscreen + proctoring (blur warnings, copy/paste block)
3. Temporizador Realtime (docente puede pausar/reanudar/añadir tiempo)
4. Auto-save cada 1.5s + IndexedDB offline backup
5. Al entregar: AI grading via edge function

### Talleres (Calificación)
- Estados: `pendiente` → `entregado` → `ai_revisado` → `calificado`
- "Calificar con IA" (individual o masivo) → estado `ai_revisado`
- Docente ve nota IA + feedback → Aprobar (ThumbsUp) o Rechazar (ThumbsDown)
- Calificación manual siempre disponible

### Preguntas
- Tipos: `abierta`, `cerrada`, `codigo`, `diagrama`
- Diagrama: editor Mermaid integrado con plantillas UML
- Código: Monaco editor con ejecución via JDoodle

### Cursos
- Campos: nombre, periodo (ej: 2026-1), fecha inicio/fin, descripción
- Configuración de evaluación a nivel curso: `max_exam_attempts` (intentos por defecto que heredan los exámenes del curso, configurable por el rol Docente)
- Duplicar: copia exámenes+preguntas, talleres, **estudiantes matriculados** (clona `course_enrollments`) y muestra el conteo en el toast
- Docentes asignados via `course_teachers`
- Bug fix: las fechas se sanean a `YYYY-MM-DD` (`toDateInput()`) antes de cargarlas en `<input type="date">` para que el selector funcione con valores ISO previos

### Talleres (asignación)
- Los talleres se asignan **a nivel de curso**, no por estudiante individual
- Al crear/publicar un taller, `autoAssignWorkshop` asegura que todos los estudiantes matriculados lo reciban
- La UI de selección manual de estudiantes en el editor de taller fue retirada — los talleres son ítems del curso

### Exámenes — Reintentos
- Cada curso define `max_exam_attempts` (default 1) — aplica a todos los exámenes del curso
- Cada examen puede sobrescribir con `exams.max_attempts` (nullable → si NULL hereda del curso). Útil para quices con múltiples intentos en un curso de un solo intento por defecto
- El estudiante:
  - Si tiene una submission `en_progreso`, el botón dice "Reanudar" y NO consume nuevo intento
  - Si `finishedCount (completado + sospechoso) >= maxAttempts` → bloqueado con "Sin intentos disponibles"
  - Mientras le queden intentos y la ventana esté abierta, puede iniciar un nuevo intento (botón "Reintentar examen")
  - El badge "Intento X de Y" sólo se muestra si `maxAttempts > 1`

### Notas de apoyo del examen (cheat-sheet aprobada)
- Tabla `exam_notes`: el estudiante sube **texto plano** asociado a un examen desde su card en `/app/student/exams` (sólo si la ventana sigue abierta y el examen no está completado)
- Estados: `pendiente` → `aprobada` (visible durante el take) | `rechazada` (con `rejection_reason` obligatorio → estudiante puede editar y reenviar)
- El docente revisa/aprueba/rechaza desde el editor del examen (`/app/teacher/exams/$examId` → pestaña "Notas de apoyo") con `TeacherExamNotes`
- Durante el examen (`take.$examId`), si existe nota `aprobada` para `(exam_id, user_id)`, se muestra un panel sticky colapsable arriba de las preguntas vía hook `useApprovedExamNote`
- Componentes: `src/components/ExamNotesManager.tsx` exporta `StudentExamNotes`, `TeacherExamNotes`, `useApprovedExamNote`

### Duplicación de cursos
- Toggle "Copiar docentes" en el modal de duplicar (default **OFF** → no copia `course_teachers`)
- Toggle "Copiar matrículas" preexistente sigue independiente

### Asistencia rápida (Docente)
- En `/app/teacher/attendance` el selector por estudiante muestra sólo **P** (Presente) / **A** (Ausente) en un control compacto `w-12`, optimizado para móvil

### Talleres — asignación con exclusión
- Modal de asignación: selector de **Curso** + listado de estudiantes del curso con checkboxes para **excluir** individualmente (badges "Incluido"/"Excluido")
- Al confirmar, asigna a todos los estudiantes del curso EXCEPTO los excluidos

### Notificaciones
- Realtime push via Supabase
- Triggers: asignar examen, publicar taller
- Toast al entrar al dashboard
- Bell icon en sidebar con popover

## Variables de Entorno (.env)
```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

## Notas Importantes
- **Sin registro público**: Solo admins crean usuarios (auth.tsx sin signup)
- **Vite config**: No modificar — viene de @lovable.dev/vite-tanstack-config
- **Route tree**: Se auto-genera al hacer build (routeTree.gen.ts)
- **Service Worker**: Puede cachear JS viejo — hacer hard refresh (Ctrl+Shift+R) o clear site data
- **Supabase types**: Actualizar manualmente en `src/integrations/supabase/types.ts` al agregar tablas/columnas
- **Dark mode**: CSS variables OKLch en styles.css, toggle via use-theme.ts
- **Rol activo**: Compartido via React Context (ActiveRoleContext) desde AppLayout
