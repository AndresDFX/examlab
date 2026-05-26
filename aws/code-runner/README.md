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

## Permisos AWS necesarios para el deploy

El usuario o rol IAM que corra `deploy.sh` necesita estos permisos. La
política es **least-privilege** — solo permite tocar los recursos
específicos del runner (`examlab-code-runner`), no toda la cuenta.

### Atajo: política AWS managed (rápido pero más amplio)

Si tu org no es estricta con least-privilege, adjuntá estas managed
policies al usuario:

- `AmazonEC2ContainerRegistryFullAccess` — ECR (repo + push)
- `AWSLambda_FullAccess` — Lambda (function + URL)
- `AWSCloudFormationFullAccess` — CloudFormation (stack)
- `IAMFullAccess` — IAM (rol del Lambda, **demasiado amplio para prod**)
- `AmazonSSMFullAccess` — SSM Parameter Store (API key)
- `CloudWatchLogsFullAccess` — CloudWatch Logs

### Recomendado: política custom least-privilege

Una sola policy JSON para pegar en IAM. Solo permite tocar recursos
con prefijo `examlab-code-runner`. Cambiá `<ACCOUNT_ID>` y `<REGION>`
por los tuyos (o dejá `*` en `Resource` para multi-región).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AccountIdentity",
      "Effect": "Allow",
      "Action": ["sts:GetCallerIdentity"],
      "Resource": "*"
    },
    {
      "Sid": "EcrAuthLogin",
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken"],
      "Resource": "*"
    },
    {
      "Sid": "EcrRepoManagement",
      "Effect": "Allow",
      "Action": [
        "ecr:DescribeRepositories",
        "ecr:CreateRepository",
        "ecr:TagResource",
        "ecr:PutImageScanningConfiguration"
      ],
      "Resource": "arn:aws:ecr:*:<ACCOUNT_ID>:repository/examlab-code-runner"
    },
    {
      "Sid": "EcrImagePush",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:CompleteLayerUpload",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
        "ecr:DescribeImages"
      ],
      "Resource": "arn:aws:ecr:*:<ACCOUNT_ID>:repository/examlab-code-runner"
    },
    {
      "Sid": "CloudFormationStack",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplateSummary",
        "cloudformation:ValidateTemplate",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:ListChangeSets"
      ],
      "Resource": "arn:aws:cloudformation:*:<ACCOUNT_ID>:stack/examlab-code-runner/*"
    },
    {
      "Sid": "CloudFormationTemplateUpload",
      "Effect": "Allow",
      "Action": ["cloudformation:GetTemplateSummary", "cloudformation:ValidateTemplate"],
      "Resource": "*"
    },
    {
      "Sid": "LambdaFunction",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateFunction",
        "lambda:DeleteFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:GetFunctionUrlConfig",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:CreateFunctionUrlConfig",
        "lambda:UpdateFunctionUrlConfig",
        "lambda:DeleteFunctionUrlConfig",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:GetPolicy",
        "lambda:ListVersionsByFunction",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:ListTags"
      ],
      "Resource": "arn:aws:lambda:*:<ACCOUNT_ID>:function:examlab-code-runner"
    },
    {
      "Sid": "IamRoleForLambda",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PassRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
        "iam:TagRole",
        "iam:UntagRole"
      ],
      "Resource": [
        "arn:aws:iam::<ACCOUNT_ID>:role/examlab-code-runner-*",
        "arn:aws:iam::<ACCOUNT_ID>:role/ExamlabCodeRunner*"
      ]
    },
    {
      "Sid": "SsmApiKey",
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"],
      "Resource": "arn:aws:ssm:*:<ACCOUNT_ID>:parameter/examlab-code-runner/*"
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:DescribeLogGroups",
        "logs:PutRetentionPolicy",
        "logs:TagLogGroup",
        "logs:UntagLogGroup",
        "logs:TagResource",
        "logs:UntagResource",
        "logs:ListTagsForResource",
        "logs:TailLogs"
      ],
      "Resource": "arn:aws:logs:*:<ACCOUNT_ID>:log-group:/aws/lambda/examlab-code-runner*"
    }
  ]
}
```

### Cómo aplicar la política

1. IAM Console → Policies → Create policy → JSON → pegar el bloque de
   arriba (reemplazá `<ACCOUNT_ID>`) → Name: `ExamLabCodeRunnerDeploy`.
2. IAM Console → Users → tu usuario → Add permissions → Attach existing
   policy → marcar `ExamLabCodeRunnerDeploy`.
3. Si querés un rol asumible en CI (GitHub Actions / GitLab):
   - Create role → Web identity (OIDC) → attach `ExamLabCodeRunnerDeploy`.
4. Verificá: `aws sts get-caller-identity` y luego `./deploy.sh`.

### Notas

- **No incluye permisos para crear el bucket S3 que CloudFormation usa
  para staging**: `aws cloudformation deploy` lo crea silenciosamente
  en `cf-templates-<random>-<region>` y CF lo gestiona con su propio rol
  de servicio. Si tu cuenta nunca usó CloudFormation, también necesitarás
  `s3:CreateBucket`, `s3:PutObject`, `s3:GetObject` sobre
  `arn:aws:s3:::cf-templates-*`. Una vez creado el bucket, esto no se
  necesita más.
- **El runner Lambda corre con SU PROPIO rol** (creado por la
  CloudFormation stack) — ese rol solo tiene
  `AWSLambdaBasicExecutionRole` (logs). El usuario que despliega NO le
  da permisos al runner; eso lo hace CF al crear el `ExecutionRole`.
- **Region**: las policies usan `*` en region porque el deploy soporta
  multi-region via `AWS_REGION=...`. Si solo deployás en una, podés
  restringir cambiando `*` por `us-east-1` (o la tuya).

## Setup paso a paso

### Pre-requisitos

- AWS CLI configurado (`aws configure`) con un IAM user que tenga la
  policy `ExamLabCodeRunnerDeploy` (ver sección anterior).
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
