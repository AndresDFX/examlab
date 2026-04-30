#!/bin/bash
# Generic Lovable→AWS bootstrap — runs on EC2 first boot, downloaded from S3 by user-data.
# Required env (passed by CloudFormation user-data):
#   PROJECT_NAME    — name of the Lovable project (used for paths, service names, etc.)
#   S3_BUCKET       — S3 bucket holding the app code
#   S3_KEY          — S3 key for the code tarball
#   AWS_REGION      — AWS region
#   LOVABLE_API_KEY — (optional) Gemini/OpenRouter key for AI features
#   STORAGE_BUCKET  — (optional) S3 bucket for Supabase Storage
set -e
exec > >(tee -a /var/log/user-data.log) 2>&1

# Default project name if not provided (allows generic deploys to any Lovable project)
APP_NAME="${PROJECT_NAME:-lovable-app}"
APP_DIR="/opt/$APP_NAME"
APP_LOG="/var/log/$APP_NAME.log"
APP_SERVICE="$APP_NAME.service"
CRED_FILE="/root/$APP_NAME-credentials.txt"

echo "=== Bootstrap started for project: $APP_NAME at $(date) ==="

# [1/9] System dependencies + 2GB swap
echo "=== [1/9] System dependencies ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl wget unzip build-essential ca-certificates gnupg lsb-release jq openssl git ec2-instance-connect

if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

# [2/9] Node.js 20
echo "=== [2/9] Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
echo "Node: $(node --version) | npm: $(npm --version)"

# [3/9] Docker + Compose v2
echo "=== [3/9] Docker ==="
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu

# [4/9] Wait for Elastic IP
echo "=== [4/9] Waiting for Elastic IP ==="
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
PUBLIC_IP=""
for i in $(seq 1 60); do
  PUBLIC_IP=$(aws ec2 describe-addresses --filters "Name=instance-id,Values=$INSTANCE_ID" --region "$AWS_REGION" --query 'Addresses[0].PublicIp' --output text 2>/dev/null || echo "None")
  [ "$PUBLIC_IP" != "None" ] && [ -n "$PUBLIC_IP" ] && break
  sleep 5
done
# Fallback to IMDS public IP if EIP not detected
if [ "$PUBLIC_IP" = "None" ] || [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
fi
# Hard fail if still no IP — Supabase Storage breaks if URLs are 'http://:8000'
if [ -z "$PUBLIC_IP" ] || [ "$PUBLIC_IP" = "None" ]; then
  echo "FATAL: Could not determine public IP. Aborting."
  exit 1
fi
echo "Public IP: $PUBLIC_IP"

# [5/9] Download app code
echo "=== [5/9] Download app code ==="
rm -rf $APP_DIR && mkdir -p $APP_DIR
aws s3 cp "s3://$S3_BUCKET/$S3_KEY" /tmp/code.tar.gz --region "$AWS_REGION"
tar -xzf /tmp/code.tar.gz -C $APP_DIR
rm /tmp/code.tar.gz
[ -f $APP_DIR/package.json ] || { echo "ERROR: package.json missing"; exit 1; }

# [6/9] Setup Supabase self-hosted
echo "=== [6/9] Supabase setup ==="
rm -rf /opt/supabase /tmp/supabase-repo
git clone --depth 1 https://github.com/supabase/supabase.git /tmp/supabase-repo
mkdir -p /opt/supabase
cp -r /tmp/supabase-repo/docker/. /opt/supabase/
cp /tmp/supabase-repo/docker/.env.example /opt/supabase/.env
rm -rf /tmp/supabase-repo

# Generate JWT secret + signed keys (10-year validity)
JWT_SECRET=$(openssl rand -hex 32)
gen_jwt() {
  node -e "
    const c=require('crypto');
    const b=x=>Buffer.from(x).toString('base64').replace(/=+\$/,'').replace(/\+/g,'-').replace(/\//g,'_');
    const bs=x=>x.toString('base64').replace(/=+\$/,'').replace(/\+/g,'-').replace(/\//g,'_');
    const h=b(JSON.stringify({alg:'HS256',typ:'JWT'}));
    const now=Math.floor(Date.now()/1000);
    const p=b(JSON.stringify({role:'$1',iss:'supabase',iat:now,exp:now+315360000}));
    const s=bs(c.createHmac('sha256','$JWT_SECRET').update(h+'.'+p).digest());
    console.log(h+'.'+p+'.'+s);
  "
}
ANON_KEY=$(gen_jwt anon)
SERVICE_ROLE_KEY=$(gen_jwt service_role)
DB_PASS=$(openssl rand -hex 16)
DASHBOARD_PASS=$(openssl rand -hex 12)
SECRET_KEY_BASE=$(openssl rand -hex 32)
VAULT_ENC_KEY=$(openssl rand -hex 16)
LOGFLARE_API_KEY=$(openssl rand -hex 16)
LOGFLARE_PUB=$(openssl rand -hex 16)
LOGFLARE_PRIV=$(openssl rand -hex 16)

E=/opt/supabase/.env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$DB_PASS|" $E
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" $E
sed -i "s|^ANON_KEY=.*|ANON_KEY=$ANON_KEY|" $E
sed -i "s|^SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY|" $E
sed -i "s|^DASHBOARD_USERNAME=.*|DASHBOARD_USERNAME=supabase|" $E
sed -i "s|^DASHBOARD_PASSWORD=.*|DASHBOARD_PASSWORD=$DASHBOARD_PASS|" $E
sed -i "s|^SECRET_KEY_BASE=.*|SECRET_KEY_BASE=$SECRET_KEY_BASE|" $E
sed -i "s|^VAULT_ENC_KEY=.*|VAULT_ENC_KEY=$VAULT_ENC_KEY|" $E
sed -i "s|^LOGFLARE_API_KEY=.*|LOGFLARE_API_KEY=$LOGFLARE_API_KEY|" $E
sed -i "s|^LOGFLARE_PUBLIC_ACCESS_TOKEN=.*|LOGFLARE_PUBLIC_ACCESS_TOKEN=$LOGFLARE_PUB|" $E
sed -i "s|^LOGFLARE_PRIVATE_ACCESS_TOKEN=.*|LOGFLARE_PRIVATE_ACCESS_TOKEN=$LOGFLARE_PRIV|" $E
sed -i "s|^SITE_URL=.*|SITE_URL=http://$PUBLIC_IP:3000|" $E
sed -i "s|^API_EXTERNAL_URL=.*|API_EXTERNAL_URL=http://$PUBLIC_IP:8000|" $E
sed -i "s|^SUPABASE_PUBLIC_URL=.*|SUPABASE_PUBLIC_URL=http://$PUBLIC_IP:8000|" $E

# Validate URLs were written with a non-empty host (would break Storage)
if grep -qE "^(SITE_URL|API_EXTERNAL_URL|SUPABASE_PUBLIC_URL)=http://:" $E; then
  echo "FATAL: URLs in $E have empty host. PUBLIC_IP='$PUBLIC_IP'"
  exit 1
fi

# Copy migrations + edge functions from app
if [ -d $APP_DIR/supabase/migrations ]; then
  mkdir -p /opt/supabase/volumes/db/init
  cp $APP_DIR/supabase/migrations/*.sql /opt/supabase/volumes/db/init/ 2>/dev/null || true
fi
if [ -d $APP_DIR/supabase/functions ]; then
  mkdir -p /opt/supabase/volumes/functions
  for fn in $APP_DIR/supabase/functions/*/; do
    [ -d "$fn" ] || continue
    name=$(basename "$fn")
    rm -rf "/opt/supabase/volumes/functions/$name"
    cp -r "$fn" "/opt/supabase/volumes/functions/$name"
  done
  # Replace Lovable Gateway URL with Google Gemini OpenAI-compatible endpoint.
  # Lovable Gateway is internal to lovable.dev; Gemini's OpenAI endpoint accepts the same
  # request shape so the code keeps working unchanged.
  find /opt/supabase/volumes/functions -name "*.ts" -exec \
    sed -i \
      -e 's|https://ai.gateway.lovable.dev/v1/chat/completions|https://generativelanguage.googleapis.com/v1beta/openai/chat/completions|g' \
      -e 's|"google/gemini-|"gemini-|g' \
      {} \;

  # Inject AI-fallback fetch wrapper at the top of each edge function that calls Gemini.
  # When the model returns 429 (quota) or 503 (overload), the wrapper transparently
  # retries the same request with progressively cheaper/less-loaded models.
  cat > /tmp/ai-fallback-wrapper.ts <<'WRAPPEREOF'
// === [auto-injected by deploy] AI fallback wrapper ===
// Intercepts fetch() to Google Gemini. On 429/503, retries with fallback models
// in order: gemini-2.5-flash → gemini-2.0-flash → gemini-2.0-flash-lite → gemini-1.5-flash → gemini-1.5-flash-8b.
// This is transparent: the original code keeps calling fetch() and gets a successful Response.
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
      if (model !== original) console.log(`[AI fallback] succeeded with ${model} (original=${original})`);
      return response;
    }
    if (response.status === 429 || response.status === 503) {
      console.log(`[AI fallback] ${model} returned ${response.status}, trying next...`);
      lastResp = response.clone();
      continue;
    }
    return response;
  }
  console.log(`[AI fallback] all models failed (last status: ${lastResp?.status})`);
  return lastResp ?? _AI_ORIG_FETCH(input, init);
};
// === [end auto-injected] ===
WRAPPEREOF

  for fn_file in /opt/supabase/volumes/functions/*/index.ts; do
    [ -f "$fn_file" ] || continue
    if grep -q "generativelanguage.googleapis.com" "$fn_file" && \
       ! grep -q "auto-injected by deploy" "$fn_file"; then
      tmp=$(mktemp)
      cat /tmp/ai-fallback-wrapper.ts "$fn_file" > "$tmp"
      mv "$tmp" "$fn_file"
      echo "  ✓ AI fallback wrapper injected: $(basename $(dirname $fn_file))"
    fi
  done
  rm -f /tmp/ai-fallback-wrapper.ts
fi

# Inject LOVABLE_API_KEY for edge functions (accepts OpenRouter or Lovable key)
if [ -n "${LOVABLE_API_KEY:-}" ]; then
  if grep -q "^LOVABLE_API_KEY=" $E; then
    sed -i "s|^LOVABLE_API_KEY=.*|LOVABLE_API_KEY=$LOVABLE_API_KEY|" $E
  else
    echo "LOVABLE_API_KEY=$LOVABLE_API_KEY" >> $E
  fi
fi

# S3 storage backend for Supabase + AI key + override services
INSTANCE_REGION="$AWS_REGION"
cat > /opt/supabase/docker-compose.override.yml <<DCO
services:
  functions:
    environment:
      LOVABLE_API_KEY: "\${LOVABLE_API_KEY}"
DCO

if [ -n "${STORAGE_BUCKET:-}" ]; then
  # Append storage env vars to .env
  {
    echo "GLOBAL_S3_BUCKET=$STORAGE_BUCKET"
    echo "REGION=$INSTANCE_REGION"
    echo "STORAGE_BACKEND=s3"
    echo "GLOBAL_S3_PROTOCOL=https"
    echo "GLOBAL_S3_FORCE_PATH_STYLE=false"
  } >> $E
  # Override storage service to use S3 backend (uses EC2 IAM role for auth)
  cat >> /opt/supabase/docker-compose.override.yml <<DCO2
  storage:
    environment:
      STORAGE_BACKEND: s3
      GLOBAL_S3_BUCKET: "$STORAGE_BUCKET"
      REGION: "$INSTANCE_REGION"
      AWS_DEFAULT_REGION: "$INSTANCE_REGION"
      GLOBAL_S3_PROTOCOL: https
      GLOBAL_S3_FORCE_PATH_STYLE: "false"
DCO2
fi

# Start Supabase
cd /opt/supabase
docker compose pull
docker compose up -d
echo "Waiting for Supabase Kong..."
for i in $(seq 1 60); do
  curl -s -o /dev/null -w "%{http_code}" http://localhost:8000 | grep -qE "200|401|404" && break
  sleep 5
done

# [7/9] Apply migrations
echo "=== [7/9] Apply migrations ==="
if [ -d $APP_DIR/supabase/migrations ]; then
  sleep 10
  for f in $APP_DIR/supabase/migrations/*.sql; do
    [ -f "$f" ] || continue
    echo "Applying: $(basename $f)"
    docker exec -i supabase-db psql -U postgres -d postgres < "$f" || echo "WARN: $(basename $f) failed"
  done
fi

# [8/9] Configure app .env + npm install
echo "=== [8/9] Configure app ==="
cat > $APP_DIR/.env <<APPENV
VITE_SUPABASE_URL=http://$PUBLIC_IP:8000
VITE_SUPABASE_PUBLISHABLE_KEY=$ANON_KEY
VITE_SUPABASE_PROJECT_ID=$APP_NAME
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
APPENV

grep -q "^VITE_SUPABASE_URL=http" $APP_DIR/.env || { echo "ERROR: .env URL missing"; exit 1; }
grep -q "^VITE_SUPABASE_PUBLISHABLE_KEY=eyJ" $APP_DIR/.env || { echo "ERROR: .env key missing"; exit 1; }

chown -R ubuntu:ubuntu $APP_DIR
echo "Installing npm deps (3-5 min)..."
sudo -u ubuntu bash -c "cd $APP_DIR && npm install --legacy-peer-deps --no-audit --no-fund --prefer-offline" || {
  echo "ERROR: npm install failed"; free -h; df -h; exit 1
}

# [9/9] systemd service
echo "=== [9/9] systemd service ==="
cat > /etc/systemd/system/$APP_SERVICE <<SVC
[Unit]
Description=$APP_NAME Vite Dev Server
After=network.target docker.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/npm run dev -- --host 0.0.0.0 --port 3000
Restart=always
RestartSec=10
StandardOutput=append:$APP_LOG
StandardError=append:$APP_LOG

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable $APP_SERVICE
systemctl start $APP_SERVICE

# Save credentials
cat > $CRED_FILE <<CRED
===== $APP_NAME Credentials =====
Generated: $(date)
Public IP: $PUBLIC_IP
App URL: http://$PUBLIC_IP:3000
Supabase API: http://$PUBLIC_IP:8000
Supabase Studio: http://$PUBLIC_IP:8000
  Username: supabase
  Password: $DASHBOARD_PASS
Database (internal):
  Host: localhost:5432  DB: postgres  User: postgres
  Password: $DB_PASS
Keys:
  ANON_KEY: $ANON_KEY
  SERVICE_ROLE_KEY: $SERVICE_ROLE_KEY
  JWT_SECRET: $JWT_SECRET
CRED
chmod 600 $CRED_FILE

# Wait for app to respond
echo "Waiting for app..."
APP_READY=0
for i in $(seq 1 30); do
  curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 | grep -qE "200|304" && { APP_READY=1; break; }
  sleep 10
done

# Final status report
echo ""
echo "════════════════════════════════════════════════════════"
echo "  Status Report"
echo "════════════════════════════════════════════════════════"
echo "$APP_SERVICE: $(systemctl is-active $APP_SERVICE 2>/dev/null)"
echo "Listening: $(ss -tlnp 2>/dev/null | grep -cE ':3000|:8000') of 2 ports"
cd /opt/supabase && docker compose ps --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null | head -10
free -h | head -2
df -h / | tail -1
echo "════════════════════════════════════════════════════════"
[ "$APP_READY" = "1" ] && echo "  ✅ Deployment OK" || echo "  ⚠️  App not responding yet — check journalctl -u $APP_SERVICE"
echo "════════════════════════════════════════════════════════"
echo "  App:          http://$PUBLIC_IP:3000"
echo "  Supabase API: http://$PUBLIC_IP:8000"
echo "  Credentials:  sudo cat $CRED_FILE"
echo "════════════════════════════════════════════════════════"
