# Manual — Configurar el envío de correo de ExamLab con Google (SMTP + App Password)

**Qué es esto:** habilitar el envío de correos de ExamLab por **SMTP de Google** (`smtp.gmail.com`) autenticando con la cuenta de Workspace institucional `castano.julian@correounivalle.edu.co` y una **App Password** de 16 caracteres.

**Qué NO es esto:** no es OAuth ni un proyecto de Google Cloud Console. El correo no usa la API de Gmail, ni pantalla de consentimiento, ni scopes, ni redirect URI. El OAuth de Google que existe en este repo (`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`, [supabase/functions/_shared/calendar-google.ts:31-45](../supabase/functions/_shared/calendar-google.ts)) es **exclusivamente para vincular Google Calendar del docente**. Si estás creando un proyecto en Cloud Console para "habilitar el correo", estás en el flujo equivocado.

---

## 0. Cómo viaja un correo (para saber dónde se rompe)

```
INSERT en public.notifications
  → trigger notify_send_email  (SQL, lee private.app_settings)
    → net.http_post (pg_net, fire-and-forget)
      → edge function send-email  (lee los 7 secrets)
        → SMTP smtp.gmail.com:587  (STARTTLS + App Password)
          → buzón del destinatario
```

Referencias: trigger vigente en [supabase/migrations/20261530000000_stop_auditing_expected_email_skips.sql:26-104](../supabase/migrations/20261530000000_stop_auditing_expected_email_skips.sql); edge en [supabase/functions/send-email/index.ts](../supabase/functions/send-email/index.ts).

Hay **tres** lugares independientes que hay que configurar. Si falta cualquiera, no sale ni un correo:

| # | Qué | Dónde se configura | ¿Desde la app de ExamLab? |
|---|-----|--------------------|---------------------------|
| 1 | Los 7 secrets SMTP | Edge Function Secrets de Supabase | **Sí**, si `MANAGEMENT_PAT` ya existe (§3) |
| 2 | Las 2 filas de `private.app_settings` | SQL Editor del dashboard de Supabase | **No.** Solo por SQL (§4) |
| 3 | Los toggles por tipo de correo | `/app/superadmin/system` → Correos | **Sí** (§5) |

---

## 1. Tabla de secrets

Los lee el edge en [send-email/index.ts:505-511](../supabase/functions/send-email/index.ts). El comentario de cabecera los lista en [send-email/index.ts:14-21](../supabase/functions/send-email/index.ts).

| Secret | Valor concreto para `castano.julian@correounivalle.edu.co` | ¿Obligatorio? | Qué se rompe si falta |
|---|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` | **Sí** | No manda nada. `notifications.email_skipped_reason='no_settings'` + audit `email.failed` con `reason:'smtp_env_missing'` ([index.ts:566-579](../supabase/functions/send-email/index.ts)). HTTP 500. |
| `SMTP_PORT` | `587` | **Sí** | Igual que arriba. Si está pero no es numérico → `reason:'smtp_port_invalid'` ([index.ts:580-588](../supabase/functions/send-email/index.ts)). **El puerto también decide el cifrado** — ver §1.1. |
| `SMTP_USER` | `castano.julian@correounivalle.edu.co` | **Sí** | Igual. Esta es la cuenta que **autentica**, y por eso es la que define el remitente real. |
| `SMTP_PASSWORD` | La App Password de 16 caracteres generada en §2, **sin espacios** | **Sí** | Igual, si falta. Si está pero es inválida/revocada, el arranque pasa OK y falla en el envío como `provider_error: 535 5.7.8 Username and Password not accepted`. |
| `EMAIL_FROM` | `castano.julian@correounivalle.edu.co` (**idéntico a `SMTP_USER`**) | **Sí** | Igual, si falta. Si es distinto y no es un alias "Enviar como" verificado, el correo rebota 5.5.x / 5.7.x — y **nadie lo valida**, ver §7.4. |
| `EMAIL_FROM_NAME` | `ExamLab` | No (default `"ExamLab"`, [index.ts:510](../supabase/functions/send-email/index.ts)) | El correo sale igual, pero el branding dice "ExamLab" aunque la institución se llame distinto. Se usa en 4 lugares: display-name del From ([627](../supabase/functions/send-email/index.ts)), encabezado y pie del HTML, y **prefijo del asunto** `"<Nombre>: <título>"` ([653-660](../supabase/functions/send-email/index.ts)). |
| `APP_PUBLIC_URL` | `https://examlab.lovable.app` (sin `/` final) | No para enviar, **sí para que sirva** | **El correo SALE igual, pero roto**: sin esto el botón "Ver en ExamLab" queda como `href="/app/messages/..."` — una URL relativa dentro de un correo, que no lleva a ninguna parte. Sin skip, sin audit, sin aviso. Es el modo de falla más silencioso del sistema ([index.ts:511](../supabase/functions/send-email/index.ts) + `renderEmailHtml` 200-202). |

Extra, no del correo pero necesario para poder escribir secrets desde la app:

| Secret | Valor | ¿Obligatorio? | Qué se rompe si falta |
|---|---|---|---|
| `MANAGEMENT_PAT` | Un Personal Access Token de Supabase (empieza con `sbp_`) | Solo si querés gestionar secrets desde ExamLab | El panel "Secretos infra" devuelve 503 y no se puede crear/rotar ningún secret desde la app ([manage-edge-secrets/index.ts:137-144](../supabase/functions/manage-edge-secrets/index.ts)). **Este NO se puede crear desde la app** — está en `RESERVED_SECRETS` ([línea 53](../supabase/functions/manage-edge-secrets/index.ts)). |

### 1.1 El puerto define el cifrado — no hay otra opción de TLS

En [send-email/index.ts:619](../supabase/functions/send-email/index.ts):

```ts
tls: port === 465, // 465 = SMTPS implícito, 587 = STARTTLS (lo maneja denomailer)
```

- `SMTP_PORT=587` → conecta en claro y hace **STARTTLS** automático. **Este es el valor recomendado.**
- `SMTP_PORT=465` → TLS implícito desde el saludo. También válido con Gmail.
- **Cualquier otro valor** (25, 2525, 1025) → conecta sin cifrado y `denomailer` se niega a autenticar con `Connection is not secure!`. Ese texto exacto en `email_skipped_reason` significa "el puerto está mal", no "el servidor de Google falló".

---

## 2. Lado de Google (7 pasos)

Estos pasos se hacen con la cuenta `castano.julian@correounivalle.edu.co` logueada en el navegador. **El repo no documenta nada de esto** — es el hueco más grande del proyecto: los tres lugares que mencionan App Password ([send-email/index.ts:18](../supabase/functions/send-email/index.ts), `TenantEmailSettingsDialog.tsx:233`, `es.json:4611`) dicen "usá una App Password" sin decir cómo llegar a poder crearla.

1. Andá a **https://myaccount.google.com/security** con la cuenta `castano.julian@correounivalle.edu.co`.
2. Buscá **"Verificación en 2 pasos"** y confirmá que dice **"Activada"**. Si dice "Desactivada", activala ahora (te va a pedir un teléfono o una app de autenticación). **Sin verificación en 2 pasos activa, la opción "Contraseñas de aplicaciones" NO EXISTE en el menú** — no es que Google la haya quitado, es que no aparece hasta que tengas 2FA. Este es el error #1 de este procedimiento.
3. Andá a **https://myaccount.google.com/apppasswords**.
   - Si la página carga y te pide un nombre → seguí al paso 4.
   - Si la página dice que la opción no está disponible **aunque el paso 2 diga "Activada"** → el administrador del Workspace de Univalle tiene las App Passwords **bloqueadas por política de la organización**. Eso no se arregla del lado de ExamLab: hay que pedirlo al IT de la universidad, o irse al plan B de §8.2.
4. En **"Nombre de la app"** escribí `ExamLab SMTP` (el nombre es solo una etiqueta para que después sepas cuál revocar).
5. Click en **Crear**.
6. Google muestra **16 caracteres en 4 grupos de 4** (ej. `abcd efgh ijkl mnop`). Copialos **quitando los espacios** → `abcdefghijklmnop`. Ese string es el valor de `SMTP_PASSWORD`.
7. Cerrá la ventana. **Google no vuelve a mostrar ese valor nunca.** Si lo perdés, borrá esa App Password y generá otra.

> **Ojo:** la App Password se invalida sola si cambia la contraseña de la cuenta de Google. Si algún día el correo deja de salir de golpe y nadie tocó ExamLab, lo primero a revisar es si alguien cambió la contraseña de `castano.julian@correounivalle.edu.co`.

---

## 3. Lado de Supabase — cargar los secrets (2 caminos)

### 3.1 Camino A — desde el dashboard de Supabase (siempre funciona)

Es el único camino para el **primer** setup, porque el camino B necesita un secret que solo se puede crear acá.

1. Entrá a **https://supabase.com/dashboard** → proyecto `uxxpzfsfcnqiwwdxoelm`.
2. Menú lateral → **Settings** → **Edge Functions** → sección **Secrets** (también accesible como "Edge Function Secrets").
3. Click en **Add new secret** y creá uno por uno, con el nombre **exacto** en mayúsculas:

   | Name | Value |
   |---|---|
   | `SMTP_HOST` | `smtp.gmail.com` |
   | `SMTP_PORT` | `587` |
   | `SMTP_USER` | `castano.julian@correounivalle.edu.co` |
   | `SMTP_PASSWORD` | los 16 caracteres del §2.6, sin espacios |
   | `EMAIL_FROM` | `castano.julian@correounivalle.edu.co` |
   | `EMAIL_FROM_NAME` | `ExamLab` |
   | `APP_PUBLIC_URL` | `https://examlab.lovable.app` |

4. Verificá que los nombres no tengan espacios ni minúsculas. `Smtp_Host` no lo lee nadie: el edge hace `Deno.env.get("SMTP_HOST")` literal.
5. Los secrets aplican al **próximo arranque** de la edge function. No hace falta redeploy, pero puede tardar unos segundos en propagarse.

### 3.2 Camino B — desde ExamLab (para rotar la App Password sin entrar al dashboard)

Requiere que `MANAGEMENT_PAT` ya exista, y **solo lo puede usar un SuperAdmin** — la edge devuelve 403 a un Admin de institución ([manage-edge-secrets/index.ts:129-134](../supabase/functions/manage-edge-secrets/index.ts)).

**Setup único de `MANAGEMENT_PAT` (obligatoriamente en el dashboard):**

1. Andá a **https://supabase.com/dashboard/account/tokens** → **Generate new token** → nombre `ExamLab manage-edge-secrets` → copiá el valor (empieza con `sbp_`).
2. Dashboard → proyecto → **Settings → Edge Functions → Secrets** → **Add new secret** con Name `MANAGEMENT_PAT` y Value el `sbp_...`.

**Uso desde la app, a partir de ahí:**

3. Entrá a ExamLab con la cuenta SuperAdmin (`castano.julian@correounivalle.edu.co` / rol SuperAdmin).
4. Navegá a **`/app/superadmin/system`** → tab **"Secretos infra"** ([app.superadmin.system.tsx:65-68 y :86-88](../src/routes/app.superadmin.system.tsx), label en `es.json:5023`).
5. Para crear uno nuevo: botón de **crear** → campo **Nombre** (se fuerza a MAYÚSCULAS) + campo **Valor** (input tipo contraseña con botón de ojo) → **Guardar**. Invoca `manage-edge-secrets` con `action:"set"` ([AdminEdgeSecretsPanel.tsx:119-121](../src/modules/admin/AdminEdgeSecretsPanel.tsx)).
6. Para rotar la App Password: click en **editar** sobre la fila `SMTP_PASSWORD` → pegá el valor nuevo → **Guardar**. (El campo arranca vacío a propósito: el valor viejo no se puede leer.)

> **Los valores nunca se pueden volver a leer.** El panel muestra literalmente `(configurado)` + la cantidad de caracteres + la fecha de modificación ([manage-edge-secrets/index.ts:62-65](../supabase/functions/manage-edge-secrets/index.ts)), porque el Management API de Supabase ya no devuelve el valor real. Si dudás de la App Password, la única salida es re-escribirla.

---

## 4. Lado de la base de datos — las 2 filas obligatorias + `pg_net` (3 pasos)

**Esto es lo que más veces deja el correo apagado con todos los secrets perfectos.** No se puede hacer desde ExamLab: hay que ir al SQL Editor del dashboard de Supabase.

> ⚠️ **El comentario del propio edge está obsoleto.** [send-email/index.ts:23-25](../supabase/functions/send-email/index.ts) dice:
> ```
> ALTER DATABASE postgres SET app.settings.send_email_url = '<url>/functions/v1/send-email';
> ALTER DATABASE postgres SET app.settings.service_role_key = '<service_role_jwt>';
> ```
> **NO CORRAS ESO.** No sirve: en Supabase Cloud requiere superuser (que no tenemos) y en este proyecto **nadie lo lee**. Un grep de `app.settings.send_email_url` en todo el repo solo devuelve ese comentario. La configuración real son **dos filas en la tabla `private.app_settings`**, y el motivo está escrito en [20260523000000_notifications_email_delivery.sql:31-36](../supabase/migrations/20260523000000_notifications_email_delivery.sql).

Ninguna migración inserta esas filas: la migración solo hace `CREATE TABLE IF NOT EXISTS private.app_settings` ([línea 40-46](../supabase/migrations/20260523000000_notifications_email_delivery.sql)). Es setup manual, sí o sí.

1. Dashboard de Supabase → proyecto `uxxpzfsfcnqiwwdxoelm` → **SQL Editor** → **New query**.

2. **LEER PRIMERO.** Corré este bloque, que no escribe nada:

```sql
-- ¿están las 2 filas?
SELECT key, length(value) AS largo, updated_at FROM private.app_settings ORDER BY key;
-- ¿está la extensión que hace la llamada HTTP? (es lo mismo que evalúa el trigger)
SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') AS pg_net_ok;
```

   - Si aparecen **las dos filas** (`send_email_url` y `service_role_key`) y el correo hoy funciona:
     **no toques nada más de esta sección**, seguí al §5. En este proyecto el correo ya viene
     operando en producción, así que lo más probable es que ya estén.
   - Si `pg_net_ok` da **false**: no sale ni un correo, y el síntoma
     (`email_skipped_reason = 'pg_net_missing'`, sin ningún `email.dispatched` en Auditoría) no se
     parece a ninguno de los casos del §7. Activá **`pg_net`** en dashboard → **Database →
     Extensions** ANTES de seguir. El trigger lo chequea explícitamente
     ([20261530000000:66-78](../supabase/migrations/20261530000000_stop_auditing_expected_email_skips.sql)).

3. **Solo si falta alguna de las dos filas**, insertá la que falte. Reemplazá `<service_role_jwt>`
   por la Service Role Key del proyecto (dashboard → **Settings → API → Project API keys →
   `service_role`**):

```sql
INSERT INTO private.app_settings (key, value) VALUES
  ('send_email_url',   'https://uxxpzfsfcnqiwwdxoelm.supabase.co/functions/v1/send-email'),
  ('service_role_key', '<service_role_jwt>')
ON CONFLICT (key) DO NOTHING;
```

> ⚠️ **Por qué `DO NOTHING` y no `DO UPDATE`, y por qué leer antes de escribir.** Un `DO UPDATE`
> sobreescribe `service_role_key`. Si te equivocás al copiarla —o pegás una clave del formato nuevo
> `sb_secret_*`, que el gateway rebota con 401— convertís una verificación en el apagón total del
> §7.5 **para las 4 instituciones a la vez**, y sin ningún error visible: `net.http_post` es
> fire-and-forget, así que el trigger sigue auditando `email.dispatched` como si todo estuviera bien
> ([20261530000000:81-96](../supabase/migrations/20261530000000_stop_auditing_expected_email_skips.sql)).
> Si de verdad necesitás rotar la key, hacelo con un `UPDATE` explícito sobre esa única fila y
> verificá el envío inmediatamente después.

**Quién las consume:** `notify_send_email` usa `send_email_url` como destino del `net.http_post` y `service_role_key` como el header `Authorization: Bearer ...` ([20261530000000:37-38 y :81-89](../supabase/migrations/20261530000000_stop_auditing_expected_email_skips.sql)). El cron de reintentos `retry_failed_email_notifications` lee las mismas dos ([20261320000000:41-42](../supabase/migrations/20261320000000_email_retry_exponential_backoff.sql)). Apagar esas filas apaga **todo** el correo, incluido el reintento.

**Sobre el formato de la service role key:** tiene que ser el **JWT** (`eyJ...`). Si pegás una key del formato nuevo `sb_secret_*`, el gateway de Supabase la rechaza con 401 antes de entrar al handler, porque `send-email` **no está declarada** en [supabase/config.toml](../supabase/config.toml) y por lo tanto corre con `verify_jwt = true` (verificado: el archivo declara 16 secciones `[functions."..."]` y ninguna es `send-email`). Ver §7.5 — es el fallo más engañoso de todos.

> ⚠️ **Cuidado con el nombre:** hay **dos** tablas llamadas `app_settings` y no tienen nada que ver. `private.app_settings` es la de este paso (key/value: URL del edge + service role key). `public.app_settings` es config por institución (umbrales de alerta, `require_exam_fullscreen`, etc.). Escribir en la equivocada no da error, simplemente no hace nada.

---

## 5. Qué panel activa cada tipo de correo (5 pasos)

Los secrets y las filas de DB habilitan el **canal**. Qué correos salen por ese canal lo decide la tabla `email_settings`, que es un **singleton GLOBAL de plataforma** (`id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1)`, [20260523000009_email_settings.sql:18](../supabase/migrations/20260523000009_email_settings.sql)).

1. Entrá a **`/app/superadmin/system`** → tab **"Correos"**
   ([app.superadmin.system.tsx:53-56 y :73-79](../src/routes/app.superadmin.system.tsx)).

   > **Por qué acá y no en Configuración.** La cuenta de este manual es SuperAdmin con
   > `tenant_id = NULL`. Con el rol activo en SuperAdmin y sin haber entrado a una institución,
   > `/app/admin/settings` calcula `isSuperAdminCrossTenant` y muestra una rama REDUCIDA de solo
   > 3 tabs — Módulos, Compilador y Auditoría: **la tab "Correos" no existe ahí**
   > ([app.admin.settings.tsx:59-61 y :82-129](../src/routes/app.admin.settings.tsx)). Y la ruta
   > vieja `/app/admin/email-settings` redirige al cross-tenant a Instituciones
   > ([app.admin.email-settings.tsx:24-31](../src/routes/app.admin.email-settings.tsx)).
   >
   > `/app/admin/settings` → "Correos" **sí** es el camino correcto para el **Admin de una
   > institución**, o para el SuperAdmin que ya entró con "Ver como esta institución" desde
   > `/app/superadmin/tenants`. Es el mismo panel: acepta SuperAdmin puro
   > ([AdminEmailSettingsPanel.tsx:403-404](../src/modules/admin/AdminEmailSettingsPanel.tsx)).
   - Como SuperAdmin también está en **`/app/superadmin/system`** → tab **"Correos"** ([app.superadmin.system.tsx:53-56](../src/routes/app.superadmin.system.tsx)) — es **el mismo panel y la misma fila**.
   - La ruta legacy `/app/admin/email-settings` sigue viva para bookmarks y muestra el mismo panel.
2. Arriba está el **kill switch global** (columna `globally_enabled`, default `TRUE`). Tiene que estar **encendido**. Cuando está apagado, la card se pinta en rojo y **todos los switches de abajo quedan deshabilitados** ([AdminEmailSettingsPanel.tsx:508-543 y :593](../src/modules/admin/AdminEmailSettingsPanel.tsx)).
3. Abajo hay 12 switches, uno por categoría ([AdminEmailSettingsPanel.tsx:83-174](../src/modules/admin/AdminEmailSettingsPanel.tsx)): Exámenes · Talleres · Proyectos · Calificaciones · Retroalimentación · Mensajes 1-a-1 · Encuestas · Contenidos / Materiales · Alertas del sistema · Bienvenida (nuevos usuarios) · Bienvenida al curso · Inicio de sesión autónoma.
4. Dejá encendido lo que quieras que salga. **Una clave que no exista en el JSON se trata como ENCENDIDA** — tanto la UI (`enabledKinds[cat.key] !== false`, [línea 563](../src/modules/admin/AdminEmailSettingsPanel.tsx)) como el edge (`enabledKinds[categoryKey] === false`, [index.ts:414](../supabase/functions/send-email/index.ts)) preguntan por `false` explícito. Para apagar algo hay que **guardarlo en false**, no basta con que falte.
5. Click en **"Guardar cambios"** (solo se habilita si hay cambios reales, [líneas 446-449](../src/modules/admin/AdminEmailSettingsPanel.tsx)). Queda registrado en Auditoría como `email_settings.updated`.

### 5.1 Dos switches del panel están MUERTOS

**"Encuestas" (`poll`)** y **"Contenidos / Materiales" (`content`)** no hacen nada. Se agregaron al predicado en su momento, pero la migración `20260708000000_broadcast_emails.sql` recreó `_notification_kind_emails` sin ellos y nunca volvieron. El set vigente es ([20261490000000:28-38](../supabase/migrations/20261490000000_notify_autonomous_sessions.sql)):

```
grade · exam · feedback · workshop · project · attendance · broadcast · course_welcome · session_start
+ kind 'info'   con link /app/messages%
+ kind 'system' con link /app/admin/system%
+ kind 'system' con link /auth/reset-password%
+ kind 'support' (si platform_settings.support_emails_enabled)
```

`poll` y `content` tampoco están en `CRITICAL_KINDS` del edge ([index.ts:45-71](../supabase/functions/send-email/index.ts)). Mover esos dos switches no cambia nada: esas notificaciones nunca emailan.

### 5.2 El switch "Bienvenida" no lo enforza `send-email`

**"Bienvenida (nuevos usuarios)"** (`welcome`) lo lee la edge `bulk-import-users`: si está apagado, no genera el token ni la notificación de alta ([bulk-import-users/index.ts:115-125 y :486](../supabase/functions/bulk-import-users/index.ts)). Afecta el **alta de usuarios**, no las notificaciones normales.

### 5.3 El kill switch mata la recuperación de contraseña (pero NO el cambio de correo)

El chequeo de `globally_enabled` corre **antes** de la excepción para transaccionales ([index.ts:385-392](../supabase/functions/send-email/index.ts) vs `isTransactional` en [:407-414](../supabase/functions/send-email/index.ts)). Con el switch global apagado **no sale el reset de contraseña** —ese sí viaja por `notifications` → `send-email`— y un usuario puede quedar sin poder recuperar su cuenta. Los switches por categoría sí respetan la excepción para transaccionales; el global no.

> Los avisos de **cambio de correo** NO se ven afectados, y eso es útil: `request-email-change` y `confirm-email-change` levantan su PROPIO `SMTPClient` leyendo los env directamente y **no consultan `email_settings`** ([request-email-change/index.ts:275-297](../supabase/functions/request-email-change/index.ts), [confirm-email-change/index.ts:205-212](../supabase/functions/confirm-email-change/index.ts)). O sea que el flujo de cambio de correo sirve como segundo test end-to-end que **aísla incluso el kill switch**: si ese correo llega y los demás no, el problema es de configuración de `email_settings`, no de SMTP.

---

## 6. VERIFICACIÓN

### 6.1 Paso 1 — la card de Diagnósticos (4 pasos)

1. Entrá como SuperAdmin a **`/app/superadmin/system`** → tab **"Diagnósticos"** ([app.superadmin.system.tsx:61-64 y :83-85](../src/routes/app.superadmin.system.tsx)).
2. Pulsá **"Refrescar"** ([SystemDiagnosticsPanel.tsx:639](../src/modules/admin/SystemDiagnosticsPanel.tsx)). **Sin ese click todas las cards dicen "Refresca para ver el estado."** — el panel no se autoejecuta.
3. Buscá la card **"Email (SMTP)"** (ícono de sobre, [SystemDiagnosticsPanel.tsx:1245-1307](../src/modules/admin/SystemDiagnosticsPanel.tsx)). Muestra un renglón por secret con **"Presente"** (✓ verde) o **"Ausente"** (✗ rojo) para: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`. Al pie: *"Todos los secrets SMTP están configurados."* (verde) o *"N secret(s) faltante(s). El envío de correos puede fallar."* (ámbar).
4. **La card no cubre `EMAIL_FROM_NAME` ni `APP_PUBLIC_URL`.** Esos dos aparecen en la card genérica **"Secrets de Edge Functions"** de la misma pantalla ([SystemDiagnosticsPanel.tsx:1036-1060](../src/modules/admin/SystemDiagnosticsPanel.tsx), lista en [health-check/index.ts:47-53](../supabase/functions/health-check/index.ts)). Mirá **las dos** cards.

> **La card verde NO prueba que el correo funcione.** Solo comprueba **presencia**: `present: Boolean(Deno.env.get(d.name))` ([health-check/index.ts:57](../supabase/functions/health-check/index.ts)). Con una App Password revocada, mal pegada o con espacios, la card sigue en verde y los correos fallan callados. Tampoco ve las filas de `private.app_settings` del §4.

### 6.2 Paso 2 — no hay botón de "correo de prueba": hacé esto en su lugar (5 pasos)

**No existe** ninguna función de "enviar correo de prueba" en la app. Sí existe para push (*"Enviar push de prueba"*, [SystemDiagnosticsPanel.tsx:1015-1023](../src/modules/admin/SystemDiagnosticsPanel.tsx)), pero la contraparte de correo está solo **planificada** ([docs/PLAN-CORREO-POR-CUENTA.md:59-60](PLAN-CORREO-POR-CUENTA.md)). La prueba end-to-end se hace así:

1. Abrí una ventana de incógnito y andá a **`/auth`** → **"Olvidé mi contraseña"**.
2. Escribí un **correo institucional** que exista en `profiles.institutional_email`. Ojo: el flujo busca **solo** por el correo institucional, no por el personal ([request-password-reset/index.ts:12-14](../supabase/functions/request-password-reset/index.ts)).
3. Enviá. La edge inserta una notificación `kind='system'` con link `/auth/reset-password?token=...` ([request-password-reset/index.ts:17-19](../supabase/functions/request-password-reset/index.ts)) y el trigger dispara el correo por el mismo SMTP y el mismo template que todo lo demás.
   - **Por qué esta prueba y no otra:** es **transaccional**, así que no depende de ningún toggle por categoría ([send-email/index.ts:407-414](../supabase/functions/send-email/index.ts)). Aísla el canal SMTP de la configuración de tipos. (Sí depende del kill switch global — ver §5.3.)
4. Revisá el buzón. Si llegó, verificá **tres cosas** además de que llegó:
   - El remitente dice `ExamLab <castano.julian@correounivalle.edu.co>`.
   - El asunto empieza con `ExamLab: ` y **está sin acentos ni emoji** (ej. `ExamLab: Recuperacion de contrasena`). Eso es **correcto y a propósito** — ver §6.4.
   - **El botón del correo abre una URL absoluta** con `https://examlab.lovable.app/...`. Si el enlace es relativo o no abre nada, falta `APP_PUBLIC_URL` (§7.3).
5. Si no llegó, seguí al paso 3.

### 6.3 Paso 3 — leer el resultado real dentro de la app (2 caminos)

**Camino A — módulo Auditoría del sidebar** → **`/app/admin/audit-logs`**
([app.admin.audit-logs.tsx:63](../src/routes/app.admin.audit-logs.tsx)). El SuperAdmin lo alcanza por
la regla RBAC `{ prefix: "/app/admin", roles: ["Admin","SuperAdmin"] }`
([rbac.ts:23](../src/shared/lib/rbac.ts)).

> Ojo: la tab **"Auditoría"** de `/app/admin/settings` **no** es este visor — renderiza el panel de
> RETENCIÓN de logs por severidad ([app.admin.settings.tsx:205-207](../src/routes/app.admin.settings.tsx)).
> Si buscás el filtro de acciones ahí, no está.

Filtrá por estas cuatro acciones ([AuditLogsView.tsx:142](../src/modules/admin/AuditLogsView.tsx)):

| Acción | Qué significa |
|---|---|
| `email.dispatched` | El trigger SQL hizo el `http_post`. **No significa que el correo salió**: `pg_net` es fire-and-forget. |
| `email.delivered` | El SMTP aceptó el correo. Esto sí es éxito. Su metadata trae `smtp_source` (`"global"` o `"tenant"`). |
| `email.skipped` | Se decidió no mandarlo. La metadata trae `reason` y `stage` (`"trigger"` o `"edge"`). |
| `email.failed` | Error real. La metadata trae el motivo: `smtp_env_missing` (con el mapa de cuál secret falta), `smtp_port_invalid`, o el error del proveedor. |

**Camino B — SQL Editor** (más directo para diagnosticar):

```sql
SELECT id, kind, title, created_at, email_delivered_at, email_skipped_reason
  FROM public.notifications
 ORDER BY created_at DESC
 LIMIT 20;
```

Cómo leer el resultado ([columnas documentadas en 20260523000000:13-21](../supabase/migrations/20260523000000_notifications_email_delivery.sql)):

| Lo que ves | Qué pasó |
|---|---|
| `email_delivered_at` con fecha | ✅ Salió. |
| `email_skipped_reason = 'no_settings'` | Faltan secrets **o** faltan las filas del §4. Se distinguen por el audit: `stage:'trigger'` = faltan las filas de DB; `reason:'smtp_env_missing'` = faltan secrets. |
| `email_skipped_reason = 'pg_net_missing'` | La extensión `pg_net` no está instalada en el proyecto. |
| `email_skipped_reason = 'kind_not_critical'` | Ese tipo de notificación no emaila por diseño (§5.1). Normal y de alto volumen. |
| `email_skipped_reason = 'kind_disabled:<categoría>'` | Apagaste ese switch en el panel de Correos. |
| `email_skipped_reason = 'globally_disabled'` | Kill switch apagado (§5.3). |
| `email_skipped_reason = 'suppressed'` | La dirección está en `email_suppressions` (§7.6). |
| `email_skipped_reason` empieza con `provider_error:` | Google rechazó. El texto que sigue es el error literal de Gmail — usalo en §7. |
| **Las dos columnas en NULL** y hay un `email.dispatched` en Auditoría | El `http_post` salió pero la edge nunca respondió. Casi siempre es el 401 del §7.5. |

### 6.4 Lo que NO es un error aunque se vea raro

Los asuntos llegan **sin acentos ni emoji** a propósito: "Calificacion", no "Calificación"; el 🎓 desaparece. Lo hace `asciiEmailSubject` ([_shared/email.ts:62-72](../supabase/functions/_shared/email.ts)) porque `denomailer` 1.6.0 rompe el encoded-word RFC 2047 de asuntos no-ASCII largos y el cliente termina mostrando la estructura MIME cruda (`--attachment100`, `Content-Type: multipart/...`) como texto en el cuerpo. El display-name del remitente también se translitera ("Fundación" → "Fundacion", `asciiDisplayName` en [:87-96](../supabase/functions/_shared/email.ts)). **El cuerpo sí conserva UTF-8 completo** (va en base64). Si alguien "arregla" esto para que respete acentos, vuelve el correo ilegible.

---

## 7. SI FALLA — los 6 casos más probables

### 7.1 "No aparece la opción Contraseñas de aplicaciones en Google"

- **Causa A:** la verificación en 2 pasos está desactivada. La opción no existe hasta que 2FA esté activa.
- **Arreglo A:** §2.2, activar 2FA y volver a `myaccount.google.com/apppasswords`.
- **Causa B:** 2FA está activa **y** la opción sigue sin aparecer → el administrador del Workspace de Univalle tiene las App Passwords bloqueadas para toda la organización (política común cuando hay SSO/SAML obligatorio, porque una App Password es una credencial que **no pasa por el IdP institucional**).
- **Arreglo B:** no se arregla desde ExamLab. Pedirlo al IT de Univalle, o pasar al plan B de §8.2. No sigas reintentando: el síntoma es idéntico al de la causa A y es donde más tiempo se pierde.

### 7.2 `provider_error: 535 5.7.8 Username and Password not accepted`

- **Causa:** `SMTP_PASSWORD` no es una App Password válida. Los tres motivos, en orden de frecuencia: pegaste la contraseña **normal** de la cuenta en vez de la App Password; pegaste los 16 caracteres **con los espacios** de Google; la App Password fue revocada (o se invalidó porque cambió la contraseña de la cuenta).
- **Arreglo:** generá una App Password nueva (§2) y re-escribila (§3.1 paso 3 o §3.2 paso 6). **No se puede verificar comparando en pantalla** — el valor guardado nunca se puede releer (`(configurado)`, [manage-edge-secrets/index.ts:62-65](../supabase/functions/manage-edge-secrets/index.ts)). La única forma es sobrescribirla y volver a probar con §6.2.
- **Nota:** la card de Diagnósticos sigue **verde** en este caso. Presencia ≠ autenticación.

### 7.3 "El correo llega pero el botón no lleva a ninguna parte"

- **Causa:** falta `APP_PUBLIC_URL`, o está sin `https://`, o tiene `/` al final. Con `appUrl` vacío el HTML arma `href="/app/messages/..."` — relativo, y un cliente de correo no tiene base contra la que resolverlo ([send-email/index.ts:511](../supabase/functions/send-email/index.ts) + `renderEmailHtml:200-202`). El texto plano queda `Ver: /app/messages/...`.
- **Por qué nadie te avisa:** `APP_PUBLIC_URL` está **fuera** del gate de secrets obligatorios ([:566](../supabase/functions/send-email/index.ts)), así que no hay skip, no hay audit, no hay toast — y la card SMTP de 5 secrets tampoco lo mira.
- **Arreglo:** cargá `APP_PUBLIC_URL = https://examlab.lovable.app` (§3) y confirmalo en la card genérica "Secrets de Edge Functions", que espera prefijo `https://` ([health-check/index.ts:53](../supabase/functions/health-check/index.ts)).
- **Efecto colateral distinto en otros dos edges:** `request-email-change` rechaza con el mensaje **engañoso** `smtp_not_configured` cuando lo único que falta es `APP_PUBLIC_URL` (está en el mismo `if`, [:283-297](../supabase/functions/request-email-change/index.ts)), y `confirm-email-change` hace un **`return` mudo sin audit ni log** ([:212](../supabase/functions/confirm-email-change/index.ts)) — el aviso de cambio de correo simplemente nunca llega y no queda rastro.

### 7.4 El correo rebota 5.5.x / 5.7.x hablando del remitente

- **Causa:** `EMAIL_FROM` no es la dirección que autentica. Con Gmail/Workspace el remitente lo define **la cuenta que autentica**, no la app ni la configuración ([send-email/index.ts:19](../supabase/functions/send-email/index.ts): *"para Gmail, igual a SMTP_USER"*). Google solo deja enviar como una dirección que la cuenta **posee** o como un alias "Enviar como" ya verificado.
- **Por qué no te avisó antes:** **la igualdad no se valida en ningún lado.** El `from` va crudo a `formatEmailAddress` ([:627](../supabase/functions/send-email/index.ts)) y la UI de SMTP por institución solo valida presencia ([TenantEmailSettingsDialog.tsx:105-125](../src/modules/superadmin/TenantEmailSettingsDialog.tsx)). El sistema arranca, la card da verde, y el fallo aparece recién en el envío.
- **Arreglo:** poné `EMAIL_FROM = SMTP_USER = castano.julian@correounivalle.edu.co`.
- **Caso especial — no funciona poner el dominio del cliente:** `EMAIL_FROM = algo@lanuevaamerica.edu.co` autenticando con correounivalle **no se arregla desde acá**, ni aunque Google lo dejara: SPF no lista al emisor, DKIM firma con `d=correounivalle` (no alinea) y el DMARC del otro dominio manda a spam o rechaza. El razonamiento completo está en [docs/PLAN-CORREO-POR-CUENTA.md:104-125](PLAN-CORREO-POR-CUENTA.md) — no vale la pena re-litigarlo. Las dos salidas legítimas: (a) cargar las credenciales propias de esa institución en `tenant_email_settings` (§8.3), o (b) dejar el From verificado y usar `reply_to` (§8.4).

### 7.5 Cero correos, `email.dispatched` en Auditoría y las dos columnas en NULL

Este es el fallo más engañoso: **parece que salió**.

- **Causa:** el gateway de Supabase rechazó la invocación con **401** antes de entrar al handler, porque `send-email` **no está declarada en `config.toml`** y por lo tanto corre con `verify_jwt = true`, y el `Bearer` que le manda el trigger sale de `private.app_settings.service_role_key`. Si ahí guardaste una key del formato nuevo `sb_secret_*` (que no es un JWT parseable) en vez del JWT `eyJ...`, se rebota con `UNAUTHORIZED_INVALID_JWT_FORMAT`.
- **Por qué no queda rastro:** `net.http_post` es fire-and-forget, así que el trigger ya audió `email.dispatched` ([20261530000000:91-96](../supabase/migrations/20261530000000_stop_auditing_expected_email_skips.sql)) y nunca se enteró del 401. No hay ningún `email.failed`.
- **Arreglo:** volvé a correr el `INSERT ... ON CONFLICT` del §4 paso 2 con la key `service_role` en formato JWT (dashboard → **Settings → API → Project API keys → `service_role`**, empieza con `eyJ`).
- **Variante:** si `service_role_key` está directamente **ausente**, el trigger no lo valida y manda `Bearer ` vacío ([:85](../supabase/migrations/20261530000000_stop_auditing_expected_email_skips.sql)) → mismo síntoma.

### 7.6 Todo verde y aun así no sale: 4 compuertas de datos

Con los 7 secrets correctos y las 2 filas puestas, el correo todavía puede no salir por configuración de **datos**, no de infraestructura:

1. **Kill switch:** `email_settings.globally_enabled = false` → `globally_disabled` ([:385-392](../supabase/functions/send-email/index.ts)). Arreglo: §5 paso 2.
2. **Toggle por categoría:** `enabled_kinds[<cat>] = false` → `kind_disabled:<cat>` ([:414-422](../supabase/functions/send-email/index.ts)). Arreglo: §5 paso 3.
3. **El tipo no emaila:** `kind_not_critical`. No es un error — es el diseño (§5.1). Los kinds `poll` y `content` caen siempre acá.
4. **Lista de supresión:** la dirección está en `email_suppressions` → `suppressed` ([:470-499](../supabase/functions/send-email/index.ts)). **Se auto-puebla:** un rebote permanente 5.x.x sobre un buzón (lleno, inexistente, deshabilitado) inscribe la dirección automáticamente ([:761-787](../supabase/functions/send-email/index.ts), detección en `isPermanentMailboxError` [:92-105](../supabase/functions/send-email/index.ts)). Un buzón que se llenó una vez **queda cortado** hasta que un Admin lo saque a mano. Arreglo: `/app/superadmin/system` → tab **"Correos"** → card de lista de supresión al final del panel ([AdminEmailSettingsPanel.tsx:193-394](../src/modules/admin/AdminEmailSettingsPanel.tsx)) → borrá la dirección. (Es el mismo panel del §5: desde `/app/admin/settings` solo lo ve el Admin de una institución, no el SuperAdmin puro.)

### 7.7 `provider_error: Connection is not secure!`

- **Causa:** `SMTP_PORT` apunta a un puerto donde Google no ofrece STARTTLS ni TLS implícito. `denomailer` se niega a autenticar sin cifrado (no reintenta: el patrón no matchea `isTransientSmtpError`).
- **Arreglo:** `SMTP_PORT = 587`. Ver §1.1.

---

## 8. Límites y alternativas

### 8.1 Los dos límites de Google, que no son el mismo

Google impone **dos** cosas distintas y este proyecto ya se chocó con las dos. Tratarlas como una sola lleva al consejo equivocado.

**Límite 1 — mensajes por día.** Cada **destinatario** cuenta, no cada "acción". El orden de magnitud para Workspace ronda los cientos de destinatarios/día, pero **cambia según la edición de Workspace** (Education no es Business): verificalo en la página de límites de Google el día que lo necesites, no lo tomes como constante de este manual.

Estimación de consumo real de ExamLab: la difusión y las notificaciones mandan **un correo por alumno**. Para un curso de 93 estudiantes:
- Publicar un examen = 93 correos. **Editarlo después también notifica** → otros 93.
- Publicar un taller = 93. Un proyecto = 93. Bienvenida al curso = 93. Una difusión = 93. Cada sesión autónoma que arranca = 93.
- Un día de arranque de curso (taller + examen + difusión) ≈ **279 correos de un solo curso**.

> **No confíes en lo que dice `CLAUDE.md:547` sobre el BCC.** Ese texto quedó viejo: afirma que la difusión manda "UN solo correo con todos en BCC". El BCC **fue eliminado** ([broadcast-course-message/index.ts:18 y :369-375](../supabase/functions/broadcast-course-message/index.ts): *"Ya NO mandamos un BCC desde acá"*). Hoy es **un correo por destinatario**, así que el límite de "destinatarios por mensaje" de Gmail es irrelevante y **no hay ninguna amortiguación del consumo diario**.

**Límite 2 — intentos de login / conexión.** Se dispara por **ráfaga**, aunque el total del día sea bajo, y **los correos que fallan también lo consumen**. Incidentes documentados en este repo:

| Fecha | Síntoma | Medición |
|---|---|---|
| 2026-07-08 | `421 4.3.0 Temporary System Problem` | `email.failed` pasó de ~17 a **325 en 14 días**; notificar a un curso de ~190 alumnos abre ~190 conexiones SMTP en el mismo instante ([docs/PLAN-ERRORES.md:183-185](PLAN-ERRORES.md)) |
| 2026-07-18 | `454 4.7.0 Too many login attempts` | **183 fallos/hora auto-sostenidos**: el cron reintentaba 50 notifs cada 5 min sin espaciado y cada envío abría hasta 3 logins ([20261320000000:4-16](../supabase/migrations/20261320000000_email_retry_exponential_backoff.sql)) |
| — | Ráfaga de 80 correos | **78/80 entregados**; los 2 restantes los drenó el cron de reintentos (`CHANGELOG.md:196`) |

Umbral empírico útil: **~80 correos simultáneos ya rozan el límite de ráfaga de esta cuenta.**

Mitigaciones que ya están en el código, no hay que hacer nada: pre-jitter aleatorio de 0-1200 ms por invocación ([send-email/index.ts:610](../supabase/functions/send-email/index.ts)); 3 intentos con backoff solo para errores transitorios ([:700-751](../supabase/functions/send-email/index.ts)); **fail-fast deliberado ante el throttle de login** (`isLoginThrottleError`, [:125-128](../supabase/functions/send-email/index.ts) — reintentar ahí lo empeora); y backoff exponencial `5min × 2^retry_count` en el cron de reintentos.

### 8.2 Alerta preventiva de volumen (recomendado activarla)

Existe una alerta por volumen de correos a 24h, **apagada por defecto** (`app_settings.email_alert_threshold_24h` default `0` = desactivada, [20260518130000_app_settings_and_email_alert.sql:29-32](../supabase/migrations/20260518130000_app_settings_and_email_alert.sql)). Cuenta `email.delivered` + `email.failed` de las últimas 24h (los `skipped` no cuentan) — que incluya los fallidos es correcto, porque un fallo igual consume intentos de login.

**Cómo activarla.** Requiere entrar en el contexto de una institución, porque el SuperAdmin puro no
ve esa tab (misma rama reducida de 3 tabs del §5): `/app/superadmin/tenants` → **"Ver como esta
institución"** → `/app/admin/settings` → tab **"General"** → campos **umbral de alerta de correos
(24h)** y **horas de enfriamiento**
([AdminGeneralSettingsPanel.tsx:534 y :555](../src/modules/admin/AdminGeneralSettingsPanel.tsx)).

> ⚠️ **El umbral es POR INSTITUCIÓN, y eso cambia el número que hay que poner.** `public.app_settings`
> es un singleton **por institución** — la columna `tenant_id` se agregó en
> [20260625000000_tenants_globals_per_tenant.sql:27-42](../supabase/migrations/20260625000000_tenants_globals_per_tenant.sql)
> y lo vuelve a documentar
> [20261580000000:9](../supabase/migrations/20261580000000_early_alert_thresholds.sql). Con 4
> instituciones hay 4 filas y 4 umbrales independientes, así que **hay que repetir el ajuste en cada
> una**: configurar solo la de FESNA no protege a las otras tres.
>
> Y como las 4 comparten **UNA sola cuenta de Google**, el umbral de cada institución tiene que ser
> una **fracción** del tope —repartido según cuánto envía cada una—, no el 70-80% del tope completo.
> Si le pones el 80% del tope a cada una, la suma es 320% y la alerta salta cuando ya te cortaron.

### 8.3 Si Google no es viable: el edge es portable sin tocar código

El propio edge lo dice en [send-email/index.ts:9-12](../supabase/functions/send-email/index.ts): *"Las mismas variables sirven para Brevo, Resend, SendGrid, Mailgun — solo cambian los valores. Diseño portable a propósito."*

Si el IT de Univalle bloquea las App Passwords (§7.1 causa B), o el volumen supera el cupo, **cambiás 5 valores de secrets y listo** — no hay que modificar ni una línea:

| Secret | Con Google | Con un ESP (ejemplo Brevo) |
|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` | el host SMTP del proveedor |
| `SMTP_PORT` | `587` | `587` (ver §1.1: solo 587 y 465 son válidos) |
| `SMTP_USER` | `castano.julian@correounivalle.edu.co` | el usuario/login SMTP del proveedor |
| `SMTP_PASSWORD` | App Password de 16 chars | la clave SMTP del proveedor |
| `EMAIL_FROM` | igual a `SMTP_USER` | una dirección **verificada en ese proveedor** |

Con un ESP desaparece la restricción `EMAIL_FROM = SMTP_USER` (§7.4), porque el remitente lo autoriza el proveedor tras verificar el dominio con SPF/DKIM. Es la salida correcta si se quiere un `no-reply@` propio.

### 8.4 Reparto de cuota por institución (la infra ya existe, está dormida)

Hay una tabla `tenant_email_settings` (PK `tenant_id`, columnas `use_custom_smtp`, `smtp_host`, `smtp_port`, `smtp_user`, `smtp_password`, `email_from`, `email_from_name`, `reply_to`) y el edge ya la consulta ([send-email/index.ts:517-547](../supabase/functions/send-email/index.ts)). Cada institución con su propia cuenta = cada una con su propia cuota, sin compartir el throttle.

- **Cómo se activa:** solo el **SuperAdmin** tiene UI → `/app/superadmin/tenants` → menú de la fila de la institución → **"Configurar correo"** ([app.superadmin.tenants.tsx:1194-1204](../src/routes/app.superadmin.tenants.tsx)). **El Admin de la institución no tiene pantalla** para esto, aunque la RLS ya se lo permitiría (gap documentado en [docs/PLAN-CORREO-POR-CUENTA.md:56-58](PLAN-CORREO-POR-CUENTA.md)).
- **Estado actual:** las 4 instituciones en producción tienen `use_custom_smtp = false` → todo cae al SMTP global de Google ([docs/PLAN-CORREO-POR-CUENTA.md:30-34](PLAN-CORREO-POR-CUENTA.md)).
- **Se resuelve por el tenant del DESTINATARIO**, no del que dispara la acción ([:517](../supabase/functions/send-email/index.ts)). Corolario para probar: un SuperAdmin con `tenant_id` NULL **siempre** recibe por el SMTP global, así que "probar con mi cuenta de SuperAdmin" nunca ejercita el SMTP de la institución.
- ⚠️ **Configuración a medias cae al global EN SILENCIO.** El override exige las 6 condiciones a la vez (`use_custom_smtp` + host + port + user + password + email_from, [:525-532](../supabase/functions/send-email/index.ts)). Si falta una sola, no hay error ni aviso: los correos siguen saliendo por la cuenta de plataforma. El único indicio es el campo **`smtp_source`** (`"global"` / `"tenant"`) en la metadata del audit `email.delivered`.
- ⚠️ **La contraseña de la institución vuelve al cliente** al abrir el dialog ([TenantEmailSettingsDialog.tsx:77 y :90](../src/modules/superadmin/TenantEmailSettingsDialog.tsx)). Es un pendiente de hardening conocido ([docs/PLAN-CORREO-POR-CUENTA.md:61-63](PLAN-CORREO-POR-CUENTA.md)). No es un campo "oculto y seguro".

### 8.5 `reply_to` — la opción intermedia, sin credenciales de cada institución

Si querés que las respuestas lleguen a la institución sin tocar el remitente (y sin romper SPF/DKIM/DMARC), usá `tenant_email_settings.reply_to`. **Aplica aunque `use_custom_smtp` sea `false`** ([send-email/index.ts:544-546](../supabase/functions/send-email/index.ts), migración [20261150000000](../supabase/migrations/20261150000000_tenant_email_settings_reply_to.sql)).

Precedencia del Reply-To, de mayor a menor: **docente emisor** (cuando la notificación tiene `related_user_id` — así una respuesta a una difusión le llega al docente que la mandó, [:553-564](../supabase/functions/send-email/index.ts)) → **`reply_to` de la institución** → **el remitente**. El `From` nunca cambia.

---

## 9. Lo que este repo NO resuelve (para que no lo busques)

1. **`MANAGEMENT_PAT` solo se puede crear en el dashboard de Supabase.** Está en `RESERVED_SECRETS` a propósito ([manage-edge-secrets/index.ts:50-53](../supabase/functions/manage-edge-secrets/index.ts)): si se pudiera borrar desde la app, quien lo borrara quedaría bloqueado de la propia UI de secrets. El primer setup arranca en el dashboard, sin excepción.
2. **Las 2 filas de `private.app_settings` solo se ponen por SQL.** No hay ninguna pantalla en ExamLab que las edite, y **ninguna migración las siembra** ([20260523000000:40-46](../supabase/migrations/20260523000000_notifications_email_delivery.sql) solo hace el `CREATE TABLE`).
3. **No hay botón de correo de prueba, ni verificación de credenciales antes de activar.** Está solo planificado, junto con la columna `verified_at` ([docs/PLAN-CORREO-POR-CUENTA.md:59-60 y :88-89](PLAN-CORREO-POR-CUENTA.md)). Mientras no exista, un SMTP mal configurado deja a una institución sin correos en silencio.
4. **`email_settings` es un singleton GLOBAL de plataforma, no una fila por institución**, y su policy de UPDATE es `has_role(auth.uid(),'Admin') OR is_super_admin()` **sin scope de tenant** ([20260910000000:21-24](../supabase/migrations/20260910000000_email_settings_super_admin_update.sql)). Es decir: **el Admin de cualquier institución puede apagar los correos de toda la plataforma** con el kill switch. Peor todavía, el comentario de la ruta legacy `app.admin.email-settings.tsx:24-27` afirma lo contrario ("el toggle es por institución") — **es falso**.
5. **La card de Diagnósticos de un Admin de institución solo se alcanza escribiendo `/app/admin/system` a mano.** El ítem se sacó del sidebar y el comentario de `AppLayout.tsx:477-479` promete un tab "Sistema" dentro de Configuración que **no existe** (los tabs reales son general/institution/email/compiler/ai-model/audit/modules, [app.admin.settings.tsx:147-182](../src/routes/app.admin.settings.tsx)).
6. **La edge `health-check` no valida rol** y corre con el `verify_jwt` por defecto: cualquier usuario autenticado que la invoque ve los booleanos de presencia de los 15 secrets. No expone valores, pero no es un endpoint "solo admin".
7. **El remitente de toda la plataforma es el buzón nominal de una persona en la universidad**, no un buzón funcional tipo `no-reply@` ([docs/PLAN-CORREO-POR-CUENTA.md:16-18](PLAN-CORREO-POR-CUENTA.md)). Riesgos operativos a declarar: si Univalle desaprovisiona o suspende esa cuenta (egreso, fin de vínculo, política de inactividad), **todo el correo de las 4 instituciones se detiene**; las App Passwords se invalidan al cambiar la contraseña; y el IT puede aplicar políticas sin avisarle al proyecto. Antes de escalar a más instituciones, migrar a un buzón funcional o a un ESP (§8.3) y registrar quién es el dueño operativo de esa credencial.
8. **Rotar la App Password no es solo un cambio en Google.** El ciclo completo es: generar en Google (§2) → cargar el secret (§3) → verificar con un envío real (§6.2). Si se rota en Google y no se actualiza el secret, el correo de las 4 instituciones cae de golpe.
9. **La nota de SSO de `CLAUDE.md:72` no tiene nada que ver con esto.** Ese SSO es el de la propia app ExamLab para una cuenta de prueba (`test-fesna@examlab.test`). La interacción entre SAML/SSO de Google Workspace y las App Passwords no está documentada en el repo — lo único cierto y relevante es lo de §7.1 causa B: una App Password **no pasa por el IdP institucional**, y por eso muchos administradores de Workspace las bloquean.
