# Backup de ExamLab — Restore en tu propio Supabase

Generado: 2026-05-12

## Contenido

| Archivo | Qué es |
|---|---|
| `full_public.sql` | **Dump completo del esquema `public`** (estructura + datos). Es el archivo principal para restaurar. |
| `schema_public.sql` | Solo estructura (tablas, funciones, triggers, RLS) del esquema `public`. |
| `data_public.sql` | Solo datos del esquema `public` (sin estructura). |
| `storage_buckets.csv` | Listado de buckets de Storage que debes recrear manualmente. |

> ⚠️ **No incluido:** datos de `auth.users` ni objetos de Storage. Estos esquemas son administrados por Supabase y requieren acceso de service role / admin API. Ver sección "Migrar usuarios" y "Migrar Storage" abajo.

---

## 1) Crear tu proyecto Supabase

1. Crea un proyecto nuevo en https://supabase.com/dashboard
2. Espera a que esté `ACTIVE_HEALTHY`.
3. Anota tu **Project Ref** (ej. `abcdefghijklmno`) y la **DB password** que elegiste.

## 2) Restaurar el esquema y datos

Desde tu terminal local con `psql` instalado:

```bash
# Reemplaza PROJECT_REF y DB_PASSWORD
export PGPASSWORD='tu-db-password'
psql "postgresql://postgres.PROJECT_REF:$PGPASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres" \
  -f full_public.sql
```

> Usa el host del **pooler en modo session (puerto 5432)**, no el de transaction (6543). Ese host lo encuentras en Supabase Dashboard → Project Settings → Database → Connection string → "Session mode".

Si ves errores tipo `extension already exists` o `function already exists`, son normales — el dump intenta crear extensiones que ya están instaladas.

## 3) Recrear los buckets de Storage

En el Dashboard → Storage → New bucket, crea estos 3 (todos privados):

- `workshop-files` — limit 50 MB
- `project-files` — limit 10 MB
- `generated-contents` — limit 50 MB

Luego ejecuta las policies de Storage que están en `supabase/migrations/` del proyecto (busca `storage.objects` con `rg`).

## 4) Migrar usuarios (auth.users)

`auth.users` no se exporta con pg_dump porque requiere privilegios reservados a Supabase. Opciones:

**Opción A — Manual:** registrar usuarios de cero en el nuevo proyecto. Las FKs en `public.profiles.id` y `public.user_roles.user_id` deben coincidir con los nuevos `auth.users.id`.

**Opción B — Programática:** desde un script con la **service_role key** del proyecto origen, listar usuarios con `supabase.auth.admin.listUsers()`, y en el destino crearlos con `supabase.auth.admin.createUser({ id, email, email_confirm: true, user_metadata })` preservando el mismo UUID. Así las FKs siguen siendo válidas.

**Opción C — Soporte Supabase:** Pro plan permite pedir migración asistida.

## 5) Migrar archivos de Storage

Descarga los objetos del bucket origen y súbelos al destino preservando rutas. Script ejemplo:

```ts
// origen → destino, por bucket
const { data: list } = await origen.storage.from('project-files').list('', { limit: 1000 });
for (const f of list) {
  const { data } = await origen.storage.from('project-files').download(f.name);
  await destino.storage.from('project-files').upload(f.name, data);
}
```

## 6) Configurar variables y secrets

Ver `VARIABLES.md` adjunto para el detalle de dónde obtener cada variable.

## 7) Desplegar Edge Functions

Desde la raíz del repo:

```bash
supabase link --project-ref TU_PROJECT_REF
supabase functions deploy --no-verify-jwt  # o por función
```

Y configurar los secrets equivalentes con `supabase secrets set NOMBRE=valor`.
