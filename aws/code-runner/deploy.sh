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
#   ./deploy.sh                # build con cache + push :latest + tag único
#   ./deploy.sh v1.2           # tag custom (legacy — antes era $1)
#   ./deploy.sh --no-cache     # build sin cache (re-instala todas las deps)
#   ./deploy.sh --recreate     # destruye y recrea el stack desde cero
#   AWS_REGION=sa-east-1 ./deploy.sh
#
# Cómo se evita el "Lambda no re-pulla" cuando solo cambian capas internas:
#   Cada deploy genera un tag único `:YYYYMMDD-HHMMSS-<gitsha7>` y lo usa
#   para `update-function-code`. AWS Lambda resuelve la URI a un digest
#   inmutable y SIEMPRE re-pulla porque el digest del tag único es nuevo.
#   El tag `:latest` se mantiene en paralelo para `docker pull` manual.

set -euo pipefail

# ── Flags ──
NO_CACHE=""
RECREATE=""
CUSTOM_TAG=""
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE="--no-cache" ;;
    --recreate) RECREATE="1" ;;
    --*) echo "Flag desconocido: $arg" >&2 ; exit 1 ;;
    *) CUSTOM_TAG="$arg" ;;
  esac
done

# ── Config ──
REGION="${AWS_REGION:-us-east-1}"
REPO_NAME="examlab-code-runner"
STACK_NAME="examlab-code-runner"
# Tag único por deploy — fuerza a Lambda a re-resolver el digest. Si
# el caller pasa un tag explícito (legacy: v1.2, prod), se usa ese
# como tag "humano" pero igual generamos uno único para el deploy.
GIT_SHA="$(git rev-parse --short=7 HEAD 2>/dev/null || echo nogit)"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
UNIQUE_TAG="${TIMESTAMP}-${GIT_SHA}"
PRIMARY_TAG="${CUSTOM_TAG:-latest}"
SSM_API_KEY_NAME="/${STACK_NAME}/api-key"

# ── Cuenta + URI ──
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE_URI_PRIMARY="${ECR_REGISTRY}/${REPO_NAME}:${PRIMARY_TAG}"
IMAGE_URI_UNIQUE="${ECR_REGISTRY}/${REPO_NAME}:${UNIQUE_TAG}"

echo "═══════════════════════════════════════════════════"
echo "  ExamLab — Java Code Runner deploy"
echo "═══════════════════════════════════════════════════"
echo "  Account:       ${ACCOUNT_ID}"
echo "  Region:        ${REGION}"
echo "  Primary tag:   ${PRIMARY_TAG}"
echo "  Unique tag:    ${UNIQUE_TAG}  (forces Lambda re-pull)"
[ -n "$NO_CACHE" ] && echo "  Cache:         disabled (--no-cache)"
[ -n "$RECREATE" ] && echo "  Recreate:      YES (will delete stack first)"
echo "═══════════════════════════════════════════════════"
echo ""

# ── 0) Recrear stack (opt-in) ──
# Útil cuando un recurso quedó stale (permisos API GW, alias Lambda con
# config inválida, etc.) y un `cloudformation deploy` no lo limpia.
if [ -n "$RECREATE" ]; then
  if aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" >/dev/null 2>&1; then
    echo "▶ Destruyendo stack existente ($STACK_NAME) — esto toma ~1 min…"
    aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
    aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"
    echo "  ✓ Stack borrado"
  else
    echo "  (no había stack previo)"
  fi
fi

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

# ── 2.5) Limpieza de espacio en disco (CloudShell se llena rápido) ──
# AWS CloudShell tiene 1 GB persistente + ~10 GB efímeros. Cada build
# acumula capas/blobs en /var/lib/docker; tras 2-3 corridas explota con
# "no space left on device" justo en el último COPY del Dockerfile.
# Hacemos prune defensivo de TODO lo que Docker no esté usando ahora:
#   - contenedores detenidos
#   - imágenes dangling y no-referenciadas
#   - cache de build (BuildKit)
#   - volúmenes huérfanos
# `--force` evita el prompt; `--volumes` libera caches de buildx.
# Salida silenciosa salvo el resumen final (cuántos bytes recuperó).
echo "▶ Liberando espacio Docker (prune defensivo)…"
RECLAIMED=$(docker system prune -af --volumes 2>&1 | grep -E "^Total reclaimed|^Total:" | tail -n1 || true)
echo "  ${RECLAIMED:-(nada que limpiar)}"
# Reporte de disco disponible — útil para diagnóstico cuando el build
# pelea por bytes. CloudShell tipico: /home con ~600 MB, /tmp con ~10 GB.
DF_OUT=$(df -h / /tmp 2>/dev/null | awk 'NR>1{print "    "$NF": "$4" libres ("$5" usado)"}' || true)
[ -n "$DF_OUT" ] && echo "$DF_OUT"

# ── 3) Build + push imagen (dos tags: único + primary) ──
echo "▶ Building image (linux/amd64)..."
# --platform fuerza AMD64 incluso desde Mac M1/M2 (Lambda x86_64 por defecto).
# --provenance=false reduce el tamaño del manifest.
# Construimos UNA vez con el tag único y le agregamos el primary tag
# (típicamente :latest) — Docker no rebuildea, solo aplica otro tag al
# mismo digest.
docker build $NO_CACHE --platform linux/amd64 --provenance=false \
  -t "$IMAGE_URI_UNIQUE" .
docker tag "$IMAGE_URI_UNIQUE" "$IMAGE_URI_PRIMARY"
echo "  ✓ Image built"

echo "▶ Pushing tags a ECR (${UNIQUE_TAG} + ${PRIMARY_TAG})…"
docker push "$IMAGE_URI_UNIQUE"
docker push "$IMAGE_URI_PRIMARY"
echo "  ✓ Imágenes pushed"

# ── 3.5) Limpieza post-push para liberar el disco antes del siguiente deploy ──
# La imagen ya está en ECR — los layers locales no se necesitan más para
# esta corrida. En CloudShell esto es la diferencia entre poder deployar
# 3 veces seguidas o que la 2da falle con "no space left on device".
# Solo limpiamos lo que NO esté tageado en uso (`-f dangling=true` por
# defecto en prune con flag).
echo "▶ Limpieza post-push de capas locales…"
docker image prune -f >/dev/null 2>&1 || true
echo "  ✓ Capas dangling removidas"

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
# Pasamos el tag ÚNICO como ImageUri para que CF detecte el cambio (de
# otro modo, con :latest el manifest hash no cambia y CF salta el deploy).
echo "▶ Deploying CloudFormation stack..."
aws cloudformation deploy \
  --template-file cloudformation.yml \
  --stack-name "$STACK_NAME" \
  --parameter-overrides "ImageUri=$IMAGE_URI_UNIQUE" "ApiKey=$API_KEY" \
  --capabilities CAPABILITY_IAM \
  --region "$REGION" \
  --no-fail-on-empty-changeset

echo "  ✓ Stack OK"

# ── 6) Force-update Lambda con el tag ÚNICO ──
# Aunque CF deploy actualice la function, hacemos un update-function-code
# explícito con la URI del tag único: AWS Lambda resuelve el tag a un
# digest concreto y siempre re-pulla cuando ese digest es nuevo. Esto
# elimina el modo de falla "pushé pero Lambda sigue corriendo el digest
# viejo" que ocurría con :latest.
echo "▶ Forzando actualización del código Lambda con tag único…"
aws lambda update-function-code \
  --function-name examlab-code-runner \
  --image-uri "$IMAGE_URI_UNIQUE" \
  --region "$REGION" >/dev/null
aws lambda wait function-updated --function-name examlab-code-runner --region "$REGION"
echo "  ✓ Lambda actualizada al digest del tag ${UNIQUE_TAG}"

# ── 7) Mostrar outputs ──
echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ Deployment completo"
echo "═══════════════════════════════════════════════════"

RUNNER_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='RunnerUrl'].OutputValue" \
  --output text --region "$REGION")

# ── 8) Pre-warm + self-test ──
# Cold start del container + JVM init de javac toma ~5-10s. Hacemos un
# "ping" descartable PRIMERO para absorber el cold start; el self-test
# real corre sobre el container ya caliente y mide el caso de uso real
# (warm = lo que verá el alumno cuando no es la primera del día).
echo ""
echo "▶ Pre-warm del Lambda (absorbe cold start de ~5-10s)..."
PREWARM_BODY=$(cat <<'EOF'
{"sourceCode":"public class Main{public static void main(String[] a){System.out.println(\"warmup\");}}"}
EOF
)
PREWARM_STATUS=$(curl -s -o /tmp/runner-prewarm.out -w "%{http_code}" \
  --max-time 55 \
  -X POST "$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='RunnerUrl'].OutputValue" \
    --output text --region "$REGION")" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d "$PREWARM_BODY" || echo "000")
PREWARM_RESP=$(cat /tmp/runner-prewarm.out 2>/dev/null || echo "")
rm -f /tmp/runner-prewarm.out
echo "  Pre-warm status: $PREWARM_STATUS"
if [ "$PREWARM_STATUS" = "200" ] && echo "$PREWARM_RESP" | grep -q 'warmup'; then
  echo "  ✓ Pre-warm OK"
elif [ "$PREWARM_STATUS" = "200" ]; then
  echo "  ⚠ Pre-warm devolvió 200 pero el output es inesperado:"
  echo "    $PREWARM_RESP"
fi

echo ""
echo "▶ Self-test contra el endpoint (medición warm, debería ser <2s)..."
SELFTEST_BODY=$(cat <<'EOF'
{"sourceCode":"public class Main{public static void main(String[] a){System.out.println(\"selftest\");}}"}
EOF
)
SELFTEST_STATUS=$(curl -s -o /tmp/runner-selftest.out -w "%{http_code}" \
  -X POST "$RUNNER_URL" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d "$SELFTEST_BODY" || echo "000")
SELFTEST_RESP=$(cat /tmp/runner-selftest.out 2>/dev/null || echo "")

case "$SELFTEST_STATUS" in
  200)
    if echo "$SELFTEST_RESP" | grep -q 'selftest'; then
      echo "  ✓ Self-test OK — el endpoint compila y ejecuta Java"
    else
      echo "  ⚠ HTTP 200 pero el output es inesperado:"
      echo "    $SELFTEST_RESP"
    fi
    ;;
  401)
    echo "  ✗ HTTP 401 — el X-API-Key no fue validado por el handler."
    echo "    Verifica que API_KEY env var del Lambda coincida con la del SSM."
    echo "    Response: $SELFTEST_RESP"
    ;;
  403)
    echo "  ✗ HTTP 403 — API Gateway rechazó la request. Causas comunes:"
    echo "    1) La permission entre API GW y Lambda aún no propagó (espera 30s y reintenta)."
    echo "    2) El stack se actualizó pero algún recurso quedó stale."
    echo "       Solución: \"aws cloudformation delete-stack --stack-name $STACK_NAME --region $REGION\""
    echo "                 y luego re-correr ./deploy.sh"
    echo "    Response: $SELFTEST_RESP"
    ;;
  404)
    echo "  ✗ HTTP 404 — la ruta /run no existe en la API."
    echo "    Verifica que el output RunnerUrl termine en /run."
    ;;
  500|502|503|504)
    echo "  ✗ HTTP $SELFTEST_STATUS — error del Lambda (no llegó al provider o crashed)."
    echo "    Revisa CloudWatch: aws logs tail /aws/lambda/examlab-code-runner --since 5m --region $REGION"
    echo "    Response: $SELFTEST_RESP"
    ;;
  000)
    echo "  ✗ Sin conectividad al endpoint. Verifica que $RUNNER_URL sea válido."
    ;;
  *)
    echo "  ⚠ HTTP $SELFTEST_STATUS inesperado:"
    echo "    $SELFTEST_RESP"
    ;;
esac
rm -f /tmp/runner-selftest.out

# ── 9) Self-test GUI (modo gui_screenshot) ──
# Atrapa el "UnsatisfiedLinkError: libawt_xawt.so" ANTES de que el alumno
# lo vea. El runner debe:
#   - arrancar Xvfb,
#   - cargar libawt_xawt.so (← este es el .so que requiere libXi/libXtst/etc.),
#   - pintar el JFrame,
#   - capturar el PNG con `import`.
# Si cualquiera de esos pasos falla, la respuesta no tiene screenshotBase64
# y el stderr contiene el stacktrace.
echo ""
echo "▶ Self-test GUI (modo gui_screenshot — valida deps de AWT/Xvfb)…"
GUI_TEST_SOURCE='import javax.swing.*;public class Main{public static void main(String[] a){SwingUtilities.invokeLater(()->{JFrame f=new JFrame("ok");f.setSize(200,80);f.setVisible(true);});try{Thread.sleep(800);}catch(Exception e){}}}'
GUI_TEST_BODY=$(jq -n --arg src "$GUI_TEST_SOURCE" '{mode:"gui_screenshot", sourceCode:$src, delayMs:1000}' 2>/dev/null || cat <<EOF
{"mode":"gui_screenshot","sourceCode":$(printf '%s' "$GUI_TEST_SOURCE" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),"delayMs":1000}
EOF
)
GUI_STATUS=$(curl -s -o /tmp/runner-gui.out -w "%{http_code}" \
  --max-time 30 \
  -X POST "$RUNNER_URL" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d "$GUI_TEST_BODY" || echo "000")
GUI_RESP=$(cat /tmp/runner-gui.out 2>/dev/null || echo "")
# Criterios STRICT — antes solo verificábamos que existiera
# `screenshotBase64`, pero el Lambda SIEMPRE devuelve uno (al menos un
# PNG vacío de 233 bytes del Xvfb sin ventana). Eso permitía que el
# self-test "pasara" aunque Java crasheara con UnsatisfiedLinkError. Las
# tres condiciones nuevas atrapan el caso real:
#   - exit_code = 0 → la JVM terminó normal (no crashed)
#   - png_bytes > 1000 → la captura tiene contenido real (no Xvfb vacío)
#   - sin "UnsatisfiedLinkError" o "libawt_xawt" en cualquier campo
HAS_XAWT_ERR=$(echo "$GUI_RESP" | grep -c -E 'libawt_xawt\.so|UnsatisfiedLinkError' || true)
PNG_BYTES=$(echo "$GUI_RESP" | python3 -c '
import sys, json
try:
  d = json.loads(sys.stdin.read())
  print(d.get("pngBytes", 0))
except Exception:
  print(0)
' 2>/dev/null || echo "0")
EXIT_CODE=$(echo "$GUI_RESP" | python3 -c '
import sys, json
try:
  d = json.loads(sys.stdin.read())
  print(d.get("exitCode", -1))
except Exception:
  print(-1)
' 2>/dev/null || echo "-1")

print_diagnose() {
  echo ""
  echo "▶ Ejecutando diagnose en el runtime del Lambda (mode=diagnose)…"
  DIAG_RESP=$(curl -s --max-time 20 \
    -X POST "$RUNNER_URL" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -d '{"mode":"diagnose"}' || echo "{}")
  if command -v jq >/dev/null 2>&1; then
    echo "$DIAG_RESP" | jq -r '
      "── Java -version ─────\n" + (.java_version // "") +
      "\n── libawt_xawt path ──\n" + (.libawt_xawt_path // "(no encontrado)") +
      "\n── ldd libawt_xawt.so ──\n" + (.libawt_xawt_ldd // "") +
      "\n── Listing del directorio JDK lib ──\n" + (.libawt_xawt_listing // "") +
      "\n── Libs X11 en /usr/lib64 ──\n" + (.x11_libs_present // "") +
      "\n── LD_LIBRARY_PATH ──\n" + (.ld_library_path // "(unset)") +
      "\n── JAVA_HOME ──\n" + (.java_home_env // "(unset)") +
      "\n── DISPLAY ──\n" + (.display_env // "(unset)")
    '
  else
    # Sin jq: imprimimos el JSON crudo recortado. Suficiente para copiar
    # y pegar al equipo.
    echo "$DIAG_RESP" | head -c 4000
    echo ""
  fi
}

if [ "$GUI_STATUS" = "200" ] && [ "$HAS_XAWT_ERR" -eq 0 ] && [ "$EXIT_CODE" = "0" ] && [ "$PNG_BYTES" -gt 1000 ]; then
  echo "  ✓ GUI self-test OK — exit=0, PNG=${PNG_BYTES} bytes, AWT funcional"
elif [ "$HAS_XAWT_ERR" -gt 0 ]; then
  echo "  ✗ FALLA CRÍTICA: libawt_xawt.so no cargó en el RUNTIME del Lambda."
  echo ""
  echo "    El ldd al build pasó (libs X11 estaban presentes) pero al"
  echo "    correr el Lambda el linker dinámico no las encuentra. Causas"
  echo "    posibles: paths de búsqueda distintos en Lambda, ldconfig no"
  echo "    se ejecutó, o el JDK busca en una ubicación que Lambda no"
  echo "    expone. Ejecutamos diagnose para confirmar el detalle."
  echo ""
  echo "    Stderr del Java (recortado):"
  echo "$GUI_RESP" | head -c 800
  echo ""
  print_diagnose
  echo ""
  echo "    Reintenta:"
  echo "      ./deploy.sh --no-cache   # bypass docker cache, re-instala todo"
  exit 1
elif [ "$EXIT_CODE" != "0" ] || [ "$PNG_BYTES" -le 1000 ]; then
  echo "  ✗ FALLA: el Lambda devolvió 200 pero la ejecución no produjo una ventana real."
  echo "    exit_code=$EXIT_CODE   png_bytes=$PNG_BYTES   (Xvfb vacío = 233 bytes)"
  echo ""
  echo "    ── stdout/stderr de la JVM (del handler GUI) ──"
  # Imprimimos los campos stdout, stderr, mode del response para ver
  # POR QUÉ falló el flow GUI específicamente. Antes íbamos directo a
  # `diagnose` (que solo lee el entorno) sin mostrar el stderr del run,
  # que es donde están los stacktraces de Java / mensajes de Xvfb.
  if command -v jq >/dev/null 2>&1; then
    echo "$GUI_RESP" | jq -r '
      "mode: " + (.mode // "?") + "\n" +
      "executionTimeMs: " + ((.executionTimeMs // 0) | tostring) + "\n" +
      "── stdout ──\n" + (.stdout // "(vacío)") + "\n" +
      "── stderr ──\n" + (.stderr // "(vacío)")
    '
  else
    echo "$GUI_RESP" | head -c 2000
    echo ""
  fi
  echo ""
  echo "    Diagnóstico del runtime:"
  print_diagnose
  exit 1
else
  echo "  ⚠ GUI self-test HTTP $GUI_STATUS inesperado. Revisa CloudWatch:"
  echo "    aws logs tail /aws/lambda/examlab-code-runner --since 5m --region $REGION"
  echo "    Respuesta cortada:"
  echo "$GUI_RESP" | head -c 600
  echo ""
fi
rm -f /tmp/runner-gui.out

echo ""
echo "Configura estos dos secrets en Supabase"
echo "(Lovable / Supabase Dashboard → Settings → Edge Function Secrets):"
echo ""
echo "  AWS_RUNNER_URL     = ${RUNNER_URL}"
echo "  AWS_RUNNER_API_KEY = ${API_KEY}"
echo ""
echo "Test rápido (debería devolver { stdout: 'hola\\n', ... }):"
echo ""
cat <<EOF
  curl -s -X POST "${RUNNER_URL}" \\
    -H "Content-Type: application/json" \\
    -H "X-API-Key: ${API_KEY}" \\
    -d '{"sourceCode":"public class Main{public static void main(String[] a){System.out.println(\"hola\");}}"}'
EOF
echo ""
echo "Después, en Admin → Configuración → Compilador:"
echo "  Selecciona 'AWS Lambda — runner propio' como provider activo."
echo ""
