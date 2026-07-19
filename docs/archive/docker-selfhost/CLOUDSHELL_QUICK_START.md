# ☁️ CloudShell — Quick Deploy (sin Docker local)

**Ejecuta estos comandos desde AWS CloudShell para desplegar todo automáticamente.**

---

## 📋 Requisitos

- ✅ Cuenta AWS con acceso a CloudShell
- ✅ Terminal CloudShell abierta
- ✅ Usuario IAM con los permisos de la sección **"Permisos AWS necesarios"** (abajo)
- ❌ NO necesitas Docker en tu máquina local

---

## 🔐 Permisos AWS necesarios

`deploy-cloudshell-only.sh` crea 3 stacks CloudFormation que despliegan
~25 recursos AWS distintos (VPC, RDS, EC2, ALB, ASG, IAM, KMS, etc.).
El usuario IAM o rol que ejecute el script necesita permisos para
crearlos. Tenés dos caminos:

### Opción A — Atajo: managed policies (rápido, no least-privilege)

Si la cuenta AWS es tuya o de un sandbox/dev, adjuntá estas managed
policies al usuario IAM:

| Managed policy | Para qué |
|---|---|
| `AmazonVPCFullAccess` | VPC, subnets, IGW, NAT, route tables |
| `AmazonEC2FullAccess` | Key pair, launch template, security groups, ASG, ALB |
| `AmazonRDSFullAccess` | RDS PostgreSQL + parameter group + subnet group |
| `AWSCloudFormationFullAccess` | Crear/actualizar los 3 stacks |
| `IAMFullAccess` | Crear el rol e instance profile del EC2 |
| `AWSKeyManagementServicePowerUser` | Key KMS para cifrado RDS at-rest |
| `CloudWatchLogsFullAccess` | Log groups para EC2 y RDS |
| `AutoScalingFullAccess` | ASG + scaling policies + CloudWatch alarms |
| `ElasticLoadBalancingFullAccess` | ALB + listener + target group |

Pegalas en el usuario via IAM Console → Users → Add permissions.

**Cuándo NO usar esto:** si la cuenta es de una org corporativa con
controles SCP/Permissions Boundary o si el usuario debe estar limitado
a este proyecto. Para esos casos usá la opción B.

### Opción B — Custom policy least-privilege (recomendado para prod)

Una sola policy JSON, lista para pegar. Permite todo lo necesario pero
acotado a recursos con prefijo de tu proyecto (ej. `examlab-*`).

> **Importante:** los recursos VPC/EC2/RDS no se pueden restringir tan
> finamente como S3 o Lambda (las acciones tipo `ec2:CreateVpc` no
> aceptan ARN específico — son "account-wide" by design en AWS). Por
> eso este policy mezcla scopes amplios (las creaciones) con scopes
> acotados (las acciones sobre recursos ya creados). Es el balance
> realista para este tipo de deploy.

Reemplazá `<ACCOUNT_ID>` por el tuyo y `<PROJECT>` por el nombre del
proyecto (default: `examlab`).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "IdentityAndValidation",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "cloudformation:ValidateTemplate",
        "cloudformation:GetTemplateSummary"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudFormationStacks",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:DescribeStackResource",
        "cloudformation:GetTemplate",
        "cloudformation:ListStackResources",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:ListChangeSets",
        "cloudformation:SetStackPolicy"
      ],
      "Resource": [
        "arn:aws:cloudformation:*:<ACCOUNT_ID>:stack/<PROJECT>-vpc-*/*",
        "arn:aws:cloudformation:*:<ACCOUNT_ID>:stack/<PROJECT>-rds-*/*",
        "arn:aws:cloudformation:*:<ACCOUNT_ID>:stack/<PROJECT>-ec2-*/*"
      ]
    },
    {
      "Sid": "VpcNetworking",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateVpc",
        "ec2:DeleteVpc",
        "ec2:ModifyVpcAttribute",
        "ec2:DescribeVpcs",
        "ec2:DescribeVpcAttribute",
        "ec2:CreateSubnet",
        "ec2:DeleteSubnet",
        "ec2:ModifySubnetAttribute",
        "ec2:DescribeSubnets",
        "ec2:CreateInternetGateway",
        "ec2:DeleteInternetGateway",
        "ec2:AttachInternetGateway",
        "ec2:DetachInternetGateway",
        "ec2:DescribeInternetGateways",
        "ec2:CreateNatGateway",
        "ec2:DeleteNatGateway",
        "ec2:DescribeNatGateways",
        "ec2:AllocateAddress",
        "ec2:ReleaseAddress",
        "ec2:DescribeAddresses",
        "ec2:CreateRouteTable",
        "ec2:DeleteRouteTable",
        "ec2:DescribeRouteTables",
        "ec2:CreateRoute",
        "ec2:DeleteRoute",
        "ec2:AssociateRouteTable",
        "ec2:DisassociateRouteTable",
        "ec2:CreateTags",
        "ec2:DeleteTags",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeAccountAttributes"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Ec2Compute",
      "Effect": "Allow",
      "Action": [
        "ec2:CreateKeyPair",
        "ec2:DeleteKeyPair",
        "ec2:DescribeKeyPairs",
        "ec2:CreateLaunchTemplate",
        "ec2:DeleteLaunchTemplate",
        "ec2:CreateLaunchTemplateVersion",
        "ec2:DescribeLaunchTemplates",
        "ec2:DescribeLaunchTemplateVersions",
        "ec2:ModifyLaunchTemplate",
        "ec2:CreateSecurityGroup",
        "ec2:DeleteSecurityGroup",
        "ec2:DescribeSecurityGroups",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupEgress",
        "ec2:DescribeImages",
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus",
        "ec2:RunInstances",
        "ec2:TerminateInstances",
        "ec2:StopInstances",
        "ec2:StartInstances"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AutoScalingAndAlb",
      "Effect": "Allow",
      "Action": [
        "autoscaling:CreateAutoScalingGroup",
        "autoscaling:DeleteAutoScalingGroup",
        "autoscaling:UpdateAutoScalingGroup",
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeAutoScalingInstances",
        "autoscaling:PutScalingPolicy",
        "autoscaling:DeletePolicy",
        "autoscaling:DescribePolicies",
        "autoscaling:CreateOrUpdateTags",
        "autoscaling:DeleteTags",
        "elasticloadbalancing:CreateLoadBalancer",
        "elasticloadbalancing:DeleteLoadBalancer",
        "elasticloadbalancing:ModifyLoadBalancerAttributes",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeLoadBalancerAttributes",
        "elasticloadbalancing:CreateListener",
        "elasticloadbalancing:DeleteListener",
        "elasticloadbalancing:ModifyListener",
        "elasticloadbalancing:DescribeListeners",
        "elasticloadbalancing:CreateTargetGroup",
        "elasticloadbalancing:DeleteTargetGroup",
        "elasticloadbalancing:ModifyTargetGroup",
        "elasticloadbalancing:DescribeTargetGroups",
        "elasticloadbalancing:DescribeTargetHealth",
        "elasticloadbalancing:RegisterTargets",
        "elasticloadbalancing:DeregisterTargets",
        "elasticloadbalancing:AddTags",
        "elasticloadbalancing:RemoveTags",
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:DeleteAlarms",
        "cloudwatch:DescribeAlarms"
      ],
      "Resource": "*"
    },
    {
      "Sid": "RdsDatabase",
      "Effect": "Allow",
      "Action": [
        "rds:CreateDBInstance",
        "rds:DeleteDBInstance",
        "rds:ModifyDBInstance",
        "rds:DescribeDBInstances",
        "rds:CreateDBSubnetGroup",
        "rds:DeleteDBSubnetGroup",
        "rds:DescribeDBSubnetGroups",
        "rds:CreateDBParameterGroup",
        "rds:DeleteDBParameterGroup",
        "rds:ModifyDBParameterGroup",
        "rds:DescribeDBParameterGroups",
        "rds:DescribeDBParameters",
        "rds:AddTagsToResource",
        "rds:RemoveTagsFromResource",
        "rds:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "IamRolesForEc2AndRds",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PassRole",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:CreateInstanceProfile",
        "iam:DeleteInstanceProfile",
        "iam:GetInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:RemoveRoleFromInstanceProfile",
        "iam:TagRole",
        "iam:UntagRole"
      ],
      "Resource": [
        "arn:aws:iam::<ACCOUNT_ID>:role/<PROJECT>-*",
        "arn:aws:iam::<ACCOUNT_ID>:instance-profile/<PROJECT>-*"
      ]
    },
    {
      "Sid": "KmsForRdsEncryption",
      "Effect": "Allow",
      "Action": [
        "kms:CreateKey",
        "kms:DescribeKey",
        "kms:EnableKey",
        "kms:DisableKey",
        "kms:ScheduleKeyDeletion",
        "kms:CreateAlias",
        "kms:DeleteAlias",
        "kms:UpdateAlias",
        "kms:ListAliases",
        "kms:TagResource",
        "kms:UntagResource",
        "kms:PutKeyPolicy",
        "kms:GetKeyPolicy"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:PutRetentionPolicy",
        "logs:TagLogGroup",
        "logs:UntagLogGroup",
        "logs:TagResource",
        "logs:UntagResource",
        "logs:ListTagsForResource",
        "logs:FilterLogEvents",
        "logs:GetLogEvents"
      ],
      "Resource": "arn:aws:logs:*:<ACCOUNT_ID>:log-group:/aws/*"
    }
  ]
}
```

### Cómo aplicarla

1. IAM Console → **Policies** → **Create policy** → **JSON** → pegá el bloque.
2. Reemplazá `<ACCOUNT_ID>` (12 dígitos) y `<PROJECT>` (tu nombre, default `examlab`).
3. Name: `ExamLabCloudShellDeploy`.
4. IAM Console → **Users** → tu usuario → **Add permissions** → **Attach** → marcá `ExamLabCloudShellDeploy`.
5. Verificá en CloudShell: `aws sts get-caller-identity`.

### Notas operativas

- **`iam:PassRole`** es load-bearing: CloudFormation crea el InstanceProfile y se lo asigna a las EC2 — sin este permiso falla con `User is not authorized to perform iam:PassRole`.
- **`kms:CreateKey` no se puede restringir por ARN** (la key no existe aún). Una vez creada, CF se encarga de no tocar otras.
- **`ec2:CreateVpc`** y similares **son inherentemente "account-wide"**: no podés restringirlas a un VPC específico porque la restricción aplica DESPUÉS de creado, no en la creación. Es una limitación del modelo IAM, no del policy.
- Si tu org usa **Permissions Boundary** o **SCPs**, asegurate de que el boundary permita estas acciones — sino el policy es ignorado.
- Esta policy **NO incluye** permisos de Supabase/Lovable (esos son tokens de cuenta externa, fuera de IAM).
- **Para destruir todo** (`aws cloudformation delete-stack`) usás los mismos permisos — están incluidos.

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
