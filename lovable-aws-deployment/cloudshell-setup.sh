#!/bin/bash

###############################################################################
# cloudshell-setup.sh — Setup completo desde AWS CloudShell
#
# Ejecutar desde CloudShell:
# $ bash cloudshell-setup.sh
#
# Pasos:
# 1. Cargar variables genéricas
# 2. Generar SSH keys en CloudShell
# 3. Agregar a GitHub automáticamente
# 4. Clonar repositorio
# 5. Desplegar CloudFormation
###############################################################################

set -e

# Source variables
source "$(dirname "$0")/cloudshell-vars.env"

# Validar
if ! validate_variables; then
    echo ""
    echo "Por favor editar cloudshell-vars.env y corregir los errores."
    exit 1
fi

print_info

###############################################################################
# PASO 1: Verificar prerequisitos en CloudShell
###############################################################################
log_section() {
    echo -e "\n${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║ $1${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}\n"
}

log_ok() {
    echo -e "${GREEN}✓${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
    exit 1
}

log_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_section "PASO 1: Validando CloudShell"

# Verificar que estamos en CloudShell
if [[ -z "$CLOUDSHELL_USER" ]]; then
    log_warn "No estás en AWS CloudShell (variable CLOUDSHELL_USER no existe)"
    log_warn "Continuando de todas formas..."
fi

# Verificar AWS CLI
if ! command -v aws &> /dev/null; then
    log_error "AWS CLI no instalado. Necesario en CloudShell."
fi

# Verificar Git
if ! command -v git &> /dev/null; then
    log_error "Git no instalado. Necesario para clonar repo."
fi

log_ok "AWS CLI instalado"
log_ok "Git instalado"

# Verificar credenciales AWS
if ! aws sts get-caller-identity &> /dev/null; then
    log_error "Credenciales AWS no válidas. Ejecuta: aws configure"
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
USER_ARN=$(aws sts get-caller-identity --query Arn --output text)

log_ok "Credenciales AWS: $ACCOUNT_ID"
log_ok "Usuario: $USER_ARN"

###############################################################################
# PASO 2: Generar SSH keys en CloudShell
###############################################################################
log_section "PASO 2: Generando SSH keys"

SSH_DIR="$HOME/.ssh"
SSH_PRIVATE_KEY="$SSH_DIR/${SSH_KEY_NAME}.pem"
SSH_PUBLIC_KEY="$SSH_DIR/${SSH_KEY_NAME}.pub"

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

if [ -f "$SSH_PRIVATE_KEY" ]; then
    log_warn "SSH key ya existe: $SSH_KEY_NAME"
    read -p "¿Generar nueva clave? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_ok "Usando clave existente"
    else
        rm -f "$SSH_PRIVATE_KEY" "$SSH_PUBLIC_KEY"
        ssh-keygen -t ed25519 -f "$SSH_PRIVATE_KEY" -N "" -C "$PROJECT_NAME-$ENVIRONMENT" || \
            log_error "Fallo al generar SSH key"
    fi
else
    log_ok "Generando nueva SSH key: $SSH_KEY_NAME"
    ssh-keygen -t ed25519 -f "$SSH_PRIVATE_KEY" -N "" -C "$PROJECT_NAME-$ENVIRONMENT" || \
        log_error "Fallo al generar SSH key"
fi

chmod 600 "$SSH_PRIVATE_KEY"
chmod 644 "$SSH_PUBLIC_KEY"

PUBLIC_KEY_CONTENT=$(cat "$SSH_PUBLIC_KEY")
log_ok "SSH key generada: $SSH_KEY_NAME"

###############################################################################
# PASO 3: Agregar a GitHub (si se proporciona token)
###############################################################################
log_section "PASO 3: Agregando clave pública a GitHub"

echo ""
echo "Para agregar la clave pública a GitHub automáticamente, necesitas un Personal Access Token."
echo ""
echo "Crear token en: https://github.com/settings/tokens"
echo "  - Seleccionar: read:public_key, write:public_key"
echo "  - Copiar el token"
echo ""
read -p "¿Tienes un GitHub token? (s/n) " -n 1 -r
echo

if [[ $REPLY =~ ^[Ss]$ ]]; then
    read -sp "Pegar GitHub token: " GITHUB_TOKEN
    echo ""

    # Agregar clave a GitHub
    GITHUB_KEY_NAME="${PROJECT_NAME}-${ENVIRONMENT}-$(hostname)"

    if curl -s -X POST "https://api.github.com/user/keys" \
        -H "Authorization: token $GITHUB_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{
            \"title\": \"$GITHUB_KEY_NAME\",
            \"key\": \"$PUBLIC_KEY_CONTENT\"
        }" | grep -q '"id"'; then
        log_ok "Clave agregada a GitHub: $GITHUB_KEY_NAME"
    else
        log_warn "No se pudo agregar clave a GitHub. Agregarla manualmente:"
        echo "  https://github.com/settings/keys"
    fi
else
    log_warn "Tendrás que agregar la clave manualmente a GitHub:"
    echo ""
    echo "  1. Ir a: https://github.com/settings/keys"
    echo "  2. Click en 'New SSH key'"
    echo "  3. Título: ${PROJECT_NAME}-${ENVIRONMENT}"
    echo "  4. Pegar esta clave:"
    echo ""
    echo "---BEGIN PUBLIC KEY---"
    echo "$PUBLIC_KEY_CONTENT"
    echo "---END PUBLIC KEY---"
    echo ""
fi

###############################################################################
# PASO 4: Clonar repositorio
###############################################################################
log_section "PASO 4: Clonando repositorio"

if [ -z "$GITHUB_REPO" ]; then
    log_warn "GITHUB_REPO no configurado, saltando clonación"
    REPO_DIR="."
else
    REPO_DIR="$HOME/${GITHUB_REPO}"

    if [ -d "$REPO_DIR" ]; then
        log_warn "Repositorio ya existe: $REPO_DIR"
        read -p "¿Actualizar? (y/n) " -n 1 -r
        echo

        if [[ $REPLY =~ ^[Yy]$ ]]; then
            cd "$REPO_DIR"
            git pull origin "$GITHUB_BRANCH" || log_warn "No se pudo actualizar"
        fi
    else
        log_ok "Clonando: git@github.com:${GITHUB_OWNER}/${GITHUB_REPO}.git"

        # Usar SSH o HTTPS
        git clone -b "$GITHUB_BRANCH" \
            "git@github.com:${GITHUB_OWNER}/${GITHUB_REPO}.git" \
            "$REPO_DIR" || \
            git clone -b "$GITHUB_BRANCH" \
                "https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git" \
                "$REPO_DIR" || \
            log_error "Fallo al clonar repositorio"

        log_ok "Repositorio clonado: $REPO_DIR"
    fi

    cd "$REPO_DIR"
fi

###############################################################################
# PASO 5: Crear AWS EC2 Key Pair
###############################################################################
log_section "PASO 5: Creando AWS EC2 Key Pair"

# Verificar si ya existe
if aws ec2 describe-key-pairs \
    --key-names "$SSH_KEY_NAME" \
    --region "$AWS_REGION" &> /dev/null; then
    log_ok "Key pair ya existe en AWS: $SSH_KEY_NAME"
else
    log_ok "Importando SSH public key a AWS EC2..."

    # Importar clave pública a AWS
    aws ec2 import-key-pair \
        --key-name "$SSH_KEY_NAME" \
        --public-key-material "$(cat "$SSH_PUBLIC_KEY")" \
        --region "$AWS_REGION" > /dev/null || \
        log_error "Fallo al importar key pair a AWS"

    log_ok "Key pair importado: $SSH_KEY_NAME"
fi

###############################################################################
# PASO 6: Crear archivo de parámetros para CloudFormation
###############################################################################
log_section "PASO 6: Preparando CloudFormation parameters"

mkdir -p "$CLOUDFORMATION_DIR"

cat > "$CLOUDFORMATION_DIR/parameters.json" << EOF
[
  {
    "ParameterKey": "ProjectName",
    "ParameterValue": "$PROJECT_NAME"
  },
  {
    "ParameterKey": "Environment",
    "ParameterValue": "$ENVIRONMENT"
  },
  {
    "ParameterKey": "OwnerName",
    "ParameterValue": "$OWNER_NAME"
  },
  {
    "ParameterKey": "CostCenter",
    "ParameterValue": "$COST_CENTER"
  },
  {
    "ParameterKey": "InstanceType",
    "ParameterValue": "$EC2_INSTANCE_TYPE"
  },
  {
    "ParameterKey": "MinSize",
    "ParameterValue": "$EC2_MIN_SIZE"
  },
  {
    "ParameterKey": "MaxSize",
    "ParameterValue": "$EC2_MAX_SIZE"
  },
  {
    "ParameterKey": "DesiredCapacity",
    "ParameterValue": "$EC2_DESIRED_SIZE"
  },
  {
    "ParameterKey": "KeyName",
    "ParameterValue": "$SSH_KEY_NAME"
  },
  {
    "ParameterKey": "DBInstanceType",
    "ParameterValue": "$DB_INSTANCE_TYPE"
  },
  {
    "ParameterKey": "DBStorageSize",
    "ParameterValue": "$DB_STORAGE_SIZE"
  },
  {
    "ParameterKey": "DBPassword",
    "ParameterValue": "$DB_PASSWORD"
  },
  {
    "ParameterKey": "DBEngineVersion",
    "ParameterValue": "$DB_ENGINE_VERSION"
  },
  {
    "ParameterKey": "AppPort",
    "ParameterValue": "$APP_PORT"
  },
  {
    "ParameterKey": "GitHubRepo",
    "ParameterValue": "https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git"
  },
  {
    "ParameterKey": "GitHubBranch",
    "ParameterValue": "$GITHUB_BRANCH"
  },
  {
    "ParameterKey": "NodeVersion",
    "ParameterValue": "$NODE_VERSION"
  },
  {
    "ParameterKey": "EnableCloudWatchLogs",
    "ParameterValue": "$ENABLE_CLOUDWATCH_LOGS"
  }
]
EOF

log_ok "Parámetros guardados: $CLOUDFORMATION_DIR/parameters.json"

###############################################################################
# PASO 7: Desplegar CloudFormation
###############################################################################
log_section "PASO 7: Desplegando CloudFormation stacks"

echo ""
echo "Los siguientes stacks serán desplegados:"
echo "  1. VPC Stack:  $VPC_STACK_NAME"
echo "  2. RDS Stack:  $RDS_STACK_NAME"
echo "  3. EC2 Stack:  $EC2_STACK_NAME"
echo ""
read -p "¿Continuar con el despliegue? (y/n) " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cancelado."
    exit 0
fi

# Guardar script de deploy
cat > "$SCRIPTS_DIR/deploy-cf.sh" << 'DEPLOY_SCRIPT'
#!/bin/bash
source "$(dirname "$0")/../cloudshell-vars.env"

log_deploy() {
    echo -e "${GREEN}[CF]${NC} $1"
}

# Crear/Actualizar stacks
log_deploy "Desplegando VPC stack..."
aws cloudformation deploy \
    --template-file "$CLOUDFORMATION_DIR/vpc-stack.yaml" \
    --stack-name "$VPC_STACK_NAME" \
    --region "$AWS_REGION" \
    --no-fail-on-empty-changeset \
    --parameter-overrides \
        ProjectName="$PROJECT_NAME" \
        Environment="$ENVIRONMENT" \
    || echo "VPC stack actualizado"

log_deploy "Desplegando RDS stack..."
aws cloudformation deploy \
    --template-file "$CLOUDFORMATION_DIR/rds-stack.yaml" \
    --stack-name "$RDS_STACK_NAME" \
    --region "$AWS_REGION" \
    --parameter-overrides \
        ProjectName="$PROJECT_NAME" \
        Environment="$ENVIRONMENT" \
        DBInstanceType="$DB_INSTANCE_TYPE" \
        DBStorageSize="$DB_STORAGE_SIZE" \
        DBPassword="$DB_PASSWORD" \
        DBEngineVersion="$DB_ENGINE_VERSION" \
    || echo "RDS stack actualizado"

log_deploy "Desplegando EC2 stack..."
aws cloudformation deploy \
    --template-file "$CLOUDFORMATION_DIR/ec2-stack.yaml" \
    --stack-name "$EC2_STACK_NAME" \
    --region "$AWS_REGION" \
    --parameter-overrides \
        ProjectName="$PROJECT_NAME" \
        Environment="$ENVIRONMENT" \
        InstanceType="$EC2_INSTANCE_TYPE" \
        KeyName="$SSH_KEY_NAME" \
        AppPort="$APP_PORT" \
    || echo "EC2 stack actualizado"

log_deploy "Todos los stacks desplegados"

###############################################################################
# Mostrar información de acceso
###############################################################################
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ DESPLIEGUE COMPLETADO - INFORMACIÓN DE ACCESO           ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Obtener outputs
ALB_DNS=\$(aws cloudformation describe-stacks \
    --stack-name "$EC2_STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==\`ALBDNSName\`].OutputValue' \
    --output text 2>/dev/null || echo "Pendiente...")

RDS_ENDPOINT=\$(aws cloudformation describe-stacks \
    --stack-name "$RDS_STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==\`RDSEndpoint\`].OutputValue' \
    --output text 2>/dev/null || echo "Pendiente...")

echo "📍 ACCESO A TU APLICACIÓN:"
echo "  HTTP:  http://\$ALB_DNS"
echo ""
echo "🔑 ACCESO SSH A EC2:"
echo "  ssh -i ~/.ssh/$SSH_KEY_NAME.pem ec2-user@\$ALB_DNS"
echo ""
echo "💾 BASE DE DATOS:"
echo "  Host:     \$RDS_ENDPOINT"
echo "  Database: $DB_NAME"
echo "  User:     $DB_USERNAME"
echo ""
echo "⏱️  NOTA: Si ves 'Pendiente...', espera 2-3 minutos más"
echo ""
echo "📚 Próximos pasos:"
echo "  1. Abre en navegador: http://\$ALB_DNS"
echo "  2. Conéctate SSH: ssh -i ~/.ssh/$SSH_KEY_NAME.pem ec2-user@\$ALB_DNS"
echo "  3. Ver logs: sudo tail -f /var/log/examlab/app.log"
echo ""
DEPLOY_SCRIPT

chmod +x "$SCRIPTS_DIR/deploy-cf.sh"

echo ""
log_ok "Setup completado exitosamente"

###############################################################################
# RESUMEN FINAL
###############################################################################
echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║              PRÓXIMOS PASOS                               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}\n"

echo "1️⃣  Revisar variables (si necesitas cambiar algo):"
echo "    nano cloudshell-vars.env"
echo ""

echo "2️⃣  Ejecutar despliegue CloudFormation:"
echo "    bash scripts/deploy-cf.sh"
echo ""

echo "3️⃣  Monitorear despliegue:"
echo "    aws cloudformation list-stacks --region $AWS_REGION"
echo ""

echo "4️⃣  Ver outputs (después de deploying):"
echo "    aws cloudformation describe-stacks --stack-name $EC2_STACK_NAME --region $AWS_REGION"
echo ""

echo "5️⃣  Conectar vía SSH:"
echo "    ssh -i $SSH_PRIVATE_KEY ec2-user@<alb-dns>"
echo ""

echo -e "${GREEN}✓ CloudShell setup completado${NC}"
