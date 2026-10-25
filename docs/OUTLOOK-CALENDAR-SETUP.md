# Conectar el Calendario de Outlook / Microsoft 365 (Microsoft Graph)

> Integración para que el **docente** sincronice sus sesiones de ExamLab con su calendario de Outlook/Teams (crear eventos, auto-crear reuniones de Teams, vincular sesiones a eventos existentes trayendo el link de la reunión, y traer la transcripción de Teams).
>
> **Es DISTINTO del login SSO de Microsoft** (ver [SSO-SETUP.md](SSO-SETUP.md)): esto NO es para iniciar sesión, sino para conectar el calendario. Usa **otra app registration** con permisos de Microsoft Graph.
>
> **El código ya está listo.** Lo que falta es: (1) registrar una app en Azure con permisos de Graph y (2) cargar 2 secrets en Supabase. Sin eso, «Conectar cuenta» con Outlook responde «La conexión con Outlook / Microsoft 365 todavía no está configurada en la plataforma» (el edge `calendar` devuelve `provider_not_configured`).

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
| `OnlineMeetingTranscript.Read.All` | Traer la transcripción de las reuniones que el docente organiza (acción «Transcripción de Teams» en Asistencia) |

> **Aprobación del administrador — la que de verdad se necesita es la de la INSTITUCIÓN.**
> ExamLab pide todos estos permisos al conectar, y `OnlineMeetingTranscript.Read.All` **siempre**
> exige que lo apruebe un administrador del tenant de Microsoft del docente (aunque sea delegado).
> Hasta entonces Microsoft muestra «Se necesita aprobación del administrador» y la conexión no
> termina, ni siquiera para el calendario. El botón «Grant admin consent» de esta pantalla solo
> aprueba en el tenant donde registraste la app; para los docentes de una universidad lo tiene que
> aprobar el área de TI de esa universidad, una sola vez para todos, con este enlace:
> ```
> https://login.microsoftonline.com/<dominio-de-la-institución>/adminconsent?client_id=<Application (client) ID>
> ```
> (o desde Entra → **Aplicaciones empresariales** → la app → **Permisos** → **Conceder consentimiento
> de administrador**). Los demás permisos dependen de la política de la institución: muchas no
> dejan que el usuario apruebe apps de editores no verificados.

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
5. A partir de ahí puede **Sincronizar curso** (crea eventos + reunión de Teams) y **Vincular sesiones desde Calendar** (asocia eventos existentes y trae el link de la reunión de Teams; la grabación solo la trae con Google).

> Nota: un docente tiene **una sola** conexión activa (Google **o** Microsoft), por diseño (PK por `teacher_id`). Conectar Microsoft reemplaza una conexión Google previa.

---

## Grabación, notas y transcripción de reuniones en Outlook

- **Google Calendar**: al vincular un evento, ExamLab trae automáticamente la **grabación** y las **notas** si están adjuntas al evento (Meet las adjunta como video de Drive / Doc de Gemini).
- **Microsoft/Teams**: la grabación y las notas **NO** viven en el evento de calendario. La **transcripción** sí se trae: acción «Transcripción de Teams» en el menú de la sesión (Asistencia), con el permiso delegado `OnlineMeetingTranscript.Read.All` (Paso 2). Solo funciona para el **organizador** de la reunión, con cuenta de escuela o trabajo y con la transcripción activada en la reunión. La **grabación** sigue siendo manual (campo "Enlace de grabación" en el Tablero de sesiones y en Asistencia): traerla pediría `OnlineMeetingRecording.Read.All`.

---

## Diagnóstico

| Síntoma | Causa probable |
|---|---|
| «Esta dirección de ExamLab no está habilitada para conectar calendarios» (`origin_not_allowed`) | El dominio desde el que se abrió ExamLab no está en `supabase/functions/_shared/origen-permitido.ts` (pasó al mudar la app a `*.examlab.workers.dev`) |
| «La conexión con Outlook / Microsoft 365 todavía no está configurada» (`provider_not_configured`) | Falta `MS_OAUTH_CLIENT_ID` o `MS_OAUTH_CLIENT_SECRET` en Supabase (Paso 4) |
| «Se necesita aprobación del administrador» | El área de TI de la institución no ha aprobado la app (nota del Paso 2) |
| `AADSTS50011` redirect_uri_mismatch | La Redirect URI en Azure no es exactamente `…/functions/v1/calendar-oauth-callback` |
| Conecta pero a la hora deja de sincronizar | Falta `offline_access` → no hay refresh_token (Paso 2) |
| Evento creado sin link de Teams | La cuenta no tiene licencia Teams o el tenant bloquea — el evento se crea igual, el docente pega el link manual |
