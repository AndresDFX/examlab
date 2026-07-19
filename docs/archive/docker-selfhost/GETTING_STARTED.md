# 🚀 ExamLab — ¡Comienza aquí!

**Guía para usuarios finales: Deploy local + AWS en minutos.**

---

## 📊 ¿Cuál es tu situación?

### 🎓 "Soy estudiante / usuario final"
→ Solo accede a http://localhost:3000 después de step 3
→ No necesitas AWS

### 👨‍💼 "Soy profesor / administrador"
→ Necesitas acceso a Supabase Studio (http://localhost:8000)
→ Luego puedes desplegar a AWS

### 🏢 "Soy empresa / quiero producción en AWS"
→ Sigue los 3 steps aquí
→ Luego: `bash deploy-to-aws.sh`

---

## ⚡ 3 Steps — 5 minutos

### Step 1️⃣ — Clonar

```bash
git clone https://github.com/vivetori/examlab.git
cd examlab
```

### Step 2️⃣ — Setup (responde 4 preguntas)

```bash
bash setup.sh
```

**Preguntas:**
```
Nombre del proyecto [examlab]: _
Contraseña Postgres (mín 12 chars): _
Región AWS [us-east-1]: _
AWS Account ID (12 dígitos): _
```

**Esto genera:**
- ✅ `.env` — Variables de tu proyecto
- ✅ `docker-compose.override.yml` — Tu configuración personalizada

### Step 3️⃣ — Levantar todo

```bash
docker-compose up -d
```

Espera 30 segundos...

---

## ✅ Verificar que funciona

Abre en navegador:

| URL | Qué es | Acceso |
|-----|--------|--------|
| http://localhost:3000 | ExamLab app | Sin credenciales |
| http://localhost:8000 | Supabase Studio | admin@example.com / password |

Ves la app? ✅ **Excelente. Estás listo.**

---

## 🚀 Publicar a AWS (opcional)

Si quieres que la app esté en producción:

```bash
bash deploy-to-aws.sh
```

El script:
1. ✅ Hace backup automático de tu BD
2. ✅ Valida configuración
3. ✅ Despliega en AWS (EC2 + RDS + ALB)
4. ✅ Imprime tu URL pública

**Tiempo:** 10-15 minutos

Recibirás información como:

```
🌐 Aplicación: http://examlab-alb-xxx.us-east-1.elb.amazonaws.com
🔑 SSH: ssh -i ~/.ssh/examlab-production.pem ec2-user@examlab-alb-xxx...
💾 Base de datos: examlab-rds-xxx.us-east-1.rds.amazonaws.com
```

---

## 📋 Arquitectura (Cómo funciona)

```
┌─────────────────────────────────────────────────┐
│  TU COMPUTADORA                                 │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌───────┐  ┌──────────┐  ┌───────┐           │
│  │ Código│  │ Docker   │  │Browser│           │
│  │ (Git) │  │Containers│  │       │           │
│  └───────┘  └──────────┘  └───────┘           │
│       │           │            │               │
│       └───────┬───┴───────┬────┘               │
│               ▼           ▼                    │
│            PostgreSQL    App (Node.js)        │
│            Supabase      Nginx                │
│                                               │
└─────────────────────────────────────────────────┘
             LOCAL (docker-compose)

                    ||
                   PUSH
                    ||
                    ▼

┌──────────────────────────────────────────────────┐
│  AWS (Producción)                                │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌────────────────────────────────────────────┐│
│  │         Application Load Balancer          ││
│  │        (Tu URL pública)                    ││
│  └────────────────────────────────────────────┘│
│               │                                 │
│  ┌────────────┴────────────┐                  │
│  ▼                         ▼                  │
│ EC2 Instance 1        EC2 Instance 2         │
│ (t3.small)            (Standby)              │
│                                              │
│  ┌──────────────────────────────────────────┐│
│  │  RDS PostgreSQL 15.4                     ││
│  │  (Encrypted, Multi-AZ Backup)           ││
│  └──────────────────────────────────────────┘│
│                                              │
└──────────────────────────────────────────────┘
```

---

## 🛠️ Comandos útiles

```bash
# Ver estado
docker-compose ps

# Ver logs
docker-compose logs -f app

# Detener todo
docker-compose down

# Reiniciar
docker-compose restart

# Acceder a BD
docker-compose exec postgres psql -U postgres -d examlab
```

---

## ❌ Algo no funciona?

### "Docker no está instalado"
→ Descarga en https://docker.com

### "Port 3000 está en uso"
→ Edita `.env` y cambia `APP_PORT=3001`
→ Luego: `docker-compose restart app`

### "Supabase tarda mucho en iniciar"
→ Normal. Espera ~30 segundos.
→ Verifica: `docker-compose ps`

### "Fallo el deploy a AWS"
→ Verifica credenciales: `aws sts get-caller-identity`
→ Verifica Docker corriendo: `docker-compose ps`

**Más ayuda:** [DOCKER_DEPLOYMENT.md](DOCKER_DEPLOYMENT.md)

---

## 📚 Documentación completa

### Para aprender más:

| Documento | Para qué |
|-----------|----------|
| [SETUP_SIMPLE.md](SETUP_SIMPLE.md) | Guía paso a paso |
| [DOCKER_DEPLOYMENT.md](DOCKER_DEPLOYMENT.md) | Todo sobre Docker |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Cómo funciona internamente |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Solucionar problemas |

### Para desplegar a AWS:

| Documento | Para qué |
|-----------|----------|
| [docs/LOCAL_TO_AWS_WORKFLOW.md](docs/LOCAL_TO_AWS_WORKFLOW.md) | Flujo local → AWS |
| [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md) | Deploy automático con GitHub |

### Para editar código:

| Documentos | Para qué |
|-----------|----------|
| [CLAUDE.md](CLAUDE.md) | Info del proyecto (para Claude) |
| [docs/INDEX.md](docs/INDEX.md) | Índice de documentación |

---

## 🎯 Próximos pasos

### Opción A: Solo local (desarrollo)
```bash
# Ya está listo en http://localhost:3000
# Edita código en src/
# Los cambios aparecen automáticamente
```

### Opción B: Publicar a AWS (producción)
```bash
# Cuando esté listo:
bash deploy-to-aws.sh

# Accede a tu app pública ~5 minutos después
# URL: http://examlab-alb-xxx.us-east-1.elb.amazonaws.com
```

### Opción C: Deployment automático (GitHub)
```bash
# Para que cada push a main despliegue automáticamente:
# Ver: docs/GITHUB_ACTIONS_SETUP.md

# 1. Crear usuario IAM
bash scripts/create-github-iam-user.sh

# 2. Agregar secrets en GitHub
# 3. Push a main = deploy automático a AWS
```

---

## ✨ Esto es lo que obtuviste

✅ Entorno local 100% funcional (PostgreSQL + Supabase + App)  
✅ Base de datos persistente (no se borra al reiniciar)  
✅ Desarrollo con hot-reload (cambios al instante)  
✅ Backup automático antes de desplegar  
✅ Despliegue a AWS en 1 comando  
✅ Auto-scaling en AWS (1-2 instancias)  
✅ Monitoreo con CloudWatch  
✅ Documentación completa  

---

## 📞 ¿Necesitas ayuda?

1. **Lee:** [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
2. **Busca en logs:** `docker-compose logs -f`
3. **Pregunta:** Revisa la documentación de Docker/Supabase/AWS
4. **Reporta bug:** Abre issue en GitHub

---

## 🎓 Concepto clave: Docker

Docker te permite:

- 🔒 Mismo entorno en local y en AWS
- ⚡ Setup en 5 minutos (sin instalar 10 cosas)
- 📦 Despliegue reproducible
- 🚀 Escalar fácilmente después

No necesitas entender Docker internamente. Solo:
```bash
docker-compose up -d    # Levantar
docker-compose down     # Apagar
docker-compose logs -f  # Ver qué pasa
```

---

**¿Listo? Corre:**

```bash
bash setup.sh && docker-compose up -d
```

**Luego accede a:** http://localhost:3000

---

**Última actualización:** 2026-04-28

ExamLab — Deploy sin complicaciones 🚀
