# 🔧 Troubleshooting

Guía para resolver problemas durante el despliegue de ExamLab en AWS.

---

## 🚦 Diagnóstico rápido

### 1. Conectarse a la EC2 (sin SSH key)

```bash
aws ssm start-session --target <INSTANCE_ID> --region us-east-1
```

> El `<INSTANCE_ID>` aparece en los outputs del CloudFormation o en el archivo `~/<proyecto>-deployment-info.txt` generado por `deploy.sh`.

### 2. Comandos de diagnóstico esenciales

```bash
# Estado del setup completo
sudo tail -100 /var/log/user-data.log

# Estado del servicio de la app
sudo systemctl status examlab.service --no-pager
sudo tail -50 /var/log/examlab.log

# Estado de Supabase
cd /opt/supabase
sudo docker compose ps
sudo docker compose logs --tail 50 kong

# Conectividad local
curl http://localhost:3000   # App
curl http://localhost:8000   # Supabase Kong

# Recursos del sistema
df -h     # disco
free -h   # RAM
top -bn1  # CPU
```

---

## ⚠️ Problemas comunes

### A. La app muestra "Missing Supabase environment variables"

**Causa:** el archivo `/opt/examlab/.env` no se generó correctamente, o el systemd service no lo lee.

**Solución:**

```bash
# 1. Verificar que .env existe y tiene las variables
sudo cat /opt/examlab/.env
# Debe mostrar VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY

# 2. Si no existe, regenerar
sudo cat /root/examlab-credentials.txt   # Obtener ANON_KEY
PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
sudo bash -c "cat > /opt/examlab/.env << EOF
VITE_SUPABASE_URL=http://$PUBLIC_IP:8000
VITE_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY del archivo de credenciales>
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
EOF"

# 3. Reiniciar
sudo systemctl restart examlab.service
```

---

### B. Supabase no levanta

**Verificar:**

```bash
cd /opt/supabase
sudo docker compose ps
```

Si algunos contenedores están en `Exited` o `Restarting`:

```bash
sudo docker compose logs <nombre-servicio>
# ej: sudo docker compose logs db
```

**Causas frecuentes:**

| Síntoma | Causa | Solución |
|---------|-------|----------|
| `OOM killed` | Falta de RAM | Cambiar instance type a `t3.large` |
| `no space left on device` | Disco lleno | Aumentar `VolumeSize` en CloudFormation o `sudo docker system prune -a` |
| `password authentication failed` | Variables `.env` mal generadas | Revisar `/opt/supabase/.env` |
| `port already in use` | Otro proceso en 5432/8000 | `sudo ss -tlnp \| grep <puerto>` |

**Reiniciar Supabase:**

```bash
cd /opt/supabase
sudo docker compose down
sudo docker compose up -d
```

---

### C. El user-data se quedó a mitad

```bash
sudo tail -200 /var/log/user-data.log
```

Identifica en qué paso se detuvo:

| Paso | Componente | Si falla aquí... |
|------|-----------|------------------|
| `[1/9]` | apt-get update / dependencias | Problema de red o repos |
| `[2/9]` | Node.js 20 | Repo NodeSource caído |
| `[3/9]` | Docker | Repo de Docker caído |
| `[4/9]` | Esperar EIP | EIP no se asoció (60 reintentos × 5s = 5 min) |
| `[5/9]` | Descargar de S3 | IAM role sin permisos, o key mal pasada |
| `[6/9]` | Setup Supabase | Falla `git clone` o `docker compose up` |
| `[7/9]` | Migraciones | Errores SQL — revisar logs específicos |
| `[8/9]` | npm install | Network issue, o problema en `package.json` |
| `[9/9]` | systemd service | Problema con definición del unit file |

**Re-ejecutar manualmente:**

Si el script falló a mitad, normalmente es más rápido recrear el stack:

```bash
aws cloudformation delete-stack --stack-name examlab-stack --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name examlab-stack --region us-east-1
bash deploy.sh
```

---

### D. El stack falla en CREATE

```bash
aws cloudformation describe-stack-events \
  --stack-name examlab-stack \
  --region us-east-1 \
  --query 'StackEvents[?ResourceStatus==`CREATE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
  --output table
```

**Errores típicos:**

#### `Image not found` / `InvalidAMIID.NotFound`
La AMI Ubuntu cambió. Re-ejecuta `deploy.sh` (busca dinámicamente la AMI más reciente).

#### `KeyPair X already exists`
```bash
aws ec2 delete-key-pair --key-name examlab-key --region us-east-1
bash deploy.sh
```

#### `BucketAlreadyOwnedByYou`
El bucket existe del deploy anterior. No es un error real, CloudFormation lo ignora.

#### `BucketAlreadyExists`
Otro usuario en AWS tomó el nombre del bucket globalmente. Cambia `PROJECT_NAME`.

#### `LimitExceeded: Address limit exceeded`
La cuenta llegó al límite de Elastic IPs (5 por defecto). Libera unas o pide aumento.

---

### E. La app responde 404 / no carga

**Verificar la cadena completa:**

```bash
# 1. ¿El servicio está corriendo?
sudo systemctl status examlab.service

# 2. ¿Está escuchando en :3000?
sudo ss -tlnp | grep 3000
# Debería mostrar: LISTEN ... :3000 ... node

# 3. ¿Responde local?
curl http://localhost:3000

# 4. ¿El security group permite puerto 3000?
aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=examlab-sg" \
  --region us-east-1 \
  --query 'SecurityGroups[0].IpPermissions[?FromPort==`3000`]'
```

Si todo lo anterior está OK pero no llegas desde tu navegador:
- Revisa que estés usando el **puerto 3000** en la URL: `http://<IP>:3000`
- Revisa firewalls corporativos (puerto 3000 a veces está bloqueado)

---

### F. CORS errors en el navegador

La app llama al Supabase API con la `VITE_SUPABASE_URL` configurada. Si la URL apunta a una IP distinta de la que ves en el navegador, habrá CORS.

**Solución:**

```bash
# Verificar que VITE_SUPABASE_URL == la IP que estás usando en el browser
sudo cat /opt/examlab/.env

# Si no coincide, regenera y reinicia
```

---

### G. Errores de migraciones SQL

```bash
# Ver migraciones aplicadas
sudo grep -A2 "Applying:" /var/log/user-data.log

# Aplicar manualmente una migración
docker exec -i supabase-db psql -U postgres -d postgres < /opt/examlab/supabase/migrations/0001_init.sql
```

Si una migración falla por dependencias entre archivos, revisa el orden alfabético — las migraciones de Supabase se aplican en orden alfabético del nombre del archivo.

---

## 🔍 Logs en CloudWatch

Si necesitas ver los logs sin conectarte a la EC2:

```bash
aws logs tail /aws/ec2/examlab --follow --region us-east-1
```

> El user-data actual no envía automáticamente a CloudWatch. Si lo necesitas, instala el CloudWatch Agent (no incluido en este template para mantenerlo simple).

---

## 🚨 Restart total

Si todo está roto y quieres empezar limpio:

```bash
# 1. Eliminar stack completo (toma ~5 min)
aws cloudformation delete-stack --stack-name examlab-stack --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name examlab-stack --region us-east-1

# 2. (Opcional) Limpiar bucket S3
BUCKET=$(aws s3 ls | grep examlab-deploy | awk '{print $3}')
aws s3 rm "s3://$BUCKET" --recursive

# 3. Re-desplegar
cd ~/examlab/lovable-aws-deployment
bash deploy.sh
```

---

## 📚 Más

- [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md) — Guía completa
- [README.md](../README.md) — Inicio rápido
- [ARCHITECTURE.md](ARCHITECTURE.md) — Arquitectura detallada
