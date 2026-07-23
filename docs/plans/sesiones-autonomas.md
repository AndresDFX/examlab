# Plan — Sesiones autónomas (tipo de sesión + notificación por hora de inicio)

> Estado: PROPUESTA (pendiente de aprobación). Generado a partir de una auditoría
> de los subsistemas de sesiones, material, notificaciones/cron y calendarios.

## Qué pidió el usuario

1. Agregar un **tipo de sesión**: `Presencial`, `Virtual`, `Autónoma`. Los registros
   existentes quedan como **`virtual`**.
2. Una sesión **autónoma** **notifica a los estudiantes del curso** en la **fecha y
   hora de inicio** para que **revisen el material de la sesión**.
3. El material es **parametrizable**: puede incluir encuesta en vivo, taller, pizarra,
   contenido, etc.

## Hallazgo clave (reduce el alcance)

El vínculo sesión↔material **ya existe en la base de datos**. Una sesión ya puede
"agrupar" material por estas FKs (todas presentes y funcionando):

| Material | Vínculo actual | Se asigna desde |
|---|---|---|
| Contenido (archivos, notebooks, código) | `attendance_sessions.content_id` + `content_class_index` + `content_file_paths` (1:1) | Tablero (`app.teacher.board`) y Popover de la matriz de asistencia |
| Pizarra inline | `attendance_sessions.whiteboard_scene` + `whiteboard_shared` | Dropdown "Pizarra" en asistencia |
| Pizarras standalone | `whiteboards.attendance_session_id` (N:1) | Módulo Pizarras (al crear) |
| Encuesta / Reto en vivo | `polls.attendance_session_id` (N:1) | "Lanzar encuesta" en la sesión (kahoot solo desde el módulo Encuestas) |
| Taller / Examen / Proyecto | `{workshops,exams,projects}.attendance_session_id` (N:1) | Form de la actividad (`ActivitySessionSelect`) |
| Snippets de código | `session_code_snippets.session_id` + `code_shared` | *(regresión: falta la superficie del docente — ver Fase 2)* |

Y el **tablero del estudiante** (`app.student.courses.tsx`) **ya muestra ese material
agrupado por sesión** (contenido liberado por fecha + actividades + grabación/notas).

**Conclusión:** lo que falta NO es el material, sino: (a) el **campo tipo**, (b) la
**notificación temporizada** de la sesión autónoma, y (c) *opcionalmente* un **checklist
unificado** con orden/obligatoriedad/progreso (hoy el material está disperso en varias
tablas y vistas). Por eso el plan se divide en **Fase 1 (MVP, entrega lo pedido)** y
**Fase 2 (checklist rico, opcional)**.

---

## Decisiones a confirmar antes de implementar

1. **Default de históricos = `virtual`** ✅ (pedido explícito; el `DEFAULT 'virtual'` de
   la columna rellena todas las filas existentes sin UPDATE aparte).
2. **Kind de notificación**: crear uno nuevo `session_start` (toggle propio en el panel
   de correo + semántica clara) vs. reusar `attendance` (ya emailable). → **Recomiendo
   `session_start` nuevo.**
3. **¿La sesión autónoma cuenta para el peso de asistencia del corte?** Una autónoma no
   tiene check-in presencial. Opciones: (a) no cuenta para asistencia (se excluye del
   denominador), (b) "asistió" = abrió/completó el material, (c) igual que hoy (no
   cambia nada). → **Recomiendo (a) para el MVP** (documentar; sin tracking de progreso
   aún, contarla distorsionaría el %). Requiere tocar el cálculo de asistencia en
   `gradebook`/`grades` (filtrar `session_type='autonoma'` del denominador).
4. **¿Alcance = MVP (Fase 1) o incluye el checklist (Fase 2)?**
5. **Ventana/anticipación de la notificación**: ¿exactamente a la hora de inicio, o X
   minutos antes? El pedido dice "en la fecha y hora de inicio" → **al inicio**.

---

## FASE 1 — MVP (entrega lo pedido)

### 1.1 Migración: columna `session_type` + guard de notificación

Nueva migración `supabase/migrations/<ts>_attendance_session_type.sql` (defensiva, patrón
de `20260914_session_notes_url.sql`):

```sql
DO $$ BEGIN
  IF to_regclass('public.attendance_sessions') IS NULL THEN
    RAISE NOTICE 'attendance_sessions no existe — abortando'; RETURN;
  END IF;
  ALTER TABLE public.attendance_sessions
    ADD COLUMN IF NOT EXISTS session_type TEXT NOT NULL DEFAULT 'virtual'
      CHECK (session_type IN ('presencial','virtual','autonoma')),
    ADD COLUMN IF NOT EXISTS notified_start_at TIMESTAMPTZ NULL;  -- guard idempotente
  COMMENT ON COLUMN public.attendance_sessions.session_type IS
    'Modalidad: presencial|virtual|autonoma. Default virtual (backfill de históricos).';
  COMMENT ON COLUMN public.attendance_sessions.notified_start_at IS
    'Marca cuándo el cron notificó el inicio de una sesión autónoma (anti-reenvío).';
END $$;
NOTIFY pgrst, 'reload schema';
```

- `DEFAULT 'virtual'` → **todos los registros existentes quedan `virtual`** automáticamente.
- `notified_start_at` es el guard: el cron solo notifica cuando es `NULL` y lo setea al disparar.
- Index parcial opcional para el cron: `CREATE INDEX ... ON attendance_sessions (session_date, start_time) WHERE session_type='autonoma' AND notified_start_at IS NULL AND deleted_at IS NULL;`
- **RLS**: no cambia. El docente ya escribe columnas de la sesión con `.update()` directo
  (como `cut_id`/`content_id`) bajo la policy `attendance_sessions_staff_manage`. No hace
  falta RPC nuevo (opcional: un `set_session_type` SECURITY DEFINER espejo de
  `set_session_code_shared`, con `course_teachers OR Admin OR is_super_admin()` — no
  requerido).
- `types.ts` es autogenerado y no tendrá la columna hasta Publish → seguir el patrón
  `(supabase as any)` ya usado para `notes_url`/`code_shared`.

### 1.2 Notificación por hora de inicio (kind emailable + función + cron)

**(a) Kind emailable `session_start`** — sincronizar los **3 lugares** (invariante cross-file):
- SQL `_notification_kind_emails` (agregar `session_start` a la lista incondicional; guard
  defensivo del `platform_settings`).
- `supabase/functions/send-email/index.ts` → `CRITICAL_KINDS`.
- `src/modules/notifications/notification-email.ts` → `CRITICAL_KINDS` (+ actualizar sus tests).
- Sembrar `email_settings.enabled_kinds.session_start = true` (toggle ON por defecto en
  `AdminEmailSettingsPanel`).

**(b) Función `notify_autonomous_sessions_starting()`** (SECURITY DEFINER, molde de
`notify_students_exam_starting_soon`):

```sql
CREATE OR REPLACE FUNCTION public.notify_autonomous_sessions_starting()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INT := 0; r RECORD;
BEGIN
  FOR r IN
    SELECT s.id, s.course_id, s.title, c.name AS course_name
    FROM attendance_sessions s
    JOIN courses c ON c.id = s.course_id
    WHERE s.session_type = 'autonoma'
      AND s.notified_start_at IS NULL
      AND s.deleted_at IS NULL
      AND c.deleted_at IS NULL
      -- "due": el inicio (fecha+hora, hora de Bogotá) ya llegó, dentro de una ventana
      AND (s.session_date + COALESCE(s.start_time, '09:00'::time)) AT TIME ZONE 'America/Bogota'
            <= now()
      AND (s.session_date + COALESCE(s.start_time, '09:00'::time)) AT TIME ZONE 'America/Bogota'
            > now() - INTERVAL '2 hours'   -- evita disparar sesiones viejas en el 1er deploy
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM notify_course_students(
      r.course_id,
      'Sesión autónoma disponible',
      format('La sesión «%s» de %s ya está disponible. Revisa el material.',
             COALESCE(r.title, 'de hoy'), r.course_name),
      'session_start',
      '/app/student/courses'   -- o /app/student/attendance
    );
    UPDATE attendance_sessions SET notified_start_at = now() WHERE id = r.id;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION public.notify_autonomous_sessions_starting() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_autonomous_sessions_starting() TO service_role;
```

- **Zona horaria**: `start_time` es `TIME` sin zona interpretado como **Bogotá** →
  construir el timestamptz con `AT TIME ZONE 'America/Bogota'`. `start_time` NULL → 09:00.
- **Idempotencia**: `notified_start_at IS NULL` + `FOR UPDATE SKIP LOCKED` + `UPDATE` en el
  mismo loop → dos ticks del cron nunca re-disparan.
- **Papelera** (regla universal): filtra `s.deleted_at IS NULL` **y** `c.deleted_at IS NULL`.
- `notify_course_students` inserta a los matriculados (`course_enrollments`); `tenant_id`
  y `source_role='Sistema'` los rellenan los triggers BEFORE INSERT; el correo sale solo
  por el trigger `notify_send_email` (kind emailable) y el alumno lo ve en vivo por el
  realtime/poll de `use-notifications.ts`; con el tab cerrado, push del Service Worker.

**(c) Cron cada minuto** (patrón `cron.schedule` *bare*, NO `extensions.cron`, dentro de
`DO` guardado por `pg_namespace`; registrar en `cron_job_descriptions`):

```sql
DO $cron$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='cron') THEN
    RAISE NOTICE 'cron no disponible'; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='notify-autonomous-sessions') THEN
    PERFORM cron.schedule('notify-autonomous-sessions', '* * * * *',
      $job$ SELECT public.notify_autonomous_sessions_starting(); $job$);
  END IF;
END $cron$;
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES ('notify-autonomous-sessions', 'Notifica a los alumnos cuando arranca una sesión autónoma (cada minuto).')
ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description;
```

- Documentar el job en `docs/CRON-JOBS.md`. Aparecerá en `SupabaseCronPanel` (pausar/reagendar).

### 1.3 UI del docente (elegir el tipo)

- **Modelo compartido** `src/modules/sessions/create-session.ts`: agregar `session_type`
  a `NewSessionFields` + `buildNewSessionPayload` (default `'virtual'`). Esto lo consumen
  tanto la matriz de asistencia como el Tablero.
- **Dialog "Nueva sesión"** (`app.teacher.attendance.tsx`, `newSessionOpen` ~1697): agregar
  un `<Select>` "Tipo de sesión" (Presencial/Virtual/Autónoma) junto a Título/Corte.
- **Popover Settings2** por columna (~1399, donde ya viven Corte y Contenido): `<Select>`
  para cambiar el tipo de una sesión existente → `.update({ session_type })` (patrón
  `updateSessionCut`, `(supabase as any)`).
- **Badge en el header de columna** (~1544): badge plano con ícono por tipo.
- **Tablero** (`app.teacher.board.$courseId.tsx`): comparte `buildNewSessionPayload` → el
  selector aparece también ahí si el form de creación es común.
- **CSV** (`src/modules/sessions/csv.ts`): agregar columna `session_type` a
  `SESSIONS_TEMPLATE`/`parseSessionsCsv`/`buildSessionsRows` (default `virtual`; validar
  el enum). Actualizar sus tests puros.

### 1.4 UI del estudiante + calendarios (mostrar el tipo)

Badge/ícono por tipo (**badge plano + ícono**, NO `StatusBadge` — precedente:
`WeeklyScheduleView` usa `<span>`+ícono para modalidad). Íconos sugeridos: Presencial =
`MapPin`, Virtual = `Video`, Autónoma = `BookOpen`/`UserCheck`.

Agregar `session_type` al `select` y un badge en las **4 superficies derivadas** (todas ya
filtran `deleted_at` — el tipo viaja en el mismo select):
1. `app.student.attendance.tsx` (tabla "Detalle por sesión").
2. `app.student.courses.tsx` (tablero por sesión) — **entrada principal** al material de la
   sesión autónoma (la notif linkea aquí).
3. `app.student.calendar.tsx` + `StudentEventsCalendar.tsx` (dashboard/calendario) — 2º badge/ícono.
4. `app.index.tsx` agenda (docente "Próximas clases" + alumno) — `EventRow` ya soporta `badge`/`badgeColor`.
5. Edge `student-calendar-ics` — agregar `session_type` al select + reflejar en `summary`/`CATEGORIES`.
   **Invariante**: `src/lib/ics-builder.ts` ↔ `supabase/functions/student-calendar-ics/ics-builder.ts` (copia manual — sincronizar).

### 1.5 i18n (es ↔ en, paridad obligatoria)

- Claves nuevas en **ambos** locales: `teacherAttendance.sessionTypeLabel`,
  `.sessionTypePresencial` = "Presencial", `.sessionTypeVirtual` = "Virtual",
  `.sessionTypeAutonoma` = "Autónoma" (en: Autonomous). Reusar el precedente de
  `hc_modulesSchedulesCourseScheduleEditor.modalityPresencial/Virtual`.
- Textos de la notificación (`session_start`) en ambos locales si se centralizan.
- `locale-parity.test.ts` valida la paridad — agregar a los dos lados o rompe.

### 1.6 Cierre (obligatorio)

- Agente **`consistencia`** (iconos/i18n/persistencia/coherencia).
- `bun tsc --noEmit` (EXIT 0) + `bun test` (locale-parity + guardrails; tests de `csv.ts`).
- Publish en Lovable (la migración + el cron aplican en el deploy; `types.ts` se regenera).

---

## FASE 2 — Checklist unificado y parametrizable (opcional, mayor alcance)

Resuelve los *gaps* de fragmentación para que la sesión autónoma sea un verdadero
"checklist" que el alumno recorra:

1. **Tabla `session_items`** unificada: `(id, session_id, kind, ref_id, position, required
   boolean, label, config jsonb)` con `kind ∈ (content|poll|kahoot|workshop|exam|project|
   whiteboard|snippet|link)`. Da **orden**, **obligatorio/opcional**, **etiqueta** y
   **config por ítem** — hoy inexistentes. Se llena reusando las FKs actuales (o
   migrándolas).
2. **Tracking de progreso** por alumno: `session_item_progress(session_id, item_id,
   user_id, completed_at)` → el alumno marca/ve "material revisado" y el docente ve el %.
   Hoy solo existe asistencia presente/ausente.
3. **Lanzar desde la sesión** lo que hoy no se puede: **Reto en vivo (kahoot)** (hoy
   `LaunchPollDialog` solo hace single/multiple/slot) y **crear/adjuntar taller** desde la
   sesión (hoy solo desde el form del taller).
4. **Regresión a corregir**: reconectar la **superficie del docente para snippets** de
   sesión (`SessionCodeSnippetsDialog` en modo escritura + toggle `code_shared`) — hoy solo
   está cableado read-only para el alumno; la RPC `set_session_code_shared` ya existe.
5. **Vista unificada del alumno**: una pantalla "Sesión autónoma" (o sección en
   `app.student.courses`) que liste el checklist ordenado con estado por ítem, a donde
   apunta la notificación.
6. **Duplicar sesión consistente**: hoy `duplicateSession` copia contenido/pizarra/snippets
   pero NO encuestas ni el vínculo de talleres/exámenes/proyectos. Con `session_items` el
   bundle se duplica de raíz.

---

## Archivos que se tocan (resumen)

**Fase 1 — SQL/edge:**
- `supabase/migrations/<ts>_attendance_session_type.sql` (columna + guard + índice)
- `supabase/migrations/<ts>_notify_autonomous_sessions.sql` (kind + función + cron + `cron_job_descriptions`)
- `supabase/functions/send-email/index.ts` (`CRITICAL_KINDS`)
- `supabase/functions/student-calendar-ics/index.ts` + `ics-builder.ts` (si se refleja el tipo en el ICS)
- `docs/CRON-JOBS.md`

**Fase 1 — front:**
- `src/modules/sessions/create-session.ts` (payload + campo)
- `src/modules/sessions/csv.ts` (+ tests) 
- `src/routes/app.teacher.attendance.tsx` (Select en form + Popover + badge en header)
- `src/routes/app.teacher.board.$courseId.tsx` (si comparte el form)
- `src/routes/app.student.attendance.tsx`, `src/routes/app.student.courses.tsx` (badge)
- `src/routes/app.student.calendar.tsx`, `src/modules/dashboard/StudentEventsCalendar.tsx`, `src/routes/app.index.tsx` (badge en agenda/calendario)
- `src/modules/notifications/notification-email.ts` (`CRITICAL_KINDS` + tests)
- `src/i18n/locales/{es,en}.json` (claves de tipo + notif)
- (opcional) `src/components/ui/status-badge.tsx` solo si se decide mapear el tipo ahí (no recomendado)

## Riesgos / notas

- **Zona horaria**: el bug más probable. `start_time` es Bogotá; usar `AT TIME ZONE
  'America/Bogota'` en el cron. Probar con una sesión autónoma real cuya hora de inicio
  caiga en el minuto siguiente.
- **No re-disparo**: la columna `notified_start_at` + `SKIP LOCKED` lo garantizan; la
  ventana de 2h solo evita el spam retroactivo del primer deploy (precedente
  `scheduled_messages_no_retroactive`).
- **Peso de asistencia**: decidir (decisión #3) antes de tocar `gradebook`/`grades`.
- **Consistencia de duplicado y snippets del docente** son deuda pre-existente que la
  Fase 2 salda; la Fase 1 no la empeora.
