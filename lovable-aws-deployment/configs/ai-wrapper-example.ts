/**
 * ai-wrapper-example.ts — Wrapper para IA en AWS
 *
 * Reemplaza las llamadas a Lovable AI con:
 * - AWS Bedrock (nativo, seguro, compliance)
 * - Anthropic API (barato, rápido)
 * - Supabase Edge Functions (ya tienes)
 * - AWS Lambda (serverless)
 *
 * Uso:
 * - Copiar este archivo a: src/lib/ai.ts
 * - Editar variables de entorno
 * - Reemplazar importes en otros archivos
 */

import Anthropic from "@anthropic-ai/sdk";
import { BedrockRuntime } from "@aws-sdk/client-bedrock-runtime";

/**
 * Configuración — elegir uno
 *
 * Opción 1: ANTHROPIC_API_KEY (más barato, recomendado)
 * Opción 2: AWS_BEDROCK (nativo AWS, más caro)
 * Opción 3: SUPABASE_URL + SUPABASE_KEY (ya tienes)
 */

const AI_SERVICE = process.env.AI_SERVICE || "anthropic";
const AI_MODEL =
  process.env.AI_MODEL || "claude-3-5-sonnet-20241022";

// ═══════════════════════════════════════════════════════════════════════════
// OPCIÓN 1: Anthropic API (RECOMENDADO)
// ═══════════════════════════════════════════════════════════════════════════

let anthropicClient: Anthropic | null = null;

if (AI_SERVICE === "anthropic" && process.env.ANTHROPIC_API_KEY) {
  anthropicClient = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
}

async function callAnthropicAPI(prompt: string, maxTokens = 1024) {
  if (!anthropicClient) {
    throw new Error("Anthropic client not initialized");
  }

  const message = await anthropicClient.messages.create({
    model: AI_MODEL,
    max_tokens: maxTokens,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  if (message.content[0].type === "text") {
    return message.content[0].text;
  }

  throw new Error("Unexpected response format from Anthropic");
}

// ═══════════════════════════════════════════════════════════════════════════
// OPCIÓN 2: AWS Bedrock
// ═══════════════════════════════════════════════════════════════════════════

let bedrockClient: BedrockRuntime | null = null;

if (AI_SERVICE === "bedrock") {
  bedrockClient = new BedrockRuntime({
    region: process.env.AWS_REGION || "us-east-1",
  });
}

async function callBedrockAPI(prompt: string, maxTokens = 1024) {
  if (!bedrockClient) {
    throw new Error("Bedrock client not initialized");
  }

  const response = await bedrockClient.invokeModel({
    modelId:
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-06-01",
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  const result = JSON.parse(
    new TextDecoder().decode(response.body)
  );

  return result.content[0].text;
}

// ═══════════════════════════════════════════════════════════════════════════
// OPCIÓN 3: Supabase Edge Functions (mantener actual)
// ═══════════════════════════════════════════════════════════════════════════

async function callSupabaseEdgeFunction(
  prompt: string,
  functionName = "ai-generate"
) {
  const response = await fetch(
    `${process.env.SUPABASE_URL}/functions/v1/${functionName}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt }),
    }
  );

  if (!response.ok) {
    throw new Error(`Supabase function error: ${response.statusText}`);
  }

  const result = await response.json();
  return result.response || result;
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL — Elegir servicio automáticamente
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Llamar a IA (automáticamente elige el servicio configurado)
 */
export async function generateWithAI(
  prompt: string,
  maxTokens = 1024
): Promise<string> {
  console.log(`[AI] Using service: ${AI_SERVICE}`);

  try {
    switch (AI_SERVICE) {
      case "anthropic":
        return await callAnthropicAPI(prompt, maxTokens);

      case "bedrock":
        return await callBedrockAPI(prompt, maxTokens);

      case "supabase":
        return await callSupabaseEdgeFunction(prompt);

      default:
        throw new Error(`Unknown AI service: ${AI_SERVICE}`);
    }
  } catch (error) {
    console.error("[AI] Error:", error);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CASOS DE USO EN EXAMLAB
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generar preguntas de examen automáticamente
 */
export async function generateExamQuestions(
  topic: string,
  difficulty: "easy" | "medium" | "hard",
  count: number = 5
) {
  const prompt = `
    Generate ${count} exam questions about "${topic}" at ${difficulty} level.

    Return as JSON array with format:
    [
      {
        "question": "...",
        "options": ["A", "B", "C", "D"],
        "correctAnswer": 0,
        "explanation": "..."
      }
    ]

    IMPORTANT: Return ONLY valid JSON, no other text.
  `;

  const response = await generateWithAI(prompt, 2048);

  try {
    return JSON.parse(response);
  } catch (error) {
    console.error("[AI] Failed to parse response:", response);
    throw new Error("Failed to parse AI response");
  }
}

/**
 * Generar archivos para un proyecto
 *
 * ANTES (Lovable):
 * const files = await lovable.generateProjectFiles(description, count);
 *
 * AHORA (AWS):
 * const files = await generateProjectFiles(description, count);
 */
export async function generateProjectFiles(
  projectDescription: string,
  fileCount: number
) {
  const prompt = `
    Create the structure for a coding project: "${projectDescription}"

    Generate ${fileCount} files with these details:

    Return as JSON:
    {
      "files": [
        {
          "name": "filename.ext",
          "description": "what this file does",
          "suggestedStarterCode": "optional code snippet"
        }
      ]
    }

    IMPORTANT: Return ONLY valid JSON.
  `;

  const response = await generateWithAI(prompt, 2048);

  try {
    const result = JSON.parse(response);
    return result.files || [];
  } catch (error) {
    console.error("[AI] Failed to parse project files:", response);
    throw new Error("Failed to parse project files");
  }
}

/**
 * Calificar respuesta de examen
 *
 * ANTES (Lovable):
 * const grade = await lovable.gradeAnswer(question, answer, rubric);
 *
 * AHORA (AWS):
 * const grade = await gradeExamAnswer(question, answer, correctAnswer, rubric);
 */
export async function gradeExamAnswer(
  question: string,
  studentAnswer: string,
  correctAnswer: string,
  rubric: string
) {
  const prompt = `
    Grade a student's exam answer.

    Question: "${question}"
    Correct answer: "${correctAnswer}"
    Student answer: "${studentAnswer}"

    Grading rubric:
    ${rubric}

    Evaluate and return JSON:
    {
      "grade": number (0-100),
      "feedback": "constructive feedback",
      "strengths": ["what they did well"],
      "improvements": ["areas to work on"],
      "aiLikelihood": "assessment likelihood"
    }

    IMPORTANT: Return ONLY valid JSON.
  `;

  const response = await generateWithAI(prompt, 1024);

  try {
    return JSON.parse(response);
  } catch (error) {
    console.error("[AI] Failed to parse grade:", response);
    // Return default if parsing fails
    return {
      grade: 0,
      feedback: "Error in grading. Please review manually.",
      strengths: [],
      improvements: [],
    };
  }
}

/**
 * Calificar archivo de proyecto
 *
 * ANTES (Lovable):
 * const grade = await lovable.gradeProjectFile(code, rubric);
 *
 * AHORA (AWS):
 * const grade = await gradeProjectFile(fileName, content, expected, rubric);
 */
export async function gradeProjectFile(
  fileName: string,
  fileContent: string,
  expectedStructure: string,
  rubric: string
) {
  const prompt = `
    Review and grade a project file submission.

    File: ${fileName}

    Content:
    \`\`\`
    ${fileContent}
    \`\`\`

    Expected structure:
    ${expectedStructure}

    Grading criteria:
    ${rubric}

    Evaluate and return JSON:
    {
      "grade": number (0-100),
      "feedback": "detailed feedback",
      "issues": ["list of issues found"],
      "suggestions": ["improvements"],
      "codeQuality": "assessment"
    }

    IMPORTANT: Return ONLY valid JSON.
  `;

  const response = await generateWithAI(prompt, 1024);

  try {
    return JSON.parse(response);
  } catch (error) {
    console.error("[AI] Failed to parse project grade:", response);
    return {
      grade: 0,
      feedback: "Error in grading. Review manually.",
      issues: [],
      suggestions: [],
    };
  }
}

/**
 * Generar retroalimentación personalizada
 *
 * ANTES (Lovable):
 * const feedback = await lovable.generateFeedback(student, grades);
 *
 * AHORA (AWS):
 * const feedback = await generatePersonalizedFeedback(student, grades);
 */
export interface StudentPerformance {
  examsGrade: number;
  workshopsGrade: number;
  projectsGrade: number;
  attendance: number; // percentage
  participationScore?: number;
}

export async function generatePersonalizedFeedback(
  studentName: string,
  performance: StudentPerformance,
  courseName: string
) {
  const prompt = `
    Generate personalized feedback for a student.

    Student: ${studentName}
    Course: ${courseName}

    Performance:
    - Exams: ${performance.examsGrade}%
    - Workshops: ${performance.workshopsGrade}%
    - Projects: ${performance.projectsGrade}%
    - Attendance: ${performance.attendance}%
    ${performance.participationScore ? `- Participation: ${performance.participationScore}%` : ""}

    Provide encouraging, constructive feedback that:
    1. Acknowledges strengths
    2. Identifies specific areas for improvement
    3. Provides actionable recommendations
    4. Maintains a supportive tone

    Return as JSON:
    {
      "summary": "overall assessment",
      "strengths": ["list of strengths"],
      "areasForImprovement": ["specific areas"],
      "recommendations": ["actionable steps"],
      "encouragement": "motivating message"
    }

    IMPORTANT: Return ONLY valid JSON.
  `;

  const response = await generateWithAI(prompt, 1024);

  try {
    return JSON.parse(response);
  } catch (error) {
    console.error("[AI] Failed to parse feedback:", response);
    return {
      summary: "Please review performance manually",
      strengths: [],
      areasForImprovement: [],
      recommendations: [],
    };
  }
}

/**
 * Generar resumen de clase
 */
export async function generateLessonSummary(
  lessonTitle: string,
  lessonContent: string,
  keyPoints: string[]
) {
  const prompt = `
    Create a concise summary of a lesson.

    Lesson: ${lessonTitle}

    Content:
    ${lessonContent}

    Key points to emphasize:
    ${keyPoints.map((p) => `- ${p}`).join("\n")}

    Generate:
    1. 2-3 sentence overview
    2. Summary of key concepts
    3. Common misconceptions and clarifications
    4. 3-5 practice questions

    Return as JSON:
    {
      "overview": "...",
      "keyConcepts": ["list"],
      "misconceptions": [{"misconception": "...", "clarification": "..."}],
      "practiceQuestions": ["list"]
    }
  `;

  const response = await generateWithAI(prompt, 1536);

  try {
    return JSON.parse(response);
  } catch (error) {
    console.error("[AI] Failed to parse summary:", response);
    return {
      overview: "Error generating summary",
      keyConcepts: [],
      misconceptions: [],
      practiceQuestions: [],
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cache de respuestas para reducir costos
 */
const responseCache = new Map<string, { response: string; timestamp: number }>();
const CACHE_TTL = 3600000; // 1 hora

export function getCachedResponse(prompt: string) {
  const hash = require("crypto")
    .createHash("sha256")
    .update(prompt)
    .digest("hex");

  const cached = responseCache.get(hash);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log("[AI Cache] Hit for:", prompt.substring(0, 50));
    return cached.response;
  }

  return null;
}

export function setCachedResponse(prompt: string, response: string) {
  const hash = require("crypto")
    .createHash("sha256")
    .update(prompt)
    .digest("hex");

  responseCache.set(hash, {
    response,
    timestamp: Date.now(),
  });
}

/**
 * Wrapper con caché
 */
export async function generateWithAIAndCache(
  prompt: string,
  maxTokens = 1024
): Promise<string> {
  // Intentar cache primero
  const cached = getCachedResponse(prompt);
  if (cached) {
    return cached;
  }

  // Si no está en caché, llamar a IA
  const response = await generateWithAI(prompt, maxTokens);

  // Guardar en caché
  setCachedResponse(prompt, response);

  return response;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTAR
// ═══════════════════════════════════════════════════════════════════════════

export const AI = {
  // Funciones principales
  generate: generateWithAI,
  generateWithCache: generateWithAIAndCache,

  // Casos de uso ExamLab
  generateExamQuestions,
  generateProjectFiles,
  gradeExamAnswer,
  gradeProjectFile,
  generatePersonalizedFeedback,
  generateLessonSummary,

  // Utilidades
  getCache: getCachedResponse,
  setCache: setCachedResponse,

  // Información
  service: AI_SERVICE,
  model: AI_MODEL,
};
