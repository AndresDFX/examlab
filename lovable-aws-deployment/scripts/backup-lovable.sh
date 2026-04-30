#!/bin/bash

###############################################################################
# backup-lovable.sh — Backup de datos desde Supabase/Lovable
#
# Métodos:
# 1. pg_dump directo desde RDS o Supabase
# 2. Exportar via Supabase SQL Editor
# 3. CSV export desde tablas específicas
#
# Uso: bash backup-lovable.sh [rds|supabase|csv]
###############################################################################

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Source variables
source "$(dirname "$0")/../cloudshell-vars.env" || true

log_ok() { echo -e "${GREEN}✓${NC} $1"; }
log_err() { echo -e "${RED}✗${NC} $1"; exit 1; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_info() { echo -e "${BLUE}→${NC} $1"; }

BACKUP_DIR="${HOME}/examlab-backups"
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

###############################################################################
# MÉTODO 1: Backup directo desde RDS
###############################################################################
backup_rds() {
    log_info "Método 1: Backup desde RDS PostgreSQL"
    echo ""

    # Obtener RDS endpoint desde CloudFormation
    RDS_ENDPOINT=$(aws cloudformation describe-stacks \
        --stack-name "${RDS_STACK_NAME}" \
        --region "$AWS_REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='RDSEndpoint'].OutputValue" \
        --output text 2>/dev/null || echo "")

    if [ -z "$RDS_ENDPOINT" ]; then
        log_err "No se pudo obtener RDS endpoint"
    fi

    RDS_HOST=$(echo "$RDS_ENDPOINT" | cut -d: -f1)
    RDS_PORT=$(echo "$RDS_ENDPOINT" | cut -d: -f2)

    echo "RDS Endpoint: $RDS_HOST:$RDS_PORT"
    echo ""

    BACKUP_FILE="$BACKUP_DIR/${PROJECT_NAME}_rds_${TIMESTAMP}.sql"

    echo "Credenciales:"
    echo "  Usuario: $DB_USERNAME"
    echo "  Base de datos: $DB_NAME"
    echo ""
    echo "Creando backup en: $BACKUP_FILE"
    echo ""

    # Probar conexión primero
    if ! PGPASSWORD="$DB_PASSWORD" pg_isready -h "$RDS_HOST" -p "$RDS_PORT" -U "$DB_USERNAME" &>/dev/null; then
        log_warn "No se puede conectar a RDS. Asegúrate de:"
        echo "  1. RDS está disponible"
        echo "  2. EC2 tiene acceso a RDS (security group)"
        echo "  3. pg_isready está instalado (sudo yum install postgresql -y)"
        exit 1
    fi

    # Crear backup
    PGPASSWORD="$DB_PASSWORD" pg_dump \
        -h "$RDS_HOST" \
        -p "$RDS_PORT" \
        -U "$DB_USERNAME" \
        -d "$DB_NAME" \
        --verbose \
        --no-password \
        > "$BACKUP_FILE" || log_err "Fallo al crear backup"

    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    log_ok "Backup creado: $SIZE"
    echo "   Archivo: $BACKUP_FILE"

    # Comprimir
    gzip "$BACKUP_FILE"
    BACKUP_FILE_GZ="${BACKUP_FILE}.gz"
    SIZE_GZ=$(du -h "$BACKUP_FILE_GZ" | cut -f1)
    log_ok "Comprimido: $SIZE_GZ"
    echo "   Archivo: $BACKUP_FILE_GZ"

    # Opcionalmente subir a S3
    read -p "¿Subir a S3? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        upload_to_s3 "$BACKUP_FILE_GZ"
    fi
}

###############################################################################
# MÉTODO 2: Backup desde Supabase
###############################################################################
backup_supabase() {
    log_info "Método 2: Backup desde Supabase"
    echo ""

    if [ -z "$SUPABASE_URL" ]; then
        log_err "SUPABASE_URL no configurado en cloudshell-vars.env"
    fi

    echo "Supabase Project: $SUPABASE_URL"
    echo ""

    # El endpoint de Supabase
    SUPABASE_HOST=$(echo "$SUPABASE_URL" | sed 's/https:\/\///' | sed 's/.supabase.co//')
    SUPABASE_DB_URL="${SUPABASE_HOST}.supabase.co"

    echo "Para hacer backup desde Supabase:"
    echo ""
    echo "Opción A: Usar Supabase SQL Editor"
    echo "  1. Ir a: https://app.supabase.com/project/${SUPABASE_HOST}/sql"
    echo "  2. Ejecutar:"
    cat << 'SQL'
    -- Listar todas las tablas
    SELECT tablename FROM pg_tables WHERE schemaname = 'public';

    -- Exportar data como JSON
    SELECT json_agg(row_to_json(t)) FROM table_name t;
SQL
    echo ""
    echo "Opción B: Usar pg_dump con Supabase"
    echo "  Requiere Supabase connection string:"
    echo ""

    read -p "¿Tienes Supabase connection string? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        read -sp "Pegar connection string: " SUPABASE_CONN
        echo ""

        BACKUP_FILE="$BACKUP_DIR/${PROJECT_NAME}_supabase_${TIMESTAMP}.sql"
        echo "Creando backup..."

        PGPASSWORD="${SUPABASE_CONN##*:}" pg_dump \
            "${SUPABASE_CONN%@*}@${SUPABASE_CONN##*@}" \
            > "$BACKUP_FILE" || log_err "Fallo al hacer backup"

        SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
        log_ok "Backup creado: $SIZE"
    fi
}

###############################################################################
# MÉTODO 3: Exportar tablas específicas a CSV
###############################################################################
backup_csv_export() {
    log_info "Método 3: Exportar tablas a CSV"
    echo ""

    RDS_ENDPOINT=$(aws cloudformation describe-stacks \
        --stack-name "${RDS_STACK_NAME}" \
        --region "$AWS_REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='RDSEndpoint'].OutputValue" \
        --output text 2>/dev/null || echo "")

    RDS_HOST=$(echo "$RDS_ENDPOINT" | cut -d: -f1)
    RDS_PORT=$(echo "$RDS_ENDPOINT" | cut -d: -f2)

    EXPORT_DIR="$BACKUP_DIR/csv_${TIMESTAMP}"
    mkdir -p "$EXPORT_DIR"

    echo "Conectando a RDS..."

    # Obtener lista de tablas
    TABLES=$(PGPASSWORD="$DB_PASSWORD" psql \
        -h "$RDS_HOST" \
        -p "$RDS_PORT" \
        -U "$DB_USERNAME" \
        -d "$DB_NAME" \
        -t -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public';" \
        2>/dev/null || echo "")

    if [ -z "$TABLES" ]; then
        log_warn "No se encontraron tablas"
        return
    fi

    log_ok "Tablas encontradas:"
    echo "$TABLES" | sed 's/^/  /'

    echo ""
    echo "Exportando tablas a CSV..."

    while read -r table; do
        table=$(echo "$table" | xargs)  # trim
        [ -z "$table" ] && continue

        CSV_FILE="$EXPORT_DIR/${table}.csv"
        echo "  Exportando: $table..."

        PGPASSWORD="$DB_PASSWORD" psql \
            -h "$RDS_HOST" \
            -p "$RDS_PORT" \
            -U "$DB_USERNAME" \
            -d "$DB_NAME" \
            -c "\COPY (SELECT * FROM \"$table\") TO STDOUT WITH CSV HEADER" \
            > "$CSV_FILE" 2>/dev/null || log_warn "    Fallo al exportar $table"
    done <<< "$TABLES"

    # Crear tarball
    EXPORT_TAR="$BACKUP_DIR/${PROJECT_NAME}_csv_${TIMESTAMP}.tar.gz"
    tar czf "$EXPORT_TAR" -C "$BACKUP_DIR" "csv_${TIMESTAMP}"
    SIZE=$(du -h "$EXPORT_TAR" | cut -f1)

    log_ok "Datos exportados a CSV: $SIZE"
    echo "   Archivo: $EXPORT_TAR"

    # Opcionalmente subir a S3
    read -p "¿Subir a S3? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        upload_to_s3 "$EXPORT_TAR"
    fi
}

###############################################################################
# Subir a S3
###############################################################################
upload_to_s3() {
    local file=$1

    # Crear bucket si no existe
    S3_BUCKET="${PROJECT_NAME}-backups-$(aws sts get-caller-identity --query Account --output text)"

    if ! aws s3 ls "s3://$S3_BUCKET" > /dev/null 2>&1; then
        echo "Creando bucket S3..."
        aws s3 mb "s3://$S3_BUCKET" --region "$AWS_REGION" || log_warn "Bucket podría existir"
    fi

    echo "Subiendo a S3..."
    aws s3 cp "$file" "s3://$S3_BUCKET/backups/" || log_err "Fallo al subir a S3"

    log_ok "Subido a S3"
    echo "   Bucket: $S3_BUCKET"
    echo "   Archivo: s3://$S3_BUCKET/backups/$(basename $file)"
}

###############################################################################
# Restaurar desde backup
###############################################################################
restore_from_backup() {
    log_info "Restaurar desde backup"
    echo ""

    ls -lh "$BACKUP_DIR"/ 2>/dev/null || log_err "No hay backups en $BACKUP_DIR"

    echo ""
    read -p "Ingresa nombre del archivo a restaurar: " RESTORE_FILE

    if [ ! -f "$BACKUP_DIR/$RESTORE_FILE" ]; then
        log_err "Archivo no encontrado: $RESTORE_FILE"
    fi

    RDS_ENDPOINT=$(aws cloudformation describe-stacks \
        --stack-name "${RDS_STACK_NAME}" \
        --region "$AWS_REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='RDSEndpoint'].OutputValue" \
        --output text)

    RDS_HOST=$(echo "$RDS_ENDPOINT" | cut -d: -f1)
    RDS_PORT=$(echo "$RDS_ENDPOINT" | cut -d: -f2)

    echo ""
    echo "⚠️  ADVERTENCIA: Esto sobrescribirá todos los datos en la BD"
    read -p "Escribe 'restore' para confirmar: " CONFIRM

    if [ "$CONFIRM" != "restore" ]; then
        echo "Cancelado."
        return
    fi

    echo "Restaurando..."

    # Descomprimir si es necesario
    if [[ $RESTORE_FILE == *.gz ]]; then
        gunzip -c "$BACKUP_DIR/$RESTORE_FILE" | PGPASSWORD="$DB_PASSWORD" psql \
            -h "$RDS_HOST" \
            -p "$RDS_PORT" \
            -U "$DB_USERNAME" \
            -d "$DB_NAME" || log_err "Fallo al restaurar"
    else
        PGPASSWORD="$DB_PASSWORD" psql \
            -h "$RDS_HOST" \
            -p "$RDS_PORT" \
            -U "$DB_USERNAME" \
            -d "$DB_NAME" \
            < "$BACKUP_DIR/$RESTORE_FILE" || log_err "Fallo al restaurar"
    fi

    log_ok "Datos restaurados"
}

###############################################################################
# Main
###############################################################################

print_header() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║         BACKUP DE EXAMLAB / LOVABLE / SUPABASE             ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

print_header

case "${1:-menu}" in
    rds)
        backup_rds
        ;;
    supabase)
        backup_supabase
        ;;
    csv)
        backup_csv_export
        ;;
    restore)
        restore_from_backup
        ;;
    *)
        echo "Opciones:"
        echo "  rds          - Backup completo desde RDS"
        echo "  supabase     - Backup desde Supabase"
        echo "  csv          - Exportar tablas a CSV"
        echo "  restore      - Restaurar desde backup"
        echo ""
        echo "Uso: bash backup-lovable.sh [rds|supabase|csv|restore]"
        echo ""
        read -p "¿Qué deseas hacer? (rds/supabase/csv/restore): " choice
        case $choice in
            rds) backup_rds ;;
            supabase) backup_supabase ;;
            csv) backup_csv_export ;;
            restore) restore_from_backup ;;
            *) log_err "Opción inválida" ;;
        esac
        ;;
esac

echo ""
log_ok "Completado"
