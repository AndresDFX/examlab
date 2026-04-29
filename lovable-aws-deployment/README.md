# ExamLab → AWS Deployment

Despliegue **completamente automatizado** de ExamLab en AWS desde CloudShell.

Un solo CloudFormation stack levanta:
- **EC2 Ubuntu 22.04** con Node.js 20, Docker y la app
- **Supabase self-hosted** (PostgreSQL + Auth + Studio + Realtime + Storage)
- **Elastic IP** fija
- **CloudWatch Logs**, **Session Manager**, **VPC** dedicada

---

## 🚀 Inicio rápido

### 1. Abrir AWS CloudShell

https://console.aws.amazon.com/cloudshell/

### 2. Clonar el repo y ejecutar

```bash
git clone https://github.com/vivetori/examlab.git
cd examlab/lovable-aws-deployment
bash deploy.sh
```

### 3. Responder las preguntas

```
Nombre del proyecto [examlab]: ↵
Contraseña DB (Enter para generar): ↵
Región AWS [us-east-1]: ↵
¿Continuar? (s/n): s
```

### 4. Esperar 12-15 minutos

Al terminar verás las URLs de la app y de Supabase.

---

## 🧠 Cómo funciona

```
CloudShell ejecuta deploy.sh
   ├─ Crea SSH key (por si la necesitas)
   ├─ Empaqueta el código local en tar.gz
   ├─ Sube el código a S3 bucket
   └─ Despliega CloudFormation stack

CloudFormation crea
   ├─ VPC + Subnet pública + Internet Gateway
   ├─ Security Group (puertos 80, 443, 3000, 8000)
   ├─ IAM Role (CloudWatch + S3 + SSM)
   ├─ Elastic IP fija
   └─ EC2 t3.medium (4GB RAM, 30GB disco)

EC2 user-data automático
   ├─ [1/9] Instala dependencias del sistema (curl, openssl, git…)
   ├─ [2/9] Instala Node.js 20 (NodeSource)
   ├─ [3/9] Instala Docker + Docker Compose v2
   ├─ [4/9] Espera a que la Elastic IP se asocie
   ├─ [5/9] Descarga el código desde S3
   ├─ [6/9] Setup Supabase: clona repo oficial, genera JWT keys + claves,
   │        sustituye variables del .env, levanta docker compose
   ├─ [7/9] Aplica migraciones de supabase/migrations/*.sql
   ├─ [8/9] Crea .env de la app (VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY),
   │        ejecuta npm install --legacy-peer-deps
   └─ [9/9] Crea systemd service examlab.service y arranca la app
```

---

## 📁 Estructura

```
lovable-aws-deployment/
├── deploy.sh                          ← Script principal (CloudShell)
├── cloudformation/
│   └── all-in-one-stack.yaml          ← Stack único
├── scripts/
│   ├── create-github-iam-user.sh      ← Setup GitHub Actions
│   └── init-db.sql                    ← Schema inicial (referencia)
├── supabase/
│   ├── config.toml                    ← Config local de Supabase
│   └── migrations/                    ← Migraciones SQL
├── docs/
│   ├── ARCHITECTURE.md
│   ├── GITHUB_ACTIONS_SETUP.md
│   └── TROUBLESHOOTING.md
├── README.md                          ← Este archivo
└── DEPLOYMENT_GUIDE.md                ← Guía completa
```

---

## 🔌 Acceso después del deploy

Tras el deploy verás algo como:

```
🌐 ACCESO A LA APLICACIÓN:
   URL: http://<ELASTIC_IP>:3000

🗄️  SUPABASE:
   API:    http://<ELASTIC_IP>:8000
   Studio: http://<ELASTIC_IP>:8000

🔑 CONECTAR A LA INSTANCIA (sin SSH key):
   aws ssm start-session --target <INSTANCE_ID> --region us-east-1
```

### Ver credenciales generadas

```bash
aws ssm start-session --target <INSTANCE_ID> --region us-east-1
sudo cat /root/examlab-credentials.txt
```

Allí están: `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, password de DB y password del Studio.

---

## 🔍 Verificar el despliegue

Conéctate por Session Manager y revisa:

```bash
# Estado de la app
sudo systemctl status examlab.service

# Logs de la app
sudo tail -f /var/log/examlab.log

# Logs del setup
sudo tail -f /var/log/user-data.log

# Servicios de Supabase
cd /opt/supabase && sudo docker compose ps

# Probar la app local
curl http://localhost:3000

# Probar Supabase API local
curl http://localhost:8000
```

---

## 🧹 Limpieza

```bash
aws cloudformation delete-stack --stack-name examlab-stack --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name examlab-stack --region us-east-1
```

> El bucket S3 (`examlab-deploy-<account>-<region>`) **no** se elimina automáticamente. Si quieres borrarlo:
>
> ```bash
> aws s3 rm s3://examlab-deploy-<account>-<region> --recursive
> aws s3api delete-bucket --bucket examlab-deploy-<account>-<region> --region us-east-1
> ```

---

## ⚠️ Notas

- **t3.medium** es el mínimo (Supabase necesita ~3 GB RAM en uso). Para producción real, usa `t3.large`.
- Los puertos 3000 y 8000 están abiertos al mundo (`0.0.0.0/0`). Para producción real, restringe por CIDR.
- El `npm run dev` arranca **Vite en modo dev**. Para producción real, sustituir por `npm run build` + servidor estático (nginx).
- La instancia es **única** (no hay alta disponibilidad). Para producción, usar Auto Scaling + ALB + RDS.

Esta plantilla está pensada para **prototipos, demos y entornos de desarrollo en AWS**, no para producción a escala.

---

## 📚 Más documentación

- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) — Guía completa paso a paso
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Detalles de arquitectura
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Solución de problemas
- [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md) — CI/CD automático
