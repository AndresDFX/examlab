#!/bin/bash

###############################################################################
# deploy-to-aws.sh — Desplegar ExamLab a AWS
#
# Automatiza:
# 1. Backup de BD local (PostgreSQL)
# 2. Configuración de AWS credentials
# 3. Creación de CloudFormation stack
# 4. Deploy de la app en EC2
#
# Uso: bash deploy-to-aws.sh
###############################################################################

set -e

# Colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# Helper functions
header() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║ $1${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

success() {
    echo -e "${GREEN}✓${NC} $1"
}

error() {
    echo -e "${RED}✗${NC} $1"
    exit 1
}

info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

step() {
    echo -e "${CYAN}→${NC} $1"
}

# Load environment
header "Cargando configuración"

if [ ! -f .env ]; then
    error ".env no encontrado. Ejecuta primero: bash setup.sh"
fi

set -a
source .env
set +a

success "Configuración cargada"
info "Proyecto: $PROJECT_NAME"
info "Región: $AWS_REGION"

# Verificar Docker
header "Verificando servicios"

step "Verificando Docker..."
if ! command -v docker &> /dev/null; then
    error "Docker no está instalado"
fi
success "Docker disponible"

step "Verificando docker-compose..."
if ! command -v docker-compose &> /dev/null; then
    error "Docker Compose no está instalado"
fi
success "Docker Compose disponible"

# Verificar que containers están corriendo
step "Verificando containers..."
if ! docker ps | grep -q "${PROJECT_NAME}-postgres"; then
    error "PostgreSQL no está corriendo. Ejecuta: docker-compose up -d"
fi
success "PostgreSQL corriendo"

if ! docker ps | grep -q "${PROJECT_NAME}-app"; then
    error "App no está corriendo. Ejecuta: docker-compose up -d"
fi
success "App corriendo"

# Crear directorio de backups
mkdir -p backups
success "Directorio de backups listo"

# Backup de BD
header "Creando backup de base de datos"

BACKUP_FILE="backups/examlab-${PROJECT_NAME}-$(date +%Y%m%d-%H%M%S).sql"

step "Exportando BD desde PostgreSQL..."
docker exec ${PROJECT_NAME}-postgres pg_dump \
    -U postgres \
    -d ${POSTGRES_DB} \
    --no-password \
    > "$BACKUP_FILE" || error "Fallo al crear backup"

success "Backup creado: $BACKUP_FILE"
info "Tamaño: $(du -h "$BACKUP_FILE" | cut -f1)"

# Comprimir backup
step "Comprimiendo backup..."
gzip "$BACKUP_FILE"
BACKUP_FILE="${BACKUP_FILE}.gz"
success "Backup comprimido"

# Verificar AWS CLI
header "Configurando AWS"

if ! command -v aws &> /dev/null; then
    error "AWS CLI no está instalado. Descárgalo desde https://aws.amazon.com/cli/"
fi
success "AWS CLI instalado"

# Verificar credenciales
step "Verificando credenciales AWS..."
if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
    error "AWS_ACCESS_KEY_ID o AWS_SECRET_ACCESS_KEY no configurados en .env"
fi

if ! aws sts get-caller-identity --region "$AWS_REGION" > /dev/null 2>&1; then
    error "Credenciales AWS inválidas. Verifica tu .env"
fi

success "Credenciales AWS válidas"
success "Cuenta: $(aws sts get-caller-identity --query Account --output text)"

# Crear stack CloudFormation
header "Desplegando a AWS CloudFormation"

STACK_NAME="${PROJECT_NAME}-$(date +%s)"
TEMPLATE_FILE="cloudformation/ec2-stack.yaml"

if [ ! -f "$TEMPLATE_FILE" ]; then
    error "CloudFormation template no encontrado: $TEMPLATE_FILE"
fi
success "Template encontrado"

# Crear parámetros
step "Preparando parámetros..."

cat > /tmp/cf-params.json << EOF
[
  {
    "ParameterKey": "ProjectName",
    "ParameterValue": "$PROJECT_NAME"
  },
  {
    "ParameterKey": "Environment",
    "ParameterValue": "production"
  },
  {
    "ParameterKey": "InstanceType",
    "ParameterValue": "t3.small"
  },
  {
    "ParameterKey": "DBPassword",
    "ParameterValue": "$POSTGRES_PASSWORD"
  },
  {
    "ParameterKey": "DBName",
    "ParameterValue": "$POSTGRES_DB"
  },
  {
    "ParameterKey": "AppPort",
    "ParameterValue": "3000"
  }
]
EOF

success "Parámetros preparados"

# Validar template
step "Validando CloudFormation template..."
aws cloudformation validate-template \
    --template-body "file://$TEMPLATE_FILE" \
    --region "$AWS_REGION" > /dev/null || error "Template inválido"
success "Template válido"

# Deploy
step "Desplegando stack (esto puede tomar ~10-15 minutos)..."
aws cloudformation deploy \
    --template-file "$TEMPLATE_FILE" \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --parameter-overrides file:///tmp/cf-params.json \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset || error "Fallo el deployment"

success "Stack desplegado: $STACK_NAME"

# Obtener información de acceso
header "Información de acceso"

step "Recuperando datos del stack..."

ALB_DNS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`ALBDNSName`].OutputValue' \
    --output text 2>/dev/null)

RDS_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`RDSEndpoint`].OutputValue' \
    --output text 2>/dev/null)

if [ -z "$ALB_DNS" ]; then
    info "ALB aún se está inicializando. Intenta en unos momentos"
else
    success "ALB DNS: $ALB_DNS"
fi

if [ -z "$RDS_ENDPOINT" ]; then
    info "RDS aún se está inicializando. Intenta en unos momentos"
else
    success "RDS Endpoint: $RDS_ENDPOINT"
fi

# Guardar información
cat > /tmp/deployment-info.txt << EOF
═══════════════════════════════════════════════════════════
  DEPLOYMENT COMPLETADO - $PROJECT_NAME
═══════════════════════════════════════════════════════════

📍 Información de acceso:

🌐 Aplicación:
   URL: http://${ALB_DNS:-PENDIENTE}
   (Espera 5 minutos a que esté lista)

🔑 SSH:
   ssh -i ~/.ssh/${PROJECT_NAME}-production.pem ec2-user@${ALB_DNS:-PENDIENTE}

💾 Base de datos:
   Endpoint: ${RDS_ENDPOINT:-PENDIENTE}
   Base de datos: $POSTGRES_DB
   Usuario: postgres
   Contraseña: (la ingresada en setup)

📦 Stack CloudFormation:
   Nombre: $STACK_NAME
   Región: $AWS_REGION
   Cuenta: $AWS_ACCOUNT_ID

💿 Backup:
   Archivo: $BACKUP_FILE
   Local: docker-compose (localhost:5432)

───────────────────────────────────────────────────────────

📊 Próximos pasos:

1. Espera ~5 minutos a que la app esté lista
2. Accede a: http://${ALB_DNS:-<ALB-DNS>}
3. Verifica que todo funciona correctamente
4. Para SSH: ssh -i ~/.ssh/${PROJECT_NAME}-production.pem ec2-user@${ALB_DNS:-<ALB-DNS>}

📚 Para más información:
   - Ver logs: aws logs tail /aws/ec2/${PROJECT_NAME}-production --follow
   - CloudWatch: https://console.aws.amazon.com/cloudwatch
   - CloudFormation: https://console.aws.amazon.com/cloudformation

═══════════════════════════════════════════════════════════
EOF

cat /tmp/deployment-info.txt

# Guardar en archivo local
cp /tmp/deployment-info.txt "deployment-info-${PROJECT_NAME}.txt"
success "Información guardada en: deployment-info-${PROJECT_NAME}.txt"

header "✅ Despliegue completado"

echo "Próximos pasos:"
echo ""
echo "1. Verifica tu email para el certificado SSH (si se envió)"
echo "2. Abre: http://${ALB_DNS:-<ALB-DNS>} en ~5 minutos"
echo "3. Guarda tu información de acceso (deployment-info-*.txt)"
echo ""
echo "📞 Soporte:"
echo "   Logs locales: docker-compose logs -f app"
echo "   Logs AWS: bash scripts/print-access-info.sh"
echo ""
