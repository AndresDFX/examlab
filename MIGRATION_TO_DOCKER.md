# 🐳 Migración a Docker — Cambios principales

**Documento de transición:** La solución cambió de CloudShell + Scripts manuales a Docker + Automatización.

---

## 🔄 ¿Qué cambió?

### ANTES (CloudShell-based)
```
┌─ CloudShell (manual)
│  ├─ Editar variables en cloudshell-vars.env
│  ├─ Ejecutar cloudshell-setup.sh
│  ├─ Ejecutar scripts/deploy-cf.sh
│  └─ Esperar a que CloudFormation despliegue
│
└─ Luego: Editar código local y git push
```

### AHORA (Docker-based)
```
┌─ Máquina local (con Docker)
│  ├─ bash setup.sh (4 preguntas)
│  ├─ docker-compose up -d (30 seg)
│  ├─ Acceder a http://localhost:3000
│  └─ Editar código con hot-reload
│
└─ Cuando listo: bash deploy-to-aws.sh
   └─ Automático: backup + despliegue + info de acceso
```

---

## ✨ Ventajas del nuevo enfoque

| Aspecto | Antes | Ahora |
|--------|-------|-------|
| **Requisitos** | AWS account + CloudShell acceso | Solo Docker (Windows/Mac/Linux) |
| **Setup** | 30-45 minutos | 5 minutos |
| **BD local** | No había | Postgres local en Docker |
| **Desarrollo** | Editar local, git push, esperar CI/CD | Hot-reload instantáneo |
| **Costo local** | Nada | Nada (Docker es gratis) |
| **Reproducibilidad** | Diferentes versiones en local vs AWS | Idéntico (misma imagen Docker) |
| **Backup** | Manual | Automático antes de desplegar |
| **Usuarios sin experiencia** | Necesitaban ayuda con CloudShell | Solo 4 preguntas interactivas |

---

## 📁 Archivos nuevos (Docker)

### Root del proyecto

```
examlab/
├─ setup.sh                    ← Setup interactivo (NUEVO)
├─ Dockerfile                  ← Imagen Docker (NUEVO)
├─ docker-compose.yml          ← Orquestación (NUEVO)
├─ .env.example                ← Template variables (NUEVO)
├─ nginx.conf                  ← Reverse proxy (NUEVO)
├─ GETTING_STARTED.md          ← Guía rápida (NUEVO)
├─ SETUP_SIMPLE.md             ← Guía paso a paso (NUEVO)
├─ DOCKER_DEPLOYMENT.md        ← Referencia Docker (NUEVO)
├─ MIGRATION_TO_DOCKER.md      ← Este archivo (NUEVO)
│
├─ cloudformation/
│  ├─ vpc-stack.yaml           ← Existente (sin cambios)
│  ├─ rds-stack.yaml           ← Existente (sin cambios)
│  ├─ ec2-docker-stack.yaml    ← Docker en EC2 (NUEVO)
│
├─ scripts/
│  ├─ init-db.sql              ← Schema DB (NUEVO)
│  ├─ deploy-to-aws.sh         ← Deploy simplificado (NUEVO)
│  ├─ create-github-iam-user.sh ← IAM setup (existente)
│  └─ print-access-info.sh     ← Ver acceso (existente)
│
└─ supabase/
   ├─ config.toml              ← Supabase config (NUEVO)
   └─ migrations/              ← SQL migrations (NUEVO)
```

---

## 🚀 Flujo nuevo

### Paso 1: Usuario clona repo

```bash
git clone <repo>
cd examlab
```

### Paso 2: Setup (genera .env)

```bash
bash setup.sh
```

Pregunta:
- Nombre del proyecto
- Contraseña Postgres
- Región AWS
- AWS Account ID

**Resultado:** `.env` personalizado

### Paso 3: Levantar local

```bash
docker-compose up -d
```

**Qué ocurre:**
1. Docker descarga imágenes (PostgreSQL, Supabase, Node.js)
2. Inicia 5 contenedores conectados en red
3. Crea volúmenes persistentes para datos
4. Ejecuta script de inicialización de BD (`init-db.sql`)
5. Espera healthchecks (todo healthy)

**Resultado:** App en http://localhost:3000

### Paso 4: Desarrollar localmente

```bash
# Editar código
nano src/pages/Home.tsx

# Cambios aparecen automáticamente
# Visita http://localhost:3000
```

**Cómo funciona hot-reload:**
- Volumen Docker monta `src/` en tiempo real
- App Node.js detecta cambios
- Reconstruye y actualiza página

### Paso 5: Desplegar a AWS

```bash
bash deploy-to-aws.sh
```

**Qué ocurre:**
1. Verifica Docker está corriendo
2. Crea backup de PostgreSQL local
3. Valida CloudFormation templates
4. Despliega VPC, RDS, EC2, ALB
5. Imprime URL pública y SSH access

**Resultado:** App en AWS accesible públicamente

---

## 🔄 Diferencias en desarrollo

### Flujo local

```bash
# 1. Cambios automáticos con hot-reload
nano src/pages/Home.tsx
# → Página actualiza al refrescar

# 2. Ver logs en tiempo real
docker-compose logs -f app

# 3. Acceder a BD local
docker-compose exec postgres psql -U postgres -d examlab
```

### Flujo AWS

```bash
# 1. Los cambios están en ECó?
# Opción A: git push + GitHub Actions (automático)
# Opción B: bash deploy-to-aws.sh (manual)

# 2. Ver logs en AWS
aws logs tail /aws/ec2/examlab-production --follow

# 3. SSH a instancia
ssh -i ~/.ssh/examlab-production.pem ec2-user@<ALB-DNS>
```

---

## 🗂️ Archivos CloudShell antiguos (mantenidos para referencia)

Estos archivos **siguen existiendo** pero **ya no se usan:**

```
lovable-aws-deployment/
├─ cloudshell-vars.env        ← Obsoleto (reemplazado por .env)
├─ cloudshell-setup.sh        ← Obsoleto (reemplazado por setup.sh)
├─ scripts/deploy-cf.sh       ← Obsoleto (reemplazado por deploy-to-aws.sh)
├─ docs/GITHUB_ACTIONS_SETUP.md ← Aún válido
├─ docs/LOCAL_TO_AWS_WORKFLOW.md ← Aún válido
└─ docs/FREETIER_DOMAINS.md    ← Aún válido
```

Para usuarios que quieran el flujo antiguo:
1. Documentación está en `lovable-aws-deployment/docs/`
2. Scripts están en `lovable-aws-deployment/scripts/`
3. Templates en `lovable-aws-deployment/cloudformation/`

**Pero la vía recomendada es Docker.**

---

## 📊 Comparativa: Tareas comunes

### "Quiero desarrollar localmente"

**Antes:**
```bash
# 1. Instalar Node.js, npm, PostgreSQL localmente (1 hora)
# 2. Configurar variables en .env
# 3. npm install
# 4. psql para BD manual
# 5. npm run dev
```

**Ahora:**
```bash
# 1. bash setup.sh
# 2. docker-compose up -d
# 3. Listo (incluye Postgres, Supabase, todo)
```

### "Desplegar cambios a AWS"

**Antes:**
```bash
# 1. git push origin main
# 2. (Manual) bash scripts/deploy-cf.sh
# 3. (Manual) Verificar deployment
# 4. Esperar 15 minutos
```

**Ahora:**
```bash
# 1. (Automático con GitHub Actions)
#    git push origin main → Deploy automático
# O (Manual)
#    bash deploy-to-aws.sh
```

### "Hacer backup de BD"

**Antes:**
```bash
# Manual con AWS Console o scripts
bash lovable-aws-deployment/scripts/backup-lovable.sh
```

**Ahora:**
```bash
# Automático cada vez que despliegas
bash deploy-to-aws.sh  # Hace backup automáticamente
```

---

## 🔐 Seguridad: Cambios

### Local
- ✅ `.env` en `.gitignore` (no se commitea)
- ✅ PostgreSQL con contraseña (del setup)
- ✅ Supabase con JWT (cambiar antes de producción)

### AWS
- ✅ RDS con KMS encryption
- ✅ EC2 solo accesible vía ALB (security groups)
- ✅ SSH key generado automáticamente
- ✅ GitHub Secrets para credenciales (no en .env)

---

## 🎯 Cuándo usar cada opción

### Usar **Docker local**
- ✅ Desarrollo diario
- ✅ Testing local
- ✅ BD local (no necesitas conexión AWS)
- ✅ Compartir proyecto (reproducible)

### Usar **AWS deployment**
- ✅ Ambiente de producción
- ✅ Acceso público
- ✅ Escalabilidad
- ✅ Monitoring con CloudWatch
- ✅ Backups automáticos

### Usar **GitHub Actions** (automático)
- ✅ Deploy automático en cada push
- ✅ CI/CD pipeline
- ✅ Validación automática
- ✅ Múltiples ambientes (main→prod, develop→staging)

---

## 📝 Cambios en documentación

### Archivo principal (NUEVO)
- `GETTING_STARTED.md` ← Empieza aquí

### Guías rápidas (NUEVO)
- `SETUP_SIMPLE.md` ← Paso a paso
- `DOCKER_DEPLOYMENT.md` ← Todo sobre Docker

### Referencia AWS (Existente, actualizada)
- `docs/LOCAL_TO_AWS_WORKFLOW.md` ← Flujo local → AWS
- `docs/GITHUB_ACTIONS_SETUP.md` ← Deploy automático
- `docs/ARCHITECTURE.md` ← Diagrama de stack

### Troubleshooting (Existente)
- `docs/TROUBLESHOOTING.md` ← Solucionar problemas
- `docs/INDEX.md` ← Índice de documentación

---

## ⚙️ Configuración: Antes vs Ahora

### Antes (CloudShell)

Editabas `cloudshell-vars.env`:

```bash
PROJECT_NAME=examlab
ENVIRONMENT=production
AWS_REGION=us-east-1
ENABLE_HTTPS=false  # ← Tenías que entender qué hacía
DOMAIN_NAME=""      # ← Decisiones complejas
EC2_INSTANCE_TYPE=t3.small
DB_PASSWORD=...
```

### Ahora (Docker)

`setup.sh` te pregunta:

```
Nombre del proyecto: examlab
Contraseña Postgres: (12 caracteres mínimo)
Región AWS: us-east-1
AWS Account ID: 123456789012
```

Y genera automáticamente `..env` con todo configurado.

---

## 🚀 Plan de migración

### Si tienes código en CloudShell antiguo

1. **Opción A: Empezar de nuevo (RECOMENDADO)**
   ```bash
   # Clonar repo limpio
   git clone <repo>
   bash setup.sh
   docker-compose up -d
   ```

2. **Opción B: Mantener ambos**
   ```bash
   # Usar Docker para desarrollo
   # Usar CloudFormation antiguo para producción (si funciona)
   # Documentación en lovable-aws-deployment/
   ```

3. **Opción C: Migrar datos**
   ```bash
   # Exportar datos de CloudFormation RDS
   # Importar en Docker local
   # Verificar todo funciona
   # Desplegar con Docker
   ```

---

## 📞 Soporte

### Problemas comunes

**"No veo mi código en Docker"**
→ Verifica que el volumen está montado: `docker inspect examlab-app`

**"BD perdió datos al reiniciar"**
→ Los volúmenes persisten. Verifica con `docker volume ls`

**"Deploy a AWS falló"**
→ Verifica logs: `docker-compose logs -f` y credenciales AWS

**"¿Dónde están mis datos?"**
→ Local: `backups/` directory
→ AWS: RDS automatic backups (7 días)

---

## 📚 Lectura sugerida

1. **Primero:** `GETTING_STARTED.md` (5 min)
2. **Luego:** `SETUP_SIMPLE.md` (10 min)
3. **Si necesitas detalles:** `DOCKER_DEPLOYMENT.md` (20 min)
4. **Para AWS:** `docs/LOCAL_TO_AWS_WORKFLOW.md` (15 min)

---

**Última actualización:** 2026-04-28

Docker simplifica, automatiza y acelera. Bienvenido a la nueva forma. 🐳
