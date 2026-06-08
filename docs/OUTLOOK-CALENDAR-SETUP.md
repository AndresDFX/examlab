# Conectar el Calendario de Outlook / Microsoft 365 (Microsoft Graph)

> Integración para que el **docente** sincronice sus sesiones de ExamLab con su calendario de Outlook/Teams (crear eventos, auto-crear reuniones de Teams, y vincular sesiones a eventos existentes trayendo el link de Meet/Teams y la grabación).
>
> **Es DISTINTO del login SSO de Microsoft** (ver [SSO-SETUP.md](SSO-SETUP.md)): esto NO es para iniciar sesión, sino para conectar el calendario. Usa **otra app registration** con permisos de Microsoft Graph.
>
> **El código ya está listo.** Lo que falta es: (1) registrar una app en Azure con permisos de Graph y (2) cargar 2 secrets en Supabase. Sin eso, el botón "Conectar Microsoft/Outlook" falla con `MS_OAUTH_CLIENT_ID no configurado`.

---

## Requisitos
- Acceso de admin al **portal de Azure** (portal.azure.com) del directorio de la institución (o cuenta personal si solo se usan cuentas @outlook.com).
- Acceso a **Supabase → Edge Function Secrets** (proyecto `uxxpzfsfcnqiwwdxoelm`).

---

## Paso 1 — Registrar la app en Azure (Microsoft Entra ID)

1. portal.azure.com → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. **Name:** `ExamLab Calendar (Outlook)`.
3. **Supported account types:** **"Accounts in any organizational directory and personal Microsoft accounts"** — debe coincidir con el authority `/common` que usa el código (acepta cuentas escuela/trabajo + personales outlook.com/hotmail).
4. **Redirect URI** → plataforma **Web** → valor EXACTO:
   ```
   https://uxxpzfsfcnqiwwdxoelm.supabase.co/functions/v1/calendar-oauth-callback
   ```
   > Es la edge `calendar-oauth-callback` de Supabase, NO una URL del app. (Distinta de la del login SSO, que apunta a `/auth/v1/callback`.)
5. **Register** → en **Overview** anota el **Application (client) ID**.

## Paso 2 — Permisos de API (Microsoft Graph, **Delegated**)

En la app → **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**, agrega:

| Permiso | Para qué |
|---|---|
| `openid`, `profile`, `email` | Identificar al docente |
| `offline_access` | **CRÍTICO** — sin esto no llega `refresh_token` y la conexión muere al expirar el token (1 h) |
| `User.Read` | Leer el mail del docente |
| `Calendars.ReadWrite` | Crear/editar/borrar eventos del calendario del docente |
| `OnlineMeetings.ReadWrite` | Auto-crear la reunión de Teams al sincronizar |

> **Grant admin consent:** en tenants de organización, `Calendars.ReadWrite` y `OnlineMeetings.ReadWrite` suelen requerir que un admin del directorio dé **"Grant admin consent for <tenant>"** en esa misma pantalla. Sin el consent, cada docente vería un error de permisos al conectar.

## Paso 3 — Client Secret

1. App → **Certificates & secrets** → **Client secrets** → **New client secret**.
2. Descripción `ExamLab Supabase`, expiración máxima permitida (ej. 24 meses).
3. **Copia el `Value` de inmediato** (no el "Secret ID") — solo se muestra una vez.
4. Agenda recordatorio para rotarlo antes de que venza (al expirar, las sincronizaciones empiezan a fallar con error de refresh).

## Paso 4 — Cargar los secrets en Supabase

Supabase Dashboard → **Project Settings → Edge Functions → Secrets** (o **Edge Function Secrets**), agrega:

| Secret | Valor |
|---|---|
| `MS_OAUTH_CLIENT_ID` | el *Application (client) ID* del Paso 1 |
| `MS_OAUTH_CLIENT_SECRET` | el **Value** del client secret del Paso 3 |

> El código lee estos env vars (`buildMicrosoftAuthUrl` / `exchangeCodeForMicrosoftTokens`). No van en `.env` del front ni en la DB.

## Paso 5 — Conectar (lado docente)

1. El docente entra a la pantalla de **Calendario** en ExamLab y elige **conectar Microsoft / Outlook**.
2. Se abre el consentimiento de Microsoft (con `prompt=select_account` para elegir cuenta).
3. Acepta los permisos → vuelve a ExamLab vía `calendar-oauth-callback`.
4. Selecciona qué **calendario** usar.
5. A partir de ahí puede **Sincronizar curso** (crea eventos + reunión de Teams) y **Vincular sesiones desde Calendar** (asocia eventos existentes y trae el link de la reunión + la grabación si la tiene).

> Nota: un docente tiene **una sola** conexión activa (Google **o** Microsoft), por diseño (PK por `teacher_id`). Conectar Microsoft reemplaza una conexión Google previa.

---

## Grabación y notas de reunión en Outlook (limitación)

- **Google Calendar**: al vincular un evento, ExamLab trae automáticamente la **grabación** y las **notas** si están adjuntas al evento (Meet las adjunta como video de Drive / Doc de Gemini).
- **Microsoft/Teams**: la grabación y las notas **NO** viven en el evento de calendario — están en otra API de Graph (`onlineMeetings/.../recordings`, `/transcripts`) que requiere permisos adicionales (`OnlineMeetingRecording.Read.All`, `OnlineMeetingTranscript.Read.All`) + **admin consent a nivel aplicación**. Por eso, para Outlook, la grabación y las notas se cargan **manualmente** (campo "Enlace de grabación" / "Enlace de notas" en el Tablero de sesiones y en Asistencia). Si en el futuro se quiere el auto-fetch para Teams, hay que agregar esos scopes + el flujo de application permissions.

---

## Diagnóstico

| Síntoma | Causa probable |
|---|---|
| "MS_OAUTH_CLIENT_ID no configurado" | Falta el secret en Supabase (Paso 4) |
| `AADSTS50011` redirect_uri_mismatch | La Redirect URI en Azure no es exactamente `…/functions/v1/calendar-oauth-callback` |
| Conecta pero a la hora deja de sincronizar | Falta `offline_access` → no hay refresh_token (Paso 2) |
| Error de permisos al conectar (consent) | Falta **Grant admin consent** en el tenant (Paso 2) |
| Evento creado sin link de Teams | La cuenta no tiene licencia Teams o el tenant bloquea — el evento se crea igual, el docente pega el link manual |
