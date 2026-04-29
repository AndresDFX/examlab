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

# Validar formato de región AWS (evita pegar API key aquí por error)
if [[ ! "$AWS_REGION" =~ ^[a-z]{2,3}-[a-z]+-[0-9]+$ ]]; then
    error "Región inválida: '$AWS_REGION'. Formato esperado: us-east-1, eu-west-1, etc.
   Tip: si pegaste tu API key aquí por error, vuelve a ejecutar y pégala
   en el campo 'Google Gemini API key' (más abajo)."
fi

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}    PASO 4 de 4: Google Gemini API Key ${YELLOW}[OPCIONAL]${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo "  Solo necesario si tu proyecto Lovable usa funciones de IA"
echo "  (generación de preguntas, calificación automática, etc.)."
echo ""
echo "  Si tu proyecto NO usa IA → presiona Enter para saltar este paso."
echo ""
echo "  Si tu proyecto SÍ usa IA, necesitas una API key de Google Gemini:"
echo "    1. Ve a https://aistudio.google.com/apikey"
echo "    2. Inicia sesión con tu cuenta Google"
echo "    3. Click 'Create API key' (o 'Get API key')"
echo "    4. Selecciona o crea un Google Cloud project"
echo "    5. Copia la key (formato: AIzaSy...)"
echo "    6. Pégala abajo (la entrada está oculta por seguridad)"
echo ""
echo "    Tier gratuito: 15 requests/min, 1.500 requests/día (suficiente"
echo "    para uso de prueba y demos)."
echo ""
while true; do
    read -sp "  >>> Pega la API key de Gemini aquí (o Enter para saltar): " LOVABLE_API_KEY
    echo ""
    if [ -z "$LOVABLE_API_KEY" ]; then
        info "Saltado — funciones de IA deshabilitadas (puedes agregarla después con bash deploy.sh)"
        break
    fi
    if [[ "$LOVABLE_API_KEY" == AIzaSy* ]]; then
        success "Google Gemini API key configurada"
        break
    fi
    # Detectar inputs que claramente NO son una API key (ej. región pegada por error)
    if [[ "$LOVABLE_API_KEY" =~ ^[a-z]{2,3}-[a-z]+-[0-9]+$ ]]; then
        info "Eso parece una región AWS, no una API key. Inténtalo de nuevo."
        continue
    fi
    info "Formato no estándar de Gemini (se esperaba 'AIzaSy...')"
    read -p "  ¿Usar esta key tal cual? (s/n): " -n 1 confirm
    echo ""
    [[ "$confirm" =~ ^[Ss]$ ]] && break
    info "Reintenta..."
done

# ═══════════════════════════════════════════════════════════════════════════
# Confirmación
# ═══════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${YELLOW}Resumen:${NC}"
echo "  Proyecto: $PROJECT_NAME"
echo "  Región:   $AWS_REGION"
echo "  Cuenta:   $ACCOUNT_ID"
if [ -n "$LOVABLE_API_KEY" ]; then
    echo "  IA:       habilitada (Google Gemini)"
else
    echo "  IA:       deshabilitada (sin API key)"
fi
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
STORAGE_BUCKET="${PROJECT_NAME}-storage-${ACCOUNT_ID}-${AWS_REGION}"
S3_KEY="examlab-code-$(date +%Y%m%d%H%M%S).tar.gz"
TAR_FILE="/tmp/${S3_KEY}"

# Crear deploy bucket si no existe
if ! aws s3api head-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" 2>/dev/null; then
    step "Creando bucket de deploy: $S3_BUCKET"
    if [ "$AWS_REGION" = "us-east-1" ]; then
        aws s3api create-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" >/dev/null
    else
        aws s3api create-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" \
            --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null
    fi
    success "Deploy bucket creado"
else
    info "Deploy bucket ya existe"
fi

# Crear storage bucket si no existe (para Supabase Storage / file uploads)
if ! aws s3api head-bucket --bucket "$STORAGE_BUCKET" --region "$AWS_REGION" 2>/dev/null; then
    step "Creando storage bucket: $STORAGE_BUCKET"
    if [ "$AWS_REGION" = "us-east-1" ]; then
        aws s3api create-bucket --bucket "$STORAGE_BUCKET" --region "$AWS_REGION" >/dev/null
    else
        aws s3api create-bucket --bucket "$STORAGE_BUCKET" --region "$AWS_REGION" \
            --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null
    fi
    # Block public access (storage uses signed URLs via Supabase)
    aws s3api put-public-access-block \
        --bucket "$STORAGE_BUCKET" \
        --region "$AWS_REGION" \
        --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >/dev/null
    success "Storage bucket creado"
else
    info "Storage bucket ya existe"
fi

# Subir bootstrap.sh a S3 (lo descarga la EC2 al iniciar)
step "Subiendo bootstrap.sh..."
aws s3 cp "$SCRIPT_DIR/cloudformation/bootstrap.sh" "s3://${S3_BUCKET}/bootstrap.sh" --region "$AWS_REGION" >/dev/null
success "bootstrap.sh subido"

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
    --exclude='lovable-aws-deployment/cloudformation' \
    --exclude='lovable-aws-deployment/scripts' \
    --exclude='lovable-aws-deployment/docs' \
    --exclude='lovable-aws-deployment/*.sh' \
    --exclude='lovable-aws-deployment/*.md' \
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

# Detect if this is an update (stack exists) or fresh create
IS_UPDATE=false
if aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
    IS_UPDATE=true
    info "Stack existe — modo update (no se recreará EC2)"
else
    step "Stack nuevo — desplegando (10-15 minutos)..."
fi

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
        LovableApiKey="$LOVABLE_API_KEY" \
        StorageBucketName="$STORAGE_BUCKET" \
    --capabilities CAPABILITY_IAM \
    --no-fail-on-empty-changeset || error "Fallo el deployment"

success "Stack desplegado"

# ═══════════════════════════════════════════════════════════════════════════
# Live update si el stack ya existía (sin recrear EC2)
# ═══════════════════════════════════════════════════════════════════════════

if [ "$IS_UPDATE" = "true" ]; then
    header "Aplicando cambios en EC2 (live update)"

    INSTANCE_ID_LIVE=$(aws cloudformation describe-stacks \
        --stack-name "$STACK_NAME" \
        --region "$AWS_REGION" \
        --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
        --output text)

    step "Generando script de live-update..."

    # Write the live-update script to a temp file (avoids SSM JSON escaping issues)
    LIVE_SCRIPT="/tmp/examlab-live-update-$$.sh"
    cat > "$LIVE_SCRIPT" <<LIVEEOF
#!/bin/bash
set -e
echo "=== Live update started: \$(date) ==="

# 1. Refresh app code from S3
aws s3 cp "s3://${S3_BUCKET}/${S3_KEY}" /tmp/code.tar.gz --region "${AWS_REGION}"
rm -rf /opt/examlab.bak
cp -a /opt/examlab /opt/examlab.bak
tar -xzf /tmp/code.tar.gz -C /opt/examlab --overwrite
rm /tmp/code.tar.gz
chown -R ubuntu:ubuntu /opt/examlab

# 2. Refresh edge functions: substitute URL + inject AI fallback wrapper
if [ -d /opt/examlab/supabase/functions ]; then
  for fn_dir in /opt/examlab/supabase/functions/*/; do
    [ -d "\$fn_dir" ] || continue
    fn_name=\$(basename "\$fn_dir")
    rm -rf "/opt/supabase/volumes/functions/\$fn_name"
    cp -r "\$fn_dir" "/opt/supabase/volumes/functions/\$fn_name"
  done
  find /opt/supabase/volumes/functions -name "*.ts" -exec \\
    sed -i \\
      -e 's|https://ai.gateway.lovable.dev/v1/chat/completions|https://generativelanguage.googleapis.com/v1beta/openai/chat/completions|g' \\
      -e 's|"google/gemini-|"gemini-|g' \\
      {} \\;

  # Inject AI fallback wrapper (retries with cheaper models on 429/503)
  cat > /tmp/ai-fallback-wrapper.ts <<'WRAPPEREOF'
// === [auto-injected by deploy] AI fallback wrapper ===
const _AI_ORIG_FETCH = globalThis.fetch;
const _AI_FALLBACK_MODELS = ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash", "gemini-1.5-flash-8b"];
// deno-lint-ignore no-explicit-any
globalThis.fetch = async function _aiFetch(input: any, init?: any): Promise<Response> {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (!url.includes("generativelanguage.googleapis.com") || !init?.body) {
    return _AI_ORIG_FETCH(input, init);
  }
  let body: { model?: string; [k: string]: unknown };
  try { body = JSON.parse(init.body as string); } catch { return _AI_ORIG_FETCH(input, init); }
  const original = body.model;
  const tries: string[] = [];
  if (original) tries.push(original);
  for (const m of _AI_FALLBACK_MODELS) if (!tries.includes(m)) tries.push(m);
  let lastResp: Response | null = null;
  for (const model of tries) {
    body.model = model;
    const response = await _AI_ORIG_FETCH(input, { ...init, body: JSON.stringify(body) });
    if (response.ok) {
      if (model !== original) console.log(\`[AI fallback] succeeded with \${model} (original=\${original})\`);
      return response;
    }
    if (response.status === 429 || response.status === 503) {
      console.log(\`[AI fallback] \${model} returned \${response.status}, trying next...\`);
      lastResp = response.clone();
      continue;
    }
    return response;
  }
  console.log(\`[AI fallback] all models failed (last status: \${lastResp?.status})\`);
  return lastResp ?? _AI_ORIG_FETCH(input, init);
};
// === [end auto-injected] ===
WRAPPEREOF
  for fn_file in /opt/supabase/volumes/functions/*/index.ts; do
    [ -f "\$fn_file" ] || continue
    if grep -q "generativelanguage.googleapis.com" "\$fn_file" && ! grep -q "auto-injected by deploy" "\$fn_file"; then
      tmp=\$(mktemp)
      cat /tmp/ai-fallback-wrapper.ts "\$fn_file" > "\$tmp"
      mv "\$tmp" "\$fn_file"
    fi
  done
  rm -f /tmp/ai-fallback-wrapper.ts
fi

# 3. Update LOVABLE_API_KEY in Supabase .env
LOVABLE_KEY="${LOVABLE_API_KEY}"
if [ -n "\$LOVABLE_KEY" ]; then
  if grep -q "^LOVABLE_API_KEY=" /opt/supabase/.env; then
    sed -i "s|^LOVABLE_API_KEY=.*|LOVABLE_API_KEY=\$LOVABLE_KEY|" /opt/supabase/.env
  else
    echo "LOVABLE_API_KEY=\$LOVABLE_KEY" >> /opt/supabase/.env
  fi
  # Ensure docker-compose.override.yml exposes LOVABLE_API_KEY to functions
  if ! grep -q "LOVABLE_API_KEY" /opt/supabase/docker-compose.override.yml 2>/dev/null; then
    cat > /opt/supabase/docker-compose.override.yml <<DCO
services:
  functions:
    environment:
      LOVABLE_API_KEY: "\\\${LOVABLE_API_KEY}"
DCO
  fi
fi

# 4. Restart Supabase functions container
cd /opt/supabase
docker compose up -d --force-recreate functions

# 5. Re-install npm deps if package.json changed, then restart app
if ! cmp -s /opt/examlab/package.json /opt/examlab.bak/package.json 2>/dev/null; then
  echo "package.json changed - reinstalling deps..."
  sudo -u ubuntu bash -c "cd /opt/examlab && npm install --legacy-peer-deps --no-audit --no-fund"
fi
systemctl restart examlab.service

echo "=== Live update completed: \$(date) ==="
LIVEEOF

    # Upload script to S3 and have EC2 download + execute it
    SCRIPT_KEY="live-update-$(date +%Y%m%d%H%M%S).sh"
    aws s3 cp "$LIVE_SCRIPT" "s3://${S3_BUCKET}/${SCRIPT_KEY}" --region "$AWS_REGION" >/dev/null
    rm -f "$LIVE_SCRIPT"

    step "Ejecutando live-update vía SSM..."
    CMD_ID=$(aws ssm send-command \
        --instance-ids "$INSTANCE_ID_LIVE" \
        --region "$AWS_REGION" \
        --document-name "AWS-RunShellScript" \
        --parameters "commands=[\"aws s3 cp s3://${S3_BUCKET}/${SCRIPT_KEY} /tmp/live-update.sh --region ${AWS_REGION}\",\"chmod +x /tmp/live-update.sh\",\"sudo /tmp/live-update.sh 2>&1 | tee /var/log/live-update.log\",\"rm -f /tmp/live-update.sh\"]" \
        --query 'Command.CommandId' \
        --output text 2>/dev/null || echo "")

    if [ -z "$CMD_ID" ]; then
        info "SSM send-command falló. Aplica manualmente con:"
        echo "  aws ssm start-session --target $INSTANCE_ID_LIVE --region $AWS_REGION"
        echo "  sudo aws s3 cp s3://${S3_BUCKET}/${SCRIPT_KEY} /tmp/u.sh && sudo bash /tmp/u.sh"
    else
        step "Comando enviado ($CMD_ID), esperando..."
        for i in $(seq 1 60); do
            STATUS=$(aws ssm get-command-invocation \
                --command-id "$CMD_ID" \
                --instance-id "$INSTANCE_ID_LIVE" \
                --region "$AWS_REGION" \
                --query 'Status' \
                --output text 2>/dev/null || echo "InProgress")
            case "$STATUS" in
                Success) success "Live update completado"; break ;;
                Failed|Cancelled|TimedOut)
                    info "Live update falló ($STATUS). Logs:"
                    aws ssm get-command-invocation \
                        --command-id "$CMD_ID" \
                        --instance-id "$INSTANCE_ID_LIVE" \
                        --region "$AWS_REGION" \
                        --query 'StandardErrorContent' \
                        --output text 2>/dev/null | head -30
                    break
                    ;;
            esac
            sleep 10
        done
    fi
fi

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
