# 📦 ExamLab — Docker-based Deployment

**Nueva solución completa: Local con Docker + AWS con CloudFormation**

> **¿Nuevo en el proyecto?** Empieza aquí: [GETTING_STARTED.md](GETTING_STARTED.md)

---

## 📋 Resumen ejecutivo

### ¿Qué obtuviste?

Una solución **3-en-1** que permite:

1. **Desarrollo local completo** — En tu máquina (PostgreSQL + Supabase + App en Docker)
2. **Despliegue a AWS automático** — Un comando, 15 minutos
3. **CI/CD con GitHub Actions** — Deploy automático en cada push (opcional)

### Requisitos mínimos

- ✅ Docker instalado ([descarga aquí](https://docker.com))
- ✅ Git instalado
- ✅ Cuenta AWS (solo para producción)
- ✅ Terminal/línea de comandos

### Tiempo de setup

- **Local:** 5 minutos (`bash setup.sh` + `docker-compose up -d`)
- **AWS:** 15 minutos (`bash deploy-to-aws.sh`)
- **CI/CD:** 10 minutos (configurar GitHub Secrets)

---

## 🚀 Inicio rápido (tl;dr)

```bash
# 1. Clonar
git clone <repo>
cd examlab

# 2. Setup (responde 4 preguntas)
bash setup.sh

# 3. Levantar (30 segundos)
docker-compose up -d

# 4. Acceder
# App: http://localhost:3000
# Supabase: http://localhost:8000
```

**Listo. Ya puedes desarrollar.**

Para producción:
```bash
bash deploy-to-aws.sh
```

---

## 📚 Documentación completa

### Documentos principales

| Doc | Propósito | Tiempo | Para quién |
|-----|-----------|--------|-----------|
| [GETTING_STARTED.md](GETTING_STARTED.md) | ¿Por dónde empiezo? | 5 min | Todos |
| [SETUP_SIMPLE.md](SETUP_SIMPLE.md) | Paso a paso muy detallado | 10 min | Principiantes |
| [DOCKER_DEPLOYMENT.md](DOCKER_DEPLOYMENT.md) | Todo sobre Docker + comandos | 20 min | Desarrolladores |
| [MIGRATION_TO_DOCKER.md](MIGRATION_TO_DOCKER.md) | Qué cambió vs antes | 10 min | Usuarios antiguos |

### Documentos de referencia

| Doc | Propósito | Para quién |
|-----|-----------|-----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Cómo funciona internamente | Arquitectos / DevOps |
| [docs/LOCAL_TO_AWS_WORKFLOW.md](docs/LOCAL_TO_AWS_WORKFLOW.md) | Flujo local → AWS | Desarrolladores |
| [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md) | Deploy automático | DevOps / CI-CD |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Resolver problemas | Todos |

---

## 🐳 Archivos Docker nuevos

```
examlab/
├─ Dockerfile                 Imagen Docker (Node.js + app)
├─ docker-compose.yml         Orquestación (5 servicios)
├─ .env.example              Template para configuración
├─ nginx.conf                Reverse proxy local
│
├─ scripts/
│  ├─ init-db.sql            Schema inicial de BD
│  └─ deploy-to-aws.sh       Deploy automático a AWS
│
└─ supabase/
   ├─ config.toml            Configuración Supabase
   └─ migrations/            SQL migrations
```

---

## 🏗️ Arquitectura

### Local (Docker Compose)

```
┌────────────────────────┐
│   docker-compose       │
├────────────────────────┤
│ PostgreSQL 15          │
│ Supabase (Auth/API)    │
│ Node.js App            │
│ Nginx (Proxy)          │
│ Redis (Cache)          │
└────────────────────────┘
```

**Acceso:**
- App: http://localhost:3000
- Supabase: http://localhost:8000
- BD: localhost:5432

### AWS (CloudFormation)

```
┌──────────────────────────┐
│ AWS Region (us-east-1)   │
├──────────────────────────┤
│ ALB (Puerto 80)          │
│ EC2 (t3.small, 1-2)      │
│ RDS (PostgreSQL 15.4)    │
│ VPC + Subnets           │
│ CloudWatch Logs         │
└──────────────────────────┘
```

**Acceso:**
- App: http://<ALB-DNS>
- BD: <RDS-Endpoint>:5432
- SSH: ssh -i ~/.ssh/examlab-production.pem ec2-user@<ALB-DNS>

---

## 🔄 Flujo de trabajo

### Desarrollo diario

```bash
# 1. Editar código
nano src/pages/Home.tsx

# 2. Ver cambios al instante (hot-reload)
# Abre http://localhost:3000

# 3. Commit y push
git add src/pages/Home.tsx
git commit -m "feat: update home page"
git push origin main

# 4. (Automático) GitHub Actions despliega a AWS
# O manual:
bash deploy-to-aws.sh
```

### Con GitHub Actions (CI/CD)

```
Editar código
    ↓
git push origin main
    ↓
GitHub Actions se ejecuta
    ↓
Valida CloudFormation
    ↓
Despliega a AWS
    ↓
App actualizada en producción
```

---

## 🛠️ Comandos Docker comunes

```bash
# Ver estado
docker-compose ps

# Ver logs
docker-compose logs -f app

# Levantar todo
docker-compose up -d

# Detener todo
docker-compose down

# Acceder a BD
docker-compose exec postgres psql -U postgres -d examlab

# Hacer backup
docker-compose exec postgres pg_dump -U postgres examlab > backup.sql

# Reconstruir después de cambios en package.json
docker-compose rebuild app
docker-compose restart app
```

---

## ☁️ Despliegue a AWS

### Requisitos

- Credenciales AWS (Access Key + Secret)
- Docker corriendo localmente (para backup automático)

### Proceso

```bash
# 1. Asegúrate que docker-compose está corriendo
docker-compose ps

# 2. Desplegar
bash deploy-to-aws.sh

# 3. Esperar 10-15 minutos
# (El script muestra progreso)

# 4. Acceder a la URL que imprime
http://examlab-alb-xxx.us-east-1.elb.amazonaws.com
```

### Qué hace el script

1. ✅ Valida que Docker está corriendo
2. ✅ Crea backup automático de PostgreSQL
3. ✅ Valida credenciales AWS
4. ✅ Valida templates CloudFormation
5. ✅ Despliega VPC Stack
6. ✅ Despliega RDS Stack
7. ✅ Despliega EC2 Stack (con Auto Scaling)
8. ✅ Obtiene información de acceso
9. ✅ Imprime resumen de deployment

---

## 🔐 Seguridad

### Localmente
- PostgreSQL protegida por contraseña (de `.env`)
- `.env` nunca se commitea (en `.gitignore`)
- Supabase en localhost solo

### En AWS
- RDS encriptada (KMS)
- EC2 solo accesible vía ALB
- SSH keys generadas automáticamente
- Credenciales en GitHub Secrets (no en código)

---

## 🚨 Troubleshooting

### Docker no inicia

```bash
# Verificar Docker está corriendo
docker ps

# Ver logs de error
docker-compose logs postgres
docker-compose logs app
```

### Puerto 3000 ocupado

```bash
# En .env, cambiar:
APP_PORT=3001

# Reiniciar:
docker-compose restart app
```

### Supabase tarda mucho

```bash
# Normal. Esperar ~30 segundos
# Ver progreso:
watch docker-compose ps

# Esperar a que todos sean "healthy"
```

### Fallo deploy a AWS

```bash
# Verificar credenciales
aws sts get-caller-identity

# Verificar Docker corriendo
docker-compose ps

# Ver logs del deploy
cat deployment-info-*.txt
```

**Más help:** [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

---

## 📊 Stack tecnológico

### Local
- **Docker Compose** v3.9 — Orquestación
- **PostgreSQL** 15 Alpine — Base de datos
- **Supabase** latest — Auth + API
- **Node.js** 20 Alpine — Runtime
- **Nginx** Alpine — Reverse proxy
- **Redis** Alpine — Cache

### AWS
- **CloudFormation** — IaC
- **VPC** — Red privada
- **EC2** t3.small — Compute (1-2 instancias)
- **RDS** PostgreSQL 15.4 — Base de datos (encrypted)
- **ALB** — Load balancer
- **Auto Scaling** — CPU-based scaling
- **CloudWatch** — Monitoring
- **KMS** — Encryption

---

## 🎯 Casos de uso

### Desarrollo local
```bash
bash setup.sh
docker-compose up -d
# → http://localhost:3000
```

### Testing antes de producción
```bash
# Hacer cambios
# docker-compose logs -f para verificar
# Probar en http://localhost:3000
```

### Desplegar a producción
```bash
bash deploy-to-aws.sh
# → App en AWS con ALB DNS
```

### Deploy automático con GitHub
```bash
# Configurar GitHub Actions (una sola vez)
bash scripts/create-github-iam-user.sh

# Luego:
git push origin main  # → Deploy automático
```

---

## 📈 Próximos pasos

### Ya funciona localmente? ✅

1. **Desarrolla localmente**
   - Edita código en `src/`
   - Ver cambios en http://localhost:3000
   - Commit y push

2. **Cuando listo, desplega a AWS**
   ```bash
   bash deploy-to-aws.sh
   ```

3. **Configura deploy automático (opcional)**
   ```bash
   bash scripts/create-github-iam-user.sh
   # Agregar secrets en GitHub
   # Próximos push = deploy automático
   ```

---

## 📞 Recursos

| Recurso | URL |
|---------|-----|
| Docker | https://docker.com |
| Docker Compose | https://docker.com/products/compose |
| Supabase | https://supabase.io |
| AWS CloudFormation | https://aws.amazon.com/cloudformation |
| GitHub Actions | https://github.com/features/actions |

---

## ✅ Checklist inicial

- [ ] Docker instalado (`docker --version`)
- [ ] Git configurado (`git config --global user.name`)
- [ ] Repo clonado (`cd examlab`)
- [ ] `bash setup.sh` ejecutado
- [ ] `docker-compose up -d` ejecutado
- [ ] App accesible en http://localhost:3000
- [ ] Supabase accesible en http://localhost:8000

**¿Todo verde?** ✅ Estás listo.

---

## 📝 Versionado

**Versión actual:** 2.0 (Docker-based)

**Versión anterior:** 1.0 (CloudShell-based)
→ Documentación en `lovable-aws-deployment/` (obsoleto pero funcional)

---

## 📄 Licencia

ExamLab © 2026 Vivetori

---

**Última actualización:** 2026-04-28

Para empezar: → [GETTING_STARTED.md](GETTING_STARTED.md)

🚀 **Bienvenido a ExamLab**
