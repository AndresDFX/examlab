# 🚀 ExamLab AWS Deployment Guide

**Guía completa para desplegar ExamLab en AWS desde CloudShell**

Esta carpeta (`lovable-aws-deployment/`) contiene todos los scripts, templates y documentación necesaria para desplegar ExamLab en AWS.

---

## 📁 Estructura

```
lovable-aws-deployment/
├─ deploy-cloudshell-only.sh      ← Script principal para CloudShell
├─ deploy-to-aws.sh               ← Deploy desde máquina local con Docker
├─ cloudshell-setup.sh            ← Setup antiguo (legacy)
│
├─ cloudformation/
│  ├─ vpc-stack.yaml              ← Red privada
│  ├─ rds-stack.yaml              ← Base de datos PostgreSQL
│  ├─ ec2-stack.yaml              ← EC2 antiguo (legacy)
│  └─ ec2-docker-stack.yaml       ← EC2 con Docker automático (NUEVO)
│
├─ scripts/
│  ├─ create-github-iam-user.sh    ← Crear usuario IAM para GitHub Actions
│  ├─ print-access-info.sh        ← Mostrar información de acceso
│  ├─ backup-lovable.sh           ← Backup de datos
│  └─ init-db.sql                 ← Schema inicial de BD
│
├─ supabase/
│  ├─ config.toml                 ← Configuración Supabase
│  └─ migrations/                 ← SQL migrations
│
├─ docs/
│  ├─ ARCHITECTURE.md             ← Arquitectura del sistema
│  ├─ TROUBLESHOOTING.md          ← Solucionar problemas
│  ├─ GITHUB_ACTIONS_SETUP.md     ← Deploy automático
│  ├─ LOCAL_TO_AWS_WORKFLOW.md    ← Flujo local → AWS
│  └─ ... (más docs)
│
└─ DEPLOYMENT_GUIDE.md            ← Este archivo
```

---

## 🎯 ¿Cómo desplegar?

### **Opción A: CloudShell (recomendado para usuarios finales)**

Sin Docker local requerido:

```bash
# 1. En CloudShell de AWS
git clone https://github.com/vivetori/examlab.git
cd examlab/lovable-aws-deployment

# 2. Ejecutar deploy
bash deploy-cloudshell-only.sh

# 3. Responder 4 preguntas
# 4. Esperar 20-30 minutos
# 5. ¡Listo en AWS!
```

**Ventajas:**
- ✅ No necesitas Docker local
- ✅ Todo en AWS (reproducible, escalable)
- ✅ EC2 instala Docker automáticamente
- ✅ Ideal para usuarios sin experiencia técnica

### **Opción B: Local + AWS (para desarrolladores)**

```bash
# 1. En tu máquina con Docker
cd examlab
bash setup.sh          # Setup interactivo
docker-compose up -d   # Levanta local

# 2. Cuando listo para producción
bash lovable-aws-deployment/deploy-to-aws.sh

# 3. ¡Desplegado en AWS!
```

**Ventajas:**
- ✅ Desarrollo local con hot-reload
- ✅ Backup automático antes de desplegar
- ✅ Pruebas antes de ir a producción

### **Opción C: GitHub Actions (CI/CD automático)**

```bash
# 1. Setup una sola vez
bash lovable-aws-deployment/scripts/create-github-iam-user.sh

# 2. Agregar secrets en GitHub

# 3. Luego: git push origin main = deploy automático
```

---

## 📝 Scripts disponibles

| Script | Ubicación | Propósito | Uso |
|--------|-----------|-----------|-----|
| **deploy-cloudshell-only.sh** | `.` | Deploy desde CloudShell | `bash deploy-cloudshell-only.sh` |
| **deploy-to-aws.sh** | `.` | Deploy desde máquina local | `bash deploy-to-aws.sh` |
| **create-github-iam-user.sh** | `scripts/` | Crear usuario IAM para GitHub | `bash scripts/create-github-iam-user.sh` |
| **print-access-info.sh** | `scripts/` | Mostrar información de acceso | `bash scripts/print-access-info.sh` |
| **backup-lovable.sh** | `scripts/` | Backup manual de datos | `bash scripts/backup-lovable.sh` |
| **init-db.sql** | `scripts/` | Schema inicial BD | Ejecutado automáticamente |

---

## 🔧 CloudFormation Templates

Todos los templates están en `cloudformation/`:

| Template | Propósito | Crea |
|----------|-----------|------|
| **vpc-stack.yaml** | Networking | VPC, Subnets, Internet Gateway, NAT, Route Tables |
| **rds-stack.yaml** | Base de datos | RDS PostgreSQL 15.4, KMS encryption, Backups |
| **ec2-docker-stack.yaml** | Compute | EC2 Auto Scaling, ALB, Security Groups, CloudWatch |
| **ec2-stack.yaml** | (Legacy) | Versión anterior de EC2 stack |

### Características del ec2-docker-stack.yaml (NUEVO)

```
✅ User-data script que automáticamente:
   1. Instala Docker
   2. Instala Docker Compose
   3. Clona repositorio ExamLab
   4. Levanta docker-compose.yml
   5. Configura todo sin intervención manual
```

---

## 🌍 Variables de entorno

El archivo `.env` en la raíz del proyecto contiene:

```bash
PROJECT_NAME=examlab
ENVIRONMENT=production
AWS_REGION=us-east-1
AWS_ACCOUNT_ID=123456789012
POSTGRES_PASSWORD=MySecurePassword123!
POSTGRES_DB=examlab
NODE_ENV=production
...
```

Generado automáticamente por:
- `setup.sh` (en raíz del proyecto)
- `deploy-cloudshell-only.sh` (interactivo)

---

## 🔑 IAM User para GitHub Actions

Para setup de CI/CD:

```bash
cd lovable-aws-deployment
bash scripts/create-github-iam-user.sh
```

Esto crea:
- Usuario IAM: `github-actions`
- Access Key para autenticación
- Política con permisos CloudFormation
- Archivo `github-actions-credentials.txt` con instrucciones

---

## 📚 Documentación

Todos los docs están en `docs/`:

- **ARCHITECTURE.md** — Cómo funciona todo internamente
- **TROUBLESHOOTING.md** — Solucionar problemas comunes
- **GITHUB_ACTIONS_SETUP.md** — Setup de CI/CD
- **LOCAL_TO_AWS_WORKFLOW.md** — Flujo local → AWS
- **FREETIER_DOMAINS.md** — Opciones de dominio (opcional)

---

## 🚀 Flujo de despliegue simplificado

```
┌─ CloudShell
│  ├─ bash deploy-cloudshell-only.sh
│  └─ Responde 4 preguntas
│
├─ CloudFormation despliega:
│  ├─ VPC Stack (3-5 min)
│  ├─ RDS Stack (5-10 min)
│  └─ EC2 Stack con Docker (5-10 min)
│
├─ EC2 user-data automáticamente:
│  ├─ Instala Docker
│  ├─ Clona repositorio
│  └─ Levanta docker-compose
│
└─ ✅ App lista en http://<ALB-DNS>
```

**Tiempo total:** 20-30 minutos

---

## ✅ Checklist de despliegue

- [ ] Acceso a AWS CloudShell
- [ ] Repo clonado: `git clone https://github.com/vivetori/examlab.git`
- [ ] En carpeta: `cd examlab/lovable-aws-deployment`
- [ ] Ejecutar: `bash deploy-cloudshell-only.sh`
- [ ] Responder 4 preguntas
- [ ] Esperar 20-30 minutos
- [ ] CloudFormation completa (ver en AWS Console)
- [ ] EC2 instancia levantada con Docker
- [ ] Acceder a: `http://<ALB-DNS>`

---

## 🔐 Seguridad

### En CloudShell
- ✅ SSH keys generadas en `/tmp/` (temporal)
- ✅ `.env` con credenciales AWS
- ✅ Credenciales no mostradas en logs

### En AWS
- ✅ RDS encriptada (KMS)
- ✅ EC2 solo accesible vía ALB
- ✅ Security Groups restrictivos
- ✅ CloudWatch logs habilitados
- ✅ Backups automáticos (RDS)

---

## 🆘 Troubleshooting

### "CloudFormation template no encontrado"
```bash
# Asegúrate de estar en la carpeta correcta
cd examlab/lovable-aws-deployment

# O ejecuta desde raíz
bash lovable-aws-deployment/deploy-cloudshell-only.sh
```

### "EC2 tarda mucho en iniciar"
Normal. EC2 está:
1. Instalando Docker (2-3 min)
2. Descargando imágenes Docker (2-3 min)
3. Levantando servicios (2-3 min)

Total: ~10 minutos

Ver logs:
```bash
ssh -i /tmp/examlab-production.pem ec2-user@<ALB-DNS>
cat /var/log/user-data.log
```

### Más problemas
Ver: `docs/TROUBLESHOOTING.md`

---

## 📞 Comandos útiles

```bash
# Ver stacks CloudFormation
aws cloudformation list-stacks --region us-east-1

# Ver evento de un stack
aws cloudformation describe-stack-events \
  --stack-name examlab-ec2-production \
  --region us-east-1

# Ver logs de EC2
aws logs tail /aws/ec2/examlab-production --follow

# Conectar a EC2
ssh -i /tmp/examlab-production.pem ec2-user@<ALB-DNS>

# Ver status de Docker en EC2
docker-compose ps
```

---

## 🎯 Próximos pasos

### Después de desplegar

1. ✅ Prueba la app: `http://<ALB-DNS>`
2. ✅ Conéctate por SSH: `ssh -i /tmp/examlab-production.pem ec2-user@<ALB-DNS>`
3. ✅ Ver logs: `docker-compose logs -f app`
4. ✅ Monitorea en CloudWatch

### Configuración adicional

- Deploy automático con GitHub Actions → `scripts/create-github-iam-user.sh`
- Dominio personalizado → `docs/FREETIER_DOMAINS.md`
- Monitoreo avanzado → `docs/ARCHITECTURE.md`

---

## 📖 Documentación de raíz

Para desarrollo local:
- **GETTING_STARTED.md** — Inicio rápido
- **SETUP_SIMPLE.md** — Setup paso a paso
- **DOCKER_DEPLOYMENT.md** — Docker reference
- **README_DOCKER.md** — Resumen ejecutivo

---

## 💾 Versión de archivos

- **deploy-cloudshell-only.sh** — ✅ Versión 2.0 (Docker-based)
- **deploy-to-aws.sh** — ✅ Versión 2.0 (Docker-based)
- **ec2-docker-stack.yaml** — ✅ Versión 2.0 (Docker automático)
- **cloudshell-setup.sh** — ⏚ Legacy (use deploy-cloudshell-only.sh)

---

**Última actualización:** 2026-04-28

¿Listo para desplegar? Ejecuta:

```bash
bash deploy-cloudshell-only.sh
```
