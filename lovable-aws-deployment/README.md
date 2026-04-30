# Despliegue de ExamLab en AWS

**Despliega tu proyecto Lovable en tu propia cuenta AWS con un solo comando, en ~15 minutos.**

> Esta guía es para usuarios sin experiencia técnica. Cada paso es literal —
> copia, pega, espera.

---

## ✅ Lo que vas a tener al final

- 🌐 La aplicación corriendo en una IP fija de AWS
- 🗄️ Supabase completo en tu cuenta (PostgreSQL, Auth, Storage, Edge Functions)
- 🤖 Funciones de IA (si tu proyecto las usa)
- 🔐 Tu propia infraestructura, sin vendor lock-in

**Costo aproximado:** ~$33 USD/mes (EC2 t3.medium + IP fija + S3 + CloudWatch).

---

## 📋 Prerrequisitos

Antes de empezar necesitas:

| Requisito | Cómo conseguirlo |
|-----------|------------------|
| Cuenta AWS | [aws.amazon.com](https://aws.amazon.com) — incluye 12 meses gratis |
| Tarjeta de crédito | Para verificar la cuenta AWS (no se cobra el setup) |
| API key de Google Gemini *(solo si tu proyecto usa IA)* | Ver **Paso 1** abajo |

❌ **NO necesitas:** Docker, Node.js, AWS CLI ni nada instalado en tu máquina.

---

## 🤖 Paso 1: Obtener API key de Google Gemini *(opcional)*

> **Si tu proyecto NO usa IA, salta este paso.**
>
> ¿Cómo sé si mi proyecto usa IA? Revisa si tiene botones tipo "Generar con IA",
> "Calificar automáticamente", "Sugerir preguntas". Si no, no usa IA.

### 1.1 Ir a Google AI Studio

Abre en tu navegador: **https://aistudio.google.com/apikey**

### 1.2 Iniciar sesión con Google

Usa cualquier cuenta de Google (personal o de trabajo).

> 📸 _Screenshot: AI Studio login_
> ![AI Studio login](screenshots/01-aistudio-login.png)
> *(reemplazar con captura real del paso 1.2)*

### 1.3 Crear la API key

1. Click en el botón **"Create API key"** (azul, esquina superior derecha)
2. Selecciona un proyecto de Google Cloud existente, o click **"Create API key in new project"**
3. Espera unos segundos y aparecerá tu key

> 📸 _Screenshot: pantalla de "Create API key"_
> ![Create API key](screenshots/02-create-api-key.png)
> *(reemplazar con captura del modal de creación)*

### 1.4 Copiar la key

La key tiene este formato:

```
AIzaSyAwgl5hwI8s-ElO55WjP8IPjzcpL210gZM
```

> ⚠️ **Cópiala y guárdala temporalmente** (en un bloc de notas). La pegarás en el Paso 5.
>
> Si la pierdes, no es problema — vuelves a este paso y creas otra.

### 1.5 Costos

Google Gemini tiene un **tier gratuito generoso**:
- 15 requests/min
- 1.500 requests/día

Suficiente para uso de prueba y demos. Si necesitas más, agrega facturación en
Google Cloud (los precios están en [ai.google.dev/pricing](https://ai.google.dev/pricing)).

---

## ☁️ Paso 2: Abrir AWS CloudShell

CloudShell es una terminal Linux gratuita dentro de la consola de AWS. Ya tiene
todo lo necesario: AWS CLI, git, bash, openssl.

### 2.1 Iniciar sesión en AWS

Abre: **https://console.aws.amazon.com/**

### 2.2 Abrir CloudShell

Click en el icono de **terminal** (`>_`) en la barra superior, al lado de la
campanita y tu nombre de usuario, o ve directamente a:
**https://console.aws.amazon.com/cloudshell/**

> 📸 _Screenshot: barra superior de AWS Console resaltando el icono de CloudShell_
> ![CloudShell icon](screenshots/03-cloudshell-icon.png)
> *(reemplazar con captura de la consola AWS mostrando dónde hacer click)*

### 2.3 Esperar a que CloudShell cargue

Tarda ~30 segundos la primera vez. Cuando veas el prompt `[cloudshell-user@... ~]$`
está listo.

> 📸 _Screenshot: terminal de CloudShell lista_
> ![CloudShell ready](screenshots/04-cloudshell-ready.png)
> *(reemplazar con captura de la terminal cargada)*

---

## 📦 Paso 3: Clonar el repositorio

En CloudShell, ejecuta este comando (copia todo, pega con Ctrl+Shift+V):

```bash
git clone https://github.com/vivetori/examlab.git
```

Espera a que termine (~5 segundos). Verás algo como:

```
Cloning into 'examlab'...
remote: Enumerating objects...
Receiving objects: 100% (1234/1234), done.
```

> 📸 _Screenshot: output del git clone exitoso_
> ![Git clone OK](screenshots/05-git-clone.png)
> *(reemplazar con captura del clone completado)*

---

## 🚀 Paso 4: Ir a la carpeta de despliegue

```bash
cd examlab/lovable-aws-deployment
```

Y dale permisos de ejecución al script:

```bash
chmod +x deploy.sh
```

---

## ▶️ Paso 5: Ejecutar el despliegue

```bash
./deploy.sh
```

El script te hará 4 preguntas. Pega cada cosa donde corresponde:

### Pregunta 1 — Nombre del proyecto

```
Nombre del proyecto [examlab]:
```

→ **Presiona Enter** (deja `examlab`).

### Pregunta 2 — Contraseña de la base de datos

```
Contraseña DB (Enter para generar):
```

→ **Presiona Enter** (genera una contraseña segura automáticamente).

### Pregunta 3 — Región AWS

```
Región AWS [us-east-1]:
```

→ **Presiona Enter** (deja `us-east-1`, que es la más barata y completa).

### Pregunta 4 — API key de Gemini

```
═══════════════════════════════════════════════════════════════
    PASO 4 de 4: Google Gemini API Key [OPCIONAL]
═══════════════════════════════════════════════════════════════
   ...

  >>> Pega la API key de Gemini aquí (o Enter para saltar):
```

→ **Pega la key del Paso 1** (`AIzaSy...`). La pegada no se mostrará por seguridad,
  eso es normal. Luego presiona **Enter**.

→ Si tu proyecto NO usa IA, simplemente **presiona Enter** sin pegar nada.

### Confirmación

```
Resumen:
  Proyecto: examlab
  Región:   us-east-1
  Cuenta:   123456789012
  IA:       habilitada (Google Gemini)

¿Continuar? (s/n):
```

→ Escribe **`s`** y presiona Enter.

> 📸 _Screenshot: resumen antes de confirmar_
> ![Deploy confirmation](screenshots/06-deploy-confirm.png)
> *(reemplazar con captura del resumen y prompt "¿Continuar?")*

---

## ⏳ Paso 6: Esperar (~15 minutos)

El script va a:

1. ✅ Crear buckets de S3
2. ✅ Empaquetar el código y subirlo
3. ✅ Crear el stack de CloudFormation (VPC, EC2, IAM, etc.)
4. ✅ La EC2 instala Node, Docker, Supabase y la app

**No cierres CloudShell** durante el proceso. Verás logs avanzando paso a paso.

Al final verás algo como:

```
✓ Stack desplegado
✓ Información guardada: /home/cloudshell-user/examlab-deployment-info.txt
═════════════════════════════════════════════════════════════
```

> 📸 _Screenshot: deploy completado en CloudShell_
> ![Deploy complete](screenshots/07-deploy-complete.png)
> *(reemplazar con captura del output final con la URL)*

---

## 🔍 Paso 7: Encontrar la URL de tu app

### Opción A — Desde CloudShell

Después del paso 6, el script imprime la URL directamente. Búscala en el output:

```
🌐 ACCESO A LA APLICACIÓN:
   URL: http://54.123.45.67:3000
```

Si cerraste CloudShell, recupérala con:

```bash
cat ~/examlab-deployment-info.txt
```

### Opción B — Desde la consola de AWS

1. Ve a **CloudFormation**: https://console.aws.amazon.com/cloudformation/
2. Click en el stack **`examlab-stack`**
3. Click en la pestaña **"Outputs"**

> 📸 _Screenshot: lista de stacks de CloudFormation_
> ![CloudFormation stacks list](screenshots/08-cloudformation-list.png)
> *(reemplazar con captura mostrando examlab-stack en la lista)*

Verás una tabla así:

| Key | Value | Description |
|-----|-------|-------------|
| `AppURL` | `http://54.123.45.67:3000` | Application URL (using Elastic IP) |
| `ElasticIP` | `54.123.45.67` | Elastic IP address (fixed) |
| `InstanceId` | `i-0abc123...` | EC2 Instance ID |
| `SupabaseAPI` | `http://54.123.45.67:8000` | Supabase API endpoint |

→ Click en `AppURL` para abrir tu app en el navegador.

> 📸 _Screenshot: pestaña Outputs del stack con la URL_
> ![CloudFormation outputs](screenshots/09-cloudformation-outputs.png)
> *(reemplazar con captura de la pestaña Outputs mostrando AppURL)*

---

## 🎉 Paso 8: Usar la app

1. Abre la URL en tu navegador (ej. `http://54.123.45.67:3000`)
2. **Espera ~2 minutos más** la primera vez que abres (Vite compila los bundles)
3. Crea una cuenta de docente o haz login
4. *(Opcional)* Click en **"Iniciar datos demo"** para cargar cursos, usuarios y exámenes de prueba
5. ¡Listo!

> 📸 _Screenshot: pantalla de login de ExamLab_
> ![ExamLab login](screenshots/10-app-login.png)
> *(reemplazar con captura de la app cargada)*

> 📸 _Screenshot: dashboard del docente con datos demo cargados_
> ![ExamLab dashboard](screenshots/11-app-dashboard.png)
> *(reemplazar con captura del dashboard funcionando)*

---

## ❓ Problemas comunes

### "La página no carga" / "ERR_CONNECTION_REFUSED"

**Causa:** la EC2 todavía está instalando software.

**Solución:** espera 5 minutos más. Mientras, puedes monitorear:
1. Ve a la consola de AWS → CloudFormation → tu stack → tab **"Events"**
2. Cuando veas `CREATE_COMPLETE`, espera 5 min adicionales

### "Funciones de IA no responden" después de configurar la key

**Causa:** quota de Gemini excedida (15 req/min).

**Solución:** espera 1 minuto y reintenta. El sistema reintenta automáticamente con
modelos más básicos si el principal está saturado.

### "No tengo permisos en AWS"

**Causa:** tu usuario IAM no tiene los permisos necesarios.

**Solución:** pídele al admin que te dé estas políticas:
- `AmazonEC2FullAccess`
- `AmazonS3FullAccess`
- `IAMFullAccess`
- `AWSCloudFormationFullAccess`
- `AmazonSSMFullAccess`

O usa una cuenta con `AdministratorAccess` (no recomendado para producción).

### Otros problemas

Ver [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

---

## 🔄 Actualizar después del primer deploy

### Opción 1 — Manual (en CloudShell)

Si haces cambios en el código (en Lovable o local) y quieres re-desplegar:

```bash
cd ~/examlab
git pull
cd lovable-aws-deployment
./deploy.sh
```

El script detecta que el stack existe y solo aplica los cambios (sin recrear EC2).
Toma ~3 minutos en lugar de 15.

### Opción 2 — Automático con GitHub Actions ⭐

Cada `git push origin main` puede desplegar automáticamente sin abrir CloudShell.

**Setup (una sola vez, ~10 min):**

1. Crear IAM user para el workflow:
   ```bash
   bash scripts/create-github-iam-user.sh
   ```
2. En GitHub: **Settings → Secrets and variables → Actions** → agregar:
   - Secret `AWS_ACCESS_KEY_ID`
   - Secret `AWS_SECRET_ACCESS_KEY`
   - Secret `DB_PASSWORD`
   - Secret `LOVABLE_API_KEY` (opcional)
   - Variable `AWS_REGION` (ej. `us-east-1`)
   - Variable `PROJECT_NAME` (ej. `examlab`)
3. Hacer push y ver el deploy en **Actions** tab del repo.

El workflow está en `.github/workflows/deploy-aws.yml` y se ejecuta solo cuando
cambias archivos relevantes (no en cada commit de docs, por ejemplo).

📖 Guía completa: [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md)

---

## 🧹 Eliminar todo

Para borrar la EC2, los buckets, etc. y dejar de cobrar:

```bash
# 1. Eliminar el stack (toma ~5 min)
aws cloudformation delete-stack --stack-name examlab-stack --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name examlab-stack --region us-east-1

# 2. Eliminar los buckets S3 (opcional, cobra ~$0.05/mes si quedan)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws s3 rm "s3://examlab-deploy-${ACCOUNT}-us-east-1" --recursive
aws s3 rb "s3://examlab-deploy-${ACCOUNT}-us-east-1"
aws s3 rm "s3://examlab-storage-${ACCOUNT}-us-east-1" --recursive
aws s3 rb "s3://examlab-storage-${ACCOUNT}-us-east-1"

# 3. Eliminar SSH key (opcional)
aws ec2 delete-key-pair --key-name examlab-key --region us-east-1
```

---

## 📸 Agregar screenshots al manual

Esta guía incluye placeholders de imágenes (los `> 📸 _Screenshot: ..._` que ves
en cada paso). Para reemplazarlos con capturas reales:

1. Toma la captura durante un deploy real
2. Guárdala en `screenshots/` con el **nombre exacto** que aparece en el placeholder
   (ej. `01-aistudio-login.png`, `09-cloudformation-outputs.png`, etc.)
3. Commit y push — GitHub renderiza la imagen automáticamente

**Recomendaciones:**
- Formato PNG, ancho ≤ 1600px
- Oculta datos sensibles: API keys, account IDs, emails, IPs reales
- Usa flechas/círculos para señalar dónde hacer click ([ShareX](https://getsharex.com/), Skitch)

Mientras no existan los archivos, el README sigue siendo legible — GitHub muestra el
alt text en su lugar.

---

## 📚 Más documentación

- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) — Detalle técnico de qué se despliega
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Diagrama y decisiones de diseño
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Soluciones a problemas
- [docs/GITHUB_ACTIONS_SETUP.md](docs/GITHUB_ACTIONS_SETUP.md) — CI/CD automático
