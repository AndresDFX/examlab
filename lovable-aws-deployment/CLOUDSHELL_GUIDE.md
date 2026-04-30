# AWS CloudShell - Guía completa

Desplegar ExamLab directamente desde **AWS CloudShell en 10 minutos**.

## ✅ ¿Qué es CloudShell?

- **Bash shell gratuito** dentro de AWS Console
- **Preinstalado**: AWS CLI, Git, Node.js, Python, etc.
- **5 GB de almacenamiento** persistente en $HOME
- **Sin costo adicional** (solo pagar por recursos que uses)

## 🚀 Paso 1: Abrir CloudShell

### Opción A: Desde AWS Console
```
https://console.aws.amazon.com/
↓
Arriba a la derecha → CloudShell icon (terminal)
```

### Opción B: Link directo
```
https://console.aws.amazon.com/cloudshell/home
```

## 📥 Paso 2: Clonar repositorio

```bash
# En CloudShell, ejecutar:
git clone https://github.com/tu-usuario/examlab.git
cd examlab/lovable-aws-deployment

# Ver estructura
ls -la
```

## ⚙️ Paso 3: Editar variables

**IMPORTANTE: Editar ANTES de ejecutar setup**

```bash
# Abrir archivo
nano cloudshell-vars.env

# Cambiar valores:
# - PROJECT_NAME (nombre del proyecto)
# - ENVIRONMENT (production/staging/development)
# - GITHUB_OWNER (tu usuario GitHub)
# - GITHUB_REPO (nombre del repo)
# - DB_PASSWORD (contraseña RDS - DEBE ser segura!)

# Guardar (Ctrl+O, Enter, Ctrl+X)
```

### Valores que DEBES cambiar

```bash
PROJECT_NAME="examlab"          ← Cambiar si es otro proyecto
ENVIRONMENT="production"        ← production|staging|development
AWS_REGION="us-east-1"         ← Región preferida
OWNER_NAME="YourName"          ← Tu nombre
GITHUB_OWNER="tu-usuario"      ← Tu usuario GitHub
GITHUB_REPO="examlab"          ← Tu repo
DB_PASSWORD="ExamLab2024ChangeMe!" ← CAMBIAR A CONTRASEÑA FUERTE
```

### Contraseña RDS - Requisitos

```
- Mínimo 8 caracteres
- Debe tener letras y números
- Ejemplo fuerte: "MyExamLab2024!"
```

## 🔑 Paso 4: Ejecutar CloudShell Setup

```bash
# Ejecutar
bash cloudshell-setup.sh

# El script:
✓ Valida variables
✓ Genera SSH key en CloudShell (~/.ssh/examlab-production.pem)
✓ Importa SSH key a AWS EC2
✓ Pide agregar clave a GitHub (con token o manual)
✓ Clona repositorio (si GITHUB_REPO está configurado)
✓ Genera parámetros para CloudFormation
✓ Prepara scripts de deploy
```

### Output esperado

```
✓ AWS CLI installed
✓ Credenciales AWS: 123456789012
✓ SSH key generada: examlab-production
✓ Key pair importado a AWS
✓ Parámetros guardados: cloudformation/parameters.json

╔════════════════════════════════════════════════════════════╗
║              PRÓXIMOS PASOS                               ║
╚════════════════════════════════════════════════════════════╝

1️⃣  Revisar variables (si necesitas cambiar algo):
    nano cloudshell-vars.env

2️⃣  Ejecutar despliegue CloudFormation:
    bash scripts/deploy-cf.sh

3️⃣  Monitorear despliegue:
    aws cloudformation list-stacks --region us-east-1
```

## 🚀 Paso 5: Desplegar CloudFormation

```bash
# Ejecutar deploy
bash scripts/deploy-cf.sh

# El script:
✓ Valida setup
✓ Crea VPC stack
✓ Crea RDS stack (PostgreSQL)
✓ Crea EC2 stack (ALB, Auto Scaling)
✓ Espera a que se completen

# Esto tarda 5-7 minutos
```

## 📊 Paso 6: Ver estado del despliegue

### En tiempo real

```bash
# Ver todos los stacks
aws cloudformation list-stacks --region us-east-1

# Ver detalles de un stack
aws cloudformation describe-stacks \
  --stack-name examlab-ec2-production \
  --region us-east-1

# Ver eventos (qué se está creando)
aws cloudformation describe-stack-events \
  --stack-name examlab-ec2-production \
  --region us-east-1 | jq '.StackEvents[0:10]'

# Esperar a que termine (5 minutos)
# Estado debe ser: CREATE_COMPLETE
```

### Desde AWS Console

```
CloudFormation → Stacks → examlab-*
↓
Ver eventos en tiempo real
```

## 🎯 Paso 7: Obtener información de la aplicación

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

Output típico:
```
ALB DNS:    examlab-alb-prod-abc123.us-east-1.elb.amazonaws.com
RDS:        examlab-postgres.cxxxxxx.us-east-1.rds.amazonaws.com
```

## 🌐 Paso 8: Acceder a la aplicación

```bash
# URL de la aplicación
curl http://examlab-alb-prod-abc123.us-east-1.elb.amazonaws.com

# O en navegador
http://examlab-alb-prod-abc123.us-east-1.elb.amazonaws.com
```

## 🔐 Paso 9: Conectar vía SSH

```bash
# Ver SSH key en CloudShell
ls -la ~/.ssh/examlab-production.pem

# Conectar a EC2
ssh -i ~/.ssh/examlab-production.pem ec2-user@examlab-alb-prod-abc123.us-east-1.elb.amazonaws.com

# O con IP pública
ssh -i ~/.ssh/examlab-production.pem ec2-user@54.123.45.67
```

Una vez conectado:

```bash
# Ver logs de la aplicación
sudo tail -f /var/log/examlab/app.log

# Ver estado de Nginx
sudo systemctl status nginx

# Ver logs de Nginx
sudo tail -f /var/log/examlab/nginx_access.log

# Reiniciar aplicación
sudo systemctl restart examlab
```

## 💾 Paso 10: Backup

```bash
# Desde CloudShell:
bash scripts/backup-lovable.sh

# Opciones:
# - rds      : Backup completo de RDS
# - supabase : Backup desde Supabase
# - csv      : Exportar tablas a CSV
# - restore  : Restaurar desde backup

# Ejemplo:
bash scripts/backup-lovable.sh rds

# Genera: ~/examlab-backups/examlab_rds_YYYYMMDD.sql.gz
```

## 🏥 Verificar que todo funciona

```bash
# Desde CloudShell:
bash scripts/health-check.sh

# Verifica:
✓ ALB respondiendo
✓ EC2 instancias running
✓ RDS disponible
✓ Aplicación lista
```

## 🔄 Cambiar configuración después de deploy

```bash
# 1. Editar variables
nano cloudshell-vars.env

# 2. Re-generar parámetros
bash cloudshell-setup.sh

# 3. Re-desplegar
bash scripts/deploy-cf.sh

# CloudFormation hará UPDATE en lugar de CREATE
```

## 🗑️ Eliminar infraestructura (destruir)

```bash
# ADVERTENCIA: Esto elimina TODO, incluidos datos en RDS

# 1. Hacer backup primero
bash scripts/backup-lovable.sh rds

# 2. Eliminar stacks
for stack in examlab-ec2-production examlab-rds-production examlab-vpc-production; do
  aws cloudformation delete-stack --stack-name $stack --region us-east-1
done

# 3. Esperar a que se eliminen
aws cloudformation list-stacks --region us-east-1 | grep DELETE
```

## 🆘 Troubleshooting

### "CloudFormation stack creation failed"

```bash
# Ver qué falló:
aws cloudformation describe-stack-events \
  --stack-name examlab-ec2-production \
  --region us-east-1 | jq '.StackEvents[] | select(.ResourceStatus=="CREATE_FAILED")'

# Errores comunes:
# - KeyName not found: Verificar SSH_KEY_NAME en variables
# - VPC not found: Verificar que VPC stack se creó primero
# - Security group error: Esperar a que VPC stack esté completo
```

### "Can't connect to RDS"

```bash
# Desde EC2:
ssh -i ~/.ssh/examlab-production.pem ec2-user@<alb-dns>

# Probar conectividad
telnet <rds-endpoint> 5432

# Si no responde:
# 1. Verificar que RDS stack se creó
# 2. Verificar Security Group permite tráfico desde EC2
# 3. Verificar RDS está en la misma VPC
```

### "ALB responde 502 Bad Gateway"

```bash
# Esperar 3-5 minutos a que EC2 inicie Node.js
# Luego:

ssh -i ~/.ssh/examlab-production.pem ec2-user@<alb-dns>
sudo systemctl status examlab
sudo tail -f /var/log/examlab/app.log

# Si sigue fallando:
sudo systemctl restart examlab
```

### "Can't SSH a EC2"

```bash
# Verificar key
ls -la ~/.ssh/examlab-production.pem
chmod 600 ~/.ssh/examlab-production.pem

# Verificar seguridad group permite SSH (puerto 22)
aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=examlab-ec2-sg-production" \
  --region us-east-1

# Debe incluir puerto 22 abierto a 0.0.0.0/0 (o tu IP)
```

### "Espacio en CloudShell casi lleno"

```bash
# Ver uso
df -h

# Limpiar
rm -rf ~/examlab-backups/*.sql*  # Borrar backups grandes
rm -rf ~/.cache                   # Limpiar cache

# O:
# Descargar backups a tu máquina y luego borrar
```

## 💡 Tips CloudShell

### Copiar archivos entre máquinas

```bash
# Descargar SSH key a tu máquina
# Usar la terminal local:
scp -r ec2-user@<instance>:/path/to/file ./

# O directamente desde CloudShell:
cat ~/.ssh/examlab-production.pem
# Copiar output y pegar en tu máquina local
# Guardar como: ~/.ssh/examlab-production.pem
# chmod 600 ~/.ssh/examlab-production.pem
```

### Editar archivos en CloudShell

```bash
# Usar nano (más fácil)
nano cloudshell-vars.env

# O vim (más poderoso)
vim cloudshell-vars.env

# Editor: Ctrl+O para guardar, Ctrl+X para salir (nano)
```

### Ver AWS resources desde CloudShell

```bash
# EC2 instances
aws ec2 describe-instances --region us-east-1

# RDS instances
aws rds describe-db-instances --region us-east-1

# Security groups
aws ec2 describe-security-groups --region us-east-1

# Load balancers
aws elbv2 describe-load-balancers --region us-east-1
```

## 🎯 Flujo típico resumido

```bash
# 1. Abrir CloudShell
# 2. Clonar repo
git clone https://github.com/tu-usuario/examlab.git
cd examlab/lovable-aws-deployment

# 3. Editar variables (importante!)
nano cloudshell-vars.env

# 4. Setup
bash cloudshell-setup.sh

# 5. Deploy (esperar 5-7 min)
bash scripts/deploy-cf.sh

# 6. Verificar
bash scripts/health-check.sh

# 7. Acceder
curl http://<alb-dns>

# 8. SSH
ssh -i ~/.ssh/examlab-production.pem ec2-user@<alb-dns>

# 9. Backup
bash scripts/backup-lovable.sh rds

# 10. (Opcional) Cleanup
aws cloudformation delete-stack --stack-name examlab-ec2-production --region us-east-1
```

## 📞 Soporte

- **AWS CloudShell Docs**: https://docs.aws.amazon.com/cloudshell/
- **CloudFormation Docs**: https://docs.aws.amazon.com/cloudformation/
- **Troubleshooting**: Ver archivo TROUBLESHOOTING.md en este repo

---

**¡Listo! Acabas de desplegar una aplicación full-stack en AWS sin escribir una sola línea de infraestructura.** 🎉
