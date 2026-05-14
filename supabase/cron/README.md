# Cron jobs — setup operacional

Esta carpeta contiene los scripts SQL para **programar/desprogramar**
los jobs de `pg_cron` que ExamLab usa. Las **definiciones de las
funciones SQL** que esos jobs llaman viven en las migraciones — son
parte del schema y se aplican con cada deploy.

Los scripts de **scheduling** (este folder) son operacionales:
- Se ejecutan **una sola vez** después del primer deploy de un proyecto
  Supabase
- Se re-ejecutan **solo si querés cambiar el cron schedule** o agregar
  un job nuevo
- Son **idempotentes**: `setup.sql` desprograma todo primero y vuelve a
  programar — podés correrlo N veces sin riesgo de duplicar

## Cómo usarlo

### Setup (programar todos los jobs)

1. En Supabase Dashboard → `SQL Editor → New query`
2. Pegá el contenido completo de [`setup.sql`](setup.sql)
3. Run
4. Verifica con `SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;`

### Teardown (desprogramar todo)

Útil si querés pausar todos los recordatorios temporalmente (vacaciones,
testing, migración a otro provider de email):

1. Pegá [`teardown.sql`](teardown.sql) en el SQL Editor
2. Run
3. Los jobs quedan removidos. Las funciones SQL siguen existiendo —
   nada se pierde. Volvés a programar con `setup.sql` cuando quieras.

## Jobs incluidos

| Job | Función SQL | Schedule (UTC) | Migración que define la función |
|---|---|---|---|
| `exam-reminders-1h` | `notify_students_exam_starting_soon(1)` | `*/10 * * * *` | 20260523000006 |
| `workshop-due-24h` | `notify_students_workshop_due_soon(24)` | `0 */2 * * *` | 20260523000007 |
| `project-due-24h` | `notify_students_project_due_soon(24)` | `0 */2 * * *` | 20260523000007 |
| `teacher-exam-prep-1h` | `notify_teachers_pending_exam_notes_before_exam(1)` | `*/10 * * * *` | 20260523000008 |
| `teacher-daily-summary` | `notify_teachers_daily_summary()` | `0 4 * * *` (23:00 hora Colombia) | 20260523000008 |

## Convención

- **Las funciones SQL son parte del schema** — viven en `supabase/migrations/`
  y se aplican con cada deploy via Lovable o supabase CLI.
- **El scheduling es config operacional** — vive acá, se ejecuta una vez
  por entorno (dev, staging, prod), y nunca corre como parte de un deploy
  automático (porque pg_cron no permite re-programar idempotentemente
  sin desprogramar primero).

Si agregás una **función nueva** que tiene que ser cron job:
1. Definí la función en una migración nueva (`supabase/migrations/...`)
2. Agregá el `cron.unschedule(...) + cron.schedule(...)` correspondiente
   a [`setup.sql`](setup.sql)
3. Documenta el job en [`../../docs/CRON-JOBS.md`](../../docs/CRON-JOBS.md)
4. Corré `setup.sql` en cada entorno donde lo quieras activar

## Por qué no van en migraciones

Las migraciones se aplican automáticamente en cada deploy. Si pusiéramos
`cron.schedule(...)` ahí:

- Falla en el 2° deploy con "job 'X' already exists"
- O peor: si el schedule cambia entre versiones, queda inconsistente
- Probaste a hacer un rollback? El cron schedule no se va con el rollback

Mantener scheduling separado de schema migrations es la convención
estándar en Postgres para evitar estos problemas.
