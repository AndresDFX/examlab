# ExamLab — Java Code Runner en AWS Lambda

Self-hosted alternativa a OnlineCompiler.io para ejecutar código Java de
los estudiantes. Diseñada para correr 100% dentro del **AWS Always Free
tier** (sin caducidad de 12 meses).

## Dos modos

El mismo Lambda atiende dos modos según el body que reciba:

| Modo | Body | Uso | Tipo de pregunta |
|------|------|-----|------------------|
| `run` (default) | `{ sourceCode, stdin }` | Compila + ejecuta + retorna stdout/stderr | `codigo` (Java consola) |
| `gui_screenshot` | `{ sourceCode, mode: "gui_screenshot", delayMs? }` | Compila + Xvfb + ImageMagick `import` + retorna PNG base64 | `java_gui` cuando admin elige `aws_screenshot` |

El modo screenshot **no es interactivo** — el alumno solo ve la captura.
Para Swing interactivo se usa CheerpJ en el navegador (opción 1 del
documento `docs/JAVA-GUI-OPTIONS.md`). El modo screenshot existe como
alternativa sin licencia comercial (opción 2 del mismo documento).

## ¿Qué se despliega?

```
┌──────────────────────────────────────────────────────────┐
│ ECR repo `examlab-code-runner` (Always Free 500MB)       │
│ └── imagen Docker (Lambda Python + OpenJDK 21)            │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│ Lambda function `examlab-code-runner`                    │
│ - Always Free: 1M invocaciones + 400K GB-segundos/mes    │
│ - Container image (sin código en zip)                    │
│ - IAM role vacío (solo CloudWatch Logs)                  │
│ - Sin VPC (sin acceso a tu infra)                        │
│ - Timeout 30s, memoria 1024MB                            │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│ Lambda Function URL (público, sin API Gateway)           │
│ Auth: X-API-Key validado dentro del handler              │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│ CloudWatch Logs `/aws/lambda/examlab-code-runner`        │
│ Retención 7 días (5GB Always Free)                       │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│ SSM Parameter `/examlab-code-runner/api-key` (SecureStr) │
│ Para que `deploy.sh` reutilice la misma key entre runs   │
└──────────────────────────────────────────────────────────┘
```

## Costo

Always Free dentro de estos límites:

| Recurso | Free Tier | Tu uso estimado |
|---|---|---|
| Lambda invocations | 1,000,000 / mes | 30-50K (institución mediana) |
| Lambda compute | 400,000 GB-segundos / mes | 150K (5K execs × 5s × 1GB) |
| ECR image storage | 500 MB | ~450 MB (OpenJDK 21 slim) |
| CloudWatch Logs | 5 GB ingest + 5 GB storage | <1 GB con retención de 7 días |
| Function URL | Sin cuota | ∞ |
| Data egress | 100 GB / mes | Despreciable (texto stdout) |

Después del free tier:
- Lambda: $0.20 / 1M requests + $0.0000166667 / GB-segundo
- ECR: $0.10 / GB / mes
- CloudWatch: $0.50 / GB ingest

Ejemplo: 100K execs/mes × 5s × 1GB = 500K GB-segundos → te pasas del free
tier por 100K GB-segundos = **$1.67/mes**. Despreciable.

## Setup paso a paso

### Pre-requisitos

- AWS CLI configurado (`aws configure` con un IAM user que tenga permisos
  de `ecr:*`, `lambda:*`, `iam:CreateRole`, `cloudformation:*`, `logs:*`,
  `ssm:PutParameter`).
- Docker corriendo localmente.
- `openssl` (para generar la API key).

### 1) Deploy de la infraestructura

```bash
cd aws/code-runner/

# Primera vez: crea ECR + Lambda + IAM + Function URL.
# Siguientes corridas: solo actualiza la imagen.
AWS_REGION=us-east-1 ./deploy.sh
```

El script:
1. Crea el ECR repo (idempotente).
2. Build de la imagen Docker (`--platform linux/amd64`).
3. Push a ECR.
4. Genera/recupera la API key del SSM Parameter Store.
5. Despliega el stack CloudFormation.
6. Fuerza un `update-function-code` (para que tags como `:latest` se
   propaguen aunque el ImageUri no cambie en CF).
7. Muestra la `RunnerUrl` y dónde recuperar la API key.

### 2) Configurar Supabase

En Lovable / Supabase Dashboard → Edge Function Secrets, agregar:

```
AWS_RUNNER_URL     = https://xxxx.lambda-url.us-east-1.on.aws/
AWS_RUNNER_API_KEY = <recuperar con el comando de abajo>
```

Recuperar la API key:

```bash
aws ssm get-parameter \
  --name /examlab-code-runner/api-key \
  --with-decryption \
  --query Parameter.Value \
  --output text \
  --region us-east-1
```

### 3) Activar el provider en la app

`Admin → Configuración → Compilador` → selecciona
**"AWS Lambda — runner propio"** → Guardar.

A partir de ahora:
- Java se ejecuta en TU Lambda (compile errors completos con número de
  línea, sin "Internal error: code execution failed" opaco).
- Otros lenguajes (Python, C, etc.) caen automáticamente a OnlineCompiler.io
  como fallback.

## Probar manualmente

```bash
URL=$(aws cloudformation describe-stacks \
  --stack-name examlab-code-runner \
  --query "Stacks[0].Outputs[?OutputKey=='RunnerUrl'].OutputValue" \
  --output text --region us-east-1)
KEY=$(aws ssm get-parameter --name /examlab-code-runner/api-key \
  --with-decryption --query Parameter.Value --output text --region us-east-1)

curl -s -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KEY" \
  -d '{"sourceCode":"public class Main{public static void main(String[]a){System.out.println(\"hola\");}}"}'
# → {"stdout":"hola\n","stderr":"","exitCode":0,"executionTimeMs":2500}
```

Compile error real:

```bash
curl -s -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KEY" \
  -d '{"sourceCode":"public class Main{public static void main(String[]a){System.out.println(\"hola\")}}"}'
# → {"stdout":"","stderr":"Main.java:1: error: ';' expected\npublic class Main{...\n              ^\n1 error","exitCode":1,...}
```

## Seguridad

**¿Es seguro correr código de alumno en mi cuenta AWS?** Sí, con caveats:

- **Lambda corre cada invocación en una Firecracker microVM**. Es el mismo
  sandbox que AWS usa para sus propios servicios. El código del alumno
  no puede escapar al host ni a otras invocaciones.
- **El IAM role del Lambda está vacío** (solo `AWSLambdaBasicExecutionRole`
  que es CloudWatch Logs). Si el alumno hace `subprocess.run("aws s3 ls")`,
  recibe AccessDenied. No tiene credenciales de IAM válidas.
- **Sin VPC attachment**: el alumno no puede hacer requests a tus RDS,
  ElastiCache, etc. internas.
- **Timeouts**: compile 15s, run 15s — bucles infinitos se matan.
- **Memoria**: 1GB en Lambda → OOM kill si pasa.
- **Tamaño del código**: 100 KB máx (zip bombs, JAR bombs, etc.).
- **Stdin**: 10 KB máx (evita ataques DoS via input).

Lo único que el alumno PODRÍA hacer:
- Llamadas HTTP de salida desde Lambda al internet público. Si te preocupa
  (exfiltración de logs, mining, etc.), agrega un Security Group restrictivo
  o limita egress en VPC (perdiendo el "sin VPC" benefit).
- Imprimir mucho stdout para llenar CloudWatch Logs. Por eso truncamos a
  50KB de salida en `app.py:_truncate()`.

## Mantenimiento

- **Actualizar OpenJDK**: cambia el `dnf install java-21-amazon-corretto-headless`
  a la versión nueva en `Dockerfile`, luego `./deploy.sh`.
- **Rotar API key**: borra el SSM Parameter y vuelve a correr `./deploy.sh`.
  La nueva key sale en el output; actualízala en Supabase Edge Function Secrets.
- **Ver logs**: `aws logs tail /aws/lambda/examlab-code-runner --follow --region us-east-1`
- **Destruir todo**: `aws cloudformation delete-stack --stack-name examlab-code-runner --region us-east-1`
  (luego borra manualmente el ECR repo y el SSM Parameter si quieres).

## Limitaciones

- **Solo Java**. Otros lenguajes caen al fallback (OnlineCompiler.io). Si
  quieres soportar Python/C/etc. en Lambda, instala los runtimes en el
  `Dockerfile` y extiende `app.py`.
- **Sin GUI/Swing**. El runner es solo stdout/stderr. Las preguntas
  `java_gui` siguen usando CheerpJ en el navegador.
- **Sin librerías externas**. No hay Maven ni Gradle — el alumno solo
  puede usar la stdlib de Java. Si necesitas JUnit u otras libs, monta
  un JAR en `/var/task/lib/` y agrégalo al classpath en `app.py`.

## Plan B si decides destruirlo

Si dejas de usar el provider, en `Admin → Configuración → Compilador`
vuelve a seleccionar `OnlineCompiler.io`. La app sigue funcionando igual.
Luego corre `aws cloudformation delete-stack` para limpiar.
