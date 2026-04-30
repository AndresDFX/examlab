# 🐳 Docker Deployment — ExamLab en Contenedores

**Solución completa para desplegar ExamLab localmente y a AWS con Docker.**

---

## 📋 Tabla de contenidos

1. [Inicio rápido (3 comandos)](#-inicio-rápido)
2. [Cómo funciona](#-cómo-funciona)
3. [Estructura Docker](#-estructura-docker)
4. [Despliegue a AWS](#-despliegue-a-aws)
5. [Desarrollo local](#-desarrollo-local)
6. [Comandos útiles](#-comandos-útiles)

---

## ⚡ Inicio rápido

### 1️⃣ Clonar proyecto

```bash
git clone <repo>
cd examlab
```

### 2️⃣ Configurar (responde 4 preguntas)

```bash
bash setup.sh
```

### 3️⃣ Levantar todo

```bash
docker-compose up -d
```

✅ **Listo en 2 minutos.** Accede a:
- App: http://localhost:3000
- Supabase Studio: http://localhost:8000

---

## 🔍 Cómo funciona

```
┌─────────────────────────────────────────────────────┐
│                 Docker Compose                      │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────┐  ┌──────────────┐                │
│  │ PostgreSQL  │  │ Supabase     │                │
│  │ (Base de    │  │ (Auth, API)  │                │
│  │  datos)     │  │              │                │
│  └──────┬──────┘  └──────┬───────┘                │
│         │                │                        │
│         └────────┬───────┘                        │
│                  ▼                                │
│          ┌──────────────┐                        │
│          │ Node.js App  │                        │
│          │ (ExamLab)    │                        │
│          └──────┬───────┘                        │
│                 │                                │
│          ┌──────┴──────┐                        │
│          ▼             ▼                        │
│       Nginx       Redis                        │
│      (Proxy)    (Cache)                        │
│                                                │
└─────────────────────────────────────────────────────┘

  Docker Network: examlab-network
```

### Componentes

| Servicio | Rol | Puerto |
|----------|-----|--------|
| **PostgreSQL** | Base de datos | 5432 |
| **Supabase** | Auth + API | 8000 |
| **App (Node.js)** | Aplicación ExamLab | 3000 |
| **Nginx** | Reverse proxy | 80 |
| **Redis** | Cache (opcional) | 6379 |

---

## 🐳 Estructura Docker

### Dockerfile (Multi-stage)

```dockerfile
# Build
FROM node:20-alpine AS builder
RUN npm ci && npm run build

# Runtime
FROM node:20-alpine
COPY --from=builder /app/dist ./dist
CMD ["npm", "run", "start"]
```

**Ventajas:**
- ✅ Imagen pequeña (~150MB)
- ✅ Rápida de construir
- ✅ Segura (sin código fuente)

### docker-compose.yml

Orquestra **5 servicios** con:
- ✅ Healthchecks automáticos
- ✅ Volúmenes persistentes (datos)
- ✅ Variables de entorno
- ✅ Red privada
- ✅ Restart automático

### setup.sh

Script interactivo que pregunta:
```
✓ Nombre del proyecto (default: examlab)
✓ Contraseña Postgres (mínimo 12 caracteres)
✓ Región AWS (default: us-east-1)
✓ AWS Account ID (12 dígitos)
```

Genera automáticamente:
- `.env` - Variables de entorno
- `docker-compose.override.yml` - Overrides personalizados

---

## ☁️ Despliegue a AWS

### Flujo automático

```bash
bash deploy-to-aws.sh
```

Esto:

1. ✅ **Backup automático**
   - Exporta PostgreSQL a `.sql.gz`
   - Guarda en `backups/`

2. ✅ **Configura AWS**
   - Verifica credenciales
   - Valida CloudFormation templates

3. ✅ **Despliega CloudFormation**
   - VPC + Subnets
   - RDS PostgreSQL
   - EC2 Auto Scaling
   - ALB Load Balancer

4. ✅ **Obtiene información**
   - ALB DNS
   - RDS Endpoint
   - SSH credentials

**Tiempo:** ~10-15 minutos

### Arquitectura en AWS

```
┌────────────────────────────────────────────────┐
│              AWS Region (us-east-1)            │
├────────────────────────────────────────────────┤
│                                                │
│  ┌─────────────────────────────────────────┐ │
│  │           VPC (10.0.0.0/16)             │ │
│  ├─────────────────────────────────────────┤ │
│  │                                         │ │
│  │  ┌──────────────────────────────────┐ │ │
│  │  │  ALB Load Balancer (Port 80)     │ │ │
│  │  └──────────────────────────────────┘ │ │
│  │               │                        │ │
│  │  ┌────────────┴────────────┐          │ │
│  │  ▼                         ▼          │ │
│  │ EC2 (t3.small)        EC2 (t3.small) │ │
│  │ (Auto-scaled 1-2)      (Standby)     │ │
│  │                                       │ │
│  │  ┌──────────────────────────────────┐ │ │
│  │  │     RDS PostgreSQL 15.4          │ │ │
│  │  │  (db.t3.micro, 20-100GB)        │ │ │
│  │  │  Multi-AZ, Encrypted            │ │ │
│  │  └──────────────────────────────────┘ │ │
│  │                                        │ │
│  └────────────────────────────────────────┘ │
│                                              │
└──────────────────────────────────────────────┘
```

---

## 💻 Desarrollo local

### Hot reload

Los cambios en `src/` se aplican automáticamente:

```bash
# Editar archivo
nano src/pages/Home.tsx

# La app se recarga en ~2 segundos
# Accede a: http://localhost:3000
```

### Agregar dependencias

```bash
# 1. Agregar a package.json
npm install lodash

# 2. Reconstruir imagen
docker-compose rebuild app

# 3. Reiniciar
docker-compose restart app
```

### Base de datos local

Acceder directamente:

```bash
docker-compose exec postgres psql -U postgres -d examlab
```

Hacer query:

```sql
SELECT * FROM users;
SELECT * FROM exams;
```

### Supabase Studio

Accede a: http://localhost:8000

```
Email: admin@example.com
Password: password
```

Aquí puedes:
- ✅ Ver datos en tiempo real
- ✅ Configurar políticas RLS
- ✅ Crear edge functions
- ✅ Gestionar usuarios

---

## 🛠️ Comandos útiles

### Estado de servicios

```bash
# Ver todo corriendo
docker-compose ps

# Ver logs en tiempo real
docker-compose logs -f

# Ver logs de servicio específico
docker-compose logs -f app
docker-compose logs -f postgres
docker-compose logs -f supabase
```

### Control de servicios

```bash
# Levantar todo
docker-compose up -d

# Detener todo
docker-compose down

# Reiniciar servicio
docker-compose restart app

# Reconstruir imagen
docker-compose build app
docker-compose rebuild app

# Ver estado de red
docker network inspect examlab-network
```

### Base de datos

```bash
# Exportar backup
docker-compose exec postgres pg_dump -U postgres examlab > backup.sql

# Importar backup
docker-compose exec -T postgres psql -U postgres examlab < backup.sql

# Ver size de BD
docker-compose exec postgres du -sh /var/lib/postgresql/data
```

### Limpieza

```bash
# Borrar contenedores (mantiene volúmenes)
docker-compose down

# Borrar todo incluido volúmenes (CUIDADO!)
docker-compose down -v

# Prunar imágenes no usadas
docker image prune -a

# Ver volúmenes
docker volume ls
```

---

## 📊 Monitoreo

### Healthchecks automáticos

Cada servicio se verifica cada 10 segundos:

```bash
docker-compose ps
# STATUS: healthy / running / starting / exited
```

### Logs

```bash
# Logs de app
docker-compose logs app | tail -100

# Errors en PostgreSQL
docker-compose logs postgres | grep ERROR

# Supabase startup
docker-compose logs supabase | head -50
```

### Performance

```bash
# Uso de recursos
docker stats

# Conexiones a BD
docker-compose exec postgres psql -U postgres -c "SELECT * FROM pg_stat_activity;"
```

---

## 🔐 Seguridad

### En local

- ✅ PostgreSQL: contraseña (de `.env`)
- ✅ Supabase: Email/password hardcoded (cambiar en producción)
- ✅ JWT: Secret debería ser único

### En AWS

- ✅ RDS: Encrypted (KMS)
- ✅ EC2: Acceso solo por ALB
- ✅ Secrets: En GitHub Secrets (no en código)
- ✅ SSH keys: Generadas y guardadas

### Buenas prácticas

```bash
# ✅ NO commitear .env
echo ".env" >> .gitignore

# ✅ Cambiar contraseña de Supabase antes de producción
# En: supabase/config.toml

# ✅ Rotar JWT_SECRET regularmente
# En: .env → JWT_SECRET

# ✅ Hacer backups antes de cambios importantes
bash deploy-to-aws.sh  # Hace backup automático
```

---

## 🚨 Troubleshooting

### "Port 3000 already in use"

Cambiar puerto en `.env`:

```env
APP_PORT=3001
```

Reiniciar: `docker-compose restart app`

### "PostgreSQL fails to start"

```bash
# Ver logs
docker-compose logs postgres

# Verificar volumen
docker volume ls | grep postgres

# Reintentar (borra datos)
docker-compose down -v
docker-compose up -d
```

### "Supabase not responding"

Esperar 30 segundos (setup inicial es lento):

```bash
watch docker-compose ps
# Espera a que todo sea "healthy"
```

### "App no conecta a BD"

Verificar variables de entorno:

```bash
cat .env | grep POSTGRES
docker-compose config | grep DATABASE_URL
```

### "Fallo el deploy a AWS"

```bash
# 1. Verifica credenciales
aws sts get-caller-identity

# 2. Verifica Docker está corriendo
docker-compose ps

# 3. Ver logs de deploy
cat deployment-info-*.txt
```

---

## 📚 Más información

- **Setup simple**: [SETUP_SIMPLE.md](SETUP_SIMPLE.md)
- **Arquitectura**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Troubleshooting**: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- **GitHub Actions**: [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md)

---

## 🎯 Flujo completo

```bash
# 1️⃣ Setup (1 minuto)
bash setup.sh

# 2️⃣ Levantar local (30 segundos)
docker-compose up -d

# 3️⃣ Editar código (desarrollo)
nano src/pages/Home.tsx

# 4️⃣ Ver cambios (automático)
# Abre: http://localhost:3000

# 5️⃣ Desplegar a AWS (15 minutos)
bash deploy-to-aws.sh

# 6️⃣ Acceder a producción
# URL: http://examlab-alb-xxx.us-east-1.elb.amazonaws.com
```

---

**Última actualización:** 2026-04-28

ExamLab — Despliegue sin complicaciones 🚀
