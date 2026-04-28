# AI Integration en AWS - Guía completa

Cómo manejar comunicación con AI después de migrar desde Lovable.

## 🤔 Problema: IA en Lovable vs AWS

### En Lovable
```javascript
// Automático - Lovable proporciona acceso directo
const response = await fetch("https://api.lovable.dev/ai", {
  method: "POST",
  body: JSON.stringify({
    messages: [...],
    model: "claude-3.5-sonnet" // ✓ Incluido en Lovable
  })
});
```

### En AWS (necesitas configurar)
```javascript
// Opción 1: AWS Bedrock (nativo AWS)
// Opción 2: Anthropic API (llamadas directas)
// Opción 3: Supabase Edge Functions (mantener actual)
// Opción 4: Lambda + API Gateway (serverless)
// Opción 5: SageMaker (enterprise)
```

**Este documento cubre todas las opciones.**

---

## 🎯 Comparación de opciones

| Opción | Costo | Setup | Latencia | Mejor para |
|--------|-------|-------|----------|-----------|
| **AWS Bedrock** | $$$$ (pago por token) | Medio | 2-5s | Enterprise, compliance |
| **Anthropic API** | $$ (pago por token) | Muy fácil | 1-3s | Producción, predicible |
| **Supabase Edge Fn** | Variable | Fácil | 2-4s | Ya tienes Supabase |
| **Lambda + API GW** | $ (por invocación) | Complejo | 3-8s | Bajo volumen |
| **SageMaker** | $$$ (instancia siempre corriendo) | Complejo | 0.5-2s | Alto volumen, custom |

### 📊 Costo típico (10,000 requests/mes)

```
AWS Bedrock (Claude 3.5 Sonnet):
  Input: 10,000 × 500 tokens × $0.003/1K = $15
  Output: 10,000 × 300 tokens × $0.015/1K = $45
  Total = $60/mes

Anthropic API (Claude 3.5 Sonnet):
  Input: 10,000 × 500 tokens × $0.003/1K = $15
  Output: 10,000 × 300 tokens × $0.015/1K = $45
  Total = $60/mes

Lambda (100ms promedio):
  10,000 invocaciones × $0.0000002 = $2
  + API Gateway + transfer = $15/mes
  Total = ~$17/mes (+ costo de API externa)

Supabase Edge Functions:
  Incluido en plan (hasta 2M invocaciones)
  Total = $0-25/mes
```

---

## ✅ OPCIÓN 1: AWS Bedrock (RECOMENDADO para AWS)

### Ventajas
✅ Nativo AWS (no hay llamadas externas)  
✅ Compliance y seguridad (datos no salen de AWS)  
✅ Mismo billing que otros servicios AWS  
✅ VPC endpoints disponibles  
✅ Integración con CloudWatch, IAM, KMS  

### Desventajas
❌ Costo más alto que Anthropic API directo  
❌ Menor variedad de modelos  

### Setup en AWS CloudFormation

Agregar a `rds-stack.yaml` o crear nuevo stack:

```yaml
# cloudformation/bedrock-stack.yaml
AWSTemplateFormatVersion: '2010-09-09'

Description: AWS Bedrock setup para acceso a Claude

Parameters:
  ProjectName:
    Type: String
    Default: examlab

  Environment:
    Type: String
    Default: production

Resources:
  # IAM Role para EC2 (acceso a Bedrock)
  BedrockAccessPolicy:
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
              - 'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0'
              - 'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-20241022-v1:0'
              - 'arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-4-1-20250805-v1:0'
      Roles:
        - !Sub '${ProjectName}-ec2-role-${Environment}'

  # CloudWatch Log Group para Bedrock (audit)
  BedrockLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub '/aws/bedrock/${ProjectName}-${Environment}'
      RetentionInDays: 30

Outputs:
  BedrockAvailable:
    Value: 'true'
    Description: Bedrock está disponible en esta región
```

### Usar Bedrock desde Node.js

```javascript
// src/lib/ai.ts - Wrapper para IA
import { BedrockRuntime } from "@aws-sdk/client-bedrock-runtime";

const bedrockClient = new BedrockRuntime({
  region: process.env.AWS_REGION || "us-east-1"
});

export async function generateWithAI(prompt: string, maxTokens = 1024) {
  try {
    const response = await bedrockClient.invokeModel({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-06-01",
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    const result = JSON.parse(
      new TextDecoder().decode(response.body)
    );

    return result.content[0].text;
  } catch (error) {
    console.error("Bedrock error:", error);
    throw error;
  }
}

// Uso en ExamLab
export async function gradeProjectFile(
  fileContent: string,
  rubric: string
) {
  const prompt = `
    Revisar el siguiente código/contenido y calificar según la rúbrica.
    
    Contenido:
    ${fileContent}
    
    Rúbrica:
    ${rubric}
    
    Responder en JSON: { grade: number, feedback: string }
  `;

  const aiResponse = await generateWithAI(prompt);
  return JSON.parse(aiResponse);
}
```

### Variables de entorno en `cloudshell-vars.env`

```bash
# AI Configuration
USE_AI_SERVICE="bedrock"           # bedrock|anthropic|supabase|lambda
AWS_BEDROCK_REGION="us-east-1"    # Región con Bedrock
AI_MODEL="claude-3-5-sonnet"      # Modelo a usar
```

---

## ✅ OPCIÓN 2: Anthropic API (MÁS BARATO)

### Ventajas
✅ 30% más barato que Bedrock  
✅ Mismo modelo Claude  
✅ Soporte directo de Anthropic  
✅ Acceso a últimos modelos primero  
✅ No necesita AWS Bedrock habilitado  

### Desventajas
❌ Datos salen de AWS (compliance)  
❌ Otra cuenta/billing diferente  
❌ Requiere API key en variables  

### Setup

1. **Obtener API Key en Anthropic**
   ```
   https://console.anthropic.com/account/keys
   ```

2. **Agregar a `cloudshell-vars.env`**
   ```bash
   AI_SERVICE="anthropic"
   ANTHROPIC_API_KEY="sk-ant-..."  # Tu API key
   ```

3. **Guardar en AWS Secrets Manager**
   ```bash
   aws secretsmanager create-secret \
     --name examlab/anthropic-key \
     --secret-string '{"api_key":"sk-ant-..."}' \
     --region us-east-1
   ```

4. **Código Node.js**
   ```javascript
   import Anthropic from "@anthropic-ai/sdk";

   const client = new Anthropic({
     apiKey: process.env.ANTHROPIC_API_KEY
   });

   export async function generateWithAI(prompt: string) {
     const message = await client.messages.create({
       model: "claude-3-5-sonnet-20241022",
       max_tokens: 1024,
       messages: [
         {
           role: "user",
           content: prompt
         }
       ]
     });

     return message.content[0].type === "text" 
       ? message.content[0].text 
       : "";
   }
   ```

### Usar Secrets Manager desde EC2

```bash
# En user_data.sh o en la app:
aws secretsmanager get-secret-value \
  --secret-id examlab/anthropic-key \
  --region us-east-1 \
  --query SecretString \
  --output text | jq -r '.api_key'
```

---

## ✅ OPCIÓN 3: Mantener Supabase Edge Functions

### Ventajas
✅ Ya tienes Supabase configurado  
✅ No cambiar código existente  
✅ Funciones serverless incluidas en plan  
✅ Bajo costo  

### Desventajas
❌ Depender de otro proveedor (Supabase)  
❌ Latencia variable  
❌ Límites de invocaciones  

### Mantener Supabase + AWS RDS

```
┌─────────────────────┐
│  EC2 en AWS         │
│  (App Node.js)      │
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    │             │
┌───▼──────┐  ┌──▼───────────┐
│RDS PG    │  │Supabase      │
│en AWS    │  │Edge Function │
└──────────┘  │(IA calls)    │
              └──────────────┘
```

### Configurar

1. **Edge Function en Supabase** (mantener igual)
   ```typescript
   // supabase/functions/ai-grade/index.ts
   import Anthropic from "@anthropic-ai/sdk";

   export default async (req: Request) => {
     const { fileContent, rubric } = await req.json();
     
     const client = new Anthropic({
       apiKey: Deno.env.get("ANTHROPIC_API_KEY")
     });

     const message = await client.messages.create({
       model: "claude-3-5-sonnet-20241022",
       max_tokens: 1024,
       messages: [{
         role: "user",
         content: `Calificar: ${fileContent}\nRúbrica: ${rubric}`
       }]
     });

     return new Response(JSON.stringify(message), {
       headers: { "Content-Type": "application/json" }
     });
   };
   ```

2. **Llamar desde EC2**
   ```javascript
   export async function gradeWithSupabase(
     fileContent: string,
     rubric: string
   ) {
     const response = await fetch(
       `${process.env.SUPABASE_URL}/functions/v1/ai-grade`,
       {
         method: "POST",
         headers: {
           "Authorization": `Bearer ${process.env.SUPABASE_ANON_KEY}`,
           "Content-Type": "application/json"
         },
         body: JSON.stringify({ fileContent, rubric })
       }
     );

     return response.json();
   }
   ```

---

## ✅ OPCIÓN 4: AWS Lambda + API Gateway

### Ventajas
✅ Serverless (sin gestionar servidores)  
✅ Escala automáticamente  
✅ Barato para bajo volumen  

### Desventajas
❌ Cold starts (3-5s primeras invocaciones)  
❌ Setup más complejo  
❌ No tan integrado con código Node.js  

### Setup en CloudFormation

```yaml
# cloudformation/lambda-ai-stack.yaml
AWSTemplateFormatVersion: '2010-09-09'

Parameters:
  ProjectName:
    Type: String
    Default: examlab

  AnthropicApiKey:
    Type: String
    NoEcho: true
    Description: API Key de Anthropic

Resources:
  LambdaExecutionRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

  AiGradingFunction:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: !Sub '${ProjectName}-ai-grading'
      Runtime: python3.11
      Role: !GetAtt LambdaExecutionRole.Arn
      Timeout: 30
      Environment:
        Variables:
          ANTHROPIC_API_KEY: !Ref AnthropicApiKey
      Code:
        ZipFile: |
          import json
          import boto3
          import requests
          import os

          def lambda_handler(event, context):
              body = json.loads(event.get('body', '{}'))
              file_content = body.get('fileContent')
              rubric = body.get('rubric')

              prompt = f"""
              Revisar y calificar:
              {file_content}
              
              Rúbrica: {rubric}
              
              Responder en JSON: {{"grade": number, "feedback": string}}
              """

              response = requests.post(
                  "https://api.anthropic.com/v1/messages",
                  headers={
                      "x-api-key": os.environ["ANTHROPIC_API_KEY"],
                      "anthropic-version": "2023-06-01",
                      "content-type": "application/json"
                  },
                  json={
                      "model": "claude-3-5-sonnet-20241022",
                      "max_tokens": 1024,
                      "messages": [{"role": "user", "content": prompt}]
                  }
              )

              result = response.json()
              return {
                  "statusCode": 200,
                  "body": json.dumps({
                      "grade": result["content"][0]["text"]
                  })
              }

  ApiGateway:
    Type: AWS::ApiGateway::RestApi
    Properties:
      Name: !Sub '${ProjectName}-ai-api'

  ApiResource:
    Type: AWS::ApiGateway::Resource
    Properties:
      RestApiId: !Ref ApiGateway
      ParentId: !GetAtt ApiGateway.RootResourceId
      PathPart: grade

  ApiMethod:
    Type: AWS::ApiGateway::Method
    Properties:
      RestApiId: !Ref ApiGateway
      ResourceId: !Ref ApiResource
      HttpMethod: POST
      AuthorizationType: NONE
      Integration:
        Type: AWS_PROXY
        IntegrationHttpMethod: POST
        Uri: !Sub 'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${AiGradingFunction.Arn}/invocations'

  ApiDeployment:
    Type: AWS::ApiGateway::Deployment
    DependsOn: ApiMethod
    Properties:
      RestApiId: !Ref ApiGateway
      StageName: prod

Outputs:
  ApiEndpoint:
    Value: !Sub 'https://${ApiGateway}.execute-api.${AWS::Region}.amazonaws.com/prod/grade'
```

---

## 🔍 Casos de uso en ExamLab

### 1. Generar preguntas/ejercicios

```javascript
// src/lib/ai-generate.ts
export async function generateExamQuestions(
  courseId: string,
  topic: string,
  difficulty: "easy" | "medium" | "hard",
  count: number = 5
) {
  const prompt = `
    Generar ${count} preguntas de examen sobre "${topic}"
    Nivel: ${difficulty}
    
    Formato: JSON array con { question, options: [], correctAnswer }
  `;

  const response = await generateWithAI(prompt);
  return JSON.parse(response);
}

export async function generateProjectFiles(
  projectDescription: string,
  fileCount: number
) {
  const prompt = `
    Generar estructura de ${fileCount} archivos para proyecto:
    ${projectDescription}
    
    Retornar JSON: { files: [{ name, description }] }
  `;

  const response = await generateWithAI(prompt);
  return JSON.parse(response);
}
```

### 2. Calificar respuestas

```javascript
// src/lib/ai-grading.ts
export async function gradeExamAnswer(
  question: string,
  studentAnswer: string,
  correctAnswer: string,
  rubric: string
) {
  const prompt = `
    Calificar respuesta de estudiante.
    
    Pregunta: ${question}
    Respuesta esperada: ${correctAnswer}
    Respuesta estudiante: ${studentAnswer}
    
    Rúbrica: ${rubric}
    
    Responder JSON: {
      "grade": number (0-100),
      "feedback": "explicación clara",
      "strengths": ["fortalezas"],
      "improvements": ["áreas a mejorar"]
    }
  `;

  return generateWithAI(prompt);
}

export async function gradeProjectFile(
  fileName: string,
  fileContent: string,
  expectedStructure: string,
  rubric: string
) {
  const prompt = `
    Revisar archivo de proyecto: ${fileName}
    
    Contenido:
    ${fileContent}
    
    Estructura esperada:
    ${expectedStructure}
    
    Criterios de evaluación:
    ${rubric}
    
    Retornar: { grade: 0-100, feedback: string, issues: [] }
  `;

  return generateWithAI(prompt);
}
```

### 3. Proporcionar retroalimentación personalizada

```javascript
// src/lib/ai-feedback.ts
export async function generatePersonalizedFeedback(
  studentName: string,
  performance: {
    examsGrade: number;
    workshopsGrade: number;
    projectsGrade: number;
    attendance: number;
  },
  course: string
) {
  const prompt = `
    Generar retroalimentación personalizada para estudiante.
    
    Nombre: ${studentName}
    Curso: ${course}
    Calificación exámenes: ${performance.examsGrade}
    Calificación talleres: ${performance.workshopsGrade}
    Calificación proyectos: ${performance.projectsGrade}
    Asistencia: ${performance.attendance}%
    
    Proporcionar:
    1. Resumen de desempeño
    2. Fortalezas identificadas
    3. Áreas de mejora específicas
    4. Recomendaciones accionables
    5. Motivación positiva
  `;

  return generateWithAI(prompt);
}
```

---

## 🏗️ Arquitectura recomendada

```
┌─────────────────────────────────────────────────────────────┐
│                  ExamLab App (Node.js)                      │
│                    en EC2 / Lambda                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Llamada IA:                                               │
│  ├─ Generar preguntas   → generateWithAI()                │
│  ├─ Calificar respuestas → gradeWithAI()                  │
│  └─ Feedback            → feedbackWithAI()                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
    ┌─────▼──────┐   ┌─────▼────────┐  ┌───▼─────────┐
    │ AWS        │   │ Anthropic    │  │Supabase     │
    │ Bedrock    │   │ API          │  │Edge Fn      │
    │ (nativo)   │   │ (barato)     │  │(existente)  │
    └────────────┘   └──────────────┘  └─────────────┘
    
    Recomendación: Usar ENV variable para elegir
    AI_SERVICE = "bedrock" | "anthropic" | "supabase"
```

---

## 📋 Implementación por fases

### Fase 1: Setup básico (5 min)
```bash
# En cloudshell-vars.env
AI_SERVICE="anthropic"
ANTHROPIC_API_KEY="sk-ant-..."

# Deploy
bash scripts/deploy-cf.sh
```

### Fase 2: Integrar en ExamLab (30 min)
```bash
# En EC2
npm install @anthropic-ai/sdk

# Reemplazar llamadas a Lovable AI con función nueva
# src/lib/ai.ts → getAIResponse()
```

### Fase 3: Caching y optimización (1 hora)
```javascript
// Cachear respuestas frecuentes
import NodeCache from "node-cache";

const aiCache = new NodeCache({ stdTTL: 3600 });

export async function generateWithCache(prompt: string) {
  const cacheKey = crypto
    .createHash("sha256")
    .update(prompt)
    .digest("hex");

  if (aiCache.has(cacheKey)) {
    return aiCache.get(cacheKey);
  }

  const response = await generateWithAI(prompt);
  aiCache.set(cacheKey, response);
  return response;
}
```

### Fase 4: Monitoreo (30 min)
```bash
# CloudWatch metrics
AWS_BEDROCK_USAGE_METRIC: "bedrock-tokens-used"
AWS_BEDROCK_COST_METRIC: "bedrock-cost"

# Alertas
CPU usage > 80% → Scale up
IA latency > 5s → Alert
IA cost > $100/day → Alert
```

---

## 🎯 Decisión rápida: ¿Cuál elegir?

```
┌─────────────────────────────────────────┐
│ ¿Necesitas máxima privacidad/compliance?│
│           SÍ → AWS Bedrock              │
│           NO → continuar                │
└─────────────────────────────────────────┘
                    │
        ┌───────────┴──────────┐
        │                      │
        ▼                      ▼
┌─────────────────┐   ┌──────────────────┐
│ ¿Bajo presup?   │   │ ¿Ya tienes       │
│ SÍ → Anthropic  │   │ Supabase?        │
│ NO → Bedrock    │   │ SÍ → Mantenerlo  │
└─────────────────┘   │ NO → Anthropic   │
                      └──────────────────┘
```

---

## 💡 Tips finales

### Rate limiting
```javascript
import { RateLimiter } from "limiter";

const limiter = new RateLimiter({
  tokensPerInterval: 100,
  interval: "minute"
});

export async function generateWithRateLimit(prompt: string) {
  await limiter.removeTokens(1);
  return generateWithAI(prompt);
}
```

### Error handling
```javascript
export async function generateWithFallback(prompt: string) {
  try {
    return await generateWithAI(prompt);
  } catch (error) {
    console.error("AI error:", error);
    
    // Fallback a respuesta genérica
    return {
      grade: 75,
      feedback: "Revisar manualmente - error en IA"
    };
  }
}
```

### Costos controlados
```bash
# En cloudshell-vars.env
MAX_AI_TOKENS_PER_MONTH=100000        # Límite de seguridad
MAX_AI_COST_PER_DAY=50                # $50/día máximo
ENABLE_AI_CACHING=true                # Cachear respuestas
```

---

## 📊 Monitoreo de costos

```bash
# Ver gastos de Bedrock
aws ce get-cost-and-usage \
  --time-period Start=2024-04-01,End=2024-04-30 \
  --granularity MONTHLY \
  --metrics "UnblendedCost" \
  --filter file://filter.json \
  --group-by Type=DIMENSION,Key=SERVICE

# Alertas en CloudWatch
aws cloudwatch put-metric-alarm \
  --alarm-name ai-cost-high \
  --alarm-description "Alert if AI costs > $100" \
  --threshold 100 \
  --comparison-operator GreaterThanThreshold
```

---

## ✅ Resumen

| Aspecto | Lovable | AWS (tu solución) |
|--------|---------|-------------------|
| **IA integrada** | ✅ Automática | ✅ Configurada manualmente |
| **Costo** | Incluido | $60-200/mes (depende volumen) |
| **Contratos** | Lovable maneja | Tú contratas API |
| **Privacidad** | Lovable | AWS Bedrock (mejor) |
| **Escalabilidad** | Limitada | Ilimitada |
| **Control** | Limitado | Total |

**El cambio es mínimo**: Reemplazar 1-2 funciones que llaman a IA. El resto del código sigue igual. ✅

