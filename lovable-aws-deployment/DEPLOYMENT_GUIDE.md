# 🚀 ExamLab — Guía completa de despliegue en AWS

Esta guía explica paso a paso cómo desplegar ExamLab en AWS desde **CloudShell**, qué hace cada componente y cómo solucionar problemas.

---

## 📋 Requisitos

- ✅ Cuenta AWS con permisos para CloudFormation, EC2, S3, IAM, VPC
- ✅ Acceso a [AWS CloudShell](https://console.aws.amazon.com/cloudshell/)
- ✅ Repo `vivetori/examlab` accesible (clonable desde CloudShell)
- ⚠️ **Si tu proyecto usa IA**: API key de Google Gemini (ver paso siguiente)
- ❌ **No** necesitas Docker, Node.js o AWS CLI en tu máquina local

---

## 🤖 Pre-requisito: Google Gemini API Key (solo si usas IA)

Si tu proyecto Lovable tiene funciones de IA (generación de preguntas con IA,
calificación automática de exámenes/talleres, etc.), debes obtener una **Google
Gemini API key** ANTES de ejecutar el deploy.

### Cómo obtener la API key

1. Ve a 👉 https://aistudio.google.com/apikey
2. Inicia sesión con tu cuenta Google
3. Click **"Create API key"** (botón azul)
4. Selecciona un Google Cloud project existente o crea uno nuevo
5. Copia la API key generada (formato: `AIzaSy...`)
6. **Guárdala temporalmente** — la pegarás cuando `deploy.sh` la pida

### Costos

Google Gemini tiene un **tier gratuito generoso**:

| Modelo | RPM | RPD | TPM |
|--------|-----|-----|-----|
| gemini-2.5-pro (free) | 5 | 100 | 250.000 |
| gemini-2.5-flash (free) | 15 | 1.500 | 1.000.000 |

> Para uso de prueba/demo, el tier gratuito es suficiente. Si esperas más volumen,
> habilita facturación en Google Cloud (los precios actuales están en
> [ai.google.dev/pricing](https://ai.google.dev/pricing)).

### ¿Mi proyecto usa IA?

Si tu app tiene alguna de estas funciones, **necesitas la key**:

- 🤖 Generar preguntas de exámenes/talleres con IA
- ✏️ Calificar respuestas/proyectos automáticamente
- 📝 Generar enunciados de proyectos
- 🔍 Cualquier botón con icono de sparkles/IA

Si tu app **no** tiene ninguna de estas funciones (solo gestiona usuarios, cursos
y exámenes manualmente), puedes saltar este paso presionando Enter cuando
`deploy.sh` pida la key.

---

## 🚀 Despliegue rápido

### Paso 1 — Abrir CloudShell

```
https://console.aws.amazon.com/cloudshell/
```

CloudShell ya tiene preinstalados: AWS CLI, git, bash, openssl. Las credenciales AWS están configuradas automáticamente.

### Paso 2 — Clonar y ejecutar

```bash
git clone https://github.com/vivetori/examlab.git
cd examlab/lovable-aws-deployment
bash deploy.sh
```

### Paso 3 — Responder

```
Nombre del proyecto [examlab]: ↵
Contraseña DB (Enter para generar): ↵      # genera una segura automáticamente
Región AWS [us-east-1]: ↵
¿Continuar? (s/n): s
```

### Paso 4 — Esperar (~12-15 minutos)

El script hace:

1. Valida AWS y obtiene cuenta
2. Busca la última AMI Ubuntu 22.04 LTS de la región
3. Crea SSH key par (se guarda en `/tmp/`)
4. Crea S3 bucket único (`<proyecto>-deploy-<cuenta>-<región>`)
5. Empaqueta el código local en `tar.gz` (excluyendo `node_modules`, `.git`, `.env`)
6. Sube el código a S3
7. Despliega CloudFormation

CloudFormation tarda ~12 minutos:
- Stack: ~3 min en crear EC2 + EIP
- User-data: ~9 min (instalación + Supabase + npm install)

---

## 🧠 Qué se despliega

### Recursos de AWS

| Recurso | Tipo | Descripción |
|---------|------|-------------|
| VPC | `10.0.0.0/16` | Red privada |
| Subnet | `10.0.1.0/24` | Pública, con IGW |
| Internet Gateway | — | Salida a internet |
| Security Group | — | Puertos 80, 443, 3000, 8000 |
| EC2 | t3.medium (4 GB RAM, 30 GB gp3) | Ubuntu 22.04 LTS |
| Elastic IP | — | IP fija |
| IAM Role | — | CloudWatch + S3 GetObject + SSM |
| S3 Bucket | — | `<proyecto>-deploy-<cuenta>-<región>` |
| CloudWatch Log Group | `/aws/ec2/<proyecto>` | Retención 7 días |

### Software dentro de la EC2

| Servicio | Puerto | Descripción |
|----------|--------|-------------|
| ExamLab (Vite dev) | 3000 | Frontend React |
| Supabase Kong API | 8000 | Gateway HTTP/REST/Auth |
| Supabase Studio | 8000 (`/`) | UI de admin |
| Supabase PostgreSQL | 5432 (interno) | Base de datos |
| Supabase Auth, Realtime, Storage, etc. | varios | Stack completo de Supabase |

---

## 🔐 Credenciales generadas

El user-data genera automáticamente:

- `JWT_SECRET` (32 bytes hex)
- `ANON_KEY` (JWT firmado con role `anon`, válido 10 años)
- `SERVICE_ROLE_KEY` (JWT firmado con role `service_role`, válido 10 años)
- `POSTGRES_PASSWORD` (16 bytes hex)
- `DASHBOARD_PASSWORD` (12 bytes hex, para el Studio de Supabase)
- `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `LOGFLARE_API_KEY` (otras claves internas)

Todas se guardan en la EC2 en `/root/examlab-credentials.txt` (modo 600, solo root).

Para obtenerlas:

```bash
aws ssm start-session --target <INSTANCE_ID> --region us-east-1
sudo cat /root/examlab-credentials.txt
```

---

## 🔌 Variables de entorno de la app

El user-data crea automáticamente `/opt/examlab/.env`:

```bash
VITE_SUPABASE_URL=http://<ELASTIC_IP>:8000
VITE_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY>
VITE_SUPABASE_PROJECT_ID=examlab
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
```

El frontend Vite las lee en build/dev time vía `import.meta.env.VITE_*`.

---

## 🔄 Re-despliegue / actualización del código

Si modificas el código y quieres redesplegar:

```bash
# En CloudShell
cd ~/examlab
git pull   # o pega tus cambios localmente

cd lovable-aws-deployment
bash deploy.sh
```

`deploy.sh` re-empaqueta y re-sube el código a S3, y CloudFormation hace `update-stack`. Si sólo cambia el código (no los parámetros), no recrea la EC2 — pero tampoco re-ejecuta el user-data automáticamente. Para forzar re-ejecución:

```bash
# Eliminar y volver a crear
aws cloudformation delete-stack --stack-name examlab-stack --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name examlab-stack --region us-east-1
bash deploy.sh
```

O solo actualizar la app sin reiniciar Supabase, conectándote a la EC2:

```bash
aws ssm start-session --target <INSTANCE_ID> --region us-east-1
cd /opt/examlab
sudo aws s3 cp s3://<bucket>/<key> /tmp/code.tar.gz
sudo tar -xzf /tmp/code.tar.gz -C /opt/examlab
sudo systemctl restart examlab.service
```

---

## ✅ Verificación post-deploy

### 1. La app responde

```bash
curl -I http://<ELASTIC_IP>:3000
# HTTP/1.1 200 OK
```

### 2. Supabase Kong responde

```bash
curl http://<ELASTIC_IP>:8000
# {"message":"no Route matched..."} ← esperado, significa Kong vivo
```

### 3. Login en Studio

Abre `http://<ELASTIC_IP>:8000` en el navegador. Login con `supabase` / `<DASHBOARD_PASSWORD>`.

### 4. Verifica migraciones aplicadas

En el Studio → SQL Editor, ejecuta:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

Deberías ver las tablas del proyecto.

---

## 🆘 Troubleshooting

### La app muestra "Missing Supabase environment variables"

El user-data falló al crear `/opt/examlab/.env`. Verifica:

```bash
aws ssm start-session --target <INSTANCE_ID> --region us-east-1
sudo cat /opt/examlab/.env
sudo grep -A3 "Configuring ExamLab" /var/log/user-data.log
sudo systemctl restart examlab.service
```

### Supabase no levanta

```bash
cd /opt/supabase
sudo docker compose ps
sudo docker compose logs --tail 50 kong
sudo docker compose logs --tail 50 db
```

Causas comunes:
- **Falta de RAM**: t3.small (2 GB) no funciona, usa al menos t3.medium (4 GB).
- **Falta de disco**: revisa con `df -h`. Si el `/` está al 90%+, aumenta el `BlockDeviceMappings`.

### El user-data falló a mitad

```bash
sudo tail -100 /var/log/user-data.log
```

Identifica el paso que falló (`[1/9]` … `[9/9]`) y revisa la causa.

### El stack falla en CREATE

```bash
aws cloudformation describe-stack-events \
  --stack-name examlab-stack \
  --region us-east-1 \
  --query 'StackEvents[?ResourceStatus==`CREATE_FAILED`]'
```

Errores típicos:
- **`AMIId not found`**: la AMI dynamic search falló. Re-ejecuta `deploy.sh`.
- **`KeyName not found`**: borra y recrea: `aws ec2 delete-key-pair --key-name <name>`.
- **`Bucket already exists`**: alguien usó ese nombre globalmente. Cambia el `PROJECT_NAME`.

---

## 🧹 Eliminar todo

```bash
# Eliminar stack
aws cloudformation delete-stack --stack-name examlab-stack --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name examlab-stack --region us-east-1

# Eliminar bucket S3 (opcional, cobra ~$0.05/mes)
BUCKET=$(aws s3 ls | grep examlab-deploy | awk '{print $3}')
aws s3 rm "s3://$BUCKET" --recursive
aws s3api delete-bucket --bucket "$BUCKET" --region us-east-1

# Eliminar SSH key (opcional)
aws ec2 delete-key-pair --key-name examlab-key --region us-east-1
```

---

## 💰 Costos estimados (us-east-1)

| Recurso | Costo aproximado |
|---------|------------------|
| EC2 t3.medium (24/7) | ~$30/mes |
| EBS 30GB gp3 | ~$2.4/mes |
| Elastic IP (asociada) | $0 |
| Elastic IP (sin asociar) | ~$3.6/mes |
| S3 bucket (~50MB) | ~$0.01/mes |
| CloudWatch Logs (7 días) | ~$0.50/mes |
| **Total estimado** | **~$33/mes** |

> Si paras la EC2 sin eliminar el stack, sigues pagando la EIP (~$3.6/mes). Mejor `delete-stack` cuando no se use.

---

## 📚 Más

- [README.md](README.md) — Inicio rápido
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Detalles de arquitectura
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Más casos
- [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md) — Deploy automático con CI/CD
