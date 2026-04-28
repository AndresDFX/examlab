# 📚 Índice completo - Lovable AWS Deployment

## 🎯 ¿Por dónde empiezo?

### 👤 Soy principiante/quiero hacerlo rápido
1. Leer: **[CLOUDSHELL_GUIDE.md](CLOUDSHELL_GUIDE.md)** (10 min)
2. Ejecutar: **[cloudshell-setup.sh](cloudshell-setup.sh)** (5 min)
3. Esperar y disfrutar ✅

### 🏗️ Soy arquitecto/quiero entender la estructura
1. Leer: **[DEPLOYMENT_FLOW.md](DEPLOYMENT_FLOW.md)** (15 min)
2. Revisar: `cloudformation/*.yaml` (CloudFormation templates)
3. Entender: Variables en **[cloudshell-vars.env](cloudshell-vars.env)**

### 💾 Necesito hacer backups
Ver: **[scripts/backup-lovable.sh](scripts/backup-lovable.sh)** (3 métodos)

### 🔍 Tengo problemas/troubleshooting
Ver secciones en: **[README.md](README.md)** o **[CLOUDSHELL_GUIDE.md](CLOUDSHELL_GUIDE.md)**

---

## 📁 Archivos y su propósito

### 🚀 Archivos principales

| Archivo | Tamaño | Propósito | Editar? |
|---------|--------|----------|---------|
| **[cloudshell-vars.env](cloudshell-vars.env)** | 3KB | Variables genéricas - configura aquí | ✅ SÍ |
| **[cloudshell-setup.sh](cloudshell-setup.sh)** | 13KB | Setup inicial - ejecutar primero | ❌ No |
| **[README.md](README.md)** | 8KB | Guía principal y troubleshooting | ℹ️ Info |
| **[CLOUDSHELL_GUIDE.md](CLOUDSHELL_GUIDE.md)** | 12KB | Guía específica para AWS CloudShell | ℹ️ Info |
| **[DEPLOYMENT_FLOW.md](DEPLOYMENT_FLOW.md)** | 10KB | Diagramas y flujos visuales | ℹ️ Info |

### ☁️ CloudFormation Templates

| Archivo | Tipo | Recursos | Notas |
|---------|------|----------|-------|
| **[cloudformation/vpc-stack.yaml](cloudformation/vpc-stack.yaml)** | VPC | 10 recursos | VPC, subnets, IGW, NAT, routes |
| **[cloudformation/rds-stack.yaml](cloudformation/rds-stack.yaml)** | Database | 8 recursos | PostgreSQL, backups, KMS, monitoring |
| **[cloudformation/ec2-stack.yaml](cloudformation/ec2-stack.yaml)** | Compute | 15+ recursos | ALB, ASG, Security Groups, IAM |

### 🔧 Scripts utilitarios

| Archivo | Propósito | Cuándo usarlo |
|---------|-----------|---------------|
| **[scripts/backup-lovable.sh](scripts/backup-lovable.sh)** | Backup RDS/Supabase/CSV | Regularmente o antes de cambios importantes |
| **[scripts/deploy-cf.sh](scripts/deploy-cf.sh)** | Deploy CloudFormation | Auto-generado por setup.sh |
| **[scripts/health-check.sh](scripts/health-check.sh)** | Verificar infraestructura | Después de despliegue |

---

## 🚀 Quick Command Reference

### Setup inicial
```bash
# 1. Editar variables
nano cloudshell-vars.env

# 2. Setup (genera SSH keys, importa a AWS)
bash cloudshell-setup.sh

# 3. Desplegar infraestructura (CloudFormation)
bash scripts/deploy-cf.sh

# 4. Verificar (esperar 5-10 min después del deploy)
bash scripts/health-check.sh
```

### Información después de deploy
```bash
# Obtener ALB DNS
aws cloudformation describe-stacks \
  --stack-name examlab-ec2-production \
  --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`ALBDNSName`].OutputValue' \
  --output text

# Obtener RDS endpoint
aws cloudformation describe-stacks \
  --stack-name examlab-rds-production \
  --region us-east-1 \
  --query 'Stacks[0].Outputs[?OutputKey==`RDSEndpoint`].OutputValue' \
  --output text
```

### Acceso y diagnóstico
```bash
# Conectar vía SSH
ssh -i ~/.ssh/examlab-production.pem ec2-user@<alb-dns>

# Ver logs en EC2
sudo tail -f /var/log/examlab/app.log

# Hacer backup
bash scripts/backup-lovable.sh rds

# Monitorear despliegue
aws cloudformation list-stacks --region us-east-1
```

### Limpieza
```bash
# Hacer backup primero
bash scripts/backup-lovable.sh rds

# Eliminar stacks (destruye TODO)
for stack in examlab-ec2-production examlab-rds-production examlab-vpc-production; do
  aws cloudformation delete-stack --stack-name $stack --region us-east-1
done
```

---

## 🎓 Flujo de aprendizaje

### Nivel 1: Principiante (15 min)
- [ ] Leer: CLOUDSHELL_GUIDE.md secciones 1-3
- [ ] Ejecutar: cloudshell-setup.sh
- [ ] Ver: ALB respondiendo

### Nivel 2: Intermedio (30 min)
- [ ] Leer: README.md completo
- [ ] Entender: Variables en cloudshell-vars.env
- [ ] Hacer: Primer backup con backup-lovable.sh
- [ ] Conectar: SSH a EC2 y explorar

### Nivel 3: Avanzado (1 hora)
- [ ] Leer: DEPLOYMENT_FLOW.md
- [ ] Revisar: CloudFormation templates (YAML)
- [ ] Entender: Cómo cambia variables → infraestructura
- [ ] Experimentar: Cambiar variables y re-desplegar

### Nivel 4: Experto (Libre)
- [ ] Modificar: CloudFormation templates
- [ ] Agregar: Nuevos recursos (RDS read replicas, etc)
- [ ] Automatizar: CI/CD, backups programados
- [ ] Optimizar: Costos, performance, seguridad

---

## 🔐 Seguridad - Checklist

- [ ] Cambiar `DB_PASSWORD` a algo fuerte
- [ ] Agregar SSH key a GitHub
- [ ] Revisar Security Groups (cerrar puertos innecesarios)
- [ ] Habilitar HTTPS (opcional pero recomendado)
- [ ] Configurar RLS en Supabase/RDS
- [ ] Programar backups automáticos
- [ ] Habilitar CloudWatch monitoring
- [ ] Usar AWS Secrets Manager para credenciales
- [ ] Restringir acceso SSH a IPs específicas (en producción)

---

## 💰 Optimización de costos

### Reducir costos
```bash
# Cambiar a instancias más pequeñas
EC2_INSTANCE_TYPE="t3.micro"      # Ahorrar $9/mes
DB_INSTANCE_TYPE="db.t3.micro"    # Ya es mínimo

# Desarrollo/testing: usar ambiente "development"
ENVIRONMENT="development"
BACKUP_ENABLED="false"             # Sin backups automáticos
LOG_RETENTION_DAYS="1"             # 1 día en lugar de 7
```

### Dimensionamiento correcto
```bash
# Monitorear uso real
bash scripts/health-check.sh

# Ver métricas en CloudWatch
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --statistics Average \
  --period 3600 \
  --start-time 2024-04-01T00:00:00Z \
  --end-time 2024-04-28T23:59:59Z
```

---

## 🌍 Variables genéricas - Guía completa

### Obligatorias (cambiar SIEMPRE)
```bash
PROJECT_NAME                  # Nombre único del proyecto
ENVIRONMENT                   # production/staging/development
DB_PASSWORD                   # Mínimo 8 caracteres, letras+números
```

### Recomendadas (cambiar según necesidad)
```bash
AWS_REGION                    # Region cercana a usuarios
EC2_INSTANCE_TYPE            # t3.micro (dev), t3.small (prod)
GITHUB_OWNER                  # Para clonar repo automáticamente
GITHUB_REPO
```

### Opcionales
```bash
SUPABASE_URL                  # Si usas Supabase
ENABLE_HTTPS                  # true para producción
BACKUP_ENABLED               # false en desarrollo
```

### Auto-generadas (NO editar)
```bash
VPC_STACK_NAME               # Generado automáticamente
RDS_STACK_NAME
EC2_STACK_NAME
SSH_KEY_NAME
# ... etc
```

---

## 📊 CloudFormation - Parámetros clave

### VPC Stack
```yaml
ProjectName: examlab           # Prefijo de recursos
Environment: production        # Tag para recursos
VpcCIDR: 10.0.0.0/16         # CIDR principal
EnableNATGateway: false       # Ahorrar costos
```

### RDS Stack
```yaml
DBInstanceType: db.t3.micro   # Tipo de instancia
DBStorageSize: 20             # GB iniciales
DBPassword: ExamLab2024ChangeMe!  # ⚠️ CAMBIAR
BackupRetentionDays: 7        # Días de retención
MultiAZ: false                # High availability
```

### EC2 Stack
```yaml
InstanceType: t3.small        # Tipo EC2
MinSize: 1                    # Auto Scaling mín
MaxSize: 2                    # Auto Scaling máx
KeyName: examlab-production   # SSH key
AppPort: 3000                 # Puerto Node.js
```

---

## 📞 Soporte rápido

### Búscalo en este repo
- "No funciona" → [CLOUDSHELL_GUIDE.md#troubleshooting](CLOUDSHELL_GUIDE.md)
- "¿Cómo conectar?" → [CLOUDSHELL_GUIDE.md#paso-9](CLOUDSHELL_GUIDE.md)
- "¿Cómo hacer backup?" → [scripts/backup-lovable.sh](scripts/backup-lovable.sh)
- "Entender arquitectura" → [DEPLOYMENT_FLOW.md](DEPLOYMENT_FLOW.md)
- "¿Cuánto cuesta?" → [README.md#-costos](README.md)

### Búscalo en internet
- CloudFormation: https://docs.aws.amazon.com/cloudformation/
- CloudShell: https://docs.aws.amazon.com/cloudshell/
- RDS: https://docs.aws.amazon.com/rds/
- EC2: https://docs.aws.amazon.com/ec2/

---

## 📈 Roadmap sugerido

### Semana 1: Setup básico
- [ ] Desplegar infraestructura inicial
- [ ] Verificar que todo funciona
- [ ] Hacer primer backup

### Semana 2: Optimización
- [ ] Configurar dominio personalizado
- [ ] Habilitar HTTPS
- [ ] Programar backups automáticos

### Semana 3: Monitoreo
- [ ] Configurar alertas CloudWatch
- [ ] Revisar logs regularmente
- [ ] Optimizar costos si es necesario

### Semana 4+: Production-ready
- [ ] RLS en base de datos
- [ ] CI/CD pipeline
- [ ] Disaster recovery plan
- [ ] Load testing

---

## ✅ Checklist pre-production

- [ ] Variables configuradas correctamente
- [ ] Contraseña RDS fuerte (8+ caracteres)
- [ ] SSH keys agregadas a GitHub
- [ ] Primer backup hecho
- [ ] ALB respondiendo
- [ ] RDS accesible desde EC2
- [ ] Logs monitoreados
- [ ] Backups programados
- [ ] HTTPS habilitado (si aplica)
- [ ] DNS configurado (si aplica)
- [ ] Team tiene acceso necesario
- [ ] Runbook documentado

---

## 🎉 Felicidades!

**Acabas de crear una infraestructura AWS profesional, escalable y segura en menos de 15 minutos.**

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  Lovable Project → CloudFormation → AWS Infrastructure │
│                                                         │
│  CloudShell → SSH Keys → GitHub → EC2 → ALB → RDS     │
│                                                         │
│  ✅ Automated  ✅ Secure  ✅ Scalable  ✅ Cost-optimized
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Próximo paso**: Clonar, editar `cloudshell-vars.env`, ejecutar `cloudshell-setup.sh` 🚀

---

**Última actualización**: 28 Abril 2024
**Version**: 1.0
**Status**: Production-ready ✅
