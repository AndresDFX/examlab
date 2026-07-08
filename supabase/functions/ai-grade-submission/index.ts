// AI grading: scores exam answers or workshop submissions via AI Gateway
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { auditFromEdge } from "../_shared/audit.ts";
import { enforceRateLimit } from "../_shared/rate-limit.ts";
import { describeAiError } from "../_shared/ai-error.ts";
import {
  getActiveAiModel as resolveActiveModel,
  aiChatCompletionFailover,
  type ActiveModel,
  type AiProvider,
} from "../_shared/ai-model.ts";
// Motor de red (copia Deno) — calificación DETERMINISTA de preguntas
// `red_consola` server-side (exámenes/proyectos). Sincronizar con
// src/modules/network/* (ver invariante en CLAUDE.md).
import { gradeNetwork } from "../_shared/network/grading.ts";
import { parseScenario, parseNetworkAnswer } from "../_shared/network/scenario.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Cliente service-role compartido para leer ai_prompts (tabla con RLS).
// La función igual lo necesita más abajo para escribir submissions, así
// que reusamos la misma instancia.
const adminClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

/**
 * Resuelve el system prompt para un use_case dado, considerando el
 * override por curso si existe. Estrategia:
 *   1. Si `courseId` está, busca override del curso → si existe, lo usa.
 *   2. Si no, busca el global (course_id IS NULL).
 *   3. Si la tabla está vacía o no llega nada (red/RLS), usa el fallback
 *      hardcoded (mismo texto que el seed) para que la calificación nunca
 *      se rompa por config faltante.
 */

// Hint del request actual para resolver `ai_model_settings` por tenant.
// Se setea al inicio del handler con `courseId` del body y `Authorization`
// del request. Los call sites internos hacen `await getActiveAiModel()` y
// la función delega al helper shared con el hint cacheado.
let requestModelHint: { courseId?: string | null; authHeader?: string | null } = {};

function setRequestModelHint(h: { courseId?: string | null; authHeader?: string | null }): void {
  requestModelHint = h;
}

// Último modelo activo resuelto, cacheado a nivel módulo. `describeAiError`
// lo lee (`cachedModel?.provider`) para nombrar el provider correcto en el
// mensaje de error. Los call sites hacen `await getActiveAiModel()` antes de
// cada fetch IA, así que para cuando un error dispara `describeAiError` ya
// está poblado. Sin esta definición, `cachedModel?.provider` era un
// ReferenceError "cachedModel is not defined" en el path de error HTTP.
let cachedModel: ActiveModel | null = null;

async function getActiveAiModel(): Promise<ActiveModel> {
  const m = await resolveActiveModel(requestModelHint);
  cachedModel = m;
  return m;
}
export type { AiProvider };

/**
 * Wrapper único de chat completions. Internamente decide endpoint/auth/modelo
 * según la config activa en ai_model_settings.
 *
 * - openai  → api.openai.com/v1/chat/completions + OPENAI_API_KEY
 * - gemini  → generativelanguage.googleapis.com/v1beta/openai/chat/completions + GEMINI_API_KEY
 *   (default cuando provider no es 'openai', incluyendo legacy 'lovable')
 *
 * Ambos hablan el mismo formato OpenAI chat-completions, así que el body
 * (messages/tools/tool_choice) viaja idéntico — solo cambia `model`.
 */
async function aiChatCompletion(body: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool_choice?: any;
}): Promise<Response> {
  const m = await getActiveAiModel();
  // Failover de API keys (principal → respaldo → env) + retry transitorio en
  // el helper compartido. Cada Admin gestiona su propia key + respaldos.
  return aiChatCompletionFailover(m, { model: m.model, ...body });
}

/**
 * Califica múltiples preguntas abiertas en UNA sola llamada al modelo.
 *
 * Ganancia: para un examen con N preguntas abiertas pasamos de N requests
 * a 1. Reduce latencia ~Nx, cuesta menos tokens de overhead (system prompt
 * + warm-up no se paga N veces) y elimina los rate limits intermitentes
 * que aparecían en exámenes largos.
 *
 * Retorna un Map<qid, result>. Para preguntas que la IA omitió del array
 * de respuesta, el caller las trata como falla individual ("missing_in_batch").
 *
 * Si la llamada falla en bloque (HTTP error, sin tool_call, JSON inválido),
 * retorna `{ batchError: ... }` — el caller distribuye el error a TODAS las
 * preguntas del batch (mismo error en cada una) + audita.
 */
interface BatchItem {
  qid: string;
  content: string;
  rubric: string;
  userAnswer: string;
  maxPoints: number;
  /** Tipo de pregunta. Determina el preámbulo que se inserta en el
   *  prompt para que la IA califique correctamente. Si está ausente
   *  o es 'abierta', se usa el flujo estándar de respuesta abierta.
   *  Valores conocidos: 'abierta' | 'codigo' | 'java_gui' | 'python_gui' | 'diagrama'. */
  type?: string;
  /** Lenguaje del código (solo aplica a type='codigo', 'java_gui' o 'python_gui').
   *  Ej. 'java', 'python', 'javascript'. Para java_gui siempre 'java',
   *  para python_gui siempre 'python'. */
  language?: string | null;
  /** Framework GUI (solo aplica a type='java_gui'): 'swing' | 'javafx'.
   *  Cambia las expectativas de la IA — Swing usa JFrame/JButton,
   *  JavaFX usa Stage/Scene/Application.launch().
   *  Para python_gui no aplica — solo tkinter está soportado. */
  framework?: string | null;
}

/**
 * Construye el preámbulo per-item según el tipo de pregunta. Sin esto
 * todas las respuestas se evalúan como "open answer" — la IA no
 * distingue código fuente de prosa, y para java_gui pierde el contexto
 * de framework. Resultado del bug: feedback genérico tipo "buena
 * explicación pero falta detalle" sobre código Java GUI.
 */
function itemDirectiveForType(it: BatchItem): string {
  const t = (it.type ?? "abierta").toLowerCase();
  if (t === "codigo") {
    const lang = it.language ?? "código";
    return (
      `[TIPO DE RESPUESTA: código fuente en ${lang}]\n` +
      `Evalúa: corrección sintáctica, lógica del algoritmo, manejo de casos borde, ` +
      `complejidad/eficiencia razonable, y claridad/buenas prácticas. NO califiques ` +
      `la prosa — esto es código. Si el código no compila o tiene errores graves, ` +
      `puntúa bajo y explica en el feedback dónde está el problema (línea/expresión).\n`
    );
  }
  if (t === "java_gui") {
    const fw = (it.framework ?? "swing").toLowerCase();
    const fwHint =
      fw === "javafx"
        ? `JavaFX (Application/Stage/Scene). Esperá ver \`extends Application\`, ` +
          `\`start(Stage)\`, \`Application.launch(...)\`. Los componentes usan ` +
          `\`javafx.scene.control.*\` (Button, TextField, Label, etc.) y los layouts ` +
          `\`HBox\`, \`VBox\`, \`GridPane\`, \`BorderPane\`.`
        : `Swing/AWT. Esperá ver \`extends JFrame\` o uso directo de \`JFrame\`, ` +
          `\`JButton\`, \`JTextField\`, \`JLabel\`. Layouts típicos: \`FlowLayout\`, ` +
          `\`BorderLayout\`, \`GridLayout\`. \`setVisible(true)\` para mostrar la ventana.`;
    return (
      `[TIPO DE RESPUESTA: código Java con interfaz gráfica — framework ${fw.toUpperCase()}]\n` +
      `Marco esperado: ${fwHint}\n` +
      `Evalúa específicamente: (1) la ventana/escena se construye correctamente para el framework; ` +
      `(2) los componentes y el layout coinciden con lo pedido en el enunciado; ` +
      `(3) los handlers de eventos (\`ActionListener\`/lambda en Swing, \`EventHandler\`/lambda en JavaFX) ` +
      `están bien conectados; (4) no hay errores de compilación obvios; (5) el código realmente ` +
      `RENDERIZA lo que la rúbrica pide — no solo declara variables.\n` +
      `NO penalices por falta de \`Thread.sleep\` ni por estructura "main" mínima: el runner del ` +
      `proyecto envuelve el código en un bootstrap que mantiene la JVM viva (Swing) o llama a ` +
      `\`Application.launch\` (JavaFX), así que el estudiante no necesita escribir esa plomería.\n`
    );
  }
  if (t === "python_gui") {
    return (
      `[TIPO DE RESPUESTA: código Python con interfaz gráfica — framework TKINTER]\n` +
      `Marco esperado: tkinter (módulo estándar de Python). Esperá ver \`import tkinter as tk\` ` +
      `o \`from tkinter import ...\`, creación de un \`Tk()\` como ventana raíz, widgets ` +
      `\`Label\`, \`Button\`, \`Entry\`, \`Frame\`, \`Text\`, \`Canvas\`, layouts con \`pack()\`, ` +
      `\`grid()\` o \`place()\`, y al final \`root.mainloop()\`. Los handlers de eventos se ` +
      `conectan con el parámetro \`command=\` de los widgets o con \`bind('<Event>', handler)\`.\n` +
      `Evalúa específicamente: (1) la ventana raíz se crea correctamente y se ejecuta \`mainloop()\`; ` +
      `(2) los widgets y el layout (\`pack\`/\`grid\`/\`place\`) coinciden con lo pedido en el enunciado; ` +
      `(3) los handlers de eventos están bien conectados a los widgets; (4) no hay errores obvios ` +
      `de sintaxis Python ni typos de nombres de widgets; (5) el código realmente RENDERIZA lo que ` +
      `la rúbrica pide — no solo declara variables sueltas.\n` +
      `NO penalices por no cerrar la ventana manualmente (\`root.after(..., root.destroy)\`) ni por ` +
      `omitir \`root.mainloop()\` si el resto del código es coherente: el runner del proyecto ` +
      `envuelve el código en un bootstrap que monkey-patchea \`Tk.__init__\` para cerrar ` +
      `automáticamente y, si falta el \`mainloop()\`, lo invoca él. El estudiante no necesita ` +
      `escribir esa plomería.\n`
    );
  }
  if (t === "diagrama") {
    return (
      `[TIPO DE RESPUESTA: diagrama (sintaxis Mermaid, PlantUML o ASCII)]\n` +
      `Evalúa: si el diagrama modela las entidades/relaciones/flujo pedidos en el enunciado, ` +
      `completitud (no faltan elementos clave), claridad de las etiquetas, dirección/sentido ` +
      `correcto de las relaciones. Es válido si la sintaxis renderiza aunque tenga pequeños ` +
      `defectos visuales.\n`
    );
  }
  // 'abierta' o desconocido → sin directiva extra (comportamiento legacy).
  return "";
}
interface BatchScore {
  score: number;
  feedback: string;
  ai_likelihood: number;
  ai_reasons: string;
}
interface BatchError {
  batchError: {
    kind: "http" | "no_tool_call" | "parse_failed";
    http_status?: number;
    response_snippet: string;
    finish_reason?: string | null;
  };
}

async function gradeOpenAnswersInBatch(
  items: BatchItem[],
  systemPrompt: string,
  langName: string,
): Promise<{ results: Map<string, BatchScore> } | BatchError> {
  const itemsBlock = items
    .map((it, idx) => {
      const directive = itemDirectiveForType(it);
      return (
        `─── Pregunta #${idx + 1} (qid: ${it.qid}, puntaje máximo: ${it.maxPoints}) ───\n` +
        (directive ? `${directive}\n` : "") +
        `ENUNCIADO:\n${it.content}\n\n` +
        `RÚBRICA ESPERADA:\n${it.rubric}\n\n` +
        `RESPUESTA DEL ESTUDIANTE:\n${it.userAnswer}`
      );
    })
    .join("\n\n");

  const aiRes = await aiChatCompletion({
    messages: [
      {
        role: "system",
        content:
          `${systemPrompt}\n\n` +
          `IMPORTANTE: vas a calificar ${items.length} respuestas en una sola llamada. ` +
          `Devuelve UN item por cada qid recibido — no omitas ninguno. El score de cada ` +
          `qid debe respetar SU PROPIO puntaje máximo (declarado en el ítem). ` +
          `REGLA DE IDIOMA: responde siempre en ${langName}.`,
      },
      {
        role: "user",
        content:
          `Califica las siguientes ${items.length} respuestas. Por cada una devuelve qid, ` +
          `score (≤ puntaje máximo del item), feedback, ai_likelihood (0..1) y ai_reasons.\n\n` +
          `${itemsBlock}\n\n` +
          `Idioma de salida obligatorio: ${langName}.`,
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "score_batch",
          description: "Calificar un lote de respuestas en una sola llamada",
          parameters: {
            type: "object",
            properties: {
              items: {
                type: "array",
                description: "Array con la calificación de cada qid recibido",
                items: {
                  type: "object",
                  properties: {
                    qid: { type: "string" },
                    score: { type: "number" },
                    feedback: { type: "string" },
                    ai_likelihood: {
                      type: "number",
                      description: "Probabilidad 0..1 de que la respuesta sea generada por IA",
                    },
                    ai_reasons: {
                      type: "string",
                      description: "Razonamiento sobre la detección de IA",
                    },
                  },
                  required: ["qid", "score", "feedback", "ai_likelihood", "ai_reasons"],
                },
              },
            },
            required: ["items"],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "score_batch" } },
  });

  if (!aiRes.ok) {
    let body = "";
    try {
      body = await aiRes.text();
    } catch {
      /* ignore */
    }
    return {
      batchError: {
        kind: "http",
        http_status: aiRes.status,
        response_snippet: body.slice(0, 2000),
      },
    };
  }
  const aiJson = await aiRes.json();
  const tc = aiJson.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc) {
    return {
      batchError: {
        kind: "no_tool_call",
        response_snippet: JSON.stringify(aiJson).slice(0, 2000),
        finish_reason: aiJson.choices?.[0]?.finish_reason ?? null,
      },
    };
  }
  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(tc.function.arguments);
  } catch {
    return {
      batchError: {
        kind: "parse_failed",
        response_snippet: String(tc.function.arguments).slice(0, 2000),
      },
    };
  }
  const arr = Array.isArray((parsed as { items?: unknown }).items)
    ? ((parsed as { items: unknown[] }).items as Array<Record<string, unknown>>)
    : [];

  const results = new Map<string, BatchScore>();
  for (const r of arr) {
    const qid = typeof r.qid === "string" ? r.qid : "";
    if (!qid) continue;
    results.set(qid, {
      score: Number(r.score) || 0,
      feedback: typeof r.feedback === "string" ? r.feedback : "",
      ai_likelihood: Math.max(0, Math.min(1, Number(r.ai_likelihood) || 0)),
      ai_reasons: typeof r.ai_reasons === "string" ? r.ai_reasons : "",
    });
  }
  return { results };
}

async function resolveSystemPrompt(
  useCase: string,
  courseId: string | null | undefined,
  fallback: string,
): Promise<string> {
  try {
    // 3 capas de override + fallback hardcodeado (mig 20260718000000):
    //   1. course override     (course_id = X)                → más específico
    //   2. tenant global       (course_id IS NULL, tenant_id != NULL)
    //   3. platform default    (course_id IS NULL, tenant_id IS NULL)
    //   4. fallback hardcodeado (`fallback` param)
    // Traemos las filas que la RLS deja ver para el caller (en `adminClient`
    // RLS está bypaseada, así que vienen TODAS las filas potencialmente
    // relevantes) y rankeamos en JS. PostgREST no soporta ordenar por
    // null-last directamente con multi-tabla, además el ranking es
    // de 3 niveles — más simple en código.
    const isUuid = (s: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    let q = adminClient
      .from("ai_prompts")
      .select("system_prompt, course_id, tenant_id")
      .eq("use_case", useCase);
    if (courseId && isUuid(courseId)) {
      // Si vino un courseId válido: traemos la del curso + la global del
      // tenant del curso + la platform default.
      q = q.or(`course_id.eq.${courseId},course_id.is.null`);
    } else {
      // Sin courseId: solo globales (tenant + platform).
      q = q.is("course_id", null);
    }
    const { data, error } = await q;
    if (error || !data || data.length === 0) return fallback;
    // Scope de tenant (adminClient bypasea RLS): la capa "tenant global"
    // (course_id NULL, tenant_id != NULL) debe matchear SOLO el tenant del curso.
    // Sin esto, el prompt global de OTRO tenant (rank 2) podía usarse para
    // calificar entregas de este curso. Resolvemos el tenant del curso 1 vez.
    let courseTenantId: string | null = null;
    if (courseId && isUuid(courseId)) {
      const { data: c } = await adminClient
        .from("courses")
        .select("tenant_id")
        .eq("id", courseId)
        .maybeSingle();
      courseTenantId = (c as { tenant_id?: string | null } | null)?.tenant_id ?? null;
    }
    const scoped = data.filter(
      (r) => (courseId && r.course_id === courseId) || r.tenant_id === courseTenantId || r.tenant_id === null,
    );
    if (scoped.length === 0) return fallback;
    // Ranking: course override (3) > tenant global (2) > platform
    // default (1). Tomamos la fila con mejor ranking.
    const rank = (row: { course_id: string | null; tenant_id: string | null }): number => {
      if (row.course_id) return 3;
      if (row.tenant_id) return 2;
      return 1;
    };
    const sorted = [...scoped].sort((a, b) => rank(b) - rank(a));
    return sorted[0]?.system_prompt || fallback;
  } catch (e) {
    console.warn("[ai_prompts] resolve failed, using fallback:", e);
    return fallback;
  }
}

// Fallback corto del prompt de detección de IA. Solo se usa si la fila
// global de `ai_content_detection` no está disponible (RLS/red). El seed
// completo vive en la migración 20260508160000_ai_prompts_plagio_y_ia.sql.
const AI_CONTENT_DETECTION_FALLBACK = `Estima la PROBABILIDAD (0..1) de que la respuesta haya sido generada por IA. Considera marcadores que SÍ suben la probabilidad (prosa demasiado pulida, estructura genérica, terminología fuera de la rúbrica, ausencia de voz personal, repetición del enunciado, listas/bullets espontáneos, respuestas exhaustivas para una pregunta corta) y marcadores que NO suben la probabilidad (typos, ideas mal redactadas, respuestas cortas pero precisas, reuso del enunciado). En ai_reasons cita marcadores CONCRETOS de la respuesta. Si no hay señales fuertes, retorna probabilidad <0.3 y di brevemente por qué parece humana.`;

/**
 * Resuelve el system prompt de calificación + anexa el prompt de
 * detección de IA. Esto permite que el admin/docente edite ambos por
 * separado (en /app/admin/ai-prompts y /app/teacher/ai-prompts) y que
 * los cambios se reflejen en todas las rutas de grading sin duplicar
 * el texto en cada use_case.
 */
async function buildGradingSystemPrompt(
  useCase: string,
  courseId: string | null | undefined,
  gradingFallback: string,
): Promise<string> {
  const [grading, aiDetection] = await Promise.all([
    resolveSystemPrompt(useCase, courseId, gradingFallback),
    resolveSystemPrompt("ai_content_detection", courseId, AI_CONTENT_DETECTION_FALLBACK),
  ]);
  // Regla de FORMATO de salida, mecánica y siempre aplicada (no editable).
  // El campo `feedback` se muestra como TEXTO PLANO en la UI (no se renderiza
  // Markdown), así que pedirle al modelo que use Markdown deja la
  // retroalimentación con `**`, `*`, `#`, backticks visibles. Esta regla va
  // acá (en buildGradingSystemPrompt) para cubrir TODOS los casos de uso,
  // tenants y cursos de una sola vez, sin depender de los prompts editables.
  return (
    `${grading}\n\n--- Detección de respuestas generadas por IA ---\n${aiDetection}` +
    `\n\n--- Formato de la retroalimentación (OBLIGATORIO) ---\n${FEEDBACK_PLAINTEXT_RULE}`
  );
}

/**
 * Regla de formato del `feedback`: texto plano legible, SIN sintaxis Markdown.
 * La UI no renderiza Markdown — mostraría los símbolos crudos.
 */
const FEEDBACK_PLAINTEXT_RULE =
  "Escribe el campo `feedback` en TEXTO PLANO legible, SIN sintaxis Markdown: " +
  "no uses asteriscos para negrita/cursiva (** o *), ni almohadillas (#) para títulos, " +
  "ni backticks (`) ni bloques de código, ni viñetas con `*`/`-`. " +
  "Para títulos de sección escribe la palabra seguida de dos puntos (ej. \"Fortalezas:\"). " +
  "Para enumerar usa números seguidos de punto (ej. \"1. \") o simplemente párrafos. " +
  "Para nombres de clases/métodos/archivos escríbelos tal cual, sin comillas invertidas.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  // Cerramos sobre estas variables para que el catch global tenga
  // contexto sobre qué modo + caller estaban en juego cuando explotó.
  let auditCallerId: string | null = null;
  let auditMode: string = "unknown";
  let auditEntityId: string | null = null;
  let auditModel: string | null = null;
  try {
    // ── Authn ──
    // Esta función ejecuta IA (cuesta créditos) y escribe en
    // submissions/workshop_submissions/project_submissions con
    // service-role. Sin auth del lado del caller, cualquiera con la
    // URL podría disparar grading para submissions ajenas. Verificamos
    // que el caller esté autenticado y, en modo exam grading, que sea
    // dueño de la submission O docente/admin del curso. El resto de
    // modos (workshop_full / project_*) se llaman desde flujos
    // server-side controlados; ahí basta con auth.
    // X-Trigger-Secret bypass: el cron de reintento automático
    // (retry-failed-ai-gradings) no tiene un user JWT — se autoriza con
    // un shared secret del entorno. Si el secret matchea, tratamos al
    // caller como sistema con permisos de Admin/Docente. La validez del
    // secret limita el blast radius (sin él, esta ruta sigue requiriendo
    // user JWT como antes).
    const triggerSecret =
      req.headers.get("x-trigger-secret") || req.headers.get("X-Trigger-Secret");
    const expectedTriggerSecret = Deno.env.get("RETRY_TRIGGER_SECRET");
    // Caller server-side: otro edge function del mismo proyecto
    // (ai-grading-worker drenando la cola, retry-failed-ai-gradings)
    // manda `Authorization: Bearer <service_role_key>`. Solo el código
    // server-side conoce ese key, así que matchearlo es un signal de
    // origen confiable — y funciona sea cual sea el formato del key
    // (JWT legacy o sb_secret_* nuevo), a diferencia de verify_jwt del
    // gateway que rebota los formatos no-JWT.
    const bearerToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const isServiceRoleCaller = bearerToken.length > 0 && bearerToken === serviceRoleKey;
    const isSystemTrigger =
      isServiceRoleCaller ||
      (!!expectedTriggerSecret && !!triggerSecret && triggerSecret === expectedTriggerSecret);

    let callerId: string;
    let callerIsTeacherOrAdmin: boolean;

    if (isSystemTrigger) {
      // Cron / sistema: sin user JWT. Saltamos rate limit (el cron ya
      // lo throttle a MAX_PER_RUN cada 30 min) y damos permisos de admin.
      callerId = "00000000-0000-0000-0000-000000000000"; // system sentinel
      callerIsTeacherOrAdmin = true;
      auditCallerId = null; // audit log con actorId null = sistema
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "No autenticado" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
        { global: { headers: { Authorization: authHeader } } },
      );
      const { data: u } = await userClient.auth.getUser();
      if (!u.user) {
        return new Response(JSON.stringify({ error: "Token inválido" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Rate limit: cada call gasta créditos de IA. 120/hora por usuario
      // = ~2 por minuto, suficiente para calificar manualmente un curso
      // grande (30-50 entregas) sin disparar 429, pero corta scripts en
      // loop. El helper deja pasar si el RPC SQL no está disponible.
      const rl = await enforceRateLimit(userClient, "ai.grade_submission", {
        max: 120,
        windowSeconds: 3600,
      });
      if (!rl.ok) return rl.response;

      callerId = u.user.id;
      auditCallerId = callerId;
      const { data: callerRoles } = await adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", callerId);
      callerIsTeacherOrAdmin = (callerRoles ?? []).some(
        (r: { role: string }) =>
          r.role === "Admin" || r.role === "Docente" || r.role === "SuperAdmin",
      );
    }

    const body = await req.json();
    // Multi-tenant: setear hint del modelo según courseId del body o JWT
    // del caller. Las llamadas internas de aiChatCompletion() lo
    // consumirán para resolver `ai_model_settings` filtrado por tenant.
    setRequestModelHint({
      courseId: (body as { courseId?: string | null }).courseId ?? null,
      authHeader: req.headers.get("Authorization"),
    });
    auditMode = body.batchGrading
      ? "batch"
      : body.workshopGrading
        ? "workshop_full"
        : body.workshopQuestionGrading
          ? "workshop_question"
          : body.workshopCodeZipGrading
            ? "workshop_code_zip"
            : body.projectGrading
              ? "project_full"
              : body.projectFileGrading
                ? "project_file"
                : body.projectCodeZipGrading
                  ? "project_code_zip"
                  : body.examQuestion
                    ? "exam_question"
                    : "exam_full";
    auditEntityId =
      body.submissionId ??
      body.workshopSubmissionId ??
      body.projectSubmissionId ??
      body.examSubmissionId ??
      null;
    try {
      const m = await getActiveAiModel();
      auditModel = `${m.provider}:${m.model}`;
    } catch {
      /* no-op: si falla el lookup del modelo no aborta la grading */
    }
    void auditFromEdge(adminClient, {
      actorId: callerId,
      action: "ai.grading_started",
      category: "grading",
      severity: "info",
      entityType: "submission",
      entityId: auditEntityId,
      metadata: { mode: auditMode, model: auditModel },
    });
    // La validación del API key vive ahora en aiChatCompletion según el
    // provider activo (GEMINI_API_KEY o OPENAI_API_KEY).

    // ── Modo batch genérico — califica N preguntas en UNA llamada ──
    // El caller (UI de workshop, project, exam externo, etc.) manda un
    // array `items` con todo lo necesario para evaluar cada pregunta y
    // recibe un array de resultados. Reusa el helper gradeOpenAnswersInBatch.
    //
    // body: {
    //   batchGrading: true,
    //   items: [{ qid, type, content, rubric, userAnswer, maxPoints, language? }],
    //   courseLanguage?: 'es'|'en',
    //   courseId?: string,
    //   useCase?: 'workshop_question'|'project_full'|'exam_question'  (default: workshop_question)
    // }
    // returns: { ok, results: { qid: { score, feedback, ai_likelihood, ai_reasons } } }
    //          o { error, ... } en falla.
    if (body.batchGrading) {
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) {
        return new Response(JSON.stringify({ ok: true, results: {} }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const useCase: string = typeof body.useCase === "string" ? body.useCase : "workshop_question";
      const bLang: "es" | "en" = body.courseLanguage === "en" ? "en" : "es";
      const bLangName = bLang === "en" ? "inglés (English)" : "español";

      const customSystem = await buildGradingSystemPrompt(
        useCase,
        body.courseId,
        "Eres un evaluador académico imparcial. Calificas respuestas según las rúbricas dadas. Por cada respuesta devuelves un puntaje, retroalimentación útil y una estimación 0..1 de probabilidad de que sea generada por IA.",
      );

      const batchInput: BatchItem[] = items
        .filter(
          (it: {
            qid?: unknown;
            content?: unknown;
            rubric?: unknown;
            userAnswer?: unknown;
            maxPoints?: unknown;
          }) =>
            typeof it.qid === "string" &&
            it.qid &&
            (typeof it.userAnswer === "string" ? it.userAnswer.trim() : it.userAnswer) &&
            typeof it.maxPoints === "number",
        )
        .map(
          (it: {
            qid: string;
            content?: string;
            rubric?: string;
            userAnswer: string;
            maxPoints: number;
            type?: string;
            language?: string | null;
            framework?: string | null;
          }) => ({
            qid: it.qid,
            content: String(it.content ?? ""),
            rubric: String(it.rubric ?? ""),
            userAnswer: String(it.userAnswer),
            maxPoints: Number(it.maxPoints),
            type: typeof it.type === "string" ? it.type : undefined,
            language: it.language ?? undefined,
            framework: it.framework ?? undefined,
          }),
        );

      if (batchInput.length === 0) {
        return new Response(
          JSON.stringify({ ok: true, results: {}, note: "Sin items válidos para evaluar" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const out = await gradeOpenAnswersInBatch(batchInput, customSystem, bLangName);
      if ("batchError" in out) {
        void auditFromEdge(adminClient, {
          actorId: auditCallerId,
          action: "ai.grading_failed",
          category: "grading",
          severity: "error",
          entityType: "submission",
          entityId: auditEntityId,
          metadata: {
            mode: "batch",
            scope: useCase,
            batch_size: batchInput.length,
            kind: out.batchError.kind,
            http_status: out.batchError.http_status ?? null,
            response_snippet: out.batchError.response_snippet,
            finish_reason: out.batchError.finish_reason ?? null,
            model: auditModel,
          },
        });
        return new Response(
          JSON.stringify({
            error: "Fallo al calificar en bloque",
            kind: out.batchError.kind,
            http_status: out.batchError.http_status ?? null,
            response_snippet: out.batchError.response_snippet,
          }),
          {
            status: out.batchError.http_status ?? 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // Convertimos Map → objeto { qid: result } para que sea JSON-serializable.
      const resultsObj: Record<
        string,
        { score: number; feedback: string; ai_likelihood: number; ai_reasons: string }
      > = {};
      for (const [qid, r] of out.results.entries()) {
        // Cap del score al maxPoints del item correspondiente.
        const it = batchInput.find((x) => x.qid === qid);
        const cap = it ? it.maxPoints : Number.POSITIVE_INFINITY;
        resultsObj[qid] = {
          score: Math.max(0, Math.min(cap, Number(r.score) || 0)),
          feedback: r.feedback,
          ai_likelihood: r.ai_likelihood,
          ai_reasons: r.ai_reasons,
        };
      }

      return new Response(
        JSON.stringify({ ok: true, results: resultsObj, processed: batchInput.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Workshop FULL grading (async, batch + persistencia interna) ─────
    // Diseñada para el flow async (cola): UN solo job IA persiste TODAS
    // las preguntas abiertas de UNA entrega de taller en una sola llamada
    // a Gemini, en vez de encolar N jobs (uno por pregunta) que era el
    // patrón original.
    //
    // Diferencias vs `batchGrading`:
    //   - Recibe `submissionId` (workshop_submissions.id) además de items.
    //   - Persiste los resultados directamente en workshop_submission_answers
    //     (UPDATE por submission_id + question_id) usando service_role.
    //   - Devuelve `persistedInternally: true` para que el worker NO intente
    //     re-escribir target_table (el worker tiene esa rama).
    //
    // body: {
    //   workshopFullGrading: true,
    //   submissionId: "<workshop_submissions.id>",
    //   items: [{ qid, content, rubric, userAnswer, maxPoints }],
    //   courseLanguage?: 'es'|'en',
    //   courseId?: string
    // }
    // returns: { ok, persistedInternally: true, processed: N }
    if (body.workshopFullGrading) {
      const { submissionId, courseLanguage, courseId } = body;
      const itemsInput = Array.isArray(body.items) ? body.items : [];
      if (!submissionId || typeof submissionId !== "string") {
        throw new Error("submissionId requerido");
      }

      const wfLang: "es" | "en" = courseLanguage === "en" ? "en" : "es";
      const wfLangName = wfLang === "en" ? "inglés (English)" : "español";

      // Mismo filter/map que batchGrading. Reusamos la misma forma de
      // BatchItem para que gradeOpenAnswersInBatch funcione idéntico.
      const batchInput: BatchItem[] = itemsInput
        .filter(
          (it: { qid?: unknown; userAnswer?: unknown; maxPoints?: unknown }) =>
            typeof it.qid === "string" &&
            it.qid &&
            (typeof it.userAnswer === "string" ? it.userAnswer.trim() : it.userAnswer) &&
            typeof it.maxPoints === "number",
        )
        .map(
          (it: {
            qid: string;
            content?: string;
            rubric?: string;
            userAnswer: string;
            maxPoints: number;
            type?: string;
            language?: string | null;
            framework?: string | null;
          }) => ({
            qid: it.qid,
            content: String(it.content ?? ""),
            rubric: String(it.rubric ?? ""),
            userAnswer: String(it.userAnswer),
            maxPoints: Number(it.maxPoints),
            type: typeof it.type === "string" ? it.type : undefined,
            language: it.language ?? undefined,
            framework: it.framework ?? undefined,
          }),
        );

      // Sin items válidos: salimos OK como si nada hubiera que calificar.
      // El worker marca done. La submission ya tiene su placeholder
      // "Pendiente IA…" del client — limpiar lo dejamos al docente o al
      // próximo refresh; por ahora preservamos para diagnóstico.
      if (batchInput.length === 0) {
        return new Response(JSON.stringify({ ok: true, persistedInternally: true, processed: 0 }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const customSystemWf = await buildGradingSystemPrompt(
        "workshop_question",
        courseId,
        "Eres un evaluador académico imparcial. Calificas respuestas según las rúbricas dadas. Por cada respuesta devuelves un puntaje, retroalimentación útil y una estimación 0..1 de probabilidad de que sea generada por IA.",
      );

      const outWf = await gradeOpenAnswersInBatch(batchInput, customSystemWf, wfLangName);
      if ("batchError" in outWf) {
        // Bubble up con kind explícito para que el caller (worker) lo
        // detecte como error transiente cuando aplica (http_status 429/5xx).
        // El retry automático que metimos en complete_ai_grading mira
        // el mensaje — incluimos http_status para que matchee el regex.
        const httpStatus = outWf.batchError.http_status ?? 500;
        const snippet = outWf.batchError.response_snippet ?? "sin detalle";
        throw new Error(
          `workshop_full batch failed: ${outWf.batchError.kind} (HTTP ${httpStatus}). ${snippet.slice(0, 200)}`,
        );
      }

      // ─── Persistencia interna ────────────────────────────────────────
      // UPDATE por (submission_id, question_id). Usamos el admin client
      // (service_role) que ya teníamos arriba — bypasea RLS. Hacemos un
      // UPDATE por qid en serie para tener un error claro si alguno falla.
      // Para N≤30 preguntas el overhead es negligible vs el AI call.
      let persisted = 0;
      const persistErrors: Array<{ qid: string; error: string }> = [];
      for (const [qid, r] of outWf.results.entries()) {
        const it = batchInput.find((x) => x.qid === qid);
        if (!it) continue; // qid devuelto que no estaba en el input — skip defensivo
        const cap = it.maxPoints;
        const score = Math.max(0, Math.min(cap, Number(r.score) || 0));
        const aiLikelihood = Math.max(0, Math.min(1, Number(r.ai_likelihood) || 0));
        const { error: upErr } = await adminClient
          .from("workshop_submission_answers")
          .update({
            ai_grade: score,
            ai_feedback: r.feedback || "Sin retroalimentación",
            ai_likelihood: aiLikelihood,
            ai_reasons: r.ai_reasons ?? null,
          })
          .eq("submission_id", submissionId)
          .eq("question_id", qid);
        if (upErr) {
          persistErrors.push({ qid, error: upErr.message });
        } else {
          persisted++;
        }
      }

      // Si TODAS las persistencias fallaron, lo tratamos como fallo del job.
      // Si solo algunas → reportamos en la respuesta pero marcamos done
      // (las que sí persistieron quedaron). Decisión: parcial mejor que cero.
      if (persisted === 0 && persistErrors.length > 0) {
        throw new Error(`No se pudo persistir ningún resultado: ${persistErrors[0].error}`);
      }

      return new Response(
        JSON.stringify({
          ok: true,
          persistedInternally: true,
          processed: persisted,
          partial_errors: persistErrors.length > 0 ? persistErrors : undefined,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Workshop grading mode ──
    if (body.workshopGrading) {
      const {
        workshopTitle,
        workshopInstructions,
        rubric,
        maxScore,
        studentAnswer,
        courseLanguage,
        courseId,
      } = body;
      if (!studentAnswer) throw new Error("studentAnswer requerido");
      const wsLang: "es" | "en" = courseLanguage === "en" ? "en" : "es";
      const wsLangName = wsLang === "en" ? "inglés (English)" : "español";

      const customSystem = await buildGradingSystemPrompt(
        "workshop_full",
        courseId,
        "Eres un evaluador académico imparcial. Calificas entregas de talleres según las instrucciones y rúbrica proporcionadas. Das un puntaje numérico, retroalimentación detallada y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA.",
      );
      // Reglas mecánicas que el código añade siempre — tope numérico
      // y regla de idioma. El sistema editable mantiene la persona y
      // criterios; estas reglas garantizan el contrato de salida.
      const systemPrompt = `${customSystem}\n\nPuntaje máximo permitido: ${maxScore ?? 100}.\nREGLA DE IDIOMA: responde siempre en ${wsLangName}.`;

      const aiRes = await aiChatCompletion({
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: `Taller: ${workshopTitle ?? "Sin título"}\n\nInstrucciones: ${workshopInstructions ?? "Sin instrucciones específicas"}\n\nRúbrica de evaluación: ${rubric ?? "Evalúa calidad, completitud y corrección"}\n\nPuntaje máximo: ${maxScore ?? 100}\n\nRespuesta del estudiante:\n${studentAnswer}\n\nIdioma de salida obligatorio: ${wsLangName}.`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "score_workshop",
              description: "Calificar entrega de taller y estimar si fue generada por IA",
              parameters: {
                type: "object",
                properties: {
                  score: { type: "number", description: `Puntaje entre 0 y ${maxScore ?? 100}` },
                  feedback: {
                    type: "string",
                    description: "Retroalimentación detallada",
                  },
                  ai_likelihood: {
                    type: "number",
                    description:
                      "Probabilidad 0..1 de que la respuesta del estudiante haya sido generada por IA",
                  },
                  ai_reasons: {
                    type: "string",
                    description: "Breve razonamiento sobre la detección de IA",
                  },
                },
                required: ["score", "feedback", "ai_likelihood", "ai_reasons"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "score_workshop" } },
      });

      if (!aiRes.ok) {
        const errText = await aiRes.text();
        console.error("AI error", aiRes.status, errText);
        throw new Error(await describeAiError(aiRes, cachedModel?.provider ?? "gemini", errText));
      }

      const aiJson = await aiRes.json();
      const tc = aiJson.choices?.[0]?.message?.tool_calls?.[0];
      const args = tc
        ? JSON.parse(tc.function.arguments)
        : {
            score: 0,
            feedback: "No se pudo generar retroalimentación",
            ai_likelihood: 0,
            ai_reasons: "",
          };
      const score = Math.max(0, Math.min(Number(maxScore ?? 100), Number(args.score) || 0));
      const aiLikelihood = Math.max(0, Math.min(1, Number(args.ai_likelihood) || 0));

      return new Response(
        JSON.stringify({
          ok: true,
          grade: score,
          feedback: args.feedback,
          ai_likelihood: aiLikelihood,
          ai_detected: aiLikelihood >= 0.6,
          ai_reasons: args.ai_reasons ?? "",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ── Project FULL grading (async, batch + persistencia interna) ─────
    // Diseñada para el flow async (cola): UN solo job IA persiste TODAS
    // las preguntas no-ZIP de UNA entrega de proyecto en una sola llamada
    // a Gemini, en vez de encolar N jobs (uno por archivo/pregunta).
    //
    // Es el mismo patrón que `workshopFullGrading` pero apunta a
    // `project_submission_files` (qid → file_id) y trae projectDescription
    // como contexto global del proyecto (lo mismo que el modo per-file
    // legacy `projectFileGrading`).
    //
    // ZIP/multi-file de código (project_codigo_zip) NO entra acá — cada
    // entrega ZIP requiere descomprimir y leer archivos, y por eso
    // mantiene su propio job individual. La cola lo procesa aparte.
    //
    // body: {
    //   projectFullGrading: true,
    //   submissionId: "<project_submissions.id>",
    //   items: [{ qid, content, rubric, userAnswer, maxPoints }],
    //   courseLanguage?: 'es'|'en',
    //   courseId?: string,
    //   projectDescription?: string  // contexto global; mejora coherencia de notas
    // }
    // returns: { ok, persistedInternally: true, processed: N }
    if (body.projectFullGrading) {
      const { submissionId, courseLanguage, courseId, projectDescription } = body;
      const itemsInput = Array.isArray(body.items) ? body.items : [];
      if (!submissionId || typeof submissionId !== "string") {
        throw new Error("submissionId requerido");
      }

      const pfLang: "es" | "en" = courseLanguage === "en" ? "en" : "es";
      const pfLangName = pfLang === "en" ? "inglés (English)" : "español";

      // Mismo filter/map que batchGrading / workshopFullGrading.
      const batchInput: BatchItem[] = itemsInput
        .filter(
          (it: { qid?: unknown; userAnswer?: unknown; maxPoints?: unknown }) =>
            typeof it.qid === "string" &&
            it.qid &&
            (typeof it.userAnswer === "string" ? it.userAnswer.trim() : it.userAnswer) &&
            typeof it.maxPoints === "number",
        )
        .map(
          (it: {
            qid: string;
            content?: string;
            rubric?: string;
            userAnswer: string;
            maxPoints: number;
            type?: string;
            language?: string | null;
            framework?: string | null;
          }) => ({
            qid: it.qid,
            content: String(it.content ?? ""),
            rubric: String(it.rubric ?? ""),
            userAnswer: String(it.userAnswer),
            maxPoints: Number(it.maxPoints),
            type: typeof it.type === "string" ? it.type : undefined,
            language: it.language ?? undefined,
            framework: it.framework ?? undefined,
          }),
        );

      if (batchInput.length === 0) {
        return new Response(JSON.stringify({ ok: true, persistedInternally: true, processed: 0 }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Usamos el mismo use_case `project_file` que el modo per-file
      // legacy: la rúbrica/persona del admin para "evaluar archivos del
      // proyecto" sigue aplicando. El batch solo cambia el transporte.
      const customSystemPf = await buildGradingSystemPrompt(
        "project_file",
        courseId,
        "Eres un evaluador académico imparcial. Calificas el contenido textual de archivos del proyecto de un estudiante. Para cada archivo das un puntaje, retroalimentación útil y una estimación de probabilidad (0..1) de que el contenido haya sido generado por IA.",
      );
      // Inyectamos projectDescription como contexto global ANTES de la
      // tabla de items. El helper gradeOpenAnswersInBatch no sabe de
      // projectDescription, así que lo prependemos al system prompt.
      const projectCtx =
        projectDescription && String(projectDescription).trim()
          ? `\n\nContexto global del proyecto (úsalo para entender el alcance y propósito):\n${String(projectDescription).trim()}`
          : "";
      const systemWithCtx = `${customSystemPf}${projectCtx}`;

      const outPf = await gradeOpenAnswersInBatch(batchInput, systemWithCtx, pfLangName);
      if ("batchError" in outPf) {
        const httpStatus = outPf.batchError.http_status ?? 500;
        const snippet = outPf.batchError.response_snippet ?? "sin detalle";
        throw new Error(
          `project_full batch failed: ${outPf.batchError.kind} (HTTP ${httpStatus}). ${snippet.slice(0, 200)}`,
        );
      }

      // ─── Persistencia interna ────────────────────────────────────────
      // UPDATE por (submission_id, file_id). qid acá ES el file_id (en
      // projects el "id de pregunta" se llama file_id en la tabla
      // submission_files). Mismo patrón que workshopFullGrading.
      let persisted = 0;
      const persistErrors: Array<{ qid: string; error: string }> = [];
      for (const [qid, r] of outPf.results.entries()) {
        const it = batchInput.find((x) => x.qid === qid);
        if (!it) continue;
        const cap = it.maxPoints;
        const score = Math.max(0, Math.min(cap, Number(r.score) || 0));
        const aiLikelihood = Math.max(0, Math.min(1, Number(r.ai_likelihood) || 0));
        const { error: upErr } = await adminClient
          .from("project_submission_files")
          .update({
            ai_grade: score,
            ai_feedback: r.feedback || "Sin retroalimentación",
            ai_likelihood: aiLikelihood,
            ai_reasons: r.ai_reasons ?? null,
          })
          .eq("submission_id", submissionId)
          .eq("file_id", qid);
        if (upErr) {
          persistErrors.push({ qid, error: upErr.message });
        } else {
          persisted++;
        }
      }

      if (persisted === 0 && persistErrors.length > 0) {
        throw new Error(`No se pudo persistir ningún resultado: ${persistErrors[0].error}`);
      }

      return new Response(
        JSON.stringify({
          ok: true,
          persistedInternally: true,
          processed: persisted,
          partial_errors: persistErrors.length > 0 ? persistErrors : undefined,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Project FILE grading (per-file, contenido textual) ──
    // Body: { projectFileGrading: true, fileTitle, fileDescription, expectedRubric,
    //         maxPoints, studentContent, courseLanguage }
    // Devuelve { ok, grade, feedback, ai_likelihood, ai_reasons }.
    if (body.projectFileGrading) {
      const {
        fileTitle,
        fileDescription,
        expectedRubric,
        maxPoints = 1,
        studentContent,
        courseLanguage,
        courseId,
        // Contexto global del proyecto. Inyectado por el cliente desde
        // projects.description para que cada pregunta se evalúe sin
        // perder de vista el alcance/propósito del proyecto.
        projectDescription,
      } = body;
      if (!studentContent || !fileTitle) {
        throw new Error("fileTitle y studentContent requeridos");
      }
      const pfLang: "es" | "en" = courseLanguage === "en" ? "en" : "es";
      const pfLangName = pfLang === "en" ? "inglés (English)" : "español";

      const customSystem = await buildGradingSystemPrompt(
        "project_file",
        courseId,
        "Eres un evaluador académico imparcial. Calificas el contenido textual de UN archivo del proyecto de un estudiante. Das un puntaje, retroalimentación útil y una estimación de probabilidad (0..1) de que el contenido haya sido generado por IA.",
      );
      const systemPrompt = `${customSystem}\n\nPuntaje máximo permitido: ${maxPoints}.\nREGLA DE IDIOMA: responde siempre en ${pfLangName}.`;
      const projectCtx =
        projectDescription && String(projectDescription).trim()
          ? `Contexto global del proyecto (úsalo para entender el alcance y propósito):\n${String(projectDescription).trim()}\n\n`
          : "";

      const aiRes = await aiChatCompletion({
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: `${projectCtx}Pregunta: ${fileTitle}
Descripción esperada: ${fileDescription ?? "(sin descripción)"}
Rúbrica esperada: ${expectedRubric ?? "Evalúa corrección, completitud y claridad."}
Puntaje máximo: ${maxPoints}

Contenido entregado por el estudiante:
${studentContent}

Idioma de salida obligatorio: ${pfLangName}.`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "score_project_file",
              description: "Calificar contenido de un archivo de proyecto",
              parameters: {
                type: "object",
                properties: {
                  score: { type: "number" },
                  feedback: { type: "string" },
                  ai_likelihood: {
                    type: "number",
                    description: "Probabilidad 0..1 de que el contenido haya sido generado por IA",
                  },
                  ai_reasons: {
                    type: "string",
                    description: "Breve razonamiento sobre la detección de IA",
                  },
                },
                required: ["score", "feedback", "ai_likelihood", "ai_reasons"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "score_project_file" } },
      });

      if (aiRes.status === 429) {
        return new Response(
          JSON.stringify({ error: "Límite de uso de IA. Intenta en un momento." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (aiRes.status === 402) {
        return new Response(
          JSON.stringify({ error: "Sin créditos de IA. Agrega créditos al workspace." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (!aiRes.ok) {
        const errText = await aiRes.text();
        console.error("AI error", aiRes.status, errText);
        throw new Error(await describeAiError(aiRes, cachedModel?.provider ?? "gemini", errText));
      }

      const aiJson = await aiRes.json();
      const tc = aiJson.choices?.[0]?.message?.tool_calls?.[0];
      const args = tc
        ? JSON.parse(tc.function.arguments)
        : { score: 0, feedback: "", ai_likelihood: 0, ai_reasons: "" };
      const score = Math.max(0, Math.min(Number(maxPoints) || 0, Number(args.score) || 0));
      const aiLikelihood = Math.max(0, Math.min(1, Number(args.ai_likelihood) || 0));

      return new Response(
        JSON.stringify({
          ok: true,
          grade: score,
          feedback: args.feedback,
          ai_likelihood: aiLikelihood,
          ai_detected: aiLikelihood >= 0.6,
          ai_reasons: args.ai_reasons ?? "",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ── Project CODE grading (multi-file o ZIP legacy) ──
    // Body: { projectCodeZipGrading: true,
    //         codePaths?: string[],  // NUEVO: paths individuales en project-files
    //         zipPath?: string,       // LEGACY: path único a ZIP
    //         fileTitle, fileDescription, expectedRubric, maxPoints,
    //         courseLanguage, courseId, projectDescription, allowedExtensions }
    //
    // Dos fuentes de archivos soportadas:
    //   1) codePaths (preferido): el estudiante seleccionó N archivos
    //      individuales y se subieron uno por uno. Descargamos cada uno y
    //      lo agregamos al pool. No hay descompresión — los archivos vienen
    //      ya con su nombre/extensión, así la validación previa al upload
    //      del lado cliente es 100% confiable.
    //   2) zipPath (legacy): se sube un único .zip que descomprimimos con
    //      fflate. Se mantiene SOLO para no romper entregas ya hechas con
    //      el flujo viejo si alguien recalifica.
    //
    // Aguas abajo el código es idéntico para los dos modos: filtra por
    // extensión, minifica, concatena en un solo prompt y llama a IA.
    if (body.projectCodeZipGrading || body.workshopCodeZipGrading) {
      const {
        zipPath,
        codePaths,
        fileTitle,
        fileDescription,
        expectedRubric,
        maxPoints = 1,
        courseLanguage,
        courseId,
        // Contexto global del proyecto/taller (description) — se
        // inyecta para que la IA califique este componente teniendo
        // claro el alcance del entregable entero, no solo el slot.
        projectDescription,
        // Extensiones permitidas para esta entrega. Si el docente
        // requiere SOLO Java, pasa ["java"] y rechazamos si encontramos
        // archivos con otras extensiones. Si vacío o ausente → permitimos
        // todas las del whitelist global CODE_EXT.
        allowedExtensions,
        // Scaffolding flujo ZIP único (project_files.zip_single / workshop
        // _questions.zip_single = true). Cuando viene en true:
        //   - NO se minifica el contenido de cada archivo.
        //   - NO se trunca por archivo (>50KB pasa entero).
        //   - SÍ se mantiene el tope global MAX_CHARS para no exceder el
        //     context window del modelo.
        noMinify,
      } = body as {
        zipPath?: string;
        codePaths?: string[];
        fileTitle?: string;
        fileDescription?: string;
        expectedRubric?: string;
        maxPoints?: number;
        courseLanguage?: string;
        courseId?: string;
        projectDescription?: string;
        allowedExtensions?: string[];
        noMinify?: boolean;
      };
      // Selección de bucket según el origen:
      //   - projectCodeZipGrading → 'project-files' (default histórico)
      //   - workshopCodeZipGrading → 'workshop-files'
      // El resto del pipeline (validación, minify, prompt) es idéntico.
      const sourceBucket = body.workshopCodeZipGrading ? "workshop-files" : "project-files";
      // useCase del prompt: misma rúbrica para ambos por ahora — el
      // contrato "califica este componente de código según rúbrica" no
      // cambia entre proyecto y taller. Si se necesita customizar el
      // tono después, se puede separar en otro use_case (workshop_full?).
      const codeZipUseCase = body.workshopCodeZipGrading ? "workshop_full" : "project_full";
      const cleanedCodePaths = Array.isArray(codePaths)
        ? codePaths.filter((p): p is string => typeof p === "string" && p.length > 0)
        : [];
      if (!fileTitle || (cleanedCodePaths.length === 0 && !zipPath)) {
        throw new Error("fileTitle y (codePaths o zipPath) requeridos");
      }
      const pfLang: "es" | "en" = courseLanguage === "en" ? "en" : "es";
      const pfLangName = pfLang === "en" ? "inglés (English)" : "español";

      // ── Carga de archivos: dos rutas según fuente ──
      // Resultado común: `unzipped: Record<path, Uint8Array>` que el resto
      // del pipeline ya sabe consumir.
      const unzipped: Record<string, Uint8Array> = {};
      if (cleanedCodePaths.length > 0) {
        // Multi-file: descargamos cada archivo en paralelo. Usamos
        // basename como key visible a la IA — los paths reales de Storage
        // incluyen UUIDs que no aportan señal y empeoran el prompt.
        const downloads = await Promise.all(
          cleanedCodePaths.map(async (p) => {
            const { data, error } = await adminClient.storage.from(sourceBucket).download(p);
            if (error || !data) {
              return {
                path: p,
                bytes: null as Uint8Array | null,
                error: error?.message ?? "missing",
              };
            }
            return { path: p, bytes: new Uint8Array(await data.arrayBuffer()), error: null };
          }),
        );
        const failed = downloads.filter((d) => !d.bytes);
        if (failed.length > 0) {
          throw new Error(
            `No se pudo descargar ${failed.length} archivo(s): ${failed
              .map((f) => `${f.path} (${f.error})`)
              .slice(0, 3)
              .join("; ")}`,
          );
        }
        for (const d of downloads) {
          if (!d.bytes) continue;
          // Key visible = basename. Si dos archivos comparten basename
          // (subcarpetas distintas) anteponemos un sufijo numérico.
          const base = d.path.split("/").pop() ?? d.path;
          let key = base;
          let n = 1;
          while (unzipped[key]) {
            key = `${base}.${n}`;
            n++;
          }
          unzipped[key] = d.bytes;
        }
      } else {
        // Legacy ZIP: descarga + descomprime.
        const { data: zipBlob, error: dlErr } = await adminClient.storage
          .from(sourceBucket)
          .download(zipPath!);
        if (dlErr || !zipBlob) {
          throw new Error(`No se pudo descargar el ZIP: ${dlErr?.message ?? "missing"}`);
        }
        const zipBuf = new Uint8Array(await zipBlob.arrayBuffer());
        const fflate = await import("npm:fflate@0.8.2");
        const zipFiles = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
          fflate.unzip(zipBuf, (err, files) => (err ? reject(err) : resolve(files)));
        });
        for (const [k, v] of Object.entries(zipFiles)) unzipped[k] = v;
      }

      // Whitelist de extensiones de código fuente. Doc/imágenes/binarios
      // van en preguntas separadas, no aquí.
      const CODE_EXT = new Set([
        "java",
        "kt",
        "scala",
        "groovy",
        "py",
        "rb",
        "php",
        "js",
        "jsx",
        "ts",
        "tsx",
        "mjs",
        "cjs",
        "vue",
        "svelte",
        "c",
        "cpp",
        "cc",
        "cxx",
        "h",
        "hpp",
        "hxx",
        "cs",
        "fs",
        "vb",
        "go",
        "rs",
        "swift",
        "m",
        "mm",
        "sql",
        "sh",
        "bash",
        "zsh",
        "ps1",
        "html",
        "css",
        "scss",
        "sass",
        "less",
        "json",
        "yaml",
        "yml",
        "toml",
        "xml",
        "lua",
        "r",
        "jl",
        "pl",
        "ex",
        "exs",
        "erl",
        "clj",
        "cljs",
        "dart",
        "gradle",
        "makefile",
      ]);

      // ── Auto-descompresión de ZIPs sueltos ──
      // Caso típico: el estudiante subió un único `test.zip` con todo
      // el código adentro y el flujo multi-file lo registró en
      // `code_paths = ["test.zip"]`. Esa rama NO descomprime (era SOLO
      // para `zipPath` legacy). Resultado: `unzipped["test.zip"]`
      // quedaba con los bytes del ZIP entero, el filtro de extensiones
      // lo descartaba (`.zip` no está en CODE_EXT) y la IA recibía 0
      // archivos → "No se reconocieron archivos de código".
      //
      // Solución: detectar CUALQUIER `.zip` dentro del set `unzipped` y
      // expandirlo en sitio. Esto cubre:
      //   - Multi-file con un único ZIP (caso reportado).
      //   - Multi-file con varios archivos donde uno es ZIP de assets.
      //   - ZIPs anidados (un nivel — no recursivo para evitar zip-bomb).
      // Si un ZIP falla en descomprimir (corrupto, password-protected,
      // formato raro), lo dejamos como estaba y será descartado por el
      // whitelist más abajo — comportamiento previo, no degradamos.
      const zipsToExpand = Object.entries(unzipped).filter(([k]) =>
        k.toLowerCase().endsWith(".zip"),
      );
      if (zipsToExpand.length > 0) {
        const fflate = await import("npm:fflate@0.8.2");
        for (const [zipKey, zipBytes] of zipsToExpand) {
          try {
            const inner = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
              fflate.unzip(zipBytes, (err, files) => (err ? reject(err) : resolve(files)));
            });
            delete unzipped[zipKey];
            // Merge: si el ZIP trae paths con el mismo basename que un
            // archivo ya descargado por separado, mantenemos el path
            // original del ZIP (suele tener la ruta completa
            // `src/main/java/...` que da más contexto a la IA).
            for (const [innerPath, innerBytes] of Object.entries(inner)) {
              if (innerPath.endsWith("/")) continue;
              unzipped[innerPath] = innerBytes;
            }
          } catch (e) {
            console.warn(
              `[ai-grade-submission] No se pudo descomprimir ${zipKey}:`,
              e instanceof Error ? e.message : String(e),
            );
          }
        }
      }

      const allPaths = Object.keys(unzipped).filter((p) => !p.endsWith("/"));

      // ── Validación ESTRICTA de extensiones permitidas ──
      // Si el docente parametrizó allowedExtensions (e.g. ["java"]) el ZIP
      // debe contener ÚNICAMENTE archivos con esa extensión. La iteración
      // recorre `allPaths` que incluye archivos de cualquier nivel de
      // subcarpeta — así un .md o pom.xml dentro de `src/docs/` también
      // dispara rechazo, igual que uno en la raíz.
      //
      // Lo único que toleramos sin pasar al grading son archivos de ruido
      // que el SO/IDE/build genera automáticamente y que el estudiante no
      // eligió incluir (DS_Store, __MACOSX, carpetas .git/, target/, etc).
      // Antes había una whitelist `TOLERATED_NON_CODE` (md, txt, xml,
      // json, yml...) — la eliminamos porque dejaba pasar README, pom.xml,
      // package.json, build.gradle y otros archivos que el docente reportó
      // como "deberían rechazar".
      //
      // Rechazamos ANTES de llamar a IA — evita gastar tokens en entregas
      // inválidas y le da feedback claro al alumno para recomprimir solo
      // con los archivos correctos.
      // Whitelist activa para validar la entrega:
      //   - Si el docente fijó `allowedExtensions` (e.g. ["java"]) → esa.
      //   - Si no la fijó → caemos al whitelist global `CODE_EXT`.
      // Antes (cleanedAllowed.length === 0) la validación se SALTABA
      // por completo, permitiendo que el ZIP contuviera PDFs, imágenes
      // o cualquier basura — la edge solo descartaba esos archivos
      // antes del prompt, sin avisar al estudiante. Ahora SIEMPRE
      // rechazamos archivos no-código con un error claro. Si el
      // docente quiere aceptar README/PDFs, eso se hace en otra
      // pregunta del proyecto (no en codigo_zip).
      const explicitAllowed = Array.isArray(allowedExtensions)
        ? allowedExtensions
            .filter((e): e is string => typeof e === "string")
            .map((e) => e.toLowerCase().replace(/^\./, "").trim())
            .filter(Boolean)
        : [];
      const cleanedAllowed = explicitAllowed.length > 0 ? explicitAllowed : Array.from(CODE_EXT);
      // Veto explícito de archivos config/metadata (rechazar incluso si la
      // extensión coincide o si la subida es legacy ZIP). Espejo de la
      // lista del frontend (`isBlockedFile`).
      const BLOCKED_FILENAMES_EDGE = new Set([
        ".gitignore",
        ".gitattributes",
        ".dockerignore",
        ".editorconfig",
        ".prettierrc",
        ".eslintrc",
        ".npmignore",
        ".env",
        ".env.local",
        ".env.example",
        "thumbs.db",
        "desktop.ini",
        ".ds_store",
      ]);
      if (cleanedAllowed.length > 0) {
        const allowedSet = new Set(cleanedAllowed);
        // Helper: ¿este path es ruido auto-generado que toleramos?
        // Aplica a TODO el subárbol; no usamos `startsWith` porque las
        // carpetas también aparecen anidadas dentro del proyecto comprimido
        // (ej. `MiProyecto/.git/HEAD`).
        const isToleratedNoise = (lower: string, baseName: string): boolean => {
          // SO: macOS metadata, Windows thumbs/desktop.
          if (lower.includes("__macosx/") || baseName === ".ds_store") return true;
          if (baseName === "thumbs.db" || baseName === "desktop.ini") return true;
          // VCS / IDE / build folders en cualquier nivel del árbol.
          if (/(^|\/)\.git\//.test(lower)) return true;
          if (/(^|\/)\.idea\//.test(lower)) return true;
          if (/(^|\/)\.vscode\//.test(lower)) return true;
          if (/(^|\/)node_modules\//.test(lower)) return true;
          if (/(^|\/)target\//.test(lower)) return true;
          if (/(^|\/)build\//.test(lower)) return true;
          if (/(^|\/)out\//.test(lower)) return true;
          if (/(^|\/)dist\//.test(lower)) return true;
          if (/(^|\/)\.gradle\//.test(lower)) return true;
          // Compilados Java dentro de bin/ (típico de Eclipse).
          if (/(^|\/)bin\//.test(lower) && /\.(class|exe)$/i.test(lower)) return true;
          return false;
        };
        const violations: string[] = [];
        for (const p of allPaths) {
          const lower = p.toLowerCase();
          const ext = lower.split(".").pop() ?? "";
          const baseName = lower.split("/").pop() ?? "";
          // Ruido del SO/IDE/build: ni pasa al grading ni cuenta como violación.
          if (isToleratedNoise(lower, baseName)) continue;
          // Archivos config explícitamente vetados (.gitignore, .env…) —
          // cuentan como violación aunque la extensión técnicamente "exista"
          // o esté vacía.
          if (BLOCKED_FILENAMES_EDGE.has(baseName)) {
            violations.push(p);
            continue;
          }
          // Archivos en la whitelist explícita: pasan.
          if (allowedSet.has(ext)) continue;
          // Todo lo demás cuenta como violación — incluye .md, .txt, .xml,
          // .json, imágenes, PDFs, binarios y código en otro lenguaje.
          violations.push(p);
        }
        if (violations.length > 0) {
          const sample = violations.slice(0, 5).join(", ");
          const more = violations.length > 5 ? ` (+${violations.length - 5} más)` : "";
          // Mensaje adaptativo:
          //   - Si el docente fijó allowedExtensions (whitelist corta):
          //     enumeramos las permitidas — el estudiante sabe exactamente
          //     qué subir.
          //   - Si caímos al CODE_EXT genérico (60+ items): mensaje
          //     genérico "solo archivos de código fuente" — listar las
          //     60 extensiones rompería la legibilidad.
          const allowedLabel =
            explicitAllowed.length > 0
              ? `Solo se aceptan archivos ${explicitAllowed.map((e) => `.${e}`).join(", ")}`
              : "Solo se aceptan archivos de código fuente (.java, .py, .ts, .cpp, etc.). Los PDFs, documentos, imágenes y binarios no se permiten en este slot";
          return new Response(
            JSON.stringify({
              ok: false,
              error: `El ZIP contiene archivos no permitidos para esta entrega. ${allowedLabel} (revisa también las subcarpetas). Archivos rechazados: ${sample}${more}. Recomprime con SOLO los archivos de código fuente y vuelve a entregar.`,
              grade: 0,
              feedback: "",
              ai_likelihood: 0,
              ai_detected: false,
              ai_reasons: "",
              rejected_reason: "extension_mismatch",
              rejected_files: violations.slice(0, 50),
              allowed_extensions: cleanedAllowed,
            }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
      }

      const codeFiles: { path: string; content: string }[] = [];
      let totalChars = 0;
      const MAX_CHARS = 200_000; // ~ tope para no exceder context window
      // Trazas de truncado: el docente las verá como badge en el panel
      // de calificación para saber que la IA no analizó todo el código.
      let totalWhitelisted = 0;
      let perFileTruncated = 0;
      let totalLimitReached = false;

      // ── Minificación de código fuente ──
      // Reduce tokens enviados a la IA sin perder señal:
      //   - Comentarios de bloque /* ... */ y de línea //
      //   - Strings de docstring de Python (triple comilla)
      //   - Líneas en blanco consecutivas → 1 sola
      //   - Trailing whitespace por línea
      //   - Indentación >4 espacios colapsada a 1 tab visual (\t)
      // Mantenemos string literals intactos (delimitamos con " ' o `).
      // Tipos cubiertos: java, py, js/ts/tsx/jsx, c/cpp, cs, go, kt, rs.
      // Para tipos que la IA "lee" estructura por sangría (Python: la
      // identamos pero conservamos jerarquía) no agresivar las regex.
      //
      // Trade-off documentado: si el alumno tiene un comentario CRÍTICO
      // explicando una decisión, lo perdemos. Aceptable porque la IA
      // evalúa CÓDIGO (correctness/structure/style), no metadocumentación.
      // El comentario de cabecera con autoría tampoco aporta a la nota.
      const MINIFIABLE_EXT = new Set([
        "java",
        "kt",
        "scala",
        "groovy",
        "js",
        "jsx",
        "ts",
        "tsx",
        "mjs",
        "cjs",
        "c",
        "cpp",
        "cc",
        "cxx",
        "h",
        "hpp",
        "hxx",
        "cs",
        "go",
        "rs",
        "swift",
        "dart",
      ]);
      const minifyCStyle = (src: string): string => {
        // Parser pequeño que respeta strings. Recorre char por char.
        let out = "";
        let i = 0;
        const len = src.length;
        while (i < len) {
          const c = src[i];
          const next = src[i + 1];
          // String literals: copiar tal cual.
          if (c === '"' || c === "'" || c === "`") {
            const quote = c;
            out += c;
            i++;
            while (i < len) {
              const ch = src[i];
              out += ch;
              if (ch === "\\" && i + 1 < len) {
                out += src[i + 1];
                i += 2;
                continue;
              }
              i++;
              if (ch === quote) break;
            }
            continue;
          }
          // Block comment /* ... */
          if (c === "/" && next === "*") {
            const end = src.indexOf("*/", i + 2);
            i = end < 0 ? len : end + 2;
            continue;
          }
          // Line comment //
          if (c === "/" && next === "/") {
            const eol = src.indexOf("\n", i + 2);
            i = eol < 0 ? len : eol; // dejamos el \n para no pegar líneas
            continue;
          }
          out += c;
          i++;
        }
        return out;
      };
      const collapseWhitespace = (src: string): string => {
        return (
          src
            // Trim trailing whitespace por línea
            .replace(/[ \t]+$/gm, "")
            // Múltiples líneas vacías → una sola
            .replace(/\n{3,}/g, "\n\n")
            // Indentación de >8 espacios (cuando hay nesting profundo)
            // se colapsa a 4 — la estructura sigue legible pero ahorra
            // bytes. NO normalizamos tabs porque algunos lenguajes (Py)
            // dependen de consistencia.
            .replace(/^ {8,}/gm, "    ")
        );
      };
      const minifyPython = (src: string): string => {
        // Remove # comments fuera de strings.
        let out = "";
        let i = 0;
        const len = src.length;
        while (i < len) {
          const c = src[i];
          if (c === '"' || c === "'") {
            // Posible triple-quoted string.
            const triple = src.slice(i, i + 3);
            if (triple === '"""' || triple === "'''") {
              const end = src.indexOf(triple, i + 3);
              if (end < 0) {
                out += src.slice(i);
                i = len;
                break;
              }
              // Docstring → DESCARTAR (suelen ser narrativos largos).
              i = end + 3;
              continue;
            }
            // Single-line string.
            const quote = c;
            out += c;
            i++;
            while (i < len) {
              const ch = src[i];
              out += ch;
              if (ch === "\\" && i + 1 < len) {
                out += src[i + 1];
                i += 2;
                continue;
              }
              i++;
              if (ch === quote) break;
            }
            continue;
          }
          if (c === "#") {
            const eol = src.indexOf("\n", i + 1);
            i = eol < 0 ? len : eol;
            continue;
          }
          out += c;
          i++;
        }
        return out;
      };
      const minify = (path: string, ext: string, src: string): string => {
        try {
          if (MINIFIABLE_EXT.has(ext)) return collapseWhitespace(minifyCStyle(src));
          if (ext === "py") return collapseWhitespace(minifyPython(src));
        } catch (e) {
          console.warn("[minify] failed for", path, e);
        }
        return collapseWhitespace(src);
      };

      let totalSavedChars = 0;
      for (const path of allPaths) {
        const lower = path.toLowerCase();
        const ext = lower.split(".").pop() ?? "";
        const baseName = lower.split("/").pop() ?? "";
        const isWhitelisted =
          CODE_EXT.has(ext) ||
          baseName === "makefile" ||
          baseName === "dockerfile" ||
          baseName === ".gitignore";
        if (!isWhitelisted) continue;
        totalWhitelisted++;
        const data = unzipped[path];
        if (!data || data.length === 0) continue;
        // Decodifica como UTF-8. Si el archivo es binario raro, ignoramos.
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: false }).decode(data);
        } catch {
          continue;
        }
        // Modo ZIP único scaffolding: sin minify ni truncado per-file.
        // Solo conservamos el cap global MAX_CHARS para no exceder el
        // context window del modelo.
        if (!noMinify) {
          const rawLen = text.length;
          text = minify(path, ext, text);
          totalSavedChars += Math.max(0, rawLen - text.length);
          // Skip muy grandes individuales para no bloquear todo
          if (text.length > 50_000) {
            text = text.slice(0, 50_000) + "\n…[truncado]…";
            perFileTruncated++;
          }
        }
        if (totalChars + text.length > MAX_CHARS) {
          totalLimitReached = true;
          break;
        }
        totalChars += text.length;
        codeFiles.push({ path, content: text });
      }
      // Log de ahorro — útil para auditar el impacto de la minificación
      // en el costo de tokens. CloudWatch / Supabase logs lo muestran.
      if (totalSavedChars > 0) {
        console.log(
          `[zip-grading] minified saved ${totalSavedChars} chars (${codeFiles.length} files, ${totalChars} chars total)`,
        );
      }
      const wasTruncated = totalLimitReached || perFileTruncated > 0;

      if (codeFiles.length === 0) {
        return new Response(
          JSON.stringify({
            ok: true,
            grade: 0,
            feedback:
              "No se reconocieron archivos de código en la entrega. Verifica que estés subiendo archivos fuente (.java, .py, .js, etc).",
            ai_likelihood: 0,
            ai_detected: false,
            ai_reasons: "",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const customSystem = await buildGradingSystemPrompt(
        codeZipUseCase,
        courseId,
        "Eres un evaluador académico imparcial y experto. Calificas un entregable académico basándote en sus archivos. Das nota, retroalimentación detallada y una estimación de probabilidad (0..1) de que el contenido fue generado por IA, con razones claras.",
      );
      const systemPrompt = `${customSystem}\n\nPuntaje máximo permitido: ${maxPoints}.\nREGLA DE IDIOMA: responde siempre en ${pfLangName}.`;

      const fileSection = codeFiles.map((f) => `─── ${f.path} ───\n${f.content}\n`).join("\n");
      const projectCtx =
        projectDescription && String(projectDescription).trim()
          ? `Contexto global del proyecto (úsalo para entender el alcance y propósito):\n${String(projectDescription).trim()}\n\n`
          : "";

      const aiRes = await aiChatCompletion({
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: `${projectCtx}Pregunta del proyecto: ${fileTitle}
Descripción: ${fileDescription ?? "(sin descripción)"}
Rúbrica esperada: ${expectedRubric ?? "Evalúa diseño, corrección y completitud del código."}
Puntaje máximo: ${maxPoints}

Código fuente entregado (${codeFiles.length} archivo(s)):

${fileSection}

Idioma de salida obligatorio: ${pfLangName}.`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "score_code_zip",
              description: "Calificar el código fuente entregado en un ZIP",
              parameters: {
                type: "object",
                properties: {
                  score: { type: "number" },
                  feedback: { type: "string" },
                  ai_likelihood: { type: "number" },
                  ai_reasons: { type: "string" },
                },
                required: ["score", "feedback", "ai_likelihood", "ai_reasons"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "score_code_zip" } },
      });

      if (aiRes.status === 429) {
        return new Response(
          JSON.stringify({ error: "Límite de uso de IA. Intenta en un momento." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (aiRes.status === 402) {
        return new Response(
          JSON.stringify({ error: "Sin créditos de IA. Agrega créditos al workspace." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (!aiRes.ok) {
        const errText = await aiRes.text();
        console.error("AI error", aiRes.status, errText);
        throw new Error(await describeAiError(aiRes, cachedModel?.provider ?? "gemini", errText));
      }

      const aiJson = await aiRes.json();
      const tc = aiJson.choices?.[0]?.message?.tool_calls?.[0];
      const args = tc
        ? JSON.parse(tc.function.arguments)
        : { score: 0, feedback: "", ai_likelihood: 0, ai_reasons: "" };
      const score = Math.max(0, Math.min(Number(maxPoints) || 0, Number(args.score) || 0));
      const aiLikelihood = Math.max(0, Math.min(1, Number(args.ai_likelihood) || 0));

      return new Response(
        JSON.stringify({
          ok: true,
          grade: score,
          feedback: args.feedback,
          ai_likelihood: aiLikelihood,
          ai_detected: aiLikelihood >= 0.6,
          ai_reasons: args.ai_reasons ?? "",
          files_evaluated: codeFiles.length,
          // Flags de truncado para que el cliente persista en
          // project_submission_files y muestre badge al docente.
          zip_truncated: wasTruncated,
          zip_chars_used: totalChars,
          zip_files_total: totalWhitelisted,
          zip_files_per_file_truncated: perFileTruncated,
          zip_total_limit_reached: totalLimitReached,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ── Workshop QUESTION grading (per-question, supports diagrama/codigo) ──
    if (body.workshopQuestionGrading) {
      const {
        questionType,
        questionContent,
        expectedRubric,
        maxPoints = 1,
        studentAnswer,
        language,
        courseLanguage,
        courseId,
        // Contexto opcional del proyecto: cuando este modo se reusa
        // desde el StudentProjectTaker para preguntas no-ZIP del
        // proyecto (abierta/cerrada/diagrama), inyectamos
        // projects.description para que la IA evalúe con el alcance
        // global y no como una pregunta aislada.
        projectDescription,
      } = body;
      if (!studentAnswer || !questionType) {
        throw new Error("questionType y studentAnswer requeridos");
      }
      const wqLang: "es" | "en" = courseLanguage === "en" ? "en" : "es";
      const wqLangName = wqLang === "en" ? "inglés (English)" : "español";

      let extraInstructions = "";
      if (questionType === "diagrama") {
        extraInstructions = `La respuesta del estudiante es código en sintaxis Mermaid. Evalúa: (1) que la sintaxis sea válida y parseable por Mermaid, (2) que represente correctamente el escenario solicitado, (3) que use los nodos/relaciones adecuados según la rúbrica. Penaliza errores de sintaxis y representaciones incorrectas.`;
      } else if (questionType === "codigo") {
        extraInstructions = `La respuesta es código en ${language ?? "el lenguaje solicitado"}. Evalúa corrección, lógica, manejo de casos borde y claridad. Si el código no compila o tiene errores graves, penaliza.`;
      } else if (questionType === "cerrada") {
        extraInstructions = `La respuesta es la opción seleccionada. Compara contra la opción correcta indicada en la rúbrica.`;
      }

      const customSystem = await buildGradingSystemPrompt(
        "workshop_question",
        courseId,
        "Eres un evaluador académico imparcial. Calificas la respuesta de un estudiante a UNA pregunta de taller. Das un puntaje, retroalimentación útil y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA.",
      );
      const systemPrompt = `${customSystem}\n\nPuntaje máximo permitido: ${maxPoints}.\nREGLA DE IDIOMA: responde siempre en ${wqLangName}.\n${extraInstructions}`;
      const projectCtx =
        projectDescription && String(projectDescription).trim()
          ? `Contexto global del proyecto (úsalo para entender el alcance y propósito):\n${String(projectDescription).trim()}\n\n`
          : "";

      const aiRes = await aiChatCompletion({
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: `${projectCtx}Tipo de pregunta: ${questionType}\n\nEnunciado: ${questionContent ?? ""}\n\nRúbrica esperada: ${expectedRubric ?? "Evalúa corrección y completitud."}\n\nPuntaje máximo: ${maxPoints}\n\nRespuesta del estudiante:\n${studentAnswer}\n\nIdioma de salida obligatorio: ${wqLangName}.`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "score_question",
              description:
                "Calificar respuesta a pregunta de taller y estimar si fue generada por IA",
              parameters: {
                type: "object",
                properties: {
                  score: { type: "number" },
                  feedback: { type: "string" },
                  ai_likelihood: {
                    type: "number",
                    description: "Probabilidad 0..1 de que la respuesta haya sido generada por IA",
                  },
                  ai_reasons: { type: "string" },
                },
                required: ["score", "feedback", "ai_likelihood", "ai_reasons"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "score_question" } },
      });

      if (aiRes.status === 429) {
        return new Response(
          JSON.stringify({ error: "Límite de uso de IA. Intenta en un momento." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (aiRes.status === 402) {
        return new Response(
          JSON.stringify({ error: "Sin créditos de IA. Agrega créditos al workspace." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (!aiRes.ok) {
        const errText = await aiRes.text();
        console.error("AI error", aiRes.status, errText);
        throw new Error(await describeAiError(aiRes, cachedModel?.provider ?? "gemini", errText));
      }

      const aiJson = await aiRes.json();
      const tc = aiJson.choices?.[0]?.message?.tool_calls?.[0];
      const args = tc
        ? JSON.parse(tc.function.arguments)
        : { score: 0, feedback: "Sin retroalimentación", ai_likelihood: 0, ai_reasons: "" };
      const score = Math.max(0, Math.min(Number(maxPoints), Number(args.score) || 0));
      const aiLikelihood = Math.max(0, Math.min(1, Number(args.ai_likelihood) || 0));

      return new Response(
        JSON.stringify({
          ok: true,
          grade: score,
          feedback: args.feedback,
          ai_likelihood: aiLikelihood,
          ai_detected: aiLikelihood >= 0.6,
          ai_reasons: args.ai_reasons ?? "",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── PROJECT grading mode (ZIP) ──
    if (body.projectGrading) {
      const { submissionId, courseLanguage } = body;
      if (!submissionId) throw new Error("submissionId requerido");
      const lang: "es" | "en" =
        courseLanguage === "en" || courseLanguage === "es" ? courseLanguage : "es";
      const langName = lang === "en" ? "inglés (English)" : "español";

      const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { data: psub, error: psErr } = await admin
        .from("project_submissions")
        .select("*, project:projects(*)")
        .eq("id", submissionId)
        .single();
      if (psErr || !psub) throw new Error("Entrega de proyecto no encontrada");
      const project = (psub as any).project;
      if (!psub.zip_url) throw new Error("La entrega no tiene archivo ZIP");

      // Descarga el ZIP
      const dl = await admin.storage.from("workshop-files").download(psub.zip_url);
      if (dl.error || !dl.data) throw new Error("No se pudo descargar el ZIP");
      const zipBuf = new Uint8Array(await dl.data.arrayBuffer());

      // Descomprime con fflate
      const fflate = await import("npm:fflate@0.8.2");
      const unzipped = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
        fflate.unzip(zipBuf, (err, files) => (err ? reject(err) : resolve(files)));
      });

      const TEXT_EXT = new Set([
        "py",
        "js",
        "ts",
        "tsx",
        "jsx",
        "java",
        "c",
        "h",
        "cpp",
        "hpp",
        "cs",
        "go",
        "rb",
        "php",
        "html",
        "css",
        "scss",
        "md",
        "txt",
        "json",
        "yaml",
        "yml",
        "xml",
        "sql",
        "mmd",
        "puml",
        "kt",
        "swift",
        "rs",
        "sh",
      ]);
      const MAX_FILE_BYTES = 50_000;
      const MAX_TOTAL_BYTES = 250_000;
      const MAX_FILES_INCLUDED = 30;

      const decoder = new TextDecoder("utf-8", { fatal: false });
      const filesIncluded: { path: string; content: string }[] = [];
      const filesSkipped: string[] = [];
      let totalBytes = 0;
      const allPaths = Object.keys(unzipped).filter((p) => !p.endsWith("/"));
      for (const path of allPaths) {
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        const data = unzipped[path];
        if (!TEXT_EXT.has(ext)) {
          filesSkipped.push(path + " (binario)");
          continue;
        }
        if (data.byteLength > MAX_FILE_BYTES) {
          filesSkipped.push(path + " (>50KB)");
          continue;
        }
        if (totalBytes + data.byteLength > MAX_TOTAL_BYTES) {
          filesSkipped.push(path + " (límite total)");
          continue;
        }
        if (filesIncluded.length >= MAX_FILES_INCLUDED) {
          filesSkipped.push(path + " (límite de archivos)");
          continue;
        }
        try {
          filesIncluded.push({ path, content: decoder.decode(data) });
          totalBytes += data.byteLength;
        } catch {
          filesSkipped.push(path + " (no decodificable)");
        }
      }

      const filesContext = filesIncluded
        .map((f) => `--- archivo: ${f.path} ---\n${f.content}`)
        .join("\n\n");

      const customSystemFull = await buildGradingSystemPrompt(
        "project_full",
        project.course_id,
        "Eres un evaluador académico imparcial y experto. Calificas un proyecto académico basándote en sus archivos. Das nota, retroalimentación detallada y una estimación de probabilidad (0..1) de que el contenido fue generado por IA, con razones claras.",
      );
      const projectSystemPrompt = `${customSystemFull}\n\nTipo de proyecto: ${project.project_type}.\nPuntaje máximo permitido: ${project.max_score}.\nREGLA DE IDIOMA: responde siempre en ${langName}.`;

      const aiRes = await aiChatCompletion({
        messages: [
          {
            role: "system",
            content: projectSystemPrompt,
          },
          {
            role: "user",
            content: `Título: ${project.title}
Tipo: ${project.project_type}
Instrucciones del proyecto:
${project.instructions ?? project.description ?? "Sin instrucciones."}

Puntaje máximo: ${project.max_score}
Total de archivos en el ZIP: ${allPaths.length}
Archivos incluidos para revisión (${filesIncluded.length}):
${filesIncluded.map((f) => f.path).join(", ") || "(ninguno)"}
${filesSkipped.length ? `Archivos omitidos: ${filesSkipped.slice(0, 20).join(", ")}` : ""}

Contenido de los archivos:
${filesContext || "(sin contenido legible)"}

Idioma de salida: ${langName}.`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "score_project",
              description:
                "Calificar el proyecto y estimar probabilidad de que fue generado por IA",
              parameters: {
                type: "object",
                properties: {
                  score: { type: "number" },
                  feedback: { type: "string" },
                  ai_likelihood: { type: "number" },
                  ai_reasons: { type: "string" },
                },
                required: ["score", "feedback", "ai_likelihood", "ai_reasons"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "score_project" } },
      });

      if (aiRes.status === 429) {
        return new Response(JSON.stringify({ error: "Límite de uso de IA." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiRes.status === 402) {
        return new Response(JSON.stringify({ error: "Sin créditos de IA." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!aiRes.ok) {
        const errText = await aiRes.text();
        console.error("AI error", aiRes.status, errText);
        throw new Error(await describeAiError(aiRes, cachedModel?.provider ?? "gemini", errText));
      }

      const aiJson = await aiRes.json();
      const tc = aiJson.choices?.[0]?.message?.tool_calls?.[0];
      const args = tc
        ? JSON.parse(tc.function.arguments)
        : { score: 0, feedback: "Sin retroalimentación", ai_likelihood: 0, ai_reasons: "" };
      const score = Math.max(0, Math.min(Number(project.max_score), Number(args.score) || 0));
      const aiLikelihood = Math.max(0, Math.min(1, Number(args.ai_likelihood) || 0));
      const aiDetected = aiLikelihood >= 0.6;

      const newStatus = aiDetected ? "requiere_revision" : "ai_revisado";
      await admin
        .from("project_submissions")
        .update({
          ai_grade: score,
          ai_feedback: args.feedback,
          ai_detected: aiDetected,
          ai_detected_score: aiLikelihood,
          ai_detected_reasons: args.ai_reasons ?? "",
          status: newStatus,
        })
        .eq("id", submissionId);

      return new Response(
        JSON.stringify({
          ok: true,
          grade: score,
          feedback: args.feedback,
          ai_likelihood: aiLikelihood,
          ai_detected: aiDetected,
          ai_reasons: args.ai_reasons ?? "",
          files_included: filesIncluded.length,
          files_skipped: filesSkipped.length,
          status: newStatus,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Exam grading mode (original) ──
    const { submissionId, questionId, dryRun } = body as {
      submissionId?: string;
      questionId?: string | null;
      dryRun?: boolean;
    };
    if (!submissionId) throw new Error("submissionId requerido");
    if (typeof submissionId !== "string" || !UUID_RE.test(submissionId)) {
      throw new Error("submissionId inválido");
    }
    if (questionId != null && (typeof questionId !== "string" || !UUID_RE.test(questionId))) {
      throw new Error("questionId inválido");
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: sub, error: sErr } = await admin
      .from("submissions")
      .select("*")
      .eq("id", submissionId)
      .single();
    if (sErr || !sub) throw new Error("Submission no encontrada");

    // Authz: dueño de la entrega (el alumno al entregar), worker/cron, O alguien
    // que PUEDE VER la entrega por RLS (docente del curso / admin del tenant / SA).
    // Antes se usaba `callerIsTeacherOrAdmin` GLOBAL → un docente/admin de OTRO
    // tenant podía disparar grading de una entrega ajena (costo IA + escritura
    // cross-tenant; la lectura del resultado ya la bloquea la RLS). Ahora la
    // autorización del staff se delega a la RLS de `submissions` (paridad exacta
    // con quién puede leerla): si el caller no puede SELECT-earla con su propio
    // JWT, no está autorizado. Mismo patrón que el gate de generate-contents.
    if (!isSystemTrigger && sub.user_id !== callerId) {
      const authHeader = req.headers.get("Authorization");
      const rlsClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!,
        { global: { headers: { Authorization: authHeader ?? "" } } },
      );
      const { data: visibleSub } = await rlsClient
        .from("submissions")
        .select("id")
        .eq("id", submissionId)
        .maybeSingle();
      if (!visibleSub) {
        return new Response(JSON.stringify({ error: "No tienes permiso sobre esta entrega" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { data: questions, error: qErr } = await admin
      .from("questions")
      .select("*")
      .eq("exam_id", sub.exam_id)
      .order("position");
    if (qErr) throw qErr;

    // Look up the course language via the exam → courses join. Defaults to
    // Spanish for legacy exams without a configured language.
    const { data: examMeta } = await admin
      .from("exams")
      .select("course:courses(language, grade_scale_max)")
      .eq("id", sub.exam_id)
      .maybeSingle();
    const examLang: "es" | "en" = (examMeta as any)?.course?.language === "en" ? "en" : "es";
    const examLangName = examLang === "en" ? "inglés (English)" : "español";
    const gradeScaleMax = Number((examMeta as any)?.course?.grade_scale_max ?? 5) || 5;
    // Resolvemos el system prompt una sola vez por exam (todas las
    // preguntas de este examen comparten persona/criterios). Pasamos
    // sub.exam_id → courses join arriba ya nos dio el course; tomamos
    // el course_id del examen para buscar override.
    const { data: examCourse } = await admin
      .from("exams")
      .select("course_id")
      .eq("id", sub.exam_id)
      .maybeSingle();
    const examCourseId = (examCourse as any)?.course_id ?? null;
    const customExamSystem = await buildGradingSystemPrompt(
      "exam_question",
      examCourseId,
      "Eres un evaluador imparcial de exámenes académicos. Por cada respuesta del estudiante calificas según la rúbrica con un score 0..max_points y una justificación breve, y además estimas la probabilidad (0..1) de que la respuesta haya sido generada por IA, con razones concretas.",
    );

    // Factor de velocidad: si el estudiante terminó el examen mucho más
    // rápido que el tiempo asignado, eso es señal adicional de IA. Se
    // calcula a nivel de submission (no por pregunta — no tenemos
    // timestamps por pregunta) y se aplica como un boost al likelihood
    // máximo al final.
    const startedAt = sub.started_at ? new Date(sub.started_at).getTime() : null;
    const submittedAt = sub.submitted_at ? new Date(sub.submitted_at).getTime() : Date.now();
    let actualSec = 0;
    if (startedAt) actualSec = Math.max(0, Math.floor((submittedAt - startedAt) / 1000));
    // El time_limit_minutes vive en exams (NO en courses), así que lo cargamos
    // explícitamente. (Antes había un fallback a `course.time_limit_minutes` que
    // nunca se seleccionaba en el join → siempre 0 → código muerto; removido.)
    const { data: examTimeRow } = await admin
      .from("exams")
      .select("time_limit_minutes")
      .eq("id", sub.exam_id)
      .maybeSingle();
    const expectedSec = Number((examTimeRow as any)?.time_limit_minutes ?? 0) * 60 || 0;

    const answers: Record<string, any> = sub.answers || {};
    const prevBreakdown: any[] = Array.isArray(answers.__breakdown) ? answers.__breakdown : [];
    const prevById = new Map(prevBreakdown.map((b: any) => [b.qid, b]));
    let totalPoints = 0;
    let earned = 0;
    const breakdown: any[] = [];
    // Agregamos señales de IA por pregunta y consolidamos a nivel de
    // submission. ai_detected_score = MAX de las likelihoods (peor caso),
    // y ai_detected_reasons concatena las razones de las preguntas más
    // sospechosas (top 3). Si solo se recalifica una pregunta puntual
    // arrancamos del valor previo guardado para no degradar la señal.
    let maxAiLikelihood = Number(sub.ai_detected_score) || 0;
    const aiReasonBuckets: { qid: string; likelihood: number; reason: string }[] = [];

    // Bucket de preguntas abiertas que necesitan IA — se calificará en
    // UNA sola llamada al final del loop (gradeOpenAnswersInBatch).
    // Antes hacíamos N requests (uno por pregunta abierta), ahora 1
    // por estudiante. Ganancia: latencia ~Nx menor, menos rate limits,
    // menos tokens de overhead repetidos.
    const aiBatch: Array<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q: any;
      userAnswer: string;
    }> = [];

    for (const q of questions || []) {
      // If only one question is requested, skip the rest but preserve prior scores
      if (questionId && q.id !== questionId) {
        const prev = prevById.get(q.id);
        totalPoints += Number(q.points);
        if (prev) {
          earned += Number(prev.earned) || 0;
          breakdown.push(prev);
          if (typeof prev.ai_likelihood === "number") {
            aiReasonBuckets.push({
              qid: q.id,
              likelihood: prev.ai_likelihood,
              reason: prev.ai_reasons ?? "",
            });
            if (prev.ai_likelihood > maxAiLikelihood) maxAiLikelihood = prev.ai_likelihood;
          }
        } else {
          breakdown.push({ qid: q.id, type: q.type, points: q.points, earned: 0 });
        }
        continue;
      }
      totalPoints += Number(q.points);
      const userAnswer = answers[q.id];

      if (q.type === "cerrada") {
        const correctIdx = q.options?.correct_index;
        // GUARD (fix auditoría): exigir que AMBOS sean number finito. Sin esto,
        // una `cerrada` con correct_index ausente + sin responder daba
        // `undefined === undefined` → puntaje completo por una pregunta en
        // blanco. MIRROR de scoreCerradaSingle en
        // src/modules/exams/question-scoring.ts.
        const pts = Math.max(0, Number(q.points) || 0);
        const got =
          typeof correctIdx === "number" &&
          Number.isFinite(correctIdx) &&
          typeof userAnswer === "number" &&
          Number.isFinite(userAnswer) &&
          userAnswer === correctIdx
            ? pts
            : 0;
        earned += got;
        breakdown.push({ qid: q.id, type: q.type, points: q.points, earned: got });
      } else if (q.type === "cerrada_multi") {
        // Opción múltiple: proporcional positivo SIN penalización.
        // earned = (correctas_marcadas / total_correctas) * puntos.
        // Sincronizado con src/utils/question-scoring.ts → scoreCerradaMulti.
        const correctIndices: number[] = Array.isArray(q.options?.correct_indices)
          ? q.options.correct_indices.filter((n: unknown) => typeof n === "number")
          : [];
        const selectedRaw: number[] = Array.isArray(userAnswer)
          ? userAnswer.filter((n: unknown) => typeof n === "number")
          : [];
        const selected = Array.from(new Set(selectedRaw));
        const correctSet = new Set(correctIndices);
        const minSel = typeof q.options?.min_selections === "number" ? q.options.min_selections : 0;
        const maxSel =
          typeof q.options?.max_selections === "number" ? q.options.max_selections : Infinity;

        let got = 0;
        const totalCorrect = correctSet.size;
        const totalPoints = Number(q.points);
        if (
          selected.length > 0 &&
          selected.length >= minSel &&
          selected.length <= maxSel &&
          totalCorrect > 0 &&
          totalPoints > 0
        ) {
          let matched = 0;
          for (const s of selected) {
            if (correctSet.has(s)) matched++;
          }
          got = Number(((matched / totalCorrect) * totalPoints).toFixed(2));
        }
        earned += got;
        breakdown.push({ qid: q.id, type: q.type, points: q.points, earned: got });
      } else if (q.type === "red_consola") {
        // Calificación DETERMINISTA server-side (mismo motor puro que el
        // cliente): parsea la topología final del alumno + su historial y
        // evalúa las aserciones del escenario (q.options.network). Sin IA.
        const scenario = parseScenario(q.options);
        const answer = parseNetworkAnswer(userAnswer);
        const pts = Math.max(0, Number(q.points) || 0);
        if (!scenario || !answer) {
          breakdown.push({
            qid: q.id,
            type: q.type,
            points: q.points,
            earned: 0,
            feedback: "Sin respuesta",
          });
        } else {
          const result = gradeNetwork(
            { topology: answer.topology, histories: answer.histories },
            scenario.assertions,
          );
          const got = Math.round(result.ratio * pts * 100) / 100;
          const fb = result.items
            .map((it) => `${it.passed ? "✓" : "✗"} ${it.label}${it.detail ? ` — ${it.detail}` : ""}`)
            .join("\n");
          earned += got;
          breakdown.push({ qid: q.id, type: q.type, points: q.points, earned: got, feedback: fb });
        }
      } else {
        // Sin respuesta — dos casos cuentan como "vacía":
        //   1. null/undefined o string solo con whitespace.
        //   2. Texto idéntico al starter_code de la pregunta (el alumno
        //      abrió la pregunta de código y no escribió nada propio).
        //      Sin este check la IA gasta tokens evaluando el template
        //      que escribió el propio docente.
        const trimmedAnswer = typeof userAnswer === "string" ? userAnswer.trim() : "";
        const trimmedStarter = typeof q.starter_code === "string" ? q.starter_code.trim() : "";
        const isEmpty =
          !userAnswer ||
          trimmedAnswer === "" ||
          (trimmedStarter !== "" && trimmedAnswer === trimmedStarter);
        if (isEmpty) {
          breakdown.push({
            qid: q.id,
            type: q.type,
            points: q.points,
            earned: 0,
            feedback: "Sin respuesta",
          });
          continue;
        }
        // Bucketea la pregunta — se califica en bloque después del loop.
        aiBatch.push({
          q,
          userAnswer: typeof userAnswer === "string" ? userAnswer : JSON.stringify(userAnswer),
        });
      }
    }

    // ── Llamada UNICA a IA para todas las preguntas abiertas del estudiante ──
    // Antes hacíamos una llamada por pregunta abierta. Ahora una sola con todas
    // las preguntas, distribuyendo los scores por qid al volver. Si la llamada
    // falla en bloque, marcamos cada pregunta del batch con el mismo error.
    if (aiBatch.length > 0) {
      const batchInput: BatchItem[] = aiBatch.map(({ q, userAnswer }) => {
        // q.options puede contener `java_framework` para preguntas
        // tipo java_gui. Lo extraemos para que la IA sepa si el
        // código es Swing o JavaFX (cambia la rúbrica esperada).
        // python_gui no tiene framework alternativo (solo tkinter).
        const optsAny = q.options as { java_framework?: string } | null | undefined;
        const fw = optsAny?.java_framework;
        // language implícito según tipo: java_gui → java, python_gui → python.
        // Para tipos no-GUI usamos el campo q.language (si fue declarado).
        const impliedLanguage =
          q.type === "java_gui"
            ? "java"
            : q.type === "python_gui"
              ? "python"
              : (q.language ?? undefined);
        return {
          qid: q.id,
          content: String(q.content ?? ""),
          rubric: String(q.expected_rubric ?? ""),
          userAnswer,
          maxPoints: Number(q.points),
          type: q.type,
          language: impliedLanguage,
          framework: q.type === "java_gui" ? (fw ?? "swing") : undefined,
        };
      });
      const batchOut = await gradeOpenAnswersInBatch(batchInput, customExamSystem, examLangName);

      if ("batchError" in batchOut) {
        // Falla del batch entero — distribuimos el mismo error a todas las
        // preguntas. Un solo audit log con el response completo (1 vez,
        // no N veces) para no inundar Auditoría.
        const err = batchOut.batchError;
        const feedback =
          err.kind === "http"
            ? `Error IA (HTTP ${err.http_status}). Revisa audit logs para el detalle.`
            : err.kind === "no_tool_call"
              ? "El modelo no devolvió la calificación en el formato esperado (sin tool_call). Revisa audit logs."
              : "El modelo devolvió un JSON inválido al calificar. Revisa audit logs.";
        for (const { q } of aiBatch) {
          breakdown.push({
            qid: q.id,
            type: q.type,
            points: q.points,
            earned: 0,
            feedback,
            ai_error: err,
          });
        }
        void auditFromEdge(adminClient, {
          actorId: auditCallerId,
          action: "ai.grading_failed",
          category: "grading",
          severity: "error",
          entityType: "submission",
          entityId: submissionId,
          metadata: {
            scope: "batch",
            batch_size: aiBatch.length,
            kind: err.kind,
            http_status: err.http_status ?? null,
            response_snippet: err.response_snippet,
            finish_reason: err.finish_reason ?? null,
            model: auditModel,
            provider: (await getActiveAiModel()).provider,
          },
        });
      } else {
        // Batch OK — distribuimos los resultados por qid. Las preguntas
        // que el modelo OMITIO (no devolvió score para su qid) se marcan
        // como missing_in_batch.
        for (const { q } of aiBatch) {
          const r = batchOut.results.get(q.id);
          if (!r) {
            breakdown.push({
              qid: q.id,
              type: q.type,
              points: q.points,
              earned: 0,
              feedback:
                "El modelo no incluyó esta pregunta en su respuesta. Recalifica individualmente para reintentar.",
              ai_error: { kind: "missing_in_batch" },
            });
            void auditFromEdge(adminClient, {
              actorId: auditCallerId,
              action: "ai.grading_failed",
              category: "grading",
              severity: "warning",
              entityType: "submission",
              entityId: submissionId,
              metadata: {
                questionId: q.id,
                questionType: q.type,
                reason: "missing_in_batch",
                model: auditModel,
              },
            });
            continue;
          }
          const score = Math.max(0, Math.min(Number(q.points), Number(r.score) || 0));
          earned += score;
          breakdown.push({
            qid: q.id,
            type: q.type,
            points: q.points,
            earned: score,
            feedback: r.feedback,
            ai_likelihood: r.ai_likelihood,
            ai_reasons: r.ai_reasons,
          });
          aiReasonBuckets.push({
            qid: q.id,
            likelihood: r.ai_likelihood,
            reason: r.ai_reasons,
          });
          if (r.ai_likelihood > maxAiLikelihood) maxAiLikelihood = r.ai_likelihood;
        }
      }
    }

    const grade = totalPoints > 0 ? Number(((earned / totalPoints) * gradeScaleMax).toFixed(2)) : 0;

    // Factor de velocidad: ratio actual/esperado. Cuanto menor el ratio
    // (entrega muy rápida), mayor la sospecha. Boost máximo: +0.20.
    //   ratio >= 0.5 → boost 0
    //   ratio  = 0.3 → boost ~0.08
    //   ratio  = 0.15 → boost ~0.14
    //   ratio  = 0   → boost 0.20
    // Solo aplica si tenemos los dos timestamps y al menos una pregunta
    // abierta evaluada (preguntas cerradas se contestan rápido sin que
    // sea sospechoso).
    let speedBoost = 0;
    let speedNote = "";
    const openQuestionCount = aiReasonBuckets.length;
    if (expectedSec > 0 && actualSec > 0 && openQuestionCount > 0) {
      const ratio = actualSec / expectedSec;
      if (ratio < 0.5) {
        speedBoost = Math.min(0.2, 0.4 * (0.5 - ratio));
        const minutes = Math.round(actualSec / 60);
        const expectedMin = Math.round(expectedSec / 60);
        const pct = Math.round(ratio * 100);
        speedNote = `Velocidad sospechosa: terminó en ${minutes} min de ${expectedMin} min asignados (${pct}% del tiempo).`;
      }
    }
    const finalAiLikelihood = Math.min(1, maxAiLikelihood + speedBoost);

    // Top 3 razones por likelihood. Si todas las preguntas son cerradas,
    // el bucket queda vacío y los campos ai_* quedan en sus valores por
    // defecto (false / null) — esa también es info útil para el docente.
    const topReasons = aiReasonBuckets
      .filter((b) => b.reason && b.likelihood > 0)
      .sort((a, b) => b.likelihood - a.likelihood)
      .slice(0, 3)
      .map((b) => `[${b.likelihood.toFixed(2)}] ${b.reason}`)
      .join("\n");
    const reasonsWithSpeed = speedNote ? `${speedNote}\n${topReasons}`.trim() : topReasons;
    const aiDetected = finalAiLikelihood >= 0.6;
    // Si el docente ya marcó la sospecha IA como REVISADA (ai_review_at
    // IS NOT NULL), no volvemos a flagear ni a cambiar el estado por
    // IA — su decisión queda congelada hasta que él la desmarque.
    // Solo respeta "sospechoso" forzado por proctoring si NO hay review.
    const aiAlreadyReviewed = (sub as { ai_review_at?: string | null }).ai_review_at != null;
    const newStatus = aiAlreadyReviewed
      ? sub.status // congelado: no tocar
      : sub.status === "sospechoso" || aiDetected
        ? "sospechoso"
        : "completado";

    // dryRun: el cliente pidió un preview — corremos toda la calificación
    // pero NO escribimos al DB. El cliente decide si aplicar o descartar.
    // En modo aplicar, el cliente persiste con un UPDATE directo (no
    // requiere segunda llamada a IA), así no se gastan créditos doble.
    if (!dryRun) {
      await admin
        .from("submissions")
        .update({
          ai_grade: grade,
          // Si la sospecha IA ya fue revisada, no la re-marcamos: dejamos
          // ai_detected en false aunque la likelihood haya subido.
          ai_detected: aiAlreadyReviewed ? false : aiDetected,
          ai_detected_score: finalAiLikelihood,
          ai_detected_reasons: reasonsWithSpeed || null,
          status: newStatus,
          submitted_at: sub.submitted_at ?? new Date().toISOString(),
          answers: { ...answers, __breakdown: breakdown },
        })
        .eq("id", submissionId);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        dryRun: !!dryRun,
        // Flag para el ai-grading-worker. Cuando no es dryRun, este edge
        // YA escribió submissions.answers + ai_grade + ai_detected_* via
        // el UPDATE de arriba (líneas 2114-2128). El worker debe NO
        // hacer un segundo UPDATE — solo marca el job como done. En
        // dryRun no escribe, así que el flag queda false y el caller
        // sync usa los campos `proposed_update` para persistir él.
        persistedInternally: !dryRun,
        grade,
        breakdown,
        ai_detected: aiAlreadyReviewed ? false : aiDetected,
        ai_likelihood: finalAiLikelihood,
        ai_reasons: reasonsWithSpeed,
        speed_boost: speedBoost,
        // Snapshot completo del payload que se aplicaría si el cliente
        // decide aceptar. Permite que el cliente haga un UPDATE directo
        // sin re-invocar al edge.
        proposed_update: {
          ai_grade: grade,
          ai_detected: aiAlreadyReviewed ? false : aiDetected,
          ai_detected_score: finalAiLikelihood,
          ai_detected_reasons: reasonsWithSpeed || null,
          status: newStatus,
          submitted_at: sub.submitted_at ?? new Date().toISOString(),
          answers: { ...answers, __breakdown: breakdown },
        },
        // Snapshot del estado actual (antes del recálculo) para que la
        // UI muestre OLD vs NEW sin tener que pedirlo aparte.
        previous: {
          ai_grade: sub.ai_grade ?? null,
          final_override_grade:
            (sub as { final_override_grade?: number | null }).final_override_grade ?? null,
          status: sub.status,
          ai_detected: (sub as { ai_detected?: boolean | null }).ai_detected ?? null,
          ai_detected_score:
            (sub as { ai_detected_score?: number | null }).ai_detected_score ?? null,
          breakdown: (answers as { __breakdown?: unknown }).__breakdown ?? null,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error(e);
    // Auditoría del fallo. Modo + entity_id quedaron capturados arriba
    // antes de que tirara la excepción, así sabemos qué se intentaba
    // calificar cuando todo explotó.
    void auditFromEdge(adminClient, {
      actorId: auditCallerId,
      action: "ai.grading_failed",
      category: "grading",
      severity: "error",
      entityType: "submission",
      entityId: auditEntityId,
      metadata: {
        mode: auditMode,
        model: auditModel,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
