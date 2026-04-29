#!/bin/bash

###############################################################################
# deploy.sh — Deploy ExamLab en AWS (Simple y directo)
#
# Un solo stack: VPC + EC2 + Docker
# Sin complicaciones, sin dependencias
###############################################################################

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Colors
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

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

command -v aws &>/dev/null || error "AWS CLI no instalado"
success "AWS CLI disponible"

# ═══════════════════════════════════════════════════════════════════════════
# Validar AWS
# ═══════════════════════════════════════════════════════════════════════════

header "Validando AWS"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || error "No hay credenciales AWS"
success "Cuenta: $ACCOUNT_ID"

# ═══════════════════════════════════════════════════════════════════════════
# Configuración interactiva
# ═══════════════════════════════════════════════════════════════════════════

header "Configuración"

read -p "Nombre del proyecto [examlab]: " PROJECT_NAME
PROJECT_NAME=${PROJECT_NAME:-examlab}

echo ""
read -sp "Contraseña DB (Enter para generar): " DB_PASSWORD
echo ""

if [ -z "$DB_PASSWORD" ]; then
    DB_PASSWORD="ExamLab$(date +%Y%m%d)!@$(shuf -i 100-999 -n 1)" 2>/dev/null || DB_PASSWORD="ExamLab2026!@456"
    info "Contraseña generada: $DB_PASSWORD"
fi

echo ""
REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")
REGION=${REGION:-us-east-1}
read -p "Región AWS [$REGION]: " AWS_REGION
AWS_REGION=${AWS_REGION:-$REGION}

# ═══════════════════════════════════════════════════════════════════════════
# Confirmación
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${YELLOW}Resumen:${NC}"
echo "  Proyecto: $PROJECT_NAME"
echo "  Región:   $AWS_REGION"
echo "  Cuenta:   $ACCOUNT_ID"
echo ""

read -p "¿Continuar? (s/n): " -n 1 -r
echo ""
[[ ! $REPLY =~ ^[Ss]$ ]] && { info "Cancelado"; exit 0; }

# ═══════════════════════════════════════════════════════════════════════════
# Obtener AMI
# ═══════════════════════════════════════════════════════════════════════════

header "Obteniendo AMI"

step "Buscando Ubuntu 22.04 LTS más reciente..."
AMI_ID=$(aws ec2 describe-images \
    --owners 099720109477 \
    --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
    --region "$AWS_REGION" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --output text 2>/dev/null || echo "")

if [ -z "$AMI_ID" ] || [ "$AMI_ID" = "None" ]; then
    error "No se encontró AMI de Ubuntu 22.04 LTS en la región $AWS_REGION"
fi

success "AMI: $AMI_ID"

# ═══════════════════════════════════════════════════════════════════════════
# Crear SSH Key
# ═══════════════════════════════════════════════════════════════════════════

header "SSH Key"

KEY_NAME="${PROJECT_NAME}-key"

if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$AWS_REGION" &>/dev/null; then
    step "Creando SSH key..."
    aws ec2 create-key-pair \
        --key-name "$KEY_NAME" \
        --region "$AWS_REGION" \
        --query 'KeyMaterial' \
        --output text > "/tmp/${KEY_NAME}.pem"
    chmod 600 "/tmp/${KEY_NAME}.pem"
    success "SSH key creada"
else
    info "SSH key ya existe"
fi

# ═══════════════════════════════════════════════════════════════════════════
# Empaquetar código y subir a S3
# ═══════════════════════════════════════════════════════════════════════════

header "Empaquetando código"

S3_BUCKET="${PROJECT_NAME}-deploy-${ACCOUNT_ID}-${AWS_REGION}"
S3_KEY="examlab-code-$(date +%Y%m%d%H%M%S).tar.gz"
TAR_FILE="/tmp/${S3_KEY}"

# Crear bucket si no existe
if ! aws s3api head-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" 2>/dev/null; then
    step "Creando bucket S3: $S3_BUCKET"
    if [ "$AWS_REGION" = "us-east-1" ]; then
        aws s3api create-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" >/dev/null
    else
        aws s3api create-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" \
            --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null
    fi
    success "Bucket creado"
else
    info "Bucket ya existe"
fi

# Empaquetar el código (excluyendo node_modules, .git, dist, etc.)
step "Empaquetando proyecto..."
cd "$PROJECT_ROOT"
tar -czf "$TAR_FILE" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='build' \
    --exclude='.env' \
    --exclude='.env.local' \
    --exclude='.env.*.local' \
    --exclude='*.log' \
    --exclude='.DS_Store' \
    --exclude='lovable-aws-deployment/cloudformation/*.bak' \
    .

TAR_SIZE=$(du -h "$TAR_FILE" | cut -f1)
success "Paquete creado: $TAR_SIZE"

# Subir a S3
step "Subiendo a S3..."
aws s3 cp "$TAR_FILE" "s3://${S3_BUCKET}/${S3_KEY}" --region "$AWS_REGION" >/dev/null
success "Código subido: s3://${S3_BUCKET}/${S3_KEY}"

# Limpiar archivo local
rm -f "$TAR_FILE"

# ═══════════════════════════════════════════════════════════════════════════
# Desplegar stack
# ═══════════════════════════════════════════════════════════════════════════

header "Desplegando ExamLab"

STACK_NAME="${PROJECT_NAME}-stack"

step "Desplegando stack (8-12 minutos)..."

aws cloudformation deploy \
    --template-file "$SCRIPT_DIR/cloudformation/all-in-one-stack.yaml" \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --parameter-overrides \
        ProjectName="$PROJECT_NAME" \
        KeyName="$KEY_NAME" \
        DBPassword="$DB_PASSWORD" \
        AMIId="$AMI_ID" \
        S3Bucket="$S3_BUCKET" \
        S3Key="$S3_KEY" \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset || error "Fallo el deployment"

success "Stack desplegado"

# ═══════════════════════════════════════════════════════════════════════════
# Obtener información
# ═══════════════════════════════════════════════════════════════════════════

header "Obteniendo información"

step "Recuperando IP pública..."

INSTANCE_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
    --output text 2>/dev/null || echo "")

PUBLIC_IP=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`PublicIP`].OutputValue' \
    --output text 2>/dev/null || echo "")

success "Instancia: $INSTANCE_ID"
success "IP Pública: $PUBLIC_IP"

# ═══════════════════════════════════════════════════════════════════════════
# Mostrar información final
# ═══════════════════════════════════════════════════════════════════════════

header "✅ DEPLOYMENT COMPLETADO"

cat << FINAL
╔════════════════════════════════════════════════════════════╗
║              ExamLab - ¡Listo para usar!                   ║
╚════════════════════════════════════════════════════════════╝

🌐 ACCESO A LA APLICACIÓN:
   URL: http://${PUBLIC_IP}:3000
   (Espera 12-15 minutos para que Supabase + npm install terminen)

🗄️  SUPABASE:
   API:    http://${PUBLIC_IP}:8000
   Studio: http://${PUBLIC_IP}:8000

🔑 CONECTAR A LA INSTANCIA (Session Manager, sin SSH key):
   aws ssm start-session --target ${INSTANCE_ID} --region ${AWS_REGION}

📊 INFORMACIÓN:
   Proyecto:   $PROJECT_NAME
   Instancia:  $INSTANCE_ID
   Región:     $AWS_REGION
   Stack:      $STACK_NAME

📝 VERIFICAR DESPLIEGUE (dentro de la instancia):

   sudo cat /root/examlab-credentials.txt    # Credenciales generadas
   sudo systemctl status examlab.service     # Estado de la app
   sudo tail -f /var/log/user-data.log       # Logs del setup
   sudo tail -f /var/log/examlab.log         # Logs de la app
   cd /opt/supabase && sudo docker compose ps  # Estado Supabase

⚠️  IMPORTANTE:
   • La primera carga puede tardar (npm install + Supabase boot)
   • Los puertos 3000 (app) y 8000 (Supabase) están abiertos al público
   • Para producción real, restringe los puertos por IP/CIDR

FINAL

# Guardar información en home (persistente en CloudShell)
INFO_FILE="$HOME/${PROJECT_NAME}-deployment-info.txt"

cat > "$INFO_FILE" << EOF
╔════════════════════════════════════════════════════════════╗
║              ExamLab - Deployment Information              ║
╚════════════════════════════════════════════════════════════╝

PROJECT INFORMATION:
- Project Name: $PROJECT_NAME
- Region: $AWS_REGION
- AWS Account: $ACCOUNT_ID
- Stack Name: $STACK_NAME
- Instance ID: $INSTANCE_ID

APPLICATION ACCESS:
- App URL:        http://${PUBLIC_IP}:3000
- Supabase API:   http://${PUBLIC_IP}:8000
- Elastic IP:     $PUBLIC_IP (fixed)

CONNECT TO INSTANCE (no SSH key required):
  aws ssm start-session --target $INSTANCE_ID --region $AWS_REGION

GET GENERATED CREDENTIALS (Supabase keys, DB password):
  aws ssm start-session --target $INSTANCE_ID --region $AWS_REGION
  sudo cat /root/examlab-credentials.txt

MONITORING:
- CloudWatch Logs: /aws/ec2/$PROJECT_NAME
- CloudFormation:  $STACK_NAME
- Instance:        $INSTANCE_ID

USEFUL COMMANDS (run inside the instance):
  sudo systemctl status examlab.service        # App service status
  sudo journalctl -u examlab.service -f        # App service logs
  sudo tail -f /var/log/user-data.log          # Setup logs
  sudo tail -f /var/log/examlab.log            # App stdout/stderr
  cd /opt/supabase && sudo docker compose ps   # Supabase services
  cd /opt/supabase && sudo docker compose logs -f kong  # Supabase API logs

CLEANUP (delete everything):
  aws cloudformation delete-stack --stack-name $STACK_NAME --region $AWS_REGION

DEPLOYMENT TIME:
- Completed:        $(date)
- Instance started: $(aws ec2 describe-instances --instance-ids $INSTANCE_ID --region $AWS_REGION --query 'Reservations[0].Instances[0].LaunchTime' --output text 2>/dev/null || echo 'N/A')
EOF

success "Información guardada: $INFO_FILE"
info "Muestra esta información con: cat $INFO_FILE"

echo ""
echo "═════════════════════════════════════════════════════════════"
