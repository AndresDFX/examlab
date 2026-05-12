# Variables y secrets de tu proyecto Supabase

Esta guía te dice **dónde obtener cada valor** en el dashboard de tu nuevo proyecto.

## Variables públicas (van en `.env` del frontend)

Dashboard → **Project Settings → API**

| Variable | Dónde está |
|---|---|
| `VITE_SUPABASE_URL` | "Project URL" (ej. `https://abcd.supabase.co`) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | "Project API keys" → `anon` `public` |
| `VITE_SUPABASE_PROJECT_ID` | El subdominio de la URL (`abcd`) |

## Variables de servidor (Edge Functions secrets)

Dashboard → **Project Settings → API** y **Edge Functions → Manage secrets**

Estas se setean con `supabase secrets set NOMBRE=valor` o en el dashboard:

| Secret | Dónde está |
|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Project Settings → API → `anon` key |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → `service_role` key (⚠️ secreta) |
| `SUPABASE_DB_URL` | Project Settings → Database → Connection string → URI (modo session, puerto 5432) |
| `SUPABASE_JWKS` | `https://TU_PROJECT_REF.supabase.co/auth/v1/.well-known/jwks.json` (descarga el JSON) |

## Variables de integraciones externas

Estas las debes obtener **fuera de Supabase** y luego setearlas como secrets en tu nuevo proyecto:

### Lovable AI (Gemini gateway)
- `LOVABLE_API_KEY` — desde https://lovable.dev → Settings → API Keys.  
  ⚠️ Solo funciona si tu app sigue corriendo en Lovable. Si vas standalone, reemplaza por OpenAI/Anthropic directos (ver `ai_model_settings` en DB y `aiChatCompletion` helper).

### Google Calendar OAuth
- `GOOGLE_OAUTH_CLIENT_ID` y `GOOGLE_OAUTH_CLIENT_SECRET` — desde https://console.cloud.google.com → APIs & Services → Credentials → tu OAuth 2.0 Client.
- En "Authorized redirect URIs" agrega: `https://TU_PROJECT_REF.supabase.co/functions/v1/calendar-oauth-callback`

### Web Push (VAPID)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`  
  Genera nuevos con `npx web-push generate-vapid-keys`. El subject es un `mailto:tu@email.com`.  
  ⚠️ Si cambias estas keys, **todos los `push_subscriptions` existentes se invalidan** y los usuarios deben volver a aceptar notificaciones.

## Variables de aplicación (DB settings — antes de desplegar)

Necesarias para que el trigger `notify_send_push` llame a la edge function:

```sql
-- Generar un secreto nuevo (no reuses el anterior):
-- openssl rand -hex 32
ALTER DATABASE postgres
  SET app.settings.send_push_url = 'https://TU_PROJECT_REF.supabase.co/functions/v1/send-push';
ALTER DATABASE postgres
  SET app.settings.push_trigger_secret = 'TU_NUEVO_SECRETO_HEX_64_CHARS';
```

Y luego agrega `PUSH_TRIGGER_SECRET` como secret de Edge Functions con el mismo valor.

## Resumen — checklist de secrets a configurar

```bash
supabase secrets set \
  SUPABASE_SERVICE_ROLE_KEY=... \
  LOVABLE_API_KEY=... \
  GOOGLE_OAUTH_CLIENT_ID=... \
  GOOGLE_OAUTH_CLIENT_SECRET=... \
  VAPID_PUBLIC_KEY=... \
  VAPID_PRIVATE_KEY=... \
  VAPID_SUBJECT=mailto:... \
  PUSH_TRIGGER_SECRET=...
```

(SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_DB_URL, SUPABASE_PUBLISHABLE_KEY los inyecta Supabase automáticamente en las edge functions — no necesitas setearlos.)
