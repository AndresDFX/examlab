# ExamLab — Plataforma de Exámenes Interactivos

**Desarrolla localmente con Docker. Despliega a AWS con un comando.**

![Status](https://img.shields.io/badge/status-ready-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Docker](https://img.shields.io/badge/docker-required-blue)

---

## 🚀 Inicio rápido

### Local (desarrollo)
```bash
bash setup.sh
docker-compose up -d
# → http://localhost:3000
```

### AWS (producción)
```bash
bash lovable-aws-deployment/deploy-cloudshell-only.sh
# → Responde 4 preguntas
# → En 20-30 minutos en AWS
```

---

## 📁 Estructura del proyecto

```
examlab/
├── Desarrollo local (Docker)
│   ├── setup.sh                      ← Setup interactivo
│   ├── Dockerfile                    ← Imagen Docker
│   ├── docker-compose.yml            ← 5 servicios
│   ├── .env.example                  ← Variables
│   ├── nginx.conf                    ← Reverse proxy
│   ├── GETTING_STARTED.md            ← Guía rápida
│   ├── SETUP_SIMPLE.md               ← Paso a paso
│   └── DOCKER_DEPLOYMENT.md          ← Docker referencia
│
└── AWS Deployment (CloudFormation)
    └── lovable-aws-deployment/       ← TODO aquí
        ├── deploy-cloudshell-only.sh ← Deploy desde CloudShell
        ├── deploy-to-aws.sh          ← Deploy local
        ├── cloudformation/           ← VPC, RDS, EC2
        ├── scripts/                  ← IAM, backups, etc
        ├── supabase/                 ← Config BD
        ├── docs/                     ← Documentación
        └── DEPLOYMENT_GUIDE.md       ← Guía completa
```

---

## 📖 Documentación

### Para empezar
- **[GETTING_STARTED.md](GETTING_STARTED.md)** — ¡Empieza aquí! (5 min)
- **[SETUP_SIMPLE.md](SETUP_SIMPLE.md)** — Paso a paso (10 min)

### Para desplegar
- **[lovable-aws-deployment/DEPLOYMENT_GUIDE.md](lovable-aws-deployment/DEPLOYMENT_GUIDE.md)** — Guía completa
- **[CLOUDSHELL_QUICK_START.md](CLOUDSHELL_QUICK_START.md)** — CloudShell específicamente

### Para desarrollo
- **[DOCKER_DEPLOYMENT.md](DOCKER_DEPLOYMENT.md)** — Docker profundo
- **[README_DOCKER.md](README_DOCKER.md)** — Resumen ejecutivo

### Para AWS
- **[lovable-aws-deployment/docs/ARCHITECTURE.md](lovable-aws-deployment/docs/ARCHITECTURE.md)** — Arquitectura
- **[lovable-aws-deployment/docs/GITHUB_ACTIONS_SETUP.md](lovable-aws-deployment/docs/GITHUB_ACTIONS_SETUP.md)** — CI/CD
- **[lovable-aws-deployment/docs/TROUBLESHOOTING.md](lovable-aws-deployment/docs/TROUBLESHOOTING.md)** — Solucionar problemas

---

## 🎯 Opciones de despliegue

### Opción 1: Local con Docker (desarrollo)
```bash
bash setup.sh                    # Configurar
docker-compose up -d             # Levantar
# Editar código → cambios instantáneos
```
✅ Perfecto para desarrolladores
✅ Hot-reload automático
⏱️ 5 minutos

### Opción 2: CloudShell (producción)
```bash
bash lovable-aws-deployment/deploy-cloudshell-only.sh
# Responder 4 preguntas
# Esperar 20-30 minutos
```
✅ Para usuarios finales
✅ Sin Docker local
✅ Todo en AWS automático

### Opción 3: GitHub Actions (CI/CD)
```bash
bash lovable-aws-deployment/scripts/create-github-iam-user.sh
# Configurar secretos
# git push = deploy automático
```
✅ Deploy automático
✅ Historial de cambios
✅ Múltiples ambientes

---

## 🐳 Stack tecnológico

### Local
- Docker Compose (orquestación)
- PostgreSQL 15 (base de datos)
- Supabase (auth + API)
- Node.js 20 (aplicación)
- Nginx (reverse proxy)
- Redis (cache)

### AWS
- CloudFormation (infraestructura)
- VPC (networking)
- RDS PostgreSQL (base de datos)
- EC2 Auto Scaling (compute)
- ALB (load balancer)
- CloudWatch (monitoreo)

---

## ✨ Características

- ✅ **Desarrollo sin fricción** — Setup en 5 minutos
- ✅ **Reproducible** — Idéntico local y AWS
- ✅ **Automático** — Deploy CloudShell sin Docker
- ✅ **Escalable** — Auto Scaling en AWS
- ✅ **Seguro** — Encryption, RLS, Security Groups
- ✅ **Monitoreable** — CloudWatch + logs
- ✅ **Documentado** — Guías completas

---

## 🚀 Próximos pasos

### Si estás aquí...

**Por primera vez**
→ Lee: [GETTING_STARTED.md](GETTING_STARTED.md)

**Quiero desarrollar localmente**
→ Lee: [SETUP_SIMPLE.md](SETUP_SIMPLE.md)

**Quiero desplegar a AWS**
→ Lee: [lovable-aws-deployment/DEPLOYMENT_GUIDE.md](lovable-aws-deployment/DEPLOYMENT_GUIDE.md)

**Quiero CI/CD automático**
→ Lee: [lovable-aws-deployment/docs/GITHUB_ACTIONS_SETUP.md](lovable-aws-deployment/docs/GITHUB_ACTIONS_SETUP.md)

**Tengo problemas**
→ Lee: [lovable-aws-deployment/docs/TROUBLESHOOTING.md](lovable-aws-deployment/docs/TROUBLESHOOTING.md)

---

## 📊 Estadísticas

| Métrica | Valor |
|---------|-------|
| Setup local | 5 minutos |
| Deploy a AWS | 20-30 minutos |
| Documentación | 10+ guías |
| Archivos | 50+ |
| Líneas de código | 5,000+ |
| CloudFormation templates | 3 |
| Servicios Docker | 5 |

---

## 🔗 Enlaces útiles

- **Lovable** — https://lovable.dev
- **Supabase** — https://supabase.io
- **AWS CloudFormation** — https://aws.amazon.com/cloudformation
- **Docker** — https://docker.com

---

## 📝 Notas importantes

### Para desarrolladores
- Los cambios en `src/` se reflejan al instante (hot-reload)
- El archivo `.env` no se commitea (en `.gitignore`)
- Usa `docker-compose` para levantar/detener

### Para despliegues
- Todos los scripts están en `lovable-aws-deployment/`
- Los templates CloudFormation clonan el repo y levantan Docker
- SSH keys se generan automáticamente

### Para seguridad
- Las credenciales van en `.env` (no se commitea)
- RDS está encriptada (KMS)
- EC2 solo accessible vía ALB
- Backups automáticos habilitados

---

## 💡 Tips

### Local development
```bash
# Ver logs en tiempo real
docker-compose logs -f app

# Acceder a la BD
docker-compose exec postgres psql -U postgres -d examlab

# Hacer backup
docker-compose exec postgres pg_dump -U postgres examlab > backup.sql
```

### AWS
```bash
# Ver información de acceso
bash lovable-aws-deployment/scripts/print-access-info.sh

# Monitorear
aws logs tail /aws/ec2/examlab-production --follow

# SSH a instancia
ssh -i ~/.ssh/examlab-production.pem ec2-user@<ALB-DNS>
```

---

## 🤝 Contribuir

1. Fork el repo
2. Crea una rama: `git checkout -b feature/tu-feature`
3. Commit: `git commit -m "feat: descripción"`
4. Push: `git push origin feature/tu-feature`
5. Pull Request

---

## 📄 Licencia

MIT License - Ver [LICENSE](LICENSE)

---

## 📞 Soporte

- **Documentación** → [lovable-aws-deployment/docs/](lovable-aws-deployment/docs/)
- **Troubleshooting** → [lovable-aws-deployment/docs/TROUBLESHOOTING.md](lovable-aws-deployment/docs/TROUBLESHOOTING.md)
- **Issues** → [GitHub Issues](https://github.com/vivetori/examlab/issues)

---

**Última actualización:** 2026-04-28

🚀 **¿Listo para empezar?** Lee [GETTING_STARTED.md](GETTING_STARTED.md)
