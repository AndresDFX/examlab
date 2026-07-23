# Tareas programadas (pg_cron)

Esta guía documenta los **cron jobs** activos en ExamLab y cómo
operarlos. Toda la lógica de programación corre dentro de Postgres vía
la extensión [`pg_cron`](https://github.com/citusdata/pg_cron) —
no dependemos de schedulers externos.

> **Pre-requisito**: la extensión `pg_cron` debe estar habilitada.
> Si no aparece en el panel de Sistema (`Admin → Sistema → Tareas
> programadas` la muestra), habilítala:
> `Database → Extensions → pg_cron → toggle`.

---

## Jobs activos

| Nombre del job | Schedule | Función SQL | Qué hace |
|---|---|---|---|
| `exam-reminders-1h` | `*/10 * * * *` (cada 10 min) | `notify_students_exam_starting_soon(1)` | Notifica + email al estudiante asignado cuando un examen arranca dentro de la próxima 1 hora |
| `workshop-due-24h` | `0 */2 * * *` (cada 2 horas) | `notify_students_workshop_due_soon(24)` | Aviso de taller que vence dentro de 24h |
| `project-due-24h` | `0 */2 * * *` (cada 2 horas) | `notify_students_project_due_soon(24)` | Aviso de proyecto que vence dentro de 24h |
| `teacher-exam-prep-1h` | `*/10 * * * *` (cada 10 min) | `notify_teachers_pending_exam_notes_before_exam(1)` | Avisa al docente si hay notas de apoyo por aprobar y un examen del curso arranca en próx 1h |
| `teacher-daily-summary` | `0 4 * * *` (23:00 hora Colombia / 04:00 UTC) | `notify_teachers_daily_summary()` | Resumen diario con notas pendientes, conversaciones por responder, mensajes sin responder y entregas por calificar |
| `admin-storage-threshold` | `0 */6 * * *` (cada 6 horas) | `notify_admins_storage_threshold()` | Alerta a admins si el espacio libre de DB o storage cae bajo el umbral configurado (default 15%) |

Todas tienen **idempotencia integrada**: no duplican al mismo
destinatario para la misma entidad dentro de una ventana de 2-6h.
Eso permite cambiar la cadencia del schedule sin riesgo de spam.

---

## Detalle por job

### `exam-reminders-1h`

- **Función**: `public.notify_students_exam_starting_soon(_hours INTEGER DEFAULT 1)`
- **Migración**: [`20260523000006_exam_starting_soon_notif.sql`](../supabase/migrations/20260523000006_exam_starting_soon_notif.sql)
- **Schedule**: `*/10 * * * *` — corre cada 10 minutos. El alumno
  recibe el aviso entre 50 y 60 min antes del inicio.
- **Idempotencia**: 2 horas (no envía el mismo aviso dos veces).
- **Filtros**:
  - `exams.start_time > NOW()` y dentro de la ventana `_hours`
  - Excluye estudiantes con `submissions.status IN ('completado', 'sospechoso')`
- **Notification emitida**: `kind='exam'` → dispara correo
  (CRITICAL_KIND vía `_notification_kind_emails`).

### `workshop-due-24h`

- **Función**: `public.notify_students_workshop_due_soon(_hours INTEGER DEFAULT 24)`
- **Migración**: [`20260523000007_due_reminders_and_cron_diag.sql`](../supabase/migrations/20260523000007_due_reminders_and_cron_diag.sql)
- **Schedule**: `0 */2 * * *` — cada 2 horas en punto.
- **Idempotencia**: 6 horas.
- **Filtros**:
  - `workshops.status = 'published'` con `due_date` dentro de la ventana
  - Excluye estudiantes con `workshop_submissions.status IN ('entregado', 'calificado', 'ai_revisado')`
- **Notification emitida**: `kind='workshop'` → dispara correo.

### `project-due-24h`

- **Función**: `public.notify_students_project_due_soon(_hours INTEGER DEFAULT 24)`
- **Migración**: igual que workshops (20260523000007).
- **Schedule**: `0 */2 * * *`.
- **Idempotencia**: 6 horas.
- **Asignación de estudiantes**: union de `project_assignments` directos
  + `course_enrollments` para los `project_courses` vinculados. Cubre
  ambas vías de asignación sin duplicar (DISTINCT).
- **Notification emitida**: `kind='project'` → dispara correo.

### `teacher-exam-prep-1h`

- **Función**: `public.notify_teachers_pending_exam_notes_before_exam(_hours INTEGER DEFAULT 1)`
- **Migración**: [`20260523000008_teacher_summary_notifs.sql`](../supabase/migrations/20260523000008_teacher_summary_notifs.sql)
- **Schedule**: `*/10 * * * *` — corre cada 10 min, mismo ritmo que el
  recordatorio al estudiante.
- **Idempotencia**: 12 horas por (docente, examen).
- **Lógica**:
  - Busca exámenes con `start_time` dentro de la ventana `_hours`
  - Por cada uno, cuenta `exam_notes` en estado `pendiente` (limitado
    a alumnos asignados al examen)
  - Si hay ≥1, notifica a cada docente del curso (`course_teachers`)
    con el conteo + link al examen
- **Notification emitida**: `kind='exam'` → dispara correo.
- **Caso de uso**: el docente se entera 50-60 min antes del inicio que
  todavía tiene notas por revisar. Si las aprueba a tiempo, los alumnos
  pueden usarlas durante el examen.

### `admin-storage-threshold`

- **Función**: `public.notify_admins_storage_threshold()` (sin parámetros)
- **Migración**: [`20260523000010_system_storage_alerts.sql`](../supabase/migrations/20260523000010_system_storage_alerts.sql)
- **Schedule**: `0 */6 * * *` — cada 6 horas.
- **Idempotencia**: 1 alerta por admin por día (`created_at::date = CURRENT_DATE`).
- **Lógica**:
  - Lee `system_settings` (cuotas DB + storage + umbral) y `system_storage_usage()` (bytes reales)
  - Calcula `db_used_pct` y `storage_used_pct`
  - Si cualquiera supera `100 - alert_threshold_pct` (default 85%), notifica a TODOS los admins
  - Body incluye los recursos en alerta con MB usados / cuota / %
- **Notification emitida**: `kind='system'` con `link='/app/admin/system'` →
  dispara correo + push (regla específica en `_notification_kind_emails`).
- **Configuración**: el admin ajusta cuotas y umbral desde `system_settings`
  (en la migración 20260523000010). Defaults razonables para Supabase free.

### `teacher-daily-summary`

- **Función**: `public.notify_teachers_daily_summary()` (sin parámetros)
- **Migración**: igual que `teacher-exam-prep-1h` (20260523000008).
- **Schedule**: `0 4 * * *` — 04:00 UTC = **23:00 hora Colombia**.
- **Idempotencia**: 1 vez por docente por día (`created_at::date = CURRENT_DATE`).
- **Métricas agregadas por docente**:
  - **A) Notas de apoyo pendientes**: `exam_notes.status='pendiente'` en sus cursos
  - **B) Conversaciones esperando respuesta**: `feedback_threads.closed=false`
    en sus cursos donde el último comment NO es del docente
  - **C) Mensajes sin responder**: misma lógica que el RPC
    `count_unanswered_conversations` pero parametrizada por teacher_id
  - **D) Entregas por calificar**: workshop + project submissions con
    status en `('entregado', 'ai_revisado')` en sus cursos
- **Skip si total = 0**: docentes sin pendientes NO reciben correo (no
  spammeamos con "resumen: 0 pendientes").
- **Notification emitida**: `kind='feedback'` → dispara correo. Link
  apunta a `/app` (dashboard, donde el docente ve los detalles).
- **Caso de uso**: al final del día, el docente recibe un correo
  consolidado con todo lo que dejó pendiente. Reduce el costo cognitivo
  de "tengo que revisar varias secciones de la app para saber qué me
  falta".

---

### `notify-autonomous-sessions`

- **Función**: `public.notify_autonomous_sessions_starting()` (sin parámetros)
- **Migración**: `20261490000000_notify_autonomous_sessions.sql`
- **Schedule**: `* * * * *` — **cada minuto** (precisión de la hora de inicio).
- **Qué hace**: cuando llega la fecha/hora de inicio de una sesión con
  `session_type='autonoma'`, notifica (campana + correo + push) a los alumnos
  matriculados (`course_enrollments`) para que revisen el material.
- **"Due"**: `(session_date + COALESCE(start_time,'09:00')) AT TIME ZONE
  'America/Bogota' <= now()` y `> now() - INTERVAL '2 hours'` (la ventana solo
  evita el spam retroactivo del primer deploy; el guard real es la columna).
- **Idempotencia**: columna `attendance_sessions.notified_start_at` + `FOR UPDATE
  SKIP LOCKED`. Se marca al notificar → nunca re-dispara.
- **Papelera**: filtra `deleted_at IS NULL` en la sesión y en el curso.
- **Notification emitida**: `kind='session_start'` (emailable; toggle
  `email_settings.enabled_kinds.session_start`). Link → `/app/student/courses`.
- **Relacionado**: el alumno "asiste" a la autónoma con el RPC
  `student_review_autonomous_session(_session_id)` (botón "Ya revisé el material"),
  que inserta un `attendance_record` 'presente'.

---

## Comandos operacionales

### Listar todos los jobs (qué tengo programado)

```sql
SELECT jobname, schedule, command, active
FROM cron.job
ORDER BY jobname;
```

> Más fácil: `Admin → Sistema → Tareas programadas`. Card visual con
> nombre, schedule y último resultado.

### Ver el historial de ejecuciones de un job

```sql
SELECT runid, start_time, end_time, status, return_message
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'exam-reminders-1h')
ORDER BY start_time DESC
LIMIT 20;
```

`status` típico: `succeeded` / `failed`. Si ves `failed`, el
`return_message` trae el error completo.

### Forzar una ejecución manual (sin esperar el cron)

```sql
-- Examen 1h
SELECT public.notify_students_exam_starting_soon(1);
-- Taller 24h
SELECT public.notify_students_workshop_due_soon(24);
-- Proyecto 24h
SELECT public.notify_students_project_due_soon(24);
```

Retorna el número de notificaciones insertadas en esta corrida.
Útil para probar después de crear un examen con `start_time = NOW() + 45 min`.

### Programar un job nuevo (ej. recordatorio extra de 6h antes del examen)

```sql
SELECT cron.schedule(
  'exam-reminders-6h',
  '*/15 * * * *',
  $$ SELECT public.notify_students_exam_starting_soon(6); $$
);
```

### Cambiar el schedule de un job existente

```sql
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'exam-reminders-1h'),
  schedule := '*/5 * * * *'  -- cada 5 min en vez de cada 10
);
```

### Desactivar un job (sin borrarlo)

```sql
SELECT cron.alter_job(
  job_id := (SELECT jobid FROM cron.job WHERE jobname = 'exam-reminders-1h'),
  active := false
);
```

### Borrar un job permanentemente

```sql
SELECT cron.unschedule('exam-reminders-1h');
```

---

## Setup post-migración (one-time)

Después de aplicar las migraciones, ejecuta una sola vez en SQL Editor:

```sql
-- 1) Habilitar pg_cron si no está
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- 2) Programar los cinco jobs
SELECT cron.schedule(
  'exam-reminders-1h',
  '*/10 * * * *',
  $$ SELECT public.notify_students_exam_starting_soon(1); $$
);

SELECT cron.schedule(
  'workshop-due-24h',
  '0 */2 * * *',
  $$ SELECT public.notify_students_workshop_due_soon(24); $$
);

SELECT cron.schedule(
  'project-due-24h',
  '0 */2 * * *',
  $$ SELECT public.notify_students_project_due_soon(24); $$
);

SELECT cron.schedule(
  'teacher-exam-prep-1h',
  '*/10 * * * *',
  $$ SELECT public.notify_teachers_pending_exam_notes_before_exam(1); $$
);

-- 23:00 hora Colombia = 04:00 UTC. pg_cron interpreta UTC por default.
SELECT cron.schedule(
  'teacher-daily-summary',
  '0 4 * * *',
  $$ SELECT public.notify_teachers_daily_summary(); $$
);

-- Cada 6h: chequea espacio en DB/storage; si cae bajo el umbral,
-- avisa a los admins.
SELECT cron.schedule(
  'admin-storage-threshold',
  '0 */6 * * *',
  $$ SELECT public.notify_admins_storage_threshold(); $$
);

-- 3) Verifica
SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
```

---

## Diagnóstico desde el panel

`Admin → Sistema` muestra el card **"Tareas programadas"** con:
- Nombre del job + schedule
- Badge "inactivo" si `active = false`
- Estado de la última ejecución (verde/rojo según status)
- Timestamp de la última corrida

Estados del card:
- 🟢 **OK**: todos los jobs activos y última ejecución `succeeded`
- 🟡 **Aviso**: algún job inactivo, fallado, o no hay jobs registrados
- ⚪ **Idle**: pg_cron no está instalado o `system_cron_jobs()` RPC
  no devolvió data (la migración `20260523000007` no se aplicó)

---

## Patrón para agregar un nuevo recordatorio

Si más adelante hace falta otro aviso programado (ej. "5 días antes
de cerrar el corte"), seguir este molde:

1. **Función SQL** (en una migración nueva) — debe:
   - Aceptar un parámetro de ventana (`_hours` o `_days`)
   - Hacer `INSERT INTO notifications (..., kind='exam'|'workshop'|'project'|'feedback'|'grade', ...)` — kinds que están en `CRITICAL_KINDS` → dispara correo
   - Tener `WHERE NOT EXISTS` por idempotencia (ventana ≥ 2× la cadencia del cron)
   - `RETURNS INTEGER` con `GET DIAGNOSTICS _count = ROW_COUNT`
   - `SECURITY DEFINER` + `GRANT EXECUTE ... TO service_role`

2. **Programación** (`SELECT cron.schedule(...)` en SQL Editor) — pick:
   - Cron expression con cadencia razonable (cada 10 min para urgentes,
     cada 1-2h para vencimientos de día completo)

3. **Documentar acá** en este archivo (tabla "Jobs activos" + sección
   detalle).

4. **Verificar** en `Admin → Sistema → Tareas programadas` que aparezca.

---

## FAQ

**¿Por qué no se programa "exactamente 1 hora antes" del examen?**
Programar dinámicamente "X minutos antes de cada `start_time`"
requeriría re-agendar el cron cada vez que cambian los exámenes.
El patrón "poll cada N min con ventana + dedupe" es estándar
(Calendly, Outlook, etc.). El alumno recibe el aviso entre 50 y 60
min antes — margen aceptable.

**¿Qué pasa si el cron se cae (Postgres reinicia)?**
pg_cron retoma automáticamente al volver. Las ejecuciones perdidas
NO se compensan retroactivamente, pero la idempotencia hace que la
siguiente corrida cubra los casos que quedaron pendientes (siempre
que estén dentro de la ventana del filtro `_hours`).

**¿Cómo veo si una notificación fue por correo o solo in-app?**
Revisa la tabla `audit_logs` filtrada por categoría `'email'`. Ahí
ves `email.dispatched` (trigger pasó al edge) y `email.delivered`
(SMTP confirmó). O usa el filtro "Notificaciones por correo" en el
panel de Auditoría.

**¿Puedo correr un job una sola vez sin programarlo recurrente?**
Sí — invoca la función SQL directamente: `SELECT public.notify_students_exam_starting_soon(1);`.
La idempotencia previene duplicados.
