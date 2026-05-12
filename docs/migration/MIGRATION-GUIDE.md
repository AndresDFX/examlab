# Migración del Supabase de Lovable Cloud a un Supabase propio

Esta guía documenta el proceso completo para mover la base de datos, los
usuarios y las edge functions desde el Supabase gestionado por Lovable
Cloud hacia un proyecto Supabase propio sobre el que tienes control
administrativo.

El frontend sigue corriendo en Lovable — solo cambia el backend al que
apunta. El switch se hace cambiando 5 variables de entorno en el panel
de Lovable. Es reversible (rollback en <5 min).

---

## Por qué migrar

Casos típicos para hacerlo:

- Necesitas acceso al dashboard de Supabase (Lovable no lo expone).
- Quieres configurar Edge Function Secrets, RLS policies, extensions o
  webhooks que Lovable no permite tocar.
- Te quieres independizar de Lovable Cloud o moverte a otra plataforma.

---

## Pre-requisitos

- **Docker Desktop** corriendo (toda la migración corre en un container).
- Cuenta en https://supabase.com con un proyecto vacío creado.
- Acceso al repo de la app con permisos para hacer push.

NO necesitas tener `psql`, `bun`, ni el `supabase` CLI instalados
localmente — todo va dentro del container.

---

## Paso 1 — Generar el dump desde Lovable

Lovable no expone un botón de export, pero Lovable acepta prompts que
ejecuta contra la DB del proyecto. Hay que pedirle que use `pg_dump` y
te entregue los archivos.

**Prompt a usar dentro del chat de Lovable** (copia/pega):

```
Necesito un backup completo de mi base de datos para migrar a otro
Supabase del que tengo control. Por favor:

1. Hacer pg_dump del esquema `public` con datos.
2. Hacer pg_dump del esquema `public` solo con estructura (sin datos).
3. Listar los buckets de Storage que existen (id, name, public flag,
   file_size_limit).
4. Generar dos documentos de referencia:
   - README.md explicando cómo aplicar el backup en otro proyecto
     Supabase (qué archivos, en qué orden, qué se restaura y qué NO).
   - VARIABLES.md listando dónde obtener cada variable de entorno del
     nuevo proyecto (anon key, service_role, JWT secret, etc.).

Empaquetar todo en una carpeta `backup/` con:
- full_public.sql (estructura + datos)
- schema_public.sql (solo estructura)
- data_public.sql (solo datos)
- storage_buckets.csv
- README.md
- VARIABLES.md
- examlab-db-backup.tar.gz (archivo comprimido)

Importante: NO incluir auth.users en el dump — esa tabla requiere
permisos especiales y se migra aparte vía admin API.
```

Lovable genera la carpeta y la pone disponible para descargar. Bájalas
todas a `backup/` del repo local. Ese directorio está ignorado por git
(porque `full_public.sql` contiene datos personales).

> El archivo crítico para el restore es **`backup/full_public.sql`**.
> Los `.md` ya están movidos a `docs/migration/README-backup.md` y
> `docs/migration/VARIABLES-backup.md` para referencia.

---

## Paso 2 — Crear el nuevo proyecto Supabase

En https://supabase.com/dashboard → `New project`:

1. Elegir organización, nombre, región (cerca de tus usuarios).
2. Generar una DB password fuerte y **guardarla** — la necesitas en
   el siguiente paso.
3. Esperar a que el proyecto quede en `ACTIVE_HEALTHY`.

Una vez listo, anota estos valores del dashboard:

| Valor | Dónde está |
|---|---|
| **Project Ref** | URL del dashboard (ej. `abcdef123456789`) |
| **DB password** | La que generaste arriba |
| **anon key** | Project Settings → API → `anon` `public` |
| **service_role key** | Project Settings → API → `service_role` (⚠️ secret) |
| **Personal Access Token** | https://supabase.com/dashboard/account/tokens → `Generate new token`. Empieza con `sbp_...` |
| **Connection string (Session pooler)** | Project Settings → Database → Connection string → tab **`Session pooler`** (puerto 5432). NO uses Direct connection (solo IPv6) ni Transaction pooler (puerto 6543). |

---

## Paso 3 — Configurar `docker/restore.env`

Copia el template y llena con los valores del paso 2:

```powershell
Copy-Item docker/restore.env.example docker/restore.env
notepad docker/restore.env
```

Llena al menos:

```
NEW_SUPABASE_PROJECT_REF=<ref del paso 2>
NEW_SUPABASE_DB_URL=<connection string del Session pooler con la password embebida>
NEW_SUPABASE_SERVICE_ROLE_KEY=<service_role del paso 2>
NEW_SUPABASE_ACCESS_TOKEN=<personal access token sbp_...>
```

El `NEW_SUPABASE_DB_URL` debe tener la forma:

```
postgresql://postgres.<ref>:<password>@aws-X-<region>.pooler.supabase.com:5432/postgres
```

Si la URL apunta a `db.<ref>.supabase.co`, NO es del pooler — repítelo
con el tab `Session pooler`.

> El archivo `docker/restore.env` está cubierto por `.gitignore` (patrón
> `.env.*`), no se commitea.

---

## Paso 4 — Ejecutar el restore con Docker

Un solo comando:

```powershell
.\scripts\restore.ps1
```

Construye la imagen (3-5 min la primera vez), corre el container y
ejecuta 5 pasos:

1. **Smoke test de conexión** — verifica que la DB del nuevo Supabase
   responde.
2. **Pre-create `auth.users` desde el dump** — parsea
   `backup/full_public.sql`, extrae todos los UUIDs referenciados por
   FKs a `auth.users(id)` (no solo `profiles.id`) y los crea en el
   nuevo proyecto preservando los UUIDs.
   - Para UUIDs presentes en `public.profiles` → usa el email
     institucional real + full_name.
   - Para UUIDs huérfanos (sin profile correspondiente) → crea un user
     stub con email `orphan-<uuid8>@migrated.local`.
   - Todos los users quedan con password temporal **`Temporal#123456`**.
3. **Restore SQL + GRANTs** — DROP SCHEMA public CASCADE + restore
   completo del dump + GRANTs estándar de Supabase para los roles
   `anon`, `authenticated`, `service_role`.
4. **Crear buckets de Storage** — `workshop-files`, `project-files`,
   `generated-contents` con los límites de tamaño correctos.
5. **(Skip por default)** — el paso de migrar users desde
   `public.profiles` ahora es redundante porque el paso 2 ya creó todos
   los users. Solo se corre con `SKIP_MIGRATE_USERS=false` explícito.
6. **Deploy de edge functions** — itera `supabase/functions/*` saltando
   `_shared` y despliega cada una al nuevo proyecto. Usa un `config.toml`
   mínimo en `/tmp/sb-deploy/` para evitar que el CLI rechace claves
   viejas del config.toml del workspace.

Tiempo total: **7-10 min**.

### Toggles para re-correr partes

```powershell
.\scripts\restore.ps1 -SkipRestore         # Solo users + edge fns
.\scripts\restore.ps1 -SkipMigrateUsers    # Restore + edge fns (sin tocar users)
.\scripts\restore.ps1 -SkipDeployFn        # Restore + users (sin deploy de fns)
.\scripts\restore.ps1 -DryRunUsers         # Migra users en dry-run (no escribe)
.\scripts\restore.ps1 -Rebuild             # Fuerza rebuild de la imagen Docker
```

---

## Paso 5 — Configuración post-restore en el dashboard

El script no puede tocar estas cosas (requieren UI del dashboard).

### 5.1 Auth — URL Configuration

Dashboard → **`Authentication`** → **`URL Configuration`**:

- **Site URL**: URL pública de Lovable (ej. `https://examlab.lovable.app`).
- **Redirect URLs**: `https://examlab.lovable.app/**` y `http://localhost:3000/**`.

### 5.2 Edge Function Secrets

Dashboard → **`Edge Functions`** → **`Secrets`** → `Add new secret` para
cada uno:

| Secret | Valor |
|---|---|
| `LOVABLE_API_KEY` | Lovable → Settings → API Keys |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Cloud Console → tu OAuth client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | idem |
| `VAPID_PUBLIC_KEY` | Reutiliza los del viejo, o regenera con `npx web-push generate-vapid-keys` |
| `VAPID_PRIVATE_KEY` | idem |
| `VAPID_SUBJECT` | `mailto:tu@email.com` |
| `PUSH_TRIGGER_SECRET` | **Lee el valor desde `public.push_config.trigger_secret`** (ver 5.3) |

### 5.3 Tabla `push_config`

Esta app NO usa `ALTER DATABASE SET app.settings.*` (Supabase lo bloquea
sin superuser). En su lugar, el trigger `notify_send_push()` lee de la
tabla `public.push_config` (singleton, id=1).

El restore migró la fila pero apunta al Supabase viejo. Hay que
actualizarla con la URL del nuevo + (opcional) regenerar el secret.

**SQL Editor** → New query:

```sql
-- Ver el secret actual (lo necesitas para pegarlo en Edge Function Secrets)
SELECT send_push_url, trigger_secret FROM public.push_config WHERE id = 1;

-- Actualizar la URL al nuevo Supabase (manten el trigger_secret si lo
-- vas a reutilizar; si quieres uno nuevo, generalo con
-- `openssl rand -hex 32` y pega aqui Y en Edge Function Secrets):
UPDATE public.push_config
SET send_push_url = 'https://<NEW_REF>.supabase.co/functions/v1/send-push',
    updated_at = now()
WHERE id = 1;
```

Después, en Edge Function Secrets (paso 5.2), pon el valor de
`trigger_secret` como `PUSH_TRIGGER_SECRET`. Los dos lados deben
coincidir.

### 5.4 Trigger `on_auth_user_created`

El dump no incluye triggers en el schema `auth` (pg_dump no tiene
permisos). Sin este trigger, los users nuevos creados desde la app no
generan automáticamente su fila en `public.profiles`.

**SQL Editor**:

```sql
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
```

Si te da `permission denied`, escribir un issue — algunos planes de
Supabase bloquean triggers en `auth.*` y hay que usar un webhook de Auth.

### 5.5 Arreglar profiles huérfanos (opcional)

Si entre el restore y la creación del trigger, alguien creó users desde
la app, esos users quedaron sin profile. Para repararlos:

```sql
INSERT INTO public.profiles (id, full_name, personal_email, institutional_email)
SELECT
  au.id,
  COALESCE(au.raw_user_meta_data->>'full_name', split_part(au.email, '@', 1)),
  au.raw_user_meta_data->>'personal_email',
  COALESCE(au.raw_user_meta_data->>'institutional_email', au.email)
FROM auth.users au
LEFT JOIN public.profiles p ON p.id = au.id
WHERE p.id IS NULL;
```

### 5.6 Google Cloud Console — redirect URI del nuevo proyecto

https://console.cloud.google.com → APIs & Services → Credentials →
tu OAuth 2.0 Client → `Authorized redirect URIs` → `Add URI`:

```
https://<NEW_REF>.supabase.co/functions/v1/calendar-oauth-callback
```

NO borres la URI vieja todavía — sirve para rollback inmediato.

---

## Paso 6 — Configurar GitHub Actions para deploys futuros

Después de migrar, **Lovable solo despliega el frontend**. Las edge
functions y las migrations SQL las aplica GitHub Actions automáticamente
en cada push a `main`. Hay dos workflows separados:

| Workflow | Trigger | Qué hace |
|---|---|---|
| [deploy-edge-functions.yml](../../.github/workflows/deploy-edge-functions.yml) | Cada push a `main` | Desplega todas las edge functions del repo (idempotente). Toggle manual para `prune_orphaned` (borrar funciones que ya no están en el repo). |
| [apply-migrations.yml](../../.github/workflows/apply-migrations.yml) | Push a `main` que toque `supabase/migrations/**` | `supabase db push` contra el proyecto destino. Idempotente — solo aplica migrations nuevas (las que no están en `supabase_migrations.schema_migrations` del remoto). Soporta dry-run manual. |

### Secrets a configurar en GitHub

GitHub → tu repo → **`Settings`** → **`Secrets and variables`** →
**`Actions`**. Necesitas estos 3:

| Secret | Valor | Usado por |
|---|---|---|
| `SUPABASE_PROJECT_REF` | Ref del nuevo proyecto (subdominio, ej. `uxxpzfsfcnqiwwdxoelm`) | Ambos workflows |
| `SUPABASE_ACCESS_TOKEN` | Personal Access Token (`sbp_...`) desde https://supabase.com/dashboard/account/tokens | deploy-edge-functions |
| `SUPABASE_DB_URL` | Connection string del **Session Pooler** (puerto 5432). El mismo formato del `NEW_SUPABASE_DB_URL` que usaste en `docker/restore.env`. Formato: `postgresql://postgres.<ref>:<password>@aws-X-<region>.pooler.supabase.com:5432/postgres` | apply-migrations |

> ⚠️ Para `SUPABASE_DB_URL` usar el **Session Pooler**, NO la Direct
> connection (`db.<ref>.supabase.co`) — esa solo funciona con IPv6 y
> GitHub Actions no la alcanza.

Desde ese momento, cada `git push origin main`:
1. Despliega las edge functions (~3-4 min).
2. Si tocaste `supabase/migrations/**`, aplica las nuevas (~30 seg).

---

## Paso 7 — Switch en Lovable Cloud

En el panel de variables de entorno de Lovable (NO en el `.env` del
repo — Lovable usa sus propias env vars):

| Variable | Valor nuevo |
|---|---|
| `SUPABASE_URL` | `https://<NEW_REF>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | anon key del nuevo |
| `VITE_SUPABASE_URL` | `https://<NEW_REF>.supabase.co` |
| `VITE_SUPABASE_PROJECT_ID` | `<NEW_REF>` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | anon key del nuevo (mismo valor que `SUPABASE_PUBLISHABLE_KEY`) |
| `VITE_VAPID_PUBLIC_KEY` | igual que la vieja si reutilizas, o la nueva si regeneraste |

Click **`Publish`** en Lovable. ~30 segundos después, el frontend ya
está apuntando al nuevo Supabase.

---

## Paso 8 — Validar

1. Abre la URL de Lovable.
2. Haz login con un usuario existente + password `Temporal#123456`.
3. Verifica:
   - Ves tus cursos / exámenes / talleres / proyectos.
   - Las notificaciones llegan (si hay alguna activa).
   - El admin puede crear nuevos users → aparecen en `profiles`.

Si todo OK → migración exitosa. Avisa a los usuarios el nuevo password
temporal y que lo cambien en su perfil.

---

## Rollback

Si algo falla en producción y necesitas volver al Supabase viejo:

1. En Lovable, revertir las 5-6 variables a los valores viejos (ref
   `xrgqhrqsorknplzegffr`).
2. Click `Publish`.

~30 segundos después el frontend vuelve al Supabase viejo, con todos
sus datos intactos.

**Importante**: los datos que se escribieron en el nuevo Supabase
durante el período de prueba (logins, exámenes, etc.) quedan SOLO en
el nuevo. Si rollback, no aparecen en el viejo. Por eso conviene
hacer el switch en horario de bajo tráfico para minimizar el limbo.

---

## Limitaciones conocidas

| Cosa | Status | Workaround |
|---|---|---|
| Passwords originales | NO se migran (admin API no expone hashes) | Todos los users quedan con `Temporal#123456`. Cambiar en primer login. |
| Sesiones activas | NO se migran | Los users tienen que volver a hacer login. |
| Triggers en `auth.*` | NO están en el dump (permisos) | Recrear manualmente (paso 5.4). |
| GRANTs originales del schema public | NO están en el dump | El script los re-aplica con valores estándar de Supabase. |
| Archivos de Storage | NO se copian (solo se crean los buckets vacíos) | Si los necesitas, copiar con script de Storage API. La app sigue funcionando con buckets vacíos — los archivos nuevos se suben al nuevo bucket. |

---

## Archivos relevantes

| Archivo | Para qué |
|---|---|
| [docker/restore.Dockerfile](../../docker/restore.Dockerfile) | Imagen Debian con psql 17 + bun + Supabase CLI |
| [docker/restore.sh](../../docker/restore.sh) | Script bash que orquesta los 5 pasos del restore |
| [docker/restore.env.example](../../docker/restore.env.example) | Template de configuración (copiar a `restore.env`) |
| [scripts/restore.ps1](../../scripts/restore.ps1) | Wrapper PowerShell que arma el `docker run` |
| [scripts/pre-create-users-from-dump.ts](../../scripts/pre-create-users-from-dump.ts) | Script TypeScript (corre en bun) que extrae UUIDs del dump y crea auth.users |
| [.github/workflows/deploy-edge-functions.yml](../../.github/workflows/deploy-edge-functions.yml) | Pipeline de deploy automático de edge functions en push a main |
| [docs/migration/README-backup.md](README-backup.md) | README original que generó Lovable explicando el contenido del dump |
| [docs/migration/VARIABLES-backup.md](VARIABLES-backup.md) | Listado original de variables de entorno requeridas |
