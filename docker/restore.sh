#!/usr/bin/env bash
# Orquestador del restore completo a un Supabase nuevo.
#
# Se ejecuta DENTRO del container construido con docker/restore.Dockerfile.
# El host invoca esto vía scripts/restore.ps1 (o equivalente), que monta
# el repo en /workspace y pasa las env vars necesarias.
#
# Pasos:
#   1. Validar env vars y conexión.
#   2. DROP SCHEMA public + restore desde backup/full_public.sql.
#   3. Crear los 3 buckets de Storage.
#   4. Migrar auth.users desde public.profiles (preserva UUIDs, password
#      temporal Temporal#123456 por default).
#   5. Desplegar edge functions al nuevo proyecto.
#
# Toggles opcionales (env vars en el docker run):
#   SKIP_RESTORE=true       Saltar pasos 2-3 (solo migrar users + deploy fn).
#   SKIP_MIGRATE_USERS=true Saltar paso 4.
#   SKIP_DEPLOY_FN=true     Saltar paso 5.
#   DRY_RUN_USERS=true      Migrar users en modo dry-run (no escribe nada).
#   DEFAULT_PASSWORD=...    Password temporal de los users (default Temporal#123456).
set -euo pipefail

# ─────────────────────────────────────────────────────────────────
# Validar env vars
# ─────────────────────────────────────────────────────────────────
# Required siempre: ref, service_role, access_token.
# Para la conexion a DB hay dos modos:
#   A) NEW_SUPABASE_DB_URL — connection string completa (recomendado).
#   B) NEW_SUPABASE_DB_PASSWORD + NEW_SUPABASE_REGION — el script la arma.
# El modo A es mas robusto porque la regla del hostname del pooler ha
# cambiado entre proyectos (a veces es aws-0-..., a veces aws-1-...).
required=(
  NEW_SUPABASE_PROJECT_REF
  NEW_SUPABASE_SERVICE_ROLE_KEY
  NEW_SUPABASE_ACCESS_TOKEN
)
missing=0
for v in "${required[@]}"; do
  if [ -z "${!v:-}" ]; then
    echo "ERROR: Falta env var $v" >&2
    missing=$((missing + 1))
  fi
done
[ $missing -eq 0 ] || exit 1

# Tolerar que el usuario pegue la URL completa o solo el ref.
# Ej: "https://abcdef.supabase.co" o "abcdef.supabase.co" -> "abcdef"
NEW_SUPABASE_PROJECT_REF="${NEW_SUPABASE_PROJECT_REF#https://}"
NEW_SUPABASE_PROJECT_REF="${NEW_SUPABASE_PROJECT_REF#http://}"
NEW_SUPABASE_PROJECT_REF="${NEW_SUPABASE_PROJECT_REF%%/*}"
NEW_SUPABASE_PROJECT_REF="${NEW_SUPABASE_PROJECT_REF%.supabase.co}"

# Sanidad: el ref debe ser alfanumerico, 20 chars aprox.
if ! echo "$NEW_SUPABASE_PROJECT_REF" | grep -qE '^[a-z0-9]{15,30}$'; then
  echo "ERROR: NEW_SUPABASE_PROJECT_REF no parece valido tras normalizar: '$NEW_SUPABASE_PROJECT_REF'" >&2
  exit 1
fi

NEW_URL="https://${NEW_SUPABASE_PROJECT_REF}.supabase.co"

# Construir DB_URL: preferir la pegada por el usuario; si no, armarla.
if [ -n "${NEW_SUPABASE_DB_URL:-}" ]; then
  DB_URL="$NEW_SUPABASE_DB_URL"
  echo "Usando NEW_SUPABASE_DB_URL del .env (modo A)."
elif [ -n "${NEW_SUPABASE_DB_PASSWORD:-}" ] && [ -n "${NEW_SUPABASE_REGION:-}" ]; then
  DB_URL="postgresql://postgres.${NEW_SUPABASE_PROJECT_REF}:${NEW_SUPABASE_DB_PASSWORD}@aws-0-${NEW_SUPABASE_REGION}.pooler.supabase.com:5432/postgres"
  echo "Construyendo DB_URL desde REF + REGION + PASSWORD (modo B)."
else
  echo "ERROR: Necesitas NEW_SUPABASE_DB_URL (modo A, recomendado) o" >&2
  echo "       NEW_SUPABASE_DB_PASSWORD + NEW_SUPABASE_REGION (modo B)." >&2
  exit 1
fi

# Validar que el connection string sea del POOLER, no la direct connection.
# La direct (db.<ref>.supabase.co:5432) solo funciona via IPv6 en free tier
# y Docker no lo soporta por default — falla con "Network is unreachable".
# El pooler vive en aws-N-<region>.pooler.supabase.com.
if echo "$DB_URL" | grep -qE '@db\.[a-z0-9]+\.supabase\.co'; then
  echo "ERROR: Pegaste la 'Direct connection' (db.<ref>.supabase.co)." >&2
  echo "       Esa solo funciona con IPv6 y Docker no la alcanza." >&2
  echo "" >&2
  echo "       Necesitas el 'Session Pooler' o 'Session mode':" >&2
  echo "       Dashboard del nuevo Supabase -> Project Settings -> Database" >&2
  echo "       -> busca la seccion 'Session pooler' o 'Connect via pooler" >&2
  echo "       (Session mode)'. El host correcto se ve asi:" >&2
  echo "         aws-0-<region>.pooler.supabase.com  o" >&2
  echo "         aws-1-<region>.pooler.supabase.com" >&2
  echo "       Puerto 5432 (NO 6543, que es Transaction)." >&2
  exit 1
fi
if ! echo "$DB_URL" | grep -qE 'pooler\.supabase\.com'; then
  echo "WARN: El host del DB_URL no es '*.pooler.supabase.com'. Puede que" >&2
  echo "      la conexion falle. Si falla, busca 'Session pooler' en el" >&2
  echo "      dashboard del nuevo Supabase y copia esa URI." >&2
fi

echo "═══════════════════════════════════════════════════════════"
echo " Restore completo → ${NEW_URL}"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ─────────────────────────────────────────────────────────────────
# Paso 1: smoke test
# ─────────────────────────────────────────────────────────────────
echo "[1/5] Smoke test de conexión..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "SELECT current_database() AS db, version();" >/dev/null
echo "      OK"
echo ""

# ─────────────────────────────────────────────────────────────────
# Paso 2-3: restore + buckets (saltable con SKIP_RESTORE=true)
# ─────────────────────────────────────────────────────────────────
if [ "${SKIP_RESTORE:-false}" = "true" ]; then
  echo "[2/5] Restore SALTADO (SKIP_RESTORE=true)"
  echo "[3/5] Buckets SALTADOS"
else
  if [ ! -f backup/full_public.sql ]; then
    echo "ERROR: No existe backup/full_public.sql (¿se montó /workspace correctamente?)" >&2
    exit 1
  fi
  lines=$(wc -l < backup/full_public.sql)
  # ─── Pre-paso: crear auth.users desde el dump ────────────────
  # Antes del restore necesitamos que auth.users tenga los UUIDs que
  # referencian las FKs del dump (ai_prompts.updated_by, courses.created_by,
  # etc.). El rol del pooler de Supabase no permite deshabilitar FK checks
  # con session_replication_role=replica, asi que la solucion es
  # poblar auth.users PRIMERO leyendo los profiles directamente del .sql.
  echo "[2a/5] Pre-creando auth.users desde el dump..."
  mkdir -p /tmp/migrate-deps
  cp scripts/pre-create-users-from-dump.ts /tmp/migrate-deps/pre-create.ts
  (cd /tmp/migrate-deps && \
    TARGET_SUPABASE_URL="$NEW_URL" \
    TARGET_SUPABASE_SERVICE_ROLE_KEY="$NEW_SUPABASE_SERVICE_ROLE_KEY" \
    DUMP_FILE="/workspace/backup/full_public.sql" \
    DEFAULT_PASSWORD="${DEFAULT_PASSWORD:-Temporal#123456}" \
    DRY_RUN="${DRY_RUN_USERS:-false}" \
    bun run pre-create.ts)
  echo ""

  echo "[2b/5] Restore desde backup/full_public.sql ($lines lineas)..."
  echo "      DROP SCHEMA public CASCADE..."
  psql "$DB_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE;" >/dev/null
  echo "      Aplicando dump (~1-3 min)..."
  psql "$DB_URL" -v ON_ERROR_STOP=1 -f backup/full_public.sql >/tmp/restore.log 2>&1 || {
    echo "ERROR en restore. Ultimas 80 lineas:" >&2
    tail -80 /tmp/restore.log >&2
    exit 1
  }
  tablas=$(psql "$DB_URL" -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public';")
  echo "      OK — $tablas tablas creadas en public"

  # Re-aplicar GRANTs de los roles estandar de Supabase sobre public.
  # El dump no incluye GRANTs, asi que cuando se hace DROP+CREATE del
  # schema, los permisos quedan restrictivos por default. Sin estos
  # grants, ni PostgREST ni la app pueden leer las tablas (aunque
  # tengan policies de RLS). Reproducimos lo que Supabase configura
  # automaticamente en un proyecto fresco.
  echo "      Aplicando GRANTs de Supabase (anon, authenticated, service_role)..."
  psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
    GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
SQL
  echo "      OK"

  # Baseline: marca las migrations existentes en supabase/migrations/*
  # como "ya aplicadas" en supabase_migrations.schema_migrations. Sin
  # esto, el workflow apply-migrations.yml intenta re-aplicarlas y falla
  # con "type already exists" porque el dump ya creo todos los objetos.
  if [ -f docs/migration/baseline-migrations.sql ]; then
    echo "      Aplicando baseline-migrations.sql (marcar migrations como aplicadas)..."
    psql "$DB_URL" -v ON_ERROR_STOP=1 -f docs/migration/baseline-migrations.sql >/dev/null
    marcadas=$(psql "$DB_URL" -tAc "SELECT count(*) FROM supabase_migrations.schema_migrations;")
    echo "      OK — $marcadas migrations marcadas como aplicadas"
  else
    echo "      WARN: no existe docs/migration/baseline-migrations.sql — saltando baseline."
    echo "      Si despues corres 'supabase db push' va a intentar re-aplicar todo y fallar."
  fi
  echo ""

  echo "[3/5] Creando buckets de Storage..."
  psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
    INSERT INTO storage.buckets (id, name, public, file_size_limit)
    VALUES
      ('workshop-files', 'workshop-files', false, 52428800),
      ('project-files', 'project-files', false, 10485760),
      ('generated-contents', 'generated-contents', false, 52428800)
    ON CONFLICT (id) DO NOTHING;
SQL
  buckets=$(psql "$DB_URL" -tAc "SELECT count(*) FROM storage.buckets;")
  echo "      OK — $buckets buckets totales en storage"
fi
echo ""

# ─────────────────────────────────────────────────────────────────
# Paso 4: migrar auth.users (saltable con SKIP_MIGRATE_USERS=true)
# ─────────────────────────────────────────────────────────────────
# Por default, el paso 4 esta SKIP porque el paso 2a (pre-create) ya
# creo todos los users referenciados desde el dump. El paso 4 solo se
# corre si SKIP_MIGRATE_USERS=false (override explicito); util si en
# algun escenario el pre-create se salto (SKIP_RESTORE=true).
if [ "${SKIP_MIGRATE_USERS:-true}" = "true" ]; then
  echo "[4/5] Migración de users SALTADA (ya hecha por paso 2a)"
else
  echo "[4/5] Migrando auth.users desde public.profiles..."
  # Trabajamos en /tmp/migrate-deps con SOLO lo necesario (package.json
  # + el script). Así evitamos chocar con el node_modules del host (que
  # en Windows puede tener binarios .dll/.exe inutilizables en Linux)
  # y solo instalamos @supabase/supabase-js — no las 200 deps del repo.
  mkdir -p /tmp/migrate-deps
  cp scripts/migrate-users.ts /tmp/migrate-deps/migrate-users.ts
  if [ ! -d /tmp/migrate-deps/node_modules/@supabase/supabase-js ]; then
    echo "      Instalando @supabase/supabase-js (1ª vez)..."
    (cd /tmp/migrate-deps && bun add @supabase/supabase-js@^2.103.3 >/dev/null 2>&1)
  fi
  (cd /tmp/migrate-deps && \
    TARGET_SUPABASE_URL="$NEW_URL" \
    TARGET_SUPABASE_SERVICE_ROLE_KEY="$NEW_SUPABASE_SERVICE_ROLE_KEY" \
    DRY_RUN="${DRY_RUN_USERS:-false}" \
    DEFAULT_PASSWORD="${DEFAULT_PASSWORD:-Temporal#123456}" \
    bun run migrate-users.ts)
fi
echo ""

# ─────────────────────────────────────────────────────────────────
# Paso 5: desplegar edge functions (saltable con SKIP_DEPLOY_FN=true)
# ─────────────────────────────────────────────────────────────────
if [ "${SKIP_DEPLOY_FN:-false}" = "true" ]; then
  echo "[5/5] Deploy de edge functions SALTADO (SKIP_DEPLOY_FN=true)"
else
  echo "[5/5] Desplegando edge functions a $NEW_SUPABASE_PROJECT_REF..."
  export SUPABASE_ACCESS_TOKEN="$NEW_SUPABASE_ACCESS_TOKEN"

  # El supabase/config.toml del repo tiene claves de una version vieja
  # del CLI que la actual rechaza ('realtime.max_bytes_per_second',
  # 's3_access_key', etc.). Como no queremos modificar el config del
  # workspace, armamos un dir temporal con:
  #   - symlink a supabase/functions (donde estan _shared + cada fn)
  #   - un config.toml minimo que mantiene los overrides relevantes
  #     (verify_jwt=false para calendar-oauth-callback y send-push).
  echo "      Preparando config minimo en /tmp/sb-deploy..."
  rm -rf /tmp/sb-deploy
  mkdir -p /tmp/sb-deploy/supabase
  ln -sfn /workspace/supabase/functions /tmp/sb-deploy/supabase/functions
  cat > /tmp/sb-deploy/supabase/config.toml <<EOF
project_id = "$NEW_SUPABASE_PROJECT_REF"

[functions.calendar-oauth-callback]
verify_jwt = false

[functions.send-push]
verify_jwt = false
EOF

  cd /tmp/sb-deploy
  deployed=0
  failed=0
  for dir in supabase/functions/*/; do
    name="$(basename "$dir")"
    # Saltar carpetas auxiliares (_shared, etc.).
    case "$name" in _*) echo "      Skipping helper: $name"; continue;; esac
    echo "      ═══ Deploying: $name ═══"
    if supabase functions deploy "$name" --project-ref "$NEW_SUPABASE_PROJECT_REF" 2>&1 | sed 's/^/        /'; then
      deployed=$((deployed + 1))
    else
      failed=$((failed + 1))
      echo "      WARN: deploy de $name falló — seguimos con los demás."
    fi
  done
  cd /workspace
  echo ""
  echo "      Resumen: $deployed desplegadas, $failed fallidas"
  [ $failed -gt 0 ] && echo "      ⚠️ Hubo fallos — revisa logs arriba." || true
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Restore completado"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo " Pendientes manuales en el dashboard del nuevo Supabase:"
echo "  - Authentication → URL Configuration → Site URL + Redirect URLs"
echo "  - Edge Functions → Manage secrets → LOVABLE_API_KEY,"
echo "    GOOGLE_OAUTH_*, VAPID_*, PUSH_TRIGGER_SECRET"
echo "  - SQL Editor → ALTER DATABASE postgres SET app.settings.*"
echo "  - Google Cloud Console → redirect URI del nuevo proyecto"
echo ""
echo " Después: cambiar VITE_SUPABASE_* en Lovable Cloud + Publish."
