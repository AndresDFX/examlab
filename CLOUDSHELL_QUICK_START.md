# ☁️ CloudShell — Quick Deploy (sin Docker local)

**Ejecuta estos comandos desde AWS CloudShell para desplegar todo automáticamente.**

---

## 📋 Requisitos

- ✅ Cuenta AWS con acceso a CloudShell
- ✅ Terminal CloudShell abierta
- ❌ NO necesitas Docker en tu máquina local

---

## 🚀 Pasos (copiar y pegar)

### Paso 1: Clonar repositorio

```bash
git clone https://github.com/vivetori/examlab.git
cd examlab
```

### Paso 2: Ejecutar deploy desde CloudShell

```bash
bash deploy-cloudshell-only.sh
```

**Qué hace:**
1. Pregunta 4 variables (proyecto, contraseña, región, account ID)
2. Valida credenciales AWS
3. Desplega VPC Stack (3-5 minutos)
4. Despliega RDS Stack (5-10 minutos)
5. Despliega EC2 Stack con Docker automático (5-10 minutos)
6. Imprime información de acceso

**Tiempo total:** ~20-30 minutos

---

## 📝 Qué responder cuando pida:

```
Nombre del proyecto [examlab]: 
  → Presiona Enter para "examlab" o escribe otro nombre

Contraseña Postgres (mín. 12 caracteres): 
  → Escribe una contraseña segura: MySecurePass123!

Región AWS [us-east-1]: 
  → Presiona Enter para us-east-1 o escribe otra (ej: eu-west-1)

AWS Account ID (12 dígitos): 
  → Pega tu Account ID (ej: 123456789012)
```

---

## ✅ Cuando termine:

Verás algo como:

```
╔════════════════════════════════════════════════════════╗
║         ExamLab desplegado en AWS CloudFormation       ║
╚════════════════════════════════════════════════════════╝

🌐 ACCESO A LA APLICACIÓN:
   URL: http://examlab-alb-xxx.us-east-1.elb.amazonaws.com

🔑 ACCESO SSH:
   ssh -i /tmp/examlab-production.pem ec2-user@examlab-alb-xxx...

💾 BASE DE DATOS:
   Endpoint: examlab-rds-production-xxx.us-east-1.rds.amazonaws.com
```

---

## 🔑 Guardar SSH Key

**IMPORTANTE:** La SSH key está en `/tmp/` que es temporal en CloudShell.

```bash
# Ver la key
cat /tmp/examlab-production.pem

# Copiar y guardar en tu máquina (fuera de CloudShell)
# Luego podrás hacer:
ssh -i ~/.ssh/examlab-production.pem ec2-user@<ALB-DNS>
```

---

## 📊 Durante el despliegue

CloudFormation está trabajando. Puedes ver el progreso en:

```bash
# Ver estado de stacks
aws cloudformation list-stacks --region us-east-1 \
  --stack-status-filter CREATE_IN_PROGRESS UPDATE_IN_PROGRESS

# Ver eventos de un stack
aws cloudformation describe-stack-events \
  --stack-name examlab-ec2-production \
  --region us-east-1 \
  --query 'StackEvents[0:10]'
```

---

## ⏱️ Timeline esperado

| Etapa | Tiempo | Qué pasa |
|-------|--------|---------|
| Setup | 1 min | Preguntas + validación |
| VPC | 3-5 min | Crea redes y subnets |
| RDS | 5-10 min | Crea base de datos PostgreSQL |
| EC2 | 5-10 min | EC2 instala Docker automáticamente |
| **Total** | **20-30 min** | Todo listo para usar |

---

## 🎯 Después del despliegue

### 1. Esperar 5 minutos

EC2 está instalando Docker. Espera un poco.

### 2. Probar la app

Abre en navegador:
```
http://<ALB-DNS-DEL-OUTPUT>
```

Debería ver ExamLab.

### 3. Acceder por SSH

```bash
ssh -i /tmp/examlab-production.pem ec2-user@<ALB-DNS>
```

### 4. Ver logs en EC2

```bash
ssh -i /tmp/examlab-production.pem ec2-user@<ALB-DNS>
docker-compose logs -f app
```

### 5. Ver logs en CloudWatch

```bash
aws logs tail /aws/ec2/examlab-production --follow --region us-east-1
```

---

## ❌ Si algo falla

### Error: "Credenciales AWS no configuradas"

CloudShell debe tener credenciales automáticas. Si ves esto:

```bash
# Verifica identidad
aws sts get-caller-identity

# Si no funciona, recarga CloudShell
```

### Error: "EC2 user-data fallo"

Los logs están en:
```bash
ssh -i /tmp/examlab-production.pem ec2-user@<ALB-DNS>
cat /var/log/user-data.log
```

### Error: "Port ya en uso"

No debería pasar, pero si CloudFormation dice que un stack ya existe:

```bash
# Ver stacks existentes
aws cloudformation list-stacks --region us-east-1

# Eliminar stack viejo (cuidado!)
aws cloudformation delete-stack \
  --stack-name examlab-ec2-production \
  --region us-east-1

# Esperar a que se elimine
aws cloudformation wait stack-delete-complete \
  --stack-name examlab-ec2-production \
  --region us-east-1

# Reintentar
bash deploy-cloudshell-only.sh
```

---

## 📚 Documentación relacionada

- [deploy-cloudshell-only.sh](deploy-cloudshell-only.sh) — El script que ejecutaste
- [DOCKER_DEPLOYMENT.md](DOCKER_DEPLOYMENT.md) — Cómo funciona Docker en EC2
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Más problemas

---

## 🎓 Concepto clave

```
Tu máquina local
     ↓
CloudShell (AWS Console)
     ↓
bash deploy-cloudshell-only.sh
     ↓
CloudFormation despliega:
  - VPC (networking)
  - RDS (PostgreSQL)
  - EC2 + Docker (app)
     ↓
EC2 user-data automáticamente:
  - Instala Docker
  - Clona repositorio
  - Levanta docker-compose
     ↓
App corriendo en http://<ALB-DNS> ✅
```

**No necesitas Docker local, todo se hace en EC2.**

---

**¡Listo! Copia y pega en CloudShell:**

```bash
git clone https://github.com/vivetori/examlab.git && cd examlab && bash deploy-cloudshell-only.sh
```

---

**Última actualización:** 2026-04-28
