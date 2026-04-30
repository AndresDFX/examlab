# Guía técnica de despliegue

Detalle técnico de qué se despliega y cómo está configurado.

> Si solo quieres desplegar tu proyecto, usa el [README.md](README.md) — esta
> guía es para entender qué pasa por detrás.

---

## 🧱 Recursos AWS creados por el deploy

| Recurso | Detalle |
|---------|---------|
| **VPC** | `10.0.0.0/16` con DNS habilitado |
| **Subnet pública** | `10.0.1.0/24` con auto-assign public IP |
| **Internet Gateway** | Enrutamiento al exterior |
| **Security Group** | Ingreso desde `0.0.0.0/0` a puertos 22, 80, 443, 3000, 8000 |
| **EC2** | t3.medium (2 vCPU, 4 GB RAM) con Ubuntu 22.04 LTS |
| **EBS** | 30 GB gp3 con `DeleteOnTermination: true` |
| **Elastic IP** | IP fija que sobrevive a reinicios |
| **IAM Role** | CloudWatch + S3 (deploy + storage) + SSM Session Manager |
| **S3 — bucket de deploy** | `<proyecto>-deploy-<account>-<region>` (código tar.gz + bootstrap.sh) |
| **S3 — bucket de storage** | `<proyecto>-storage-<account>-<region>` (uploads de Supabase Storage) |
| **CloudWatch Log Group** | `/aws/ec2/<proyecto>` con retención 7 días |

---

## 🔄 Secuencia de boot

Cuando la EC2 arranca, ejecuta este flujo automáticamente:

```
[user-data minimal]
  ↓ Instala AWS CLI
  ↓ Descarga bootstrap.sh desde S3
  ↓ Ejecuta bootstrap.sh
[bootstrap.sh — 9 pasos]
  ↓ [1/9] apt update + 2GB swap (mitiga OOM)
  ↓ [2/9] Node.js 20 desde NodeSource
  ↓ [3/9] Docker + Docker Compose v2
  ↓ [4/9] Espera asociación de Elastic IP (con IMDSv2)
  ↓ [5/9] Descarga código de la app desde S3
  ↓ [6/9] Setup Supabase self-hosted:
       - Clona supabase/supabase (rama master)
       - Genera JWT secret + ANON_KEY + SERVICE_ROLE_KEY (HMAC-SHA256, 10 años)
       - Genera passwords aleatorios (DB, Studio, Vault, Logflare)
       - Reescribe URLs con la EIP real
       - Copia migraciones SQL a /opt/supabase/volumes/db/init
       - Copia edge functions a /opt/supabase/volumes/functions
       - Sustituye URL Lovable Gateway → Gemini OpenAI-compatible endpoint
       - Inyecta wrapper de fetch con fallback automático de modelos
       - docker compose up -d
  ↓ [7/9] Aplica migraciones SQL contra postgres
  ↓ [8/9] Crea /opt/lovable-app/.env con VITE_SUPABASE_URL + ANON_KEY
  ↓        Hace npm install --legacy-peer-deps --no-audit --no-fund
  ↓ [9/9] Crea systemd service lovable-app.service y lo arranca
```

Tiempo total: **8-15 minutos** dependiendo de la región y la velocidad de descarga.

---

## 🤖 IA y fallback de modelos

### Cómo funciona

El código de Lovable apunta a `https://ai.gateway.lovable.dev` con `model: "google/gemini-2.5-flash"`.
Ese gateway es interno de Lovable y no acepta requests externas.

Durante el deploy, `bootstrap.sh` aplica dos transformaciones a las edge functions
**copiadas a la EC2** (el repo permanece intacto):

1. **`sed`** — sustituye la URL del gateway por el endpoint OpenAI-compatible de
   Google Gemini, y el modelo `google/gemini-X` por `gemini-X`.
2. **Wrapper de `fetch`** — se inyecta al inicio de cada `index.ts` que usa Gemini.
   Intercepta llamadas a `generativelanguage.googleapis.com` y, si el modelo devuelve
   429 (cuota) o 503 (saturación), reintenta con la siguiente cadena de fallback:
   ```
   modelo original (gemini-2.5-flash)
     → gemini-2.0-flash
     → gemini-2.0-flash-lite
     → gemini-1.5-flash
     → gemini-1.5-flash-8b
   ```
   El wrapper es transparente: el código original recibe una `Response` exitosa
   sin enterarse del fallback.

### Resultado

- Si tu cuota de `gemini-2.5-flash` se agota, automáticamente usa `gemini-2.0-flash`
- Solo verás un error si **todos** los modelos fallan
- El log del container `functions` muestra `[AI fallback] succeeded with X` cuando
  hizo fallback

### Sin tocar el código fuente

El repo permanece intacto. Toda la lógica de fallback se inyecta en el momento del
deploy. Cuando vuelvas a Lovable y hagas push, no notarás cambios en el código local.

---

## 🗄️ Storage (uploads de archivos)

Supabase Storage por defecto guarda los archivos en disco local del container.
En este deploy se usa **disco local del EC2** dentro del container, en
`/var/lib/storage` (montado a `/opt/supabase/volumes/storage` del host).

> **Nota:** existe un bucket `lovable-app-storage-*` en S3 reservado para usar como
> backend de Storage en el futuro, pero actualmente no está conectado por
> compatibilidad. Los archivos se persisten en el EBS de la EC2.

### Implicaciones

- ✅ Los archivos sobreviven a reinicios de la EC2
- ❌ Si haces `delete-stack`, se pierden todos los uploads
- ❌ El disco de 30 GB se puede llenar si suben muchos archivos

Para producción real, considera:
- Aumentar el tamaño del EBS (`VolumeSize` en CloudFormation)
- O conectar el bucket S3 como backend (configurar `STORAGE_BACKEND=s3` en el `.env`
  de Supabase y reiniciar)

---

## 🔐 Credenciales generadas

El `bootstrap.sh` genera y guarda en `/root/lovable-app-credentials.txt` (modo `600`):

```
JWT_SECRET                    32 bytes hex
ANON_KEY                      JWT firmado HS256 con role=anon, válido 10 años
SERVICE_ROLE_KEY              JWT firmado HS256 con role=service_role, 10 años
POSTGRES_PASSWORD             16 bytes hex
DASHBOARD_PASSWORD            12 bytes hex (para Supabase Studio)
SECRET_KEY_BASE               32 bytes hex (Realtime/Phoenix)
VAULT_ENC_KEY                 16 bytes hex (Postgres Vault)
LOGFLARE_API_KEY              16 bytes hex
LOGFLARE_PUBLIC_TOKEN         16 bytes hex
LOGFLARE_PRIVATE_TOKEN        16 bytes hex
```

Para verlas:

```bash
aws ssm start-session --target <INSTANCE_ID> --region us-east-1
sudo cat /root/lovable-app-credentials.txt
```

---

## 🌐 Variables de entorno de la app

`/opt/lovable-app/.env` se genera automáticamente:

```bash
VITE_SUPABASE_URL=http://<ELASTIC_IP>:8000
VITE_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY>
VITE_SUPABASE_PROJECT_ID=lovable-app
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
```

Vite las inyecta en build/dev time vía `import.meta.env.VITE_*`.

---

## 🔄 Comportamiento de actualizaciones

`deploy.sh` detecta si el stack ya existe:

### Stack nuevo (CREATE)
- Crea todos los recursos
- EC2 ejecuta `bootstrap.sh` completo
- Tiempo: ~15 minutos

### Stack existente (UPDATE)
- CloudFormation hace update de los parámetros
- **Adicionalmente, ejecuta un script live-update vía SSM** que:
  - Re-descarga el código desde S3
  - Refresca las edge functions
  - Reaplica el sed (URL Gemini) y el wrapper de fallback
  - Actualiza la `LOVABLE_API_KEY` en el `.env` de Supabase
  - Reinicia el container `functions`
  - Si cambió `package.json`, reinstala dependencias npm
  - Reinicia `lovable-app.service`
- Tiempo: ~3 minutos
- **No recrea la EC2, no se pierden datos**

---

## 🛡️ Modelo de seguridad

### Buenas prácticas

- ✅ EC2 sin credenciales AWS estáticas — usa rol IAM
- ✅ EC2 sin credenciales GitHub — código viene del bucket S3 propio
- ✅ JWT secret aleatorio por instancia
- ✅ Session Manager habilitado (no requiere SSH key abierto a internet para admin)
- ✅ Credenciales en `/root/` con permisos 600
- ✅ IMDSv2 con hop limit 2 (containers pueden usar el rol IAM)

### Limitaciones conocidas

- ❌ Puertos 80, 443, 3000, 8000 abiertos a `0.0.0.0/0` (restringe por CIDR para producción)
- ❌ Sin HTTPS por defecto (sin certificado configurado)
- ❌ ANON_KEY tiene 10 años de validez (rotarla en producción)
- ❌ Supabase Studio expuesto al mundo (protegido solo por basic auth)

---

## 💰 Costos estimados (us-east-1)

| Recurso | Costo aproximado |
|---------|------------------|
| EC2 t3.medium 24/7 | ~$30/mes |
| EBS 30GB gp3 | ~$2.40/mes |
| Elastic IP (asociada) | $0 |
| S3 buckets (~50MB total) | ~$0.05/mes |
| CloudWatch Logs (7 días) | ~$0.50/mes |
| **Total estimado** | **~$33/mes** |

> Si paras la EC2 sin eliminar el stack, sigues pagando la EIP (~$3.6/mes).
> Mejor `delete-stack` cuando no se use.

---

## 📁 Archivos del despliegue

```
lovable-aws-deployment/
├── deploy.sh                       # Orquestador (corre en CloudShell)
├── README.md                       # Guía paso a paso (para usuarios finales)
├── DEPLOYMENT_GUIDE.md             # Este archivo (técnico)
├── cloudformation/
│   ├── all-in-one-stack.yaml       # Recursos AWS + user-data minimal
│   └── bootstrap.sh                # Script principal que corre en la EC2
├── screenshots/                    # Imágenes referenciadas desde el README
└── docs/
    ├── ARCHITECTURE.md             # Diagrama Mermaid + decisiones
    └── TROUBLESHOOTING.md          # Soluciones a errores comunes
```

---

## 📚 Más

- [README.md](README.md) — Guía paso a paso (para usuarios finales)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Diagrama y decisiones
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Solución de problemas
