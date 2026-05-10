
# Plan

## 1. Limpieza + deploy

- Migración `DROP TABLE public.course_grading_weights` (huérfana confirmada por code_deadscan).
- Desplegar todas las edge functions actuales (`ai-generate-questions`, `ai-grade-submission`, `bulk-import-users`, `detect-plagiarism`, `evaluate-exam-time`, `execute-code`, `generate-contents`, `send-push`, `admin-update-password`, `calendar-ics`).
- Compilación: TanStack la corre el harness automáticamente al editar — reviso el output.

## 2. Google Calendar — OAuth per-docente

### Por qué no podemos usar el conector estándar

El conector `google_calendar` de Lovable se conecta a UNA cuenta del workspace. Como cada docente debe crear eventos en SU PROPIO calendario, necesitamos OAuth per-usuario con credenciales propias.

### Lo que necesito de vos (una sola vez)

En [Google Cloud Console](https://console.cloud.google.com/):
1. Crear un proyecto (o usar uno existente).
2. Activar **Google Calendar API**.
3. **OAuth consent screen** → External (o Internal si tenés Workspace) → agregar scopes `calendar.events` y `calendar.readonly`.
4. **Credentials → Create OAuth Client ID** → tipo Web application.
5. Authorized redirect URI: `https://examlab.lovable.app/api/public/google-oauth-callback` (y la de preview también si querés probar antes de publicar).
6. Pegarme el `client_id` y `client_secret` en el formulario que voy a abrir.

### Backend

- Migración nueva: tabla `teacher_google_tokens (teacher_id PK, refresh_token, access_token, expires_at, calendar_id, calendar_name)`. RLS: solo el dueño + Admin. Agregar columna `google_event_id` y `meeting_url` a `attendance_sessions` (ya existe `meeting_url` en algunas, verifico).
- Server functions (`src/lib/google-calendar.functions.ts`):
  - `getGoogleAuthUrl()` — genera URL OAuth con state firmado.
  - `listMyCalendars()` — refresca token si hace falta, lista calendarios del docente.
  - `setSelectedCalendar(calendarId, calendarName)` — guarda preferencia.
  - `syncCourseSessions(courseId)` — para cada `attendance_session` del curso: si no tiene `google_event_id` crea evento (con `conferenceData` para generar Meet, attendees = correos institucionales de matriculados); si lo tiene, hace `events.patch`. Persiste `google_event_id` y `meeting_url` (= Meet link).
- Server route pública `/api/public/google-oauth-callback` (TanStack server route): recibe `code` + `state`, valida state, intercambia por tokens, guarda en `teacher_google_tokens`, redirige a `/app/teacher/google-calendar?ok=1`.

### Frontend

- Nueva página `src/routes/app.teacher.google-calendar.tsx` accesible desde el sidebar docente (entrada "Google Calendar").
- Estado vacío: botón "Conectar Google Calendar" → `getGoogleAuthUrl()` → `window.location.href = url`.
- Conectado: dropdown de calendarios + botón "Guardar calendario" + selector de curso + botón "Sincronizar sesiones" (muestra progreso y conteo: creadas/actualizadas/omitidas).
- Después de sync, las sesiones del curso quedan con `meeting_url` y aparecen en el feed ICS y donde sea que se rendereen.

### Notas técnicas

- Refresh token: Google solo lo emite la 1ª vez con `access_type=offline&prompt=consent`. Si el docente revoca y reconecta, mismo flujo.
- Meet link: `events.insert` con `conferenceData.createRequest` y `conferenceDataVersion=1`. El link queda en `event.hangoutLink`.
- Attendees: `course_enrollments` → `profiles.institutional_email`. Se incluye también al docente como organizador.
- `sendUpdates=all` para que Google mande los invites por mail.

## Archivos que tocaré

- `supabase/migrations/20260510120000_drop_grading_weights.sql` (nueva)
- `supabase/migrations/20260510120100_google_calendar_tokens.sql` (nueva)
- `src/lib/google-calendar.functions.ts` (nueva)
- `src/lib/google-calendar.server.ts` (nueva, helpers OAuth)
- `src/routes/api/public/google-oauth-callback.ts` (nueva)
- `src/routes/app.teacher.google-calendar.tsx` (nueva)
- `src/components/AppLayout.tsx` (entrada en sidebar docente)

## Lo que NO hace V1

- No re-sincroniza si una sesión cambia DESPUÉS del sync (eso queda para V2; hoy podés re-darle "Sincronizar" y hace `events.patch`).
- No detecta sesiones eliminadas en la plataforma (no borra el evento de Google).
- No maneja zonas horarias avanzadas: usa `America/Bogota` por defecto.

## Riesgo / dependencia bloqueante

Sin `GOOGLE_OAUTH_CLIENT_ID` y `GOOGLE_OAUTH_CLIENT_SECRET` cargados como secrets, no puedo terminar la feature. Apenas aprobés el plan los pido con el formulario seguro.
