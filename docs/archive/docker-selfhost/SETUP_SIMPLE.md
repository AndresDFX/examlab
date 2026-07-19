# 🚀 ExamLab — Setup en 3 pasos

**Para usuarios sin experiencia técnica.**

Despliega ExamLab localmente con Docker y luego a AWS con un solo comando.

---

## 📋 Requisitos previos

- **Docker** instalado ([Descargar](https://docker.com))
- **Git** instalado ([Descargar](https://git-scm.com))
- Cuenta **AWS** con acceso administrativo
- Terminal/Command Prompt abierta

---

## ⚡ 3 Pasos rápidos

### Paso 1️⃣ — Clonar el proyecto

```bash
git clone <URL-DEL-REPO>
cd examlab
```

### Paso 2️⃣ — Configurar el proyecto

```bash
bash setup.sh
```

Responde las preguntas:
- **Nombre del proyecto** (default: `examlab`)
- **Contraseña Postgres** (mínimo 12 caracteres)
- **Región AWS** (default: `us-east-1`)
- **AWS Account ID** (12 dígitos)

✅ Esto genera el archivo `.env`

### Paso 3️⃣ — Levantar todo

```bash
docker-compose up -d
```

Espera ~30 segundos a que todo inicie.

---

## ✅ Verificar que todo funciona

### Ver el estado de los contenedores

```bash
docker-compose ps
```

Debes ver todos con estado **healthy** o **running**:

```
NAME                    STATUS
examlab-postgres        healthy
examlab-supabase        healthy
examlab-app             healthy
examlab-nginx           running
examlab-redis           running
```

### Acceder a la app

Abre en tu navegador:

- **App**: [http://localhost:3000](http://localhost:3000)
- **Supabase Studio**: [http://localhost:8000](http://localhost:8000)
  - Email: `admin@example.com`
  - Password: `password`

---

## 🚀 Desplegar a AWS

Cuando estés listo para publicar a producción:

```bash
bash deploy-to-aws.sh
```

El script:
1. ✅ Crea backup de tu base de datos
2. ✅ Configura AWS CloudFormation
3. ✅ Despliega la app en EC2
4. ✅ Configura base de datos en RDS
5. ✅ Muestra la URL de acceso

**Tiempo:** ~10-15 minutos

---

## 📖 Después del despliegue

Recibirás información como:

```
🌐 Aplicación:
   URL: http://examlab-alb-12345.us-east-1.elb.amazonaws.com

🔑 SSH:
   ssh -i ~/.ssh/examlab-production.pem ec2-user@examlab-alb-12345...

💾 Base de datos:
   Endpoint: examlab-rds-production-xxxxx.us-east-1.rds.amazonaws.com
```

---

## 🛠️ Comandos útiles

### Ver logs de la app

```bash
docker-compose logs -f app
```

### Detener todo

```bash
docker-compose down
```

### Reiniciar todo

```bash
docker-compose restart
```

### Acceder a la base de datos (local)

```bash
docker-compose exec postgres psql -U postgres -d examlab
```

### Ver backup creados

```bash
ls -lh backups/
```

---

## ❌ Solucionar problemas

### "Docker no está instalado"

Descarga e instala desde [docker.com](https://docker.com)

### "Port 3000 ya está en uso"

Cambia el puerto en `.env`:
```
APP_PORT=3001
```

Luego: `docker-compose restart app`

### "Supabase no está respondiendo"

Espera 30 segundos y recarga:
```bash
docker-compose ps
docker-compose logs supabase
```

### "Fallo al desplegar a AWS"

Verifica:
```bash
# 1. Credenciales AWS
aws sts get-caller-identity

# 2. Docker está corriendo
docker-compose ps

# 3. Archivo .env existe
cat .env | grep AWS
```

---

## 📚 Guías adicionales

- **Arquitectura**: Ver [ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Backups**: Ver [BACKUPS.md](docs/BACKUPS.md)
- **Troubleshooting**: Ver [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- **GitHub Actions CI/CD**: Ver [GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md)

---

## 🎯 Resumen

| Acción | Comando | Tiempo |
|--------|---------|--------|
| Setup inicial | `bash setup.sh` | 1 min |
| Levantar local | `docker-compose up -d` | 30 seg |
| Desplegar AWS | `bash deploy-to-aws.sh` | 10-15 min |
| Ver logs | `docker-compose logs -f app` | Inmediato |

---

## 💡 Tips

✅ **Antes de desplegar a AWS:**
- Prueba todo localmente
- Asegúrate que `docker-compose ps` muestra todo healthy
- Haz cambios primero en local

✅ **Para editar código:**
- Los cambios en `src/` se aplican automáticamente (hot reload)
- Reconstruye si cambias dependencias: `docker-compose rebuild app`

✅ **Para backups:**
- Se crean automáticamente en `backups/`
- Descárgalos regularmente

---

**¿Necesitas ayuda?**

1. Revisa los logs: `docker-compose logs -f`
2. Verifica el status: `docker-compose ps`
3. Lee: [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

**Última actualización:** 2026-04-28
