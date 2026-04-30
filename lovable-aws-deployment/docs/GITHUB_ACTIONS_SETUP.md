# Setup de GitHub Actions (CI/CD)

Configurar deploy automático a AWS en cada push a `main`.

> **Workflow:** [`.github/workflows/deploy-aws.yml`](../../.github/workflows/deploy-aws.yml)
>
> **Tiempo de setup:** ~10 minutos (una sola vez)

---

## 🎯 Qué consigues

- ✅ Cada `git push origin main` → deploy automático a AWS
- ✅ El workflow detecta si el stack ya existe → hace UPDATE sin recrear EC2 (~3 min)
- ✅ Si el stack no existe → CREATE completo (~15 min)
- ✅ Logs de cada deploy visibles en GitHub Actions
- ✅ Rollback fácil — solo `git revert` y push

---

## 📋 Pasos

### 1. Crear el IAM user de GitHub Actions

Desde AWS CloudShell:

```bash
cd ~/examlab/lovable-aws-deployment
bash scripts/create-github-iam-user.sh
```

El script genera:
- Un IAM user llamado `github-actions-examlab`
- Una política con los permisos exactos que necesita el workflow
- Una `Access Key ID` y `Secret Access Key`

**Copia las credenciales que imprime al final** — las usas en el siguiente paso.

> Si prefieres hacerlo manualmente: el IAM user necesita los permisos
> `AmazonEC2FullAccess`, `AmazonS3FullAccess`, `IAMFullAccess`,
> `AWSCloudFormationFullAccess`, `AmazonSSMFullAccess`. Para producción,
> reduce a least-privilege.

### 2. Configurar los secrets en GitHub

En tu repo de GitHub:

1. Ve a **Settings** → **Secrets and variables** → **Actions**
2. Click en la pestaña **"Secrets"**
3. Click **"New repository secret"** y agrega:

| Secret name | Valor |
|-------------|-------|
| `AWS_ACCESS_KEY_ID` | El Access Key del paso 1 |
| `AWS_SECRET_ACCESS_KEY` | El Secret Access Key del paso 1 |
| `DB_PASSWORD` | Una contraseña segura para PostgreSQL (mín. 12 chars) |
| `LOVABLE_API_KEY` | *(opcional)* Tu key de Google Gemini `AIzaSy...` |

### 3. Configurar las variables (no son secret)

En la misma pantalla, click **"Variables"** → **"New repository variable"**:

| Variable name | Valor sugerido |
|---------------|----------------|
| `AWS_REGION` | `us-east-1` (o la región que prefieras) |
| `PROJECT_NAME` | `examlab` |

### 4. Hacer un push de prueba

```bash
git commit --allow-empty -m "ci: trigger first deploy"
git push origin main
```

### 5. Ver el progreso

En GitHub: **Actions** → click en el workflow run más reciente.

Verás cada paso ejecutándose. El primer deploy tarda ~15 min (CREATE), los
siguientes ~3 min (UPDATE).

---

## 🔄 Flujo de trabajo

```
┌──────────────────┐
│  Editas código   │
│  (Lovable o IDE) │
└────────┬─────────┘
         │
         │ git push origin main
         ▼
┌────────────────────────────┐
│  GitHub Actions trigger    │
│  .github/workflows/        │
│    deploy-aws.yml          │
└────────┬───────────────────┘
         │
         │ AWS credentials desde secrets
         ▼
┌────────────────────────────┐
│  Empaqueta código          │
│  Sube a S3                 │
│  CloudFormation deploy     │
└────────┬───────────────────┘
         │
         │ ¿Stack existe?
         │
    ┌────┴────┐
    │         │
    ▼ NO      ▼ SÍ
┌────────┐ ┌──────────────┐
│ CREATE │ │ UPDATE       │
│ ~15min │ │ + SSM live   │
│ EC2    │ │ update ~3min │
│ corre  │ │ (sin recrear │
│ boot   │ │  EC2)        │
└───┬────┘ └──────┬───────┘
    │            │
    └────┬───────┘
         ▼
┌────────────────────────────┐
│  ✅ App actualizada en     │
│     http://EIP:3000        │
└────────────────────────────┘
```

---

## ⚙️ Triggers del workflow

El workflow corre automáticamente cuando:

- Push a `main` que toca:
  - `src/**` — código de la app
  - `supabase/**` — migraciones o edge functions
  - `package.json` o `package-lock.json`
  - `lovable-aws-deployment/**`
  - El propio workflow

También puedes correrlo manualmente:

1. Ve a **Actions** → **"Deploy ExamLab to AWS"**
2. Click **"Run workflow"** → elige la rama → **"Run workflow"**

---

## 🆘 Troubleshooting

### "AccessDenied" en algún paso

El IAM user no tiene los permisos suficientes. Ejecuta de nuevo
`bash scripts/create-github-iam-user.sh` y actualiza la policy.

### El workflow se cuelga en "Apply live-update"

Significa que la EC2 no responde a SSM. Verifica:
- EC2 está running (no stopped)
- IAM role de la EC2 tiene `AmazonSSMManagedInstanceCore`
- SSM Agent está corriendo en la EC2

Conéctate a la EC2 con Session Manager y reinicia el agent:

```bash
sudo systemctl restart amazon-ssm-agent
```

### "Stack already exists in ROLLBACK_COMPLETE state"

Un deploy anterior falló y dejó el stack en estado de rollback.

```bash
aws cloudformation delete-stack --stack-name examlab-stack --region us-east-1
aws cloudformation wait stack-delete-complete --stack-name examlab-stack --region us-east-1
```

Luego re-corre el workflow.

### Cómo deshabilitar temporalmente

Renombra el archivo a `.yml.disabled`:

```bash
mv .github/workflows/deploy-aws.yml .github/workflows/deploy-aws.yml.disabled
git commit -am "chore: disable auto-deploy"
git push
```

---

## 🔐 Buenas prácticas de seguridad

- ✅ **Rota los secrets** cada 90 días (especialmente `AWS_SECRET_ACCESS_KEY`)
- ✅ Usa **GitHub Environments** para producción (aprobación manual antes de deploy)
- ✅ Limita el IAM user a una policy específica del proyecto, no `AdministratorAccess`
- ✅ Habilita **branch protection** en `main` (require PR + review antes de merge)
- ❌ **Nunca** commitees secrets en código (usa `.env` en `.gitignore`)
- ❌ **Nunca** uses tu Access Key personal en GitHub Actions — siempre usa un IAM user dedicado

---

## 📚 Referencias

- [GitHub Actions docs](https://docs.github.com/en/actions)
- [AWS Actions configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials)
- [README.md principal del despliegue](../README.md)
