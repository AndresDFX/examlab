# Tests SQL contra DB real

Esta carpeta contiene scripts SQL ejecutables con `psql` que validan
comportamiento que NO se puede probar con Vitest (porque corren contra
Postgres real con RLS activo).

## Tests disponibles

| Archivo | Qué valida |
|---|---|
| [`multitenant_isolation.sql`](multitenant_isolation.sql) | Aislamiento entre 2 tenants: cada user solo ve los suyos, Superadmin ve todos, suspended bloquea escrituras |

## Cómo correr

### Desde tu máquina (manual)

```bash
# Con la variable SUPABASE_DB_URL apuntando al Session Pooler:
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/multitenant_isolation.sql
```

Si todo OK, verás:
```
NOTICE:  ✓ ALL CHECKS PASSED — el aislamiento multitenant funciona
```

Si algo falla:
```
NOTICE:  ✗ FALLA: CHECK X FAILED: descripción
ERROR:   ...
```

El script siempre hace `ROLLBACK` al final (incluso ante fallo), así que
es **seguro correrlo contra producción** — no deja datos residuales.

### Desde el pipeline CI (sugerido)

Agregar un job al workflow de migraciones que corre los tests SQL tras
aplicar todas las migraciones. Si fallan, falla el deploy.

```yaml
# .github/workflows/apply-migrations.yml — agregar este step al final
- name: Tests de aislamiento multitenant
  if: ${{ github.event_name == 'push' || !inputs.dry_run }}
  run: |
    psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/multitenant_isolation.sql
```

## Qué prueba `multitenant_isolation.sql`

| Check | Qué valida |
|---|---|
| **1** | User A solo ve cursos de su tenant (no ve curso B) |
| **2** | User B solo ve cursos de su tenant (no ve curso A) |
| **3** | Superadmin ve cursos de AMBOS tenants |
| **4** | User A NO puede insertar curso en tenant B (RLS RESTRICTIVE) |
| **5** | Suspender tenant A bloquea escrituras de su admin |
| **6** | Helper `has_tenant_access()` retorna lo esperado para cada rol |
| **7** | Singletons (email_settings) sembrados automáticamente por tenant |

## Patrón para nuevos tests SQL

Si agregas tests propios:

1. Empieza con `BEGIN;` — toda la prueba en transacción
2. Crea datos sintéticos con prefijo `test-` para no chocar con producción
3. Usa `SET LOCAL ROLE authenticated` + `PERFORM set_config('request.jwt.claims', ...)` para simular un user
4. Usa `RAISE EXCEPTION` ante cualquier check fallido (aborta el script)
5. Usa `RAISE NOTICE '✓ CHECK X passed'` al pasar
6. Termina con `ROLLBACK;` SIEMPRE (no `COMMIT`) — los datos sintéticos se descartan

Plantilla:

```sql
BEGIN;
DO $$
DECLARE
  _setup_var UUID;
BEGIN
  -- Setup
  INSERT INTO ... RETURNING id INTO _setup_var;

  -- Simular user
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', _setup_var, 'role', 'authenticated')::text, true);

  -- Check
  IF (SELECT COUNT(*) FROM tabla WHERE algo) <> esperado THEN
    RAISE EXCEPTION 'CHECK X FAILED: ...';
  END IF;
  RAISE NOTICE '✓ CHECK X passed';

EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '✗ FALLA: %', SQLERRM;
  RAISE;
END $$;
ROLLBACK;
```
