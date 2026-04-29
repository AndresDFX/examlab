#!/bin/bash

###############################################################################
# deploy-cloudshell-only.sh — Deploy desde CloudShell (sin Docker requerido)
#
# Ejecutar desde AWS CloudShell:
# $ bash deploy-cloudshell-only.sh
#
# Hace:
# 1. Pregunta configuración (4 variables)
# 2. Valida credenciales AWS
# 3. Despliega VPC + RDS + EC2 con Docker automático
# 4. EC2 instala Docker y ejecuta docker-compose automáticamente
#
# NO REQUIERE: Docker local, Node.js local, PostgreSQL local
# REQUIERE: AWS CloudShell acceso, credenciales configuradas
###############################################################################

set -e

# Determine script location and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Change to project root
cd "$PROJECT_ROOT"

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

# ═══════════════════════════════════════════════════════════════════════════
# Verificar requisitos
# ═══════════════════════════════════════════════════════════════════════════

header "Verificando requisitos"

step "Verificando AWS CLI..."
if ! command -v aws &> /dev/null; then
    error "AWS CLI no está instalado"
fi
success "AWS CLI disponible"

step "Verificando jq (JSON processor)..."
if ! command -v jq &> /dev/null; then
    error "jq no está instalado. Instálalo: sudo apt-get install jq"
fi
success "jq disponible"

# ═══════════════════════════════════════════════════════════════════════════
# Verificar credenciales AWS
# ═══════════════════════════════════════════════════════════════════════════

header "Validando credenciales AWS"

step "Verificando identidad..."
if ! ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null); then
    error "No tienes credenciales AWS configuradas en CloudShell"
fi

success "Credenciales válidas"
success "Cuenta AWS: $ACCOUNT_ID"

# ═══════════════════════════════════════════════════════════════════════════
# Configuración interactiva
# ═══════════════════════════════════════════════════════════════════════════

header "Configuración del proyecto"

echo "Responde las siguientes preguntas:"
echo ""

# Nombre del proyecto
read -p "Nombre del proyecto [examlab]: " PROJECT_NAME
PROJECT_NAME=${PROJECT_NAME:-examlab}
success "Proyecto: $PROJECT_NAME"

# Contraseña de BD
echo ""
read -sp "Contraseña Postgres (mín. 12 caracteres): " DB_PASSWORD
echo ""

if [ ${#DB_PASSWORD} -lt 12 ]; then
    error "Contraseña muy corta (mínimo 12 caracteres)"
fi
success "Contraseña configurada"

# Región AWS
echo ""
REGION=$(aws configure get region)
REGION=${REGION:-us-east-1}
read -p "Región AWS [$REGION]: " AWS_REGION
AWS_REGION=${AWS_REGION:-$REGION}
success "Región: $AWS_REGION"

# Nombre de ambiente
echo ""
read -p "Ambiente [production]: " ENVIRONMENT
ENVIRONMENT=${ENVIRONMENT:-production}
success "Ambiente: $ENVIRONMENT"

# ═══════════════════════════════════════════════════════════════════════════
# Confirmación
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${YELLOW}Resumen de configuración:${NC}"
echo "  Proyecto:        $PROJECT_NAME"
echo "  BD Password:     (****)"
echo "  Región AWS:      $AWS_REGION"
echo "  Cuenta AWS:      $ACCOUNT_ID"
echo "  Ambiente:        $ENVIRONMENT"
echo ""

read -p "¿Continuar? (s/n): " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Ss]$ ]]; then
    info "Deploy cancelado"
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════
# Generar archivos .env
# ═══════════════════════════════════════════════════════════════════════════

header "Generando configuración"

step "Creando .env..."
cat > .env << EOF
PROJECT_NAME=$PROJECT_NAME
ENVIRONMENT=$ENVIRONMENT
AWS_REGION=$AWS_REGION
AWS_ACCOUNT_ID=$ACCOUNT_ID
POSTGRES_PASSWORD=$DB_PASSWORD
POSTGRES_DB=$PROJECT_NAME
NODE_ENV=production
HOST=0.0.0.0
APP_PORT=3000
SUPABASE_URL=http://localhost:8000
EOF

success ".env creado"

# ═══════════════════════════════════════════════════════════════════════════
# Validar templates CloudFormation
# ═══════════════════════════════════════════════════════════════════════════

header "Validando CloudFormation templates"

for template in "$SCRIPT_DIR/cloudformation/vpc-stack.yaml" "$SCRIPT_DIR/cloudformation/rds-stack.yaml" "$SCRIPT_DIR/cloudformation/ec2-docker-stack.yaml"; do
    step "Validando $(basename $template)..."
    if aws cloudformation validate-template \
        --template-body "file://$template" \
        --region "$AWS_REGION" > /dev/null 2>&1; then
        success "Template válido: $(basename $template)"
    else
        error "Template inválido: $template"
    fi
done

# ═══════════════════════════════════════════════════════════════════════════
# Crear SSH Key Pair en AWS
# ═══════════════════════════════════════════════════════════════════════════

header "Configurando SSH Key Pair"

KEY_NAME="${PROJECT_NAME}-${ENVIRONMENT}"

step "Verificando key pair: $KEY_NAME..."
if aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$AWS_REGION" &>/dev/null; then
    info "Key pair ya existe: $KEY_NAME"
else
    step "Creando SSH key pair..."
    aws ec2 create-key-pair \
        --key-name "$KEY_NAME" \
        --region "$AWS_REGION" \
        --query 'KeyMaterial' \
        --output text > "/tmp/${KEY_NAME}.pem"

    chmod 600 "/tmp/${KEY_NAME}.pem"
    success "SSH key creada"
    info "Archivo: /tmp/${KEY_NAME}.pem"
fi

# ═══════════════════════════════════════════════════════════════════════════
# Desplegar VPC Stack
# ═══════════════════════════════════════════════════════════════════════════

header "Desplegando VPC Stack"

STACK_VPC="${PROJECT_NAME}-vpc-${ENVIRONMENT}"

step "Desplegando VPC (puede tomar 3-5 minutos)..."
aws cloudformation deploy \
    --template-file "$SCRIPT_DIR/cloudformation/vpc-stack.yaml" \
    --stack-name "$STACK_VPC" \
    --region "$AWS_REGION" \
    --parameter-overrides \
        ProjectName="$PROJECT_NAME" \
        Environment="$ENVIRONMENT" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset || true

success "VPC Stack desplegado"

# Obtener subnets del VPC
step "Obteniendo información de subnets..."
VPC_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_VPC" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`VpcId`].OutputValue' \
    --output text)

success "VPC ID: $VPC_ID"

# ═══════════════════════════════════════════════════════════════════════════
# Desplegar RDS Stack
# ═══════════════════════════════════════════════════════════════════════════

header "Desplegando RDS Stack"

STACK_RDS="${PROJECT_NAME}-rds-${ENVIRONMENT}"

step "Desplegando RDS PostgreSQL (puede tomar 5-10 minutos)..."
aws cloudformation deploy \
    --template-file "$SCRIPT_DIR/cloudformation/rds-stack.yaml" \
    --stack-name "$STACK_RDS" \
    --region "$AWS_REGION" \
    --parameter-overrides \
        ProjectName="$PROJECT_NAME" \
        Environment="$ENVIRONMENT" \
        DBPassword="$DB_PASSWORD" \
        DBName="$PROJECT_NAME" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset || true

success "RDS Stack desplegado"

# ═══════════════════════════════════════════════════════════════════════════
# Desplegar EC2 Stack con Docker
# ═══════════════════════════════════════════════════════════════════════════

header "Desplegando EC2 Stack con Docker"

STACK_EC2="${PROJECT_NAME}-ec2-${ENVIRONMENT}"

step "Desplegando EC2 con Auto Scaling (puede tomar 5-10 minutos)..."
step "EC2 instalará Docker automáticamente y ejecutará docker-compose..."

aws cloudformation deploy \
    --template-file "$SCRIPT_DIR/cloudformation/ec2-docker-stack.yaml" \
    --stack-name "$STACK_EC2" \
    --region "$AWS_REGION" \
    --parameter-overrides \
        ProjectName="$PROJECT_NAME" \
        Environment="$ENVIRONMENT" \
        InstanceType="t3.small" \
        KeyName="$KEY_NAME" \
        AppPort="3000" \
        DBPassword="$DB_PASSWORD" \
        DBName="$PROJECT_NAME" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset || true

success "EC2 Stack desplegado"

# ═══════════════════════════════════════════════════════════════════════════
# Obtener información de acceso
# ═══════════════════════════════════════════════════════════════════════════

header "Obteniendo información de acceso"

step "Recuperando ALB DNS..."
ALB_DNS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_EC2" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`ALBDNSName`].OutputValue' \
    --output text 2>/dev/null || echo "Pendiente...")

step "Recuperando RDS Endpoint..."
RDS_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_RDS" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`RDSEndpoint`].OutputValue' \
    --output text 2>/dev/null || echo "Pendiente...")

# ═══════════════════════════════════════════════════════════════════════════
# Mostrar información final
# ═══════════════════════════════════════════════════════════════════════════

header "✅ DEPLOYMENT COMPLETADO"

cat << FINAL_INFO
╔════════════════════════════════════════════════════════════╗
║         ExamLab desplegado en AWS CloudFormation           ║
╚════════════════════════════════════════════════════════════╝

🌐 ACCESO A LA APLICACIÓN:
   URL: http://${ALB_DNS:-PENDIENTE}
   (Espera 5 minutos a que EC2 levante Docker)

🔑 ACCESO SSH:
   ssh -i /tmp/${KEY_NAME}.pem ec2-user@${ALB_DNS:-<ALB-DNS>}

💾 BASE DE DATOS:
   Endpoint: ${RDS_ENDPOINT:-PENDIENTE}
   Base de datos: $PROJECT_NAME
   Usuario: postgres
   Contraseña: (la que ingresaste)

☁️  STACKS CLOUDFORMATION:
   VPC:  $STACK_VPC
   RDS:  $STACK_RDS
   EC2:  $STACK_EC2

📍 REGIÓN: $AWS_REGION
👤 CUENTA: $ACCOUNT_ID

───────────────────────────────────────────────────────────

⏱️  PRÓXIMOS PASOS:

1. Espera 5-10 minutos a que EC2 se inicialice
   (Está instalando Docker y ejecutando docker-compose)

2. Verifica logs en CloudWatch:
   aws logs tail /aws/ec2/$PROJECT_NAME-$ENVIRONMENT --follow

3. Cuando esté listo, accede a:
   http://${ALB_DNS:-<ALB-DNS>}

4. Para conectarte por SSH:
   ssh -i /tmp/${KEY_NAME}.pem ec2-user@${ALB_DNS:-<ALB-DNS>}

5. Ver logs de la app en EC2:
   ssh -i /tmp/${KEY_NAME}.pem ec2-user@${ALB_DNS:-<ALB-DNS>}
   docker-compose logs -f app

───────────────────────────────────────────────────────────

📝 ARCHIVO DE CONFIGURACIÓN:
   .env (contiene todas tus variables)

🔐 SSH KEY:
   /tmp/${KEY_NAME}.pem (guarda en lugar seguro)

📊 MONITORAR:
   AWS Console → CloudFormation → Stacks
   AWS Console → EC2 → Load Balancers
   AWS Console → RDS → Databases

───────────────────────────────────────────────────────────

⚠️  IMPORTANTE:
   • Descarga la SSH key de CloudShell: /tmp/${KEY_NAME}.pem
   • Guárdala en ~/.ssh/
   • Nunca la compartas ni la commits a Git
   • EC2 instalará Docker automáticamente (user-data script)

FINAL_INFO

# ═══════════════════════════════════════════════════════════════════════════
# Guardar información en archivo
# ═══════════════════════════════════════════════════════════════════════════

cat > /tmp/examlab-deployment-info.txt << EOF
ExamLab Deployment Information
==============================
Date: $(date)
Project: $PROJECT_NAME
Region: $AWS_REGION
Account: $ACCOUNT_ID

Access Information:
- App URL: http://${ALB_DNS}
- SSH: ssh -i /tmp/${KEY_NAME}.pem ec2-user@${ALB_DNS}
- RDS: ${RDS_ENDPOINT}

CloudFormation Stacks:
- VPC: $STACK_VPC
- RDS: $STACK_RDS
- EC2: $STACK_EC2

SSH Key Location: /tmp/${KEY_NAME}.pem

Next steps:
1. Wait 5-10 minutes for EC2 to initialize
2. Access http://${ALB_DNS}
3. Monitor: aws logs tail /aws/ec2/$PROJECT_NAME-$ENVIRONMENT --follow
EOF

success "Información guardada en: /tmp/examlab-deployment-info.txt"

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
