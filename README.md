# ExamLab — Plataforma de Exámenes Interactivos

**Desarrolla en Lovable. Despliega en AWS con un comando.**

![Status](https://img.shields.io/badge/status-ready-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![AWS](https://img.shields.io/badge/AWS-CloudFormation-orange)

---

## 🚀 Despliegue en AWS (un solo comando)

Desde [AWS CloudShell](https://console.aws.amazon.com/cloudshell/):

```bash
git clone https://github.com/vivetori/examlab.git
cd examlab/lovable-aws-deployment
bash deploy.sh
```

Responde 4 preguntas y espera ~12-15 minutos. Al terminar tienes:

- 🌐 **App en `http://<EIP>:3000`**
- 🗄️ **Supabase self-hosted en `http://<EIP>:8000`**
- 🔐 Credenciales generadas en la EC2 (en `/root/examlab-credentials.txt`)

[→ Ver guía completa](lovable-aws-deployment/DEPLOYMENT_GUIDE.md)

---

## 🧠 Stack

### Frontend
- React 19 + TypeScript
- TanStack Router v1 + TanStack Start
- Vite 7
- shadcn/ui + Tailwind v4
- react-i18next + idb-keyval

### Backend (en AWS)
- Supabase self-hosted (PostgreSQL + Auth + Realtime + Storage)
- EC2 Ubuntu 22.04 con Docker Compose
- CloudFormation para infraestructura

### Plataforma de desarrollo
- Lovable.dev (gestiona Supabase automáticamente)
- Las migraciones van en `supabase/migrations/*.sql`

---

## 📁 Estructura

```
examlab/
├── src/                              ← Código de la app (React + TS)
│   ├── routes/                       ← TanStack Router
│   ├── integrations/supabase/        ← Cliente Supabase
│   ├── hooks/, lib/, utils/, ...
│
├── supabase/
│   └── migrations/                   ← SQL migrations (Lovable + AWS)
│
├── lovable-aws-deployment/           ← Despliegue AWS
│   ├── deploy.sh                     ← Script principal
│   ├── cloudformation/
│   │   └── all-in-one-stack.yaml     ← Stack único
│   ├── scripts/
│   ├── supabase/
│   ├── docs/
│   ├── README.md
│   └── DEPLOYMENT_GUIDE.md
│
├── package.json                      ← Vite, React 19
├── CLAUDE.md                         ← Notas de desarrollo
└── README.md                         ← Este archivo
```

---

## 🛠️ Desarrollo local (Lovable)

El proyecto está hospedado en **Lovable**. El flujo es:

1. Edita en Lovable o en tu IDE local
2. `git push origin main`
3. Click en **Publish** en Lovable

Lovable gestiona Supabase automáticamente y aplica las migraciones de `supabase/migrations/`.

---

## ☁️ Despliegue en AWS

Para correr la app en tu propia infraestructura AWS, usa el script en `lovable-aws-deployment/`:

| Quiero... | Lee |
|-----------|-----|
| Desplegar rápido | [lovable-aws-deployment/README.md](lovable-aws-deployment/README.md) |
| Entender qué se despliega | [lovable-aws-deployment/DEPLOYMENT_GUIDE.md](lovable-aws-deployment/DEPLOYMENT_GUIDE.md) |
| Ver la arquitectura | [lovable-aws-deployment/docs/ARCHITECTURE.md](lovable-aws-deployment/docs/ARCHITECTURE.md) |
| Solucionar un problema | [lovable-aws-deployment/docs/TROUBLESHOOTING.md](lovable-aws-deployment/docs/TROUBLESHOOTING.md) |
| Configurar CI/CD | [lovable-aws-deployment/docs/GITHUB_ACTIONS_SETUP.md](lovable-aws-deployment/docs/GITHUB_ACTIONS_SETUP.md) |

---

## ✨ Qué hace el deploy automatizado

```
CloudShell ejecuta deploy.sh
    ↓
Empaqueta el código local en tar.gz y sube a S3
    ↓
CloudFormation crea: VPC + EC2 + EIP + IAM + Security Group
    ↓
EC2 user-data automático (~10 min):
    1. Sistema + dependencias (curl, openssl, git, ...)
    2. Node.js 20 (NodeSource)
    3. Docker + Docker Compose v2
    4. Espera asociación de Elastic IP
    5. Descarga código desde S3
    6. Setup Supabase self-hosted (genera JWT keys, levanta docker compose)
    7. Aplica migraciones desde supabase/migrations/
    8. Crea .env de la app con las claves de Supabase
    9. systemd service que arranca npm run dev
    ↓
✓ App en http://<EIP>:3000
✓ Supabase en http://<EIP>:8000
```

---

## 📊 Recursos consumidos

| Recurso | Detalle | Costo aprox. |
|---------|---------|--------------|
| EC2 t3.medium | 2 vCPU, 4GB RAM, 30GB gp3 | ~$32/mes |
| Elastic IP | Asociada | $0 |
| S3 bucket | ~50 MB | ~$0.01/mes |
| CloudWatch Logs | 7 días retención | ~$0.50/mes |
| **Total** | | **~$33/mes** |

---

## ⚠️ Limitaciones de la versión de despliegue

Esta plantilla está pensada para **prototipos, demos y entornos de desarrollo en AWS**:

- ❌ Sin alta disponibilidad (instancia única)
- ❌ Sin HTTPS por defecto (puerto 80/443 abiertos pero sin certificado)
- ❌ Vite dev server (no producción optimizada)
- ❌ Puertos 3000 y 8000 abiertos al mundo

Para producción real, considera:
- ✅ Auto Scaling Group + ALB con HTTPS (ACM)
- ✅ RDS PostgreSQL (en lugar de Supabase docker)
- ✅ `npm run build` + servir con nginx
- ✅ Restringir security groups por CIDR
- ✅ Backups automáticos + multi-AZ

---

## 🤝 Soporte

- **Documentación AWS:** [lovable-aws-deployment/](lovable-aws-deployment/)
- **Troubleshooting:** [lovable-aws-deployment/docs/TROUBLESHOOTING.md](lovable-aws-deployment/docs/TROUBLESHOOTING.md)
- **Issues:** [GitHub Issues](https://github.com/vivetori/examlab/issues)

---

## 📄 Licencia

MIT — Ver [LICENSE](LICENSE)
