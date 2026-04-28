# Setup de IA en AWS - Guía paso a paso

Cómo configurar IA después de migrar desde Lovable.

## 📋 Decisión rápida

### ¿Cuál servicio usar?

```
┌─────────────────────────────────────────────────┐
│ RECOMENDACIÓN: Anthropic API                    │
│                                                 │
│ ✅ Más barato que AWS Bedrock                  │
│ ✅ Más simple que configurar Bedrock            │
│ ✅ Mismo Claude model que en Lovable            │
│ ✅ Sin cambios en código existente              │
│ ✅ Datos salen de AWS (si compliance: Bedrock) │
└─────────────────────────────────────────────────┘
```

---

## 🚀 OPCIÓN 1: Usar Anthropic API (Recomendado)

### Paso 1: Obtener API Key

1. Ir a: https://console.anthropic.com/account/keys
2. Crear nueva key
3. Copiar el valor (`sk-ant-...`)

### Paso 2: Configurar en `cloudshell-vars.env`

```bash
# Editar cloudshell-vars.env

# ═══════════════════════════════════════════════════════════
# AI Configuration
# ═══════════════════════════════════════════════════════════

AI_SERVICE="anthropic"                          # Servicio a usar
ANTHROPIC_API_KEY="sk-ant-xxxxxxxxxxxxxxxxxx"  # Tu API key
AI_MODEL="claude-3-5-sonnet-20241022"          # Modelo

# Límites de seguridad (opcional)
MAX_AI_TOKENS_PER_MONTH=100000
MAX_AI_COST_PER_DAY=50
ENABLE_AI_CACHING=true                          # Cachear respuestas

# Si usas Supabase (alternativa)
# SUPABASE_URL="https://xxxxx.supabase.co"
# SUPABASE_ANON_KEY="eyJ..."
```

### Paso 3: Guardar en AWS Secrets Manager (Seguridad)

```bash
# Desde CloudShell:
aws secretsmanager create-secret \
  --name examlab/anthropic-key \
  --secret-string '{"api_key":"sk-ant-..."}' \
  --region us-east-1 \
  --tags Key=Project,Value=examlab
```

### Paso 4: Actualizar user_data.sh

En `configs/user_data.sh`, agregar después de instalar dependencias:

```bash
# Configurar variables de entorno en EC2
cat > /opt/examlab/.env.production << 'EOF'
AI_SERVICE=anthropic
ANTHROPIC_API_KEY=$(aws secretsmanager get-secret-value \
  --secret-id examlab/anthropic-key \
  --region us-east-1 \
  --query SecretString \
  --output text | jq -r '.api_key')
AI_MODEL=claude-3-5-sonnet-20241022
ENABLE_AI_CACHING=true
EOF

chown ec2-user:ec2-user /opt/examlab/.env.production
chmod 600 /opt/examlab/.env.production
```

### Paso 5: Instalar dependencia en app

```bash
# En tu proyecto ExamLab:
npm install @anthropic-ai/sdk
```

### Paso 6: Copiar wrapper a tu proyecto

```bash
# Copiar el archivo de ejemplo
cp configs/ai-wrapper-example.ts src/lib/ai.ts

# O si ya tienes src/lib/ai.ts, fusionar manualmente
```

### Paso 7: Reemplazar imports en tu código

**ANTES (Lovable):**
```typescript
import { lovableAI } from '@lovable/ai';

const questions = await lovableAI.generateQuestions(topic);
const grade = await lovableAI.grade(answer, rubric);
```

**AHORA (AWS):**
```typescript
import { AI } from '@/lib/ai';  // ← nuevo wrapper

const questions = await AI.generateExamQuestions(topic, 'medium', 5);
const grade = await AI.gradeExamAnswer(question, answer, correct, rubric);
```

---

## 🚀 OPCIÓN 2: Usar AWS Bedrock

### Paso 1: Habilitar Bedrock en AWS

```bash
# Desde CloudShell:
aws bedrock list-foundation-models --region us-east-1
```

Si no está disponible:
1. Ir a: https://console.aws.amazon.com/bedrock/
2. "Manage model access"
3. Habilitar: "Anthropic Claude 3.5 Sonnet"

### Paso 2: Configurar en `cloudshell-vars.env`

```bash
AI_SERVICE="bedrock"
AWS_BEDROCK_REGION="us-east-1"
AI_MODEL="claude-3-5-sonnet"
```

### Paso 3: Agregar permisos en CloudFormation

```yaml
# En tu ec2-stack.yaml, agregar a EC2Role:

BedrockPolicy:
  Type: AWS::IAM::Policy
  Properties:
    PolicyName: BedrockAccess
    PolicyDocument:
      Version: '2012-10-17'
      Statement:
        - Effect: Allow
          Action:
            - bedrock:InvokeModel
            - bedrock:InvokeModelWithResponseStream
          Resource: 
            - 'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet*'
    Roles:
      - !Ref EC2Role  # Tu rol EC2 existente
```

### Paso 4: Desplegar

```bash
bash scripts/deploy-cf.sh
```

---

## 🚀 OPCIÓN 3: Mantener Supabase Edge Functions

Si ya tienes Edge Functions en Supabase, puedes mantenerlas:

### Paso 1: Configurar en `cloudshell-vars.env`

```bash
AI_SERVICE="supabase"
SUPABASE_URL="https://xxxxx.supabase.co"
SUPABASE_ANON_KEY="eyJ..."
```

### Paso 2: Sin cambios en código

Las funciones existentes en `supabase/functions/` seguirán funcionando igual.

---

## ✅ Verificar que funciona

### Test 1: Desde CloudShell

```bash
# Conectar a EC2
ssh -i ~/.ssh/examlab-production.pem ec2-user@<alb-dns>

# Probar que IA está disponible
node -e "
  const { AI } = require('/opt/examlab/src/lib/ai.js');
  AI.generate('Hola, ¿quién eres?')
    .then(console.log)
    .catch(console.error);
"
```

### Test 2: Desde la app

```typescript
// En tu componente React
import { AI } from '@/lib/ai';

function TestAI() {
  const [response, setResponse] = useState('');

  const test = async () => {
    const result = await AI.generate('¿Cuál es 2+2?');
    setResponse(result);
  };

  return (
    <div>
      <button onClick={test}>Test IA</button>
      <p>{response}</p>
    </div>
  );
}
```

### Test 3: Monitor de costos

```bash
# Ver gastos en AWS
aws ce get-cost-and-usage \
  --time-period Start=2024-04-01,End=2024-04-30 \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --filter file://bedrock-filter.json
```

---

## 📊 Cambios en ExamLab

### Generación de preguntas

**ANTES:**
```typescript
async function generateExamQuestions(topic: string) {
  const result = await lovable.AI.generateQuestions({
    topic,
    count: 5
  });
  return result;
}
```

**AHORA:**
```typescript
async function generateExamQuestions(topic: string) {
  return await AI.generateExamQuestions(
    topic,
    'medium',  // difficulty
    5          // count
  );
}
```

### Calificación automática

**ANTES:**
```typescript
async function gradeProject(fileContent: string) {
  const grade = await lovable.AI.grade({
    content: fileContent,
    rubric: projectRubric
  });
  return grade;
}
```

**AHORA:**
```typescript
async function gradeProject(fileContent: string) {
  return await AI.gradeProjectFile(
    'project.js',
    fileContent,
    expectedStructure,
    projectRubric
  );
}
```

### Generar retroalimentación

**ANTES:**
```typescript
const feedback = await lovable.AI.generateFeedback(studentGrades);
```

**AHORA:**
```typescript
const feedback = await AI.generatePersonalizedFeedback(
  studentName,
  {
    examsGrade: 85,
    workshopsGrade: 90,
    projectsGrade: 92,
    attendance: 95
  },
  courseName
);
```

---

## 🔒 Seguridad

### NO hacer esto:

```bash
# ❌ MALO: API key en plain text
AI_SERVICE="anthropic"
ANTHROPIC_API_KEY="sk-ant-..." # En cloudshell-vars.env

# ❌ MALO: API key en código
const key = "sk-ant-...";
```

### HACER esto:

```bash
# ✅ BIEN: Guardar en Secrets Manager
aws secretsmanager create-secret --name examlab/anthropic-key

# ✅ BIEN: Leer desde Secrets Manager
const key = await getSecret('examlab/anthropic-key');

# ✅ BIEN: Usar variables de entorno
process.env.ANTHROPIC_API_KEY
```

### En CloudShell:

```bash
# NUNCA commitear a Git
git config core.excludesfile ~/.gitignore_personal
echo "cloudshell-vars.env" >> ~/.gitignore_personal

# O usar .gitignore del repo
# (ya incluye cloudshell-vars.env)
```

---

## 💰 Monitoreo de costos

### Configurar alertas

```bash
# Crear alarma de costo
aws cloudwatch put-metric-alarm \
  --alarm-name examlab-ai-cost-high \
  --alarm-description "Alert if AI costs exceed $100" \
  --metric-name EstimatedCharges \
  --namespace AWS/Bedrock \
  --statistic Maximum \
  --period 3600 \
  --threshold 100 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:...
```

### Dashboard CloudWatch

```bash
# Ver gastos en tiempo real
aws ce get-cost-and-usage \
  --time-period Start=$(date -d '7 days ago' +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics UnblendedCost \
  --filter '{
    "Dimensions": {
      "Key": "SERVICE",
      "Values": ["Amazon Bedrock"]
    }
  }'
```

---

## 🔄 Cambiar de servicio

Si después quieres cambiar (ej: de Anthropic a Bedrock):

```bash
# 1. Editar cloudshell-vars.env
AI_SERVICE="bedrock"

# 2. Re-generar parámetros
bash cloudshell-setup.sh

# 3. Re-desplegar
bash scripts/deploy-cf.sh

# 4. Reiniciar app en EC2
ssh -i ~/.ssh/examlab-production.pem ec2-user@<alb-dns>
sudo systemctl restart examlab

# ✅ Listo, sin cambios en código
```

---

## ✅ Checklist

- [ ] Elegí servicio IA (Anthropic recomendado)
- [ ] Obtuve API key / habilitué Bedrock
- [ ] Configuré variables en cloudshell-vars.env
- [ ] Guardé secrets en AWS Secrets Manager
- [ ] Copié ai-wrapper-example.ts a src/lib/ai.ts
- [ ] Actualicé imports en mi código
- [ ] Reemplacé funciones Lovable con nuevas
- [ ] Testeé que IA funciona
- [ ] Monitoreé costos
- [ ] Documenté cambios en mi proyecto

---

## 📞 Troubleshooting

### "ANTHROPIC_API_KEY not found"

```bash
# Verificar variable
echo $ANTHROPIC_API_KEY

# Cargar desde Secrets Manager
export ANTHROPIC_API_KEY=$(aws secretsmanager get-secret-value \
  --secret-id examlab/anthropic-key \
  --query SecretString \
  --output text | jq -r '.api_key')
```

### "Bedrock not available in region"

```bash
# Soportado en: us-west-2, us-east-1, eu-west-1, ap-northeast-1
# Cambiar región en cloudshell-vars.env
AWS_REGION="us-west-2"
AWS_BEDROCK_REGION="us-west-2"
```

### "AI response is empty"

```bash
# Verificar token count
# Anthropic limit: 200K tokens

# Si es muy grande, reducir context:
const response = await AI.generate(
  smallerPrompt,  // Reducir tamaño
  512             // Menos tokens output
);
```

### "API key rejected"

```bash
# Verificar formato
echo $ANTHROPIC_API_KEY
# Debe empezar con: sk-ant-

# Si falta formato, recrear
aws secretsmanager delete-secret --secret-id examlab/anthropic-key
aws secretsmanager create-secret --name examlab/anthropic-key \
  --secret-string '{"api_key":"sk-ant-..."}'
```

---

## 🎯 Siguientes pasos

1. **Implementar** IA según tu servicio elegido
2. **Testear** que funciona en desarrollo
3. **Monitorear** costos
4. **Optimizar** con caché y rate limiting
5. **Escalar** cuando necesites más tokens

**El cambio es simple: reemplazar 1-2 funciones. El resto del código sigue igual.** ✅
