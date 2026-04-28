#!/bin/bash

###############################################################################
# create-github-iam-user.sh — Crear usuario IAM para GitHub Actions
#
# Ejecutar desde CloudShell:
# $ bash scripts/create-github-iam-user.sh
#
# Crea:
# 1. Usuario IAM: github-actions
# 2. Access Key para autenticación
# 3. Política CloudFormation
# 4. Instrucciones para GitHub Secrets
###############################################################################

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Funciones
log_section() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║ $1${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
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

log_info() {
    echo "  $1"
}

# Header
log_section "GitHub Actions - Crear usuario IAM"

echo "Este script creará:"
echo "  ✓ Usuario IAM: github-actions"
echo "  ✓ Access Key para autenticación"
echo "  ✓ Política CloudFormation"
echo ""

# Verificar AWS CLI
if ! command -v aws &> /dev/null; then
    log_error "AWS CLI no está instalado. Instálalo y reintenta."
fi

log_ok "AWS CLI disponible"

# Verificar credenciales
if ! aws sts get-caller-identity > /dev/null 2>&1; then
    log_error "No tienes credenciales AWS configuradas. Configuralas y reintenta."
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ACCOUNT_ARN=$(aws sts get-caller-identity --query Arn --output text)

log_ok "Credenciales AWS válidas"
log_info "Account ID: $ACCOUNT_ID"
log_info "ARN: $ACCOUNT_ARN"

###############################################################################
# Paso 1: Crear usuario IAM
###############################################################################
log_section "Paso 1: Crear usuario IAM"

USER_NAME="github-actions"

# Verificar si ya existe
if aws iam get-user --user-name "$USER_NAME" > /dev/null 2>&1; then
    log_warn "Usuario $USER_NAME ya existe"
    read -p "¿Deseas continuar? (s/n): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Ss]$ ]]; then
        exit 0
    fi
else
    echo "Creando usuario IAM: $USER_NAME"
    aws iam create-user --user-name "$USER_NAME"
    log_ok "Usuario creado: $USER_NAME"
fi

###############################################################################
# Paso 2: Crear Access Key
###############################################################################
log_section "Paso 2: Crear Access Key"

# Eliminar keys antiguas si existen
EXISTING_KEYS=$(aws iam list-access-keys --user-name "$USER_NAME" --query 'AccessKeyMetadata[].AccessKeyId' --output text)

if [ ! -z "$EXISTING_KEYS" ]; then
    log_warn "Keys existentes encontradas para $USER_NAME"
    read -p "¿Deseas eliminar keys antiguas? (s/n): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Ss]$ ]]; then
        for key in $EXISTING_KEYS; do
            echo "Eliminando key: $key"
            aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$key"
        done
        log_ok "Keys antiguas eliminadas"
    fi
fi

# Crear nuevo Access Key
echo "Creando nuevo Access Key..."
ACCESS_KEY=$(aws iam create-access-key --user-name "$USER_NAME" --output json)

ACCESS_KEY_ID=$(echo $ACCESS_KEY | jq -r '.AccessKey.AccessKeyId')
SECRET_ACCESS_KEY=$(echo $ACCESS_KEY | jq -r '.AccessKey.SecretAccessKey')

log_ok "Access Key creado"

###############################################################################
# Paso 3: Crear y aplicar política
###############################################################################
log_section "Paso 3: Crear política CloudFormation"

POLICY_NAME="GitHub-CloudFormation-Policy"

# Definir política
POLICY_DOCUMENT='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudFormationManagement",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:ListStacks",
        "cloudformation:GetTemplate",
        "cloudformation:ValidateTemplate"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EC2Management",
      "Effect": "Allow",
      "Action": [
        "ec2:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "RDSManagement",
      "Effect": "Allow",
      "Action": [
        "rds:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "IAMManagement",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PassRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:CreateInstanceProfile",
        "iam:DeleteInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:RemoveRoleFromInstanceProfile",
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:AttachUserPolicy",
        "iam:DetachUserPolicy"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ElasticLoadBalancingManagement",
      "Effect": "Allow",
      "Action": [
        "elasticloadbalancing:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AutoScalingManagement",
      "Effect": "Allow",
      "Action": [
        "autoscaling:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchManagement",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:*",
        "logs:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "S3Management",
      "Effect": "Allow",
      "Action": [
        "s3:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "KMSManagement",
      "Effect": "Allow",
      "Action": [
        "kms:CreateKey",
        "kms:DescribeKey",
        "kms:GetKeyPolicy",
        "kms:PutKeyPolicy",
        "kms:CreateAlias",
        "kms:DeleteAlias",
        "kms:ListAliases"
      ],
      "Resource": "*"
    },
    {
      "Sid": "STSGetCaller",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}'

# Aplicar política
echo "Aplicando política: $POLICY_NAME"
aws iam put-user-policy \
    --user-name "$USER_NAME" \
    --policy-name "$POLICY_NAME" \
    --policy-document "$POLICY_DOCUMENT"

log_ok "Política aplicada: $POLICY_NAME"

###############################################################################
# Paso 4: Guardar credenciales
###############################################################################
log_section "Paso 4: Credenciales generadas"

# Crear archivo de credenciales
CREDENTIALS_FILE="github-actions-credentials.txt"

cat > "$CREDENTIALS_FILE" << EOF
╔════════════════════════════════════════════════════════════╗
║  GitHub Actions - AWS Credentials                          ║
╚════════════════════════════════════════════════════════════╝

Usuario IAM: $USER_NAME
Account ID: $ACCOUNT_ID
Region: us-east-1

Access Key ID:
$ACCESS_KEY_ID

Secret Access Key:
$SECRET_ACCESS_KEY

⚠️  GUARDA ESTO SEGURO - No lo compartas ni lo commits en Git

Instrucciones para GitHub:
1. Ve a: Tu repositorio → Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Agregar estos secrets:

   Name: AWS_ACCESS_KEY_ID
   Secret: $ACCESS_KEY_ID
   → Click "Add secret"

4. Agregar segundo secret:

   Name: AWS_SECRET_ACCESS_KEY
   Secret: $SECRET_ACCESS_KEY
   → Click "Add secret"

5. Agregar tercero:

   Name: DB_PASSWORD
   Secret: Tu contraseña RDS (ej: MySecure123!)
   → Click "Add secret"

6. Verificar que el archivo existe:
   .github/workflows/deploy-aws.yml

7. Hacer push a GitHub:
   git add .github/workflows/deploy-aws.yml
   git commit -m "Add GitHub Actions workflow"
   git push origin main

8. Ver ejecución en GitHub → Actions

✓ Listo! El próximo push a main desplegará automáticamente a AWS.
EOF

log_ok "Credenciales guardadas en: $CREDENTIALS_FILE"

###############################################################################
# Mostrar resumen
###############################################################################
log_section "Resumen - Próximos pasos"

echo "✓ Usuario IAM creado: $USER_NAME"
echo "✓ Access Key generado"
echo "✓ Política CloudFormation aplicada"
echo ""
echo "📋 IMPORTANTE - Guarda tus credenciales:"
cat "$CREDENTIALS_FILE" | head -20
echo ""
echo "🔐 Credenciales completas guardadas en: $CREDENTIALS_FILE"
echo ""
echo "📚 Para más información, ver:"
echo "   docs/GITHUB_ACTIONS_SETUP.md"
echo ""

# Verificar política
echo -e "${BLUE}Verificando política...${NC}"
aws iam get-user-policy \
    --user-name "$USER_NAME" \
    --policy-name "$POLICY_NAME" > /dev/null 2>&1 && log_ok "Política verificada" || log_error "Error verificando política"

log_section "✅ Setup completado"

echo "Próximos pasos:"
echo "1. Abre el archivo: $CREDENTIALS_FILE"
echo "2. Copia las credenciales"
echo "3. Agrega los secrets en GitHub"
echo "4. Haz push a main para desplegar automáticamente"
echo ""
echo "¿Necesitas ayuda?"
echo "  → Leer: docs/GITHUB_ACTIONS_SETUP.md"
echo ""
