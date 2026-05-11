# Auditoría — Integración Google Calendar (examlab)

**Procedimiento**: Protocolo VVT-SEC-LOV-001 (Fases 5 + 7 + checklist de integraciones OAuth)
**Fecha**: 2026-05-10
**Alcance**: Integración recién implementada en Lovable para conectar cuenta Google de docente, listar calendarios, sincronizar sesiones del curso creando eventos con Meet + invitaciones por correo institucional.

**Archivos auditados**:
- `src/lib/google-calendar.server.ts` — OAuth helpers + refresh + REST.
- `src/lib/google-calendar.functions.ts` — Server functions (5).
- `src/routes/api/public/google-oauth-callback.ts` — Callback público.

> ⚠️ La migración de `teacher_google_tokens` y la columna `meeting_url` de `attendance_sessions` **no están sincronizadas al filesystem local** todavía. La auditoría de RLS de `teacher_google_tokens` queda pendiente hasta que llegue la migración por `git pull` o se valide con `db_policies_mid` (PAT requerido).

---

## Resumen ejecutivo

🔴 **2 CRÍTICOS · 🟠 2 ALTOS · 🟡 3 MEDIOS · ⚪ 2 BAJOS**

La integración tiene la estructura correcta (OAuth offline, refresh con expiry, separación de capas, schema Zod en inputs), pero arrastra **dos vulnerabilidades estructurales** que la hacen inadecuada para producción:

1. **C7** — El parámetro `state` del OAuth NO se valida contra un nonce server-side persistido → **account takeover de calendario** (atacante hace que los tokens de SU cuenta Google queden asociados al `teacher_id` de la víctima).
2. **C8** — Tokens (`refresh_token` perpetuo + `access_token`) guardados en **plaintext** en la DB → dump de la tabla = acceso indefinido al calendario de cada docente.

Decisión: **No habilitar la integración en producción hasta resolver C7 y C8.**

---

## CRÍTICO

### C7 — CSRF en callback OAuth → account takeover del calendario del docente

- **Archivos**:
  - `src/lib/google-calendar.functions.ts:18-27` (genera state).
  - `src/routes/api/public/google-oauth-callback.ts:31-62` (parsea + confía).

**Patrón actual**:

```ts
// functions.ts — getGoogleAuthUrl
const nonce = crypto.randomUUID();
const state = `${userId}:${nonce}:${originB64}`;
return { url: buildAuthUrl(state, data.origin) };
```

```ts
// google-oauth-callback.ts — handler GET
const parts = state.split(":");
const teacherId = parts[0];                   // ← teacher_id viene DEL ATACANTE
// ...
await supabaseAdmin.from("teacher_google_tokens").upsert({
  teacher_id: teacherId,                       // ← se guarda con ese teacher_id
  refresh_token: tok.refresh_token,            // ← refresh_token DEL ATACANTE
  ...
});
```

El `nonce` no se persiste server-side antes de iniciar el flow, y el callback no lo cruza contra una tabla `oauth_states` con expiry. Cualquiera puede craftear su propio `state`.

**Escenario de explotación**:
1. Atacante conoce el `teacher_id` UUID de la víctima (extraíble de `profiles` si está autenticado — recordar A1 del reporte 01: profiles visible a todo authenticated).
2. Atacante construye URL: `https://accounts.google.com/o/oauth2/v2/auth?...&state=<victim_uuid>:fake_nonce:<base64_origin>`.
3. Atacante autoriza con SU cuenta de Google.
4. Google redirige a `/api/public/google-oauth-callback?code=...&state=<victim_uuid>:...`.
5. El callback intercambia `code` por tokens (del atacante), parsea `teacher_id = <victim_uuid>` del state, y hace `upsert` en `teacher_google_tokens` con esa fila.
6. La víctima docente queda silenciosamente conectada a la cuenta Google del atacante. Cuando sincroniza sesiones del curso, los eventos se crean en el calendario del atacante, los Meet se generan en su cuenta, y los estudiantes reciben invitaciones de la cuenta del atacante.

**Severidad**: 🔴 CRÍTICA — account takeover persistente + suplantación de identidad académica + posible exfiltración de identidad de estudiantes (los emails institucionales se mandan al servidor Google del atacante como `attendees`).

**Remediación**:

```sql
-- 1. Tabla para nonces server-side
CREATE TABLE public.google_oauth_states (
  state         text PRIMARY KEY,
  teacher_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  origin        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
ALTER TABLE public.google_oauth_states ENABLE ROW LEVEL SECURITY;
-- Sin policies → solo service_role accede. El cliente nunca lo ve.

CREATE INDEX idx_google_oauth_states_expires ON public.google_oauth_states(expires_at);
```

```ts
// functions.ts — getGoogleAuthUrl (REMEDIADO)
const state = crypto.randomUUID();
await supabaseAdmin.from("google_oauth_states").insert({
  state,
  teacher_id: userId,
  origin: data.origin,
});
return { url: buildAuthUrl(state, data.origin) };
```

```ts
// google-oauth-callback.ts — handler (REMEDIADO)
const { data: stateRow, error: stErr } = await supabaseAdmin
  .from("google_oauth_states")
  .select("teacher_id, origin, expires_at")
  .eq("state", state)
  .maybeSingle();
if (stErr || !stateRow) return fail("invalid_state");
if (new Date(stateRow.expires_at) < new Date()) return fail("expired_state");

// One-time: borrar antes de usar para prevenir replay
await supabaseAdmin.from("google_oauth_states").delete().eq("state", state);

const teacherId = stateRow.teacher_id;       // ← teacher_id confiable
const origin = stateRow.origin;              // ← origin confiable
// ...resto igual
```

---

### C8 — Tokens OAuth en plaintext en la DB

- **Archivo**: `src/lib/google-calendar.server.ts:99-103, 110-117`, callback `:53-61`.

`refresh_token` y `access_token` se almacenan como columnas TEXT sin encriptación at rest. El `refresh_token` de Google **no expira hasta que el usuario lo revoque**.

**Impacto**:
- Un dump accidental de la DB (backup mal protegido, query log con `SELECT * FROM teacher_google_tokens`, employee con acceso DB) entrega al atacante acceso permanente al calendario de cada docente conectado.
- Combinado con C7, un solo atacante puede comprometer múltiples cuentas.

**Remediación** (Patrón Storage del Protocolo + pgsodium):

```sql
-- Habilitar pgsodium si no está
CREATE EXTENSION IF NOT EXISTS pgsodium;

-- Columnas encriptadas
ALTER TABLE public.teacher_google_tokens
  ADD COLUMN refresh_token_enc bytea,
  ADD COLUMN access_token_enc  bytea,
  ADD COLUMN key_id uuid NOT NULL DEFAULT (pgsodium.create_key()).id;

-- Migrar datos existentes (si los hay)
UPDATE public.teacher_google_tokens
SET refresh_token_enc = pgsodium.crypto_aead_det_encrypt(
      convert_to(refresh_token, 'utf8'), 'google_token'::bytea, key_id),
    access_token_enc = pgsodium.crypto_aead_det_encrypt(
      convert_to(access_token, 'utf8'), 'google_token'::bytea, key_id);

-- Borrar columnas en plaintext
ALTER TABLE public.teacher_google_tokens
  DROP COLUMN refresh_token,
  DROP COLUMN access_token;
```

Y wrapper helpers en `google-calendar.server.ts` que encripten/desencripten al cruzar la frontera DB. Solo `service_role` (vía `supabaseAdmin`) puede invocarlos.

---

## ALTO

### A8 — Callback redirige a `origin` confiado del state sin allowlist

- **Archivo**: `src/routes/api/public/google-oauth-callback.ts:36-40`, `:64`.

```ts
let origin = url.origin;
try {
  origin = Buffer.from(originB64, "base64url").toString("utf-8");
} catch { /* fallback */ }
// ...
return Response.redirect(`${origin}/app/teacher/google-calendar?ok=1`, 302);
```

Después de remediado C7 (`origin` proviene de `google_oauth_states.origin`, no del state externo), seguimos sin validar que el `origin` sea de un dominio conocido. Si un docente legítimo inició el flow desde `https://atacante.com` (porque clickeó un link malicioso que tirado de la lógica de Lovable Cloud preview URLs), el callback redirige ahí con `ok=1`. Vector de phishing post-OAuth.

**Remediación**: allowlist explícito.

```ts
const ALLOWED_ORIGINS = new Set([
  "https://examlab.lovable.app",
  // agregar preview URLs específicos si aplica
]);
const safeOrigin = ALLOWED_ORIGINS.has(stateRow.origin)
  ? stateRow.origin
  : "https://examlab.lovable.app";
return Response.redirect(`${safeOrigin}/app/teacher/google-calendar?ok=1`, 302);
```

### A9 — `disconnectGoogle` no revoca el token en Google

- **Archivo**: `src/lib/google-calendar.functions.ts:84-92`.

```ts
export const disconnectGoogle = createServerFn({ method: "POST" })
  .handler(async ({ context }) => {
    await supabaseAdmin
      .from("teacher_google_tokens")
      .delete()
      .eq("teacher_id", context.userId);
    return { ok: true };
  });
```

Solo borra la fila local. El `refresh_token` sigue siendo válido en Google hasta que el usuario lo revoque manualmente desde su cuenta. Si la fila se borró antes de un dump filtrado o si la app fue comprometida, el token escapado sigue accesible.

**Remediación**:

```ts
export const disconnectGoogle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // 1. Leer el refresh_token
    const { data } = await supabaseAdmin
      .from("teacher_google_tokens")
      .select("refresh_token")
      .eq("teacher_id", context.userId)
      .maybeSingle();

    // 2. Revocar en Google ANTES de borrar localmente
    if (data?.refresh_token) {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(data.refresh_token)}`,
        { method: "POST" },
      ).catch(() => {/* best-effort, no bloquea el delete */});
    }

    // 3. Borrar localmente
    await supabaseAdmin
      .from("teacher_google_tokens")
      .delete()
      .eq("teacher_id", context.userId);
    return { ok: true };
  });
```

---

## MEDIO

### M8 — Mensajes de error filtran detalles internos al cliente

- **Archivos**: `google-oauth-callback.ts:62, 66` y `google-calendar.server.ts:70, 93, 104, 137`.

Ejemplos:
```ts
if (upErr) return fail(`db:${upErr.message}`, origin);          // ← mensaje Supabase al cliente
return fail((e as Error).message, origin);                      // ← stack/mensaje crudo
throw new Error(`Google token exchange falló [${res.status}]: ${text}`);  // ← respuesta de Google
```

**Impacto**: un atacante obtiene info útil del backend (estructura de schema, versiones, errores específicos de Google API).

**Remediación**: wrapper logger server-side + códigos de error genéricos al cliente.

```ts
catch (e) {
  console.error("oauth.callback.error", e);    // detallado en CloudWatch / Supabase logs
  return fail("internal_error", origin);       // genérico al cliente
}
```

### M9 — `decodeIdTokenEmail` no verifica la firma (aceptable hoy, riesgo si se reutiliza)

- **Archivo**: `src/lib/google-calendar.server.ts:142-155`.

El comentario es explícito: *"no verifica firma — solo extrae el email"*. Hoy se usa solo para mostrar al docente con qué cuenta está conectado (`teacher_google_tokens.google_email`). **No es vulnerabilidad mientras nadie use ese email para autorización**.

**Riesgo**: si en el futuro alguien usa `google_email` para validar identidad (ej. "si el email del id_token coincide con el institucional, autorizar X"), un atacante puede craftear un id_token con cualquier email. Documentar y blindar.

**Remediación**: renombrar a `decodeIdTokenEmail_UNVERIFIED` o agregar runtime check en el caller para que no se use en path de autorización.

### M10 — Invitaciones a estudiantes sin opt-in explícito

- **Archivo**: `src/lib/google-calendar.functions.ts:153-164` (extrae emails de matriculados).

`syncCourseSessions` invita por correo **institucional** a TODOS los estudiantes matriculados, sin verificar consentimiento individual. El estudiante recibe automáticamente:
- Invitación de Google Calendar a su correo institucional.
- Visibilidad del Meet a otros invitados (mitigado parcialmente con `guestsCanSeeOtherGuests: false`).

**Riesgo legal**: en jurisdicciones con regulaciones de privacidad (Habeas Data en Colombia / Ley 1581), procesar correos institucionales para invitarlos a herramientas de terceros (Google) **sin consentimiento** puede ser violación. Conviene revisar con legal.

**Remediación**:

```sql
ALTER TABLE public.course_enrollments
  ADD COLUMN calendar_opt_in boolean NOT NULL DEFAULT false;
```

Y filtrar en `syncCourseSessions`:

```ts
attendees = (profs ?? [])
  .filter((p) => enrolls.find(e => e.user_id === p.id)?.calendar_opt_in)
  .map((p) => p.institutional_email)
  // ...
```

Frontend: agregar toggle en el perfil del estudiante o al matricularse.

---

## BAJO

### B4 — `prompt: "consent"` siempre, genera refresh_tokens huérfanos en Google

- **Archivo**: `src/lib/google-calendar.server.ts:30-34`.

Cada vez que un docente "Reconecta", Google emite un nuevo `refresh_token`. El anterior queda activo hasta que se revoque. Combinado con A9 (no revoca al desconectar), genera múltiples tokens válidos en Google contra una sola cuenta.

**Remediación**: revocar al disconnect (ver A9) + considerar `prompt: "select_account"` cuando el caso de uso solo requiere cambiar de cuenta.

### B5 — Parsing del `state` no robusto

- **Archivo**: `src/routes/api/public/google-oauth-callback.ts:31-34`.

```ts
const parts = state.split(":");
if (parts.length < 3) return fail("bad_state");
const teacherId = parts[0];
const originB64 = parts.slice(2).join(":");
```

Sin schema. Si en el futuro el formato cambia (ej. agregar timestamp, role), código viejo lo acepta silenciosamente.

**Remediación**: con C7 remediado, el `state` pasa a ser un UUID opaco que solo se valida contra tabla. Este bajo se cierra automáticamente.

---

## Pendientes de auditoría (requieren acceso a producción)

1. **RLS de `teacher_google_tokens`** — confirmar policies reales con `db_policies_mid` (PAT). Esperado:
   - SELECT: `auth.uid() = teacher_id OR has_role('Admin')`.
   - INSERT/UPDATE/DELETE: bloqueado al cliente (solo `service_role` desde server fns / callback).
2. **Existencia y validez de la columna `meeting_url`** en `attendance_sessions` (migración pendiente).
3. **Configuración OAuth en Google Cloud Console**:
   - Authorized redirect URIs: ¿solo `https://examlab.lovable.app/api/public/google-oauth-callback` + preview específicos? ¿O hay wildcard?
   - Scopes solicitados vs necesarios.
4. **Rate limit en `syncCourseSessions`** — si un docente sincroniza un curso con 50 sesiones, hace 50 requests serializados a Google API. Considerar Promise.all con concurrencia limitada y backoff.

---

## Checklist de auditoría de integraciones OAuth aplicado

Para reutilizar en futuras integraciones (Stripe, OpenAI, Resend, otros OAuth):

| # | Check | Estado en Google Calendar |
|---|-------|---------------------------|
| 1 | El `state` OAuth se persiste server-side y se valida one-time en callback (CSRF) | ❌ Fallo — C7 |
| 2 | Tokens (refresh especialmente) encriptados at rest | ❌ Fallo — C8 |
| 3 | Callback público valida origin contra allowlist | ❌ Fallo — A8 |
| 4 | Disconnect revoca tokens en el proveedor, no solo localmente | ❌ Fallo — A9 |
| 5 | Mensajes de error sanitizados antes de devolver al cliente | ❌ Fallo — M8 |
| 6 | Verificaciones de firma donde corresponde (id_token, webhooks) | ⚠️ Documentado pero sin guard rail — M9 |
| 7 | Opt-in del usuario afectado cuando se le agrega como attendee/receiver | ❌ Fallo — M10 |
| 8 | RLS de tabla de tokens solo "dueño" + "admin" (no anon ni authenticated genérico) | ⏳ Pendiente confirmar |
| 9 | Inputs validados con schema (Zod) | ✅ Pasa — schema en todas las server fns |
| 10 | Auth middleware en server fns sensibles | ✅ Pasa — `requireSupabaseAuth` |
| 11 | Verificación de ownership/rol antes de mutaciones (ej. docente del curso) | ✅ Pasa — `syncCourseSessions:122-128` |
| 12 | Logs no incluyen tokens / códigos OAuth | ⚠️ No verificado — sin wrapper logger |

Este checklist será la base para diseñar la tool MCP `integration_audit_low/mid` en una próxima iteración.

---

## Plan de remediación priorizado

### Sprint 1 — Antes de habilitar la integración en producción

| Item | Severidad | Esfuerzo |
|------|-----------|----------|
| C7 — tabla `google_oauth_states` + state validation one-time | 🔴 CRÍTICO | 3 h |
| C8 — pgsodium encryption de refresh_token + access_token | 🔴 CRÍTICO | 4 h |
| A8 — allowlist de origins | 🟠 ALTO | 30 min |
| A9 — revoke en disconnect | 🟠 ALTO | 1 h |

### Sprint 2 — Antes de hacer la primera demo a usuarios externos

- M8 — wrapper logger con códigos genéricos al cliente (~1 h).
- M9 — guard rail / rename `decodeIdTokenEmail_UNVERIFIED` (~30 min).
- M10 — opt-in de estudiantes para calendar invites + flow legal (~3 h + revisión legal).
- Confirmar policies RLS reales con PAT (~30 min).

### Sprint 3 — Hardening continuo

- B4 — revisar prompt `consent` vs `select_account` (~15 min).
- Rate limit en `syncCourseSessions` (~2 h).
- Monitoring: alertas si `google_oauth_states` no se limpia (registros vencidos > 24 h indica algún flow roto).
