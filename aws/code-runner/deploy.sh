#!/usr/bin/env bash
# Despliega el runner de código Java a AWS.
#
# Idempotente: corre las veces que quieras. La primera crea ECR + Lambda,
# las siguientes solo actualizan la imagen del runner.
#
# Pre-reqs (en tu máquina local):
#   - aws CLI configurado (`aws configure`)
#   - docker corriendo
#   - openssl (para generar API key aleatoria)
#
# Uso:
#   ./deploy.sh                # imagen :latest
#   ./deploy.sh v1.2           # tag custom
#   AWS_REGION=sa-east-1 ./deploy.sh

set -euo pipefail

# ── Config ──
REGION="${AWS_REGION:-us-east-1}"
REPO_NAME="examlab-code-runner"
STACK_NAME="examlab-code-runner"
IMAGE_TAG="${1:-latest}"
SSM_API_KEY_NAME="/${STACK_NAME}/api-key"

# ── Cuenta + URI ──
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE_URI="${ECR_REGISTRY}/${REPO_NAME}:${IMAGE_TAG}"

echo "═══════════════════════════════════════════════════"
echo "  ExamLab — Java Code Runner deploy"
echo "═══════════════════════════════════════════════════"
echo "  Account:  ${ACCOUNT_ID}"
echo "  Region:   ${REGION}"
echo "  Image:    ${IMAGE_URI}"
echo "═══════════════════════════════════════════════════"
echo ""

# ── 1) Repositorio ECR ──
echo "▶ Asegurando ECR repository..."
aws ecr describe-repositories --repository-names "$REPO_NAME" --region "$REGION" >/dev/null 2>&1 || {
  echo "  Creando $REPO_NAME..."
  aws ecr create-repository \
    --repository-name "$REPO_NAME" \
    --region "$REGION" \
    --image-scanning-configuration scanOnPush=true \
    --tags Key=app,Value=examlab Key=component,Value=code-runner >/dev/null
}
echo "  ✓ Repositorio listo"

# ── 2) Docker login ──
echo "▶ Login Docker → ECR..."
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY" >/dev/null
echo "  ✓ Login OK"

# ── 3) Build + push imagen ──
echo "▶ Building image (linux/amd64)..."
# --platform fuerza AMD64 incluso desde Mac M1/M2 (Lambda x86_64 por defecto).
# --provenance=false reduce el tamaño del manifest.
docker build --platform linux/amd64 --provenance=false -t "$IMAGE_URI" .
echo "  ✓ Image built"

echo "▶ Pushing to ECR..."
docker push "$IMAGE_URI"
echo "  ✓ Image pushed"

# ── 4) API key en SSM (single source of truth) ──
echo "▶ Asegurando API key en SSM Parameter Store..."
API_KEY=$(aws ssm get-parameter --name "$SSM_API_KEY_NAME" --with-decryption --query 'Parameter.Value' --output text --region "$REGION" 2>/dev/null || echo "")
if [ -z "$API_KEY" ]; then
  echo "  Generando API key aleatoria..."
  API_KEY=$(openssl rand -base64 48 | tr -d '\n' | tr '/+' '_-')
  aws ssm put-parameter \
    --name "$SSM_API_KEY_NAME" \
    --type SecureString \
    --value "$API_KEY" \
    --region "$REGION" >/dev/null
  echo "  ✓ API key creada en SSM ($SSM_API_KEY_NAME)"
else
  echo "  ✓ API key existente reutilizada"
fi

# ── 5) Deploy CloudFormation ──
echo "▶ Deploying CloudFormation stack..."
aws cloudformation deploy \
  --template-file cloudformation.yml \
  --stack-name "$STACK_NAME" \
  --parameter-overrides "ImageUri=$IMAGE_URI" "ApiKey=$API_KEY" \
  --capabilities CAPABILITY_IAM \
  --region "$REGION" \
  --no-fail-on-empty-changeset

echo "  ✓ Stack OK"

# ── 6) Force-update Lambda (si solo cambió la image y CF no lo detecta) ──
# Esto es necesario porque CF solo detecta cambio si el parameter cambió.
# Si pushaste una imagen con el MISMO tag, CF ve `:latest` igual y no
# actualiza. Hacemos un update directo de la function code.
echo "▶ Forzando actualización del código Lambda..."
aws lambda update-function-code \
  --function-name examlab-code-runner \
  --image-uri "$IMAGE_URI" \
  --region "$REGION" >/dev/null
aws lambda wait function-updated --function-name examlab-code-runner --region "$REGION"
echo "  ✓ Lambda actualizada"

# ── 7) Mostrar outputs ──
echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ Deployment completo"
echo "═══════════════════════════════════════════════════"

FUNCTION_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl'].OutputValue" \
  --output text --region "$REGION")

echo ""
echo "Configura estos dos secrets en Supabase:"
echo "  Settings → Edge Function Secrets:"
echo ""
echo "  AWS_RUNNER_URL     = ${FUNCTION_URL}"
echo "  AWS_RUNNER_API_KEY = (recupéralo con:"
echo "                       aws ssm get-parameter --name $SSM_API_KEY_NAME \\"
echo "                         --with-decryption --query Parameter.Value \\"
echo "                         --output text --region $REGION)"
echo ""
echo "Después, en Admin → Configuración → Compilador:"
echo "  Selecciona 'AWS Lambda — runner propio' como provider activo."
echo ""
