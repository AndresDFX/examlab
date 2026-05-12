#!/usr/bin/env bash
# Regenera docs/migration/baseline-migrations.sql leyendo todas las
# migrations del repo (supabase/migrations/*.sql) y armando un INSERT
# bulk para marcarlas como "ya aplicadas" en la tabla de tracking del
# CLI de Supabase (supabase_migrations.schema_migrations).
#
# Cuando se usa:
#   Cuando se hace una migracion completa via dump+restore en lugar de
#   correr cada migration una a una, la DB queda con todos los objetos
#   creados pero la tabla schema_migrations vacia. La proxima vez que
#   `supabase db push` corre, intenta aplicar TODAS las migrations desde
#   el inicio y falla con "type already exists".
#
#   El baseline marca las migrations existentes como aplicadas (sin
#   ejecutarlas) para que el CLI solo intente aplicar las NUEVAS de aqui
#   en adelante.
#
# El script EXCLUYE migrations posteriores a una "barrera" (variable
# BARRIER_VERSION) — esas son las que SI queremos que se apliquen tras
# el restore (por ej. la que agrega 'gemini' al provider, que fue
# despues del dump).
#
# Uso:
#   scripts/baseline-migrations.sh
#   # O cambiar la barrera:
#   BARRIER_VERSION=20260601000000 scripts/baseline-migrations.sh
set -euo pipefail

# Migrations con timestamp >= esta version NO se marcan como aplicadas
# (se asume que aun no estan en la DB y queremos que db push las corra).
# Default: la primera version POSTERIOR al ultimo restore conocido.
BARRIER_VERSION="${BARRIER_VERSION:-20260515000000}"

OUT="docs/migration/baseline-migrations.sql"
MIGRATIONS_DIR="supabase/migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "ERROR: No existe $MIGRATIONS_DIR. Corre el script desde la raiz del repo." >&2
  exit 1
fi

{
  echo "-- Baseline de migrations existentes."
  echo "-- Marca todas las migrations <$BARRIER_VERSION como 'aplicadas' en"
  echo "-- supabase_migrations.schema_migrations, para que 'supabase db push'"
  echo "-- solo intente aplicar las nuevas a partir de esa version."
  echo "--"
  echo "-- Regenerado por: scripts/baseline-migrations.sh"
  echo "-- Fecha: $(date -u +'%Y-%m-%d %H:%M:%S UTC')"
  echo ""
  echo "-- Asegurar que la tabla y schema existan (no-op si ya estan)."
  echo "CREATE SCHEMA IF NOT EXISTS supabase_migrations;"
  echo "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations ("
  echo "  version text NOT NULL PRIMARY KEY,"
  echo "  statements text[],"
  echo "  name text"
  echo ");"
  echo ""
  echo "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES"
  first=1
  count=0
  for f in "$MIGRATIONS_DIR"/*.sql; do
    base=$(basename "$f" .sql)
    version="${base%%_*}"
    name="${base#*_}"
    # Filtrar por barrera.
    if [ "$version" \> "$BARRIER_VERSION" ] || [ "$version" = "$BARRIER_VERSION" ]; then
      continue
    fi
    # Escapar comillas simples por seguridad.
    safe_name=$(echo "$name" | sed "s/'/''/g")
    if [ $first -eq 1 ]; then
      first=0
      printf "  ('%s', '%s')" "$version" "$safe_name"
    else
      printf ",\n  ('%s', '%s')" "$version" "$safe_name"
    fi
    count=$((count + 1))
  done
  echo ""
  echo "ON CONFLICT (version) DO NOTHING;"
  echo ""
  echo "-- Verificacion."
  echo "SELECT count(*) AS aplicadas FROM supabase_migrations.schema_migrations;"
  echo "-- Deberia ser >= $count (puede ser mayor si ya habia algunas marcadas)."
} > "$OUT"

echo "Regenerado: $OUT"
echo "Migrations marcadas como aplicadas: $count (barrera: $BARRIER_VERSION)"
