# Cron jobs y scripts post-migración

Esta carpeta contiene scripts SQL para **programar/desprogramar** los
jobs de `pg_cron` que ExamLab usa, junto con cualquier script
**idempotente** que deba ejecutarse después de las migraciones (p.ej.
configurar extensiones, registrar jobs).

Las **definiciones de las funciones SQL** que esos jobs llaman viven en
`supabase/migrations/` — son parte del schema y se aplican
automáticamente con `Apply DB Migrations`.

Los scripts de **scheduling** (este folder) son operacionales: separados
del flujo de migraciones porque pg_cron no permite re-programar
idempotentemente sin desprogramar primero, y porque queremos correrlos
SOLO cuando cambian (no en cada deploy del frontend).

## Pipeline CI

Workflow: [`.github/workflows/cron-deploy.yml`](../../.github/workflows/cron-deploy.yml)

### Trigger automático (push)

Cuando un commit a `main` modifica:
- `supabase/cron/setup.sql`
- `supabase/cron/teardown.sql`
- `.github/workflows/cron-deploy.yml`

→ corre `setup.sql` automáticamente en producción.

### Trigger manual (workflow_dispatch)

Desde GitHub Actions → **Cron — Setup / Teardown / Verify** → **Run workflow**:

| Acción | Para qué |
|---|---|
| `setup` | (Re)programar todos los jobs según `setup.sql` |
| `teardown` | Desprogramar todo (vacaciones, debugging, migración) |
| `verify` | Solo listar el estado actual de `cron.job` |

Los 3 modos requieren el secret `SUPABASE_DB_URL` en GitHub
(Session Pooler, no direct connection).

### Idempotencia

`setup.sql` usa el patrón `unschedule WHERE EXISTS + schedule` por job.
Corrérlo N veces es seguro — solo re-aplica lo que cambió.

## Jobs programados

| Job | Función SQL | Schedule (UTC) | Función definida en |
|---|---|---|---|
| `exam-reminders-1h` | `notify_students_exam_starting_soon(1)` | `*/10 * * * *` | 20260523000006 |
| `exam-window-opens` | `notify_students_exam_window_opens(30)` | `*/15 * * * *` | 20260516110000 |
| `workshop-due-24h` | `notify_students_workshop_due_soon(24)` | `0 */2 * * *` | 20260523000007 |
| `project-due-24h` | `notify_students_project_due_soon(24)` | `0 */2 * * *` | 20260523000007 |
| `teacher-exam-prep-1h` | `notify_teachers_pending_exam_notes_before_exam(1)` | `*/10 * * * *` | 20260523000008 |
| `teacher-daily-summary` | `notify_teachers_daily_summary()` | `0 4 * * *` (23:00 Colombia) | 20260523000008 |
| `admin-storage-threshold` | `notify_admins_storage_threshold()` | `0 */6 * * *` | 20260523000010 |
| `audit-logs-purge` | `purge_audit_logs()` | `0 3 1 * *` (mensual) | 20260517150000 |
| `email-alert-threshold` | `check_email_alert_threshold()` | `*/30 * * * *` | 20260518130000 |

## Agregar un nuevo job

1. Definí la función en una migración nueva en `supabase/migrations/...`
2. Agregá el bloque `cron.unschedule + cron.schedule` a [`setup.sql`](setup.sql)
3. Agregá el `cron.unschedule` correspondiente a [`teardown.sql`](teardown.sql)
4. Documenta el job en la tabla de arriba y en [`../../docs/CRON-JOBS.md`](../../docs/CRON-JOBS.md)
5. Commit + push a `main` → el workflow `cron-deploy.yml` re-corre `setup.sql` automáticamente

## Por qué pg_cron no va en migraciones

Si pusiéramos `cron.schedule(...)` en una migración normal:

- Falla en el 2° deploy con `job 'X' already exists`
- Si cambia el schedule entre versiones, queda inconsistente en remotos
  ya desplegados
- Un rollback de migración NO desprograma el cron — queda corriendo
  contra funciones que ya no existen

Mantener scheduling separado de schema migrations es la convención
estándar Postgres para evitar estos problemas.

---

# Troubleshooting

## Error: `duplicate key value violates unique constraint "schema_migrations_pkey"`

```
Applying migration 20260517100000_projects_cerrada_multi_and_zip_truncated.sql...
ERROR: duplicate key value violates unique constraint "schema_migrations_pkey"
Key (version)=(20260517100000) already exists.
```

**Causa**: el remoto ya tiene esa versión en `supabase_migrations.schema_migrations`
(la migración corrió antes) pero el CLI local no la marca como aplicada
y vuelve a intentar pushearla. Pasa cuando:
- Se modifica el contenido de un archivo de migración **después** de
  que se aplicó.
- Hubo un push parcial: las sentencias SQL corrieron pero falló el
  INSERT en schema_migrations.
- Se aplicó la migración manualmente en SQL Editor sin pasar por CLI.

### Resuelto en CI: psql directo + ON CONFLICT (ya activo)

Anteriormente el workflow usaba `supabase db push` con `migration repair`
para auto-reparar duplicados. Eso no funcionó: el CLI seguía listando
la versión "reparada" como pendiente y entraba en bucle infinito.

**La solución actual** ([`apply-migrations.yml`](../../.github/workflows/apply-migrations.yml))
bypassea el CLI para el apply real:

1. Lista las versiones aplicadas en remote vía `psql`
2. Por cada `.sql` local NO aplicado:
   - Lee el archivo
   - Lo envuelve en `BEGIN; <contenido>; INSERT INTO schema_migrations
     ... ON CONFLICT (version) DO NOTHING; COMMIT;`
   - Lo ejecuta con `psql -f tempfile`
3. Si hay error de SQL real, `ROLLBACK` y el job falla con el log de psql
4. Si la versión ya estaba registrada pero el SQL se re-aplicó, el
   `ON CONFLICT DO NOTHING` la deja sin tocar — sin error

Esto da idempotencia absoluta sin depender de cómo el CLI compare
hashes. La `version` (timestamp) es la PK; el contenido del `statements`
no importa.

### Fix manual (si necesitas correrlo desde tu máquina)

```bash
# Una sola línea, desde tu máquina con SUPABASE_DB_URL exportado.
supabase migration repair --status applied 20260517100000 \
  --db-url "$SUPABASE_DB_URL"
```

O directamente desde el SQL Editor:

```sql
-- Verifica primero qué hay en la tabla de tracking:
SELECT version, name FROM supabase_migrations.schema_migrations
 WHERE version = '20260517100000';

-- Si el SQL del archivo realmente se aplicó (objetos existen),
-- no hace falta nada. El próximo push del CLI debería saltearla.
-- Si el push sigue fallando, eliminá la fila duplicada (CON CUIDADO,
-- solo si confirmaste que los objetos del schema sí existen):
DELETE FROM supabase_migrations.schema_migrations
 WHERE version = '20260517100000';
```

## Error: `pg_cron extension not found`

`pg_cron` debe estar habilitado a mano una sola vez por proyecto:
**Dashboard → Database → Extensions → buscar `pg_cron` → Enable**.
Después corré `setup.sql` y los jobs se programan.

## Verificar estado de cron jobs

Desde el SQL Editor:

```sql
SELECT jobname, schedule, active,
       (SELECT status FROM cron.job_run_details r
          WHERE r.jobid = j.jobid
          ORDER BY start_time DESC LIMIT 1) AS last_status,
       (SELECT start_time FROM cron.job_run_details r
          WHERE r.jobid = j.jobid
          ORDER BY start_time DESC LIMIT 1) AS last_run
  FROM cron.job j
 ORDER BY jobname;
```

O desde la UI: **Admin → Sistema → Tareas programadas** (usa el RPC
`system_cron_jobs` definido en la migración `20260523000007`).
