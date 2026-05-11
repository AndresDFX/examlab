// AI grading: scores exam answers or workshop submissions via AI Gateway
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { auditFromEdge } from "../_shared/audit.ts";
import { enforceRateLimit } from "../_shared/rate-limit.ts";

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
// Cache del modelo activo por invocación. La edge function es stateless
// entre invocaciones, pero dentro de una sola invocación pueden hacerse
// múltiples llamadas (ej. exam con N preguntas) — evitamos N queries.
let cachedModel: { provider: "lovable" | "openai"; model: string } | null = null;

async function getActiveAiModel(): Promise<{ provider: "lovable" | "openai"; model: string }> {
  if (cachedModel) return cachedModel;
  try {
    const { data } = await adminClient
      .from("ai_model_settings")
      .select("provider, model")
      .eq("is_active", true)
      .maybeSingle();
    if (data && (data.provider === "lovable" || data.provider === "openai")) {
      cachedModel = { provider: data.provider, model: data.model };
      return cachedModel;
    }
  } catch (e) {
    console.warn("[ai_model_settings] resolve failed, using default:", e);
  }
  // Fallback al comportamiento previo si no hay config.
  cachedModel = { provider: "lovable", model: "google/gemini-2.5-flash" };
  return cachedModel;
}

/**
 * Wrapper único de chat completions. Internamente decide endpoint/auth/modelo
 * según la config activa en ai_model_settings.
 *
 * - lovable → ai.gateway.lovable.dev/v1/chat/completions + LOVABLE_API_KEY
 * - openai  → api.openai.com/v1/chat/completions + OPENAI_API_KEY
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
  let url: string;
  let key: string | undefined;
  if (m.provider === "openai") {
    url = "https://api.openai.com/v1/chat/completions";
    key = Deno.env.get("OPENAI_API_KEY");
    if (!key) {
      throw new Error(
        "OPENAI_API_KEY missing. Configure el secret en Lovable o cambie el provider a 'lovable' en /app/admin/ai.",
      );
    }
  } else {
    url = "https://ai.gateway.lovable.dev/v1/chat/completions";
    key = Deno.env.get("LOVABLE_API_KEY");
    if (!key) throw new Error("LOVABLE_API_KEY missing");
  }
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: m.model, ...body }),
  });
}

async function resolveSystemPrompt(
  useCase: string,
  courseId: string | null | undefined,
  fallback: string,
): Promise<string> {
  try {
    let q = adminClient
      .from("ai_prompts")
      .select("system_prompt, course_id")
      .eq("use_case", useCase);
    // Guard: courseId se interpola en el filtro string de .or(). Si no
    // es un UUID válido, ignoramos el override y caemos al global.
    const isUuid = (s: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    if (courseId && isUuid(courseId)) {
      q = q.or(`course_id.eq.${courseId},course_id.is.null`);
    } else {
      q = q.is("course_id", null);
    }
    const { data, error } = await q;
    if (error || !data || data.length === 0) return fallback;
    // Override del curso gana sobre global. Ordenamos en JS porque
    // PostgREST no permite ordenar nulls last directo en este esquema.
    const sorted = [...data].sort((a, b) => {
      if (a.course_id && !b.course_id) return -1;
      if (!a.course_id && b.course_id) return 1;
      return 0;
    });
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
  return `${grading}\n\n--- Detección de respuestas generadas por IA ---\n${aiDetection}`;
}

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

    const callerId = u.user.id;
    auditCallerId = callerId;
    const { data: callerRoles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", callerId);
    const callerIsTeacherOrAdmin = (callerRoles ?? []).some(
      (r: { role: string }) => r.role === "Admin" || r.role === "Docente",
    );

    const body = await req.json();
    auditMode = body.workshopGrading
      ? "workshop_full"
      : body.workshopQuestionGrading
        ? "workshop_question"
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
    // provider activo (LOVABLE_API_KEY o OPENAI_API_KEY).

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
        throw new Error("Error en gateway de IA");
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
        throw new Error("Error en gateway de IA");
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

    // ── Project CODE-ZIP grading ──
    // Body: { projectCodeZipGrading: true, zipPath, fileTitle, fileDescription,
    //         expectedRubric, maxPoints, courseLanguage, courseId }
    // Descarga el ZIP de Storage (bucket project-files), filtra archivos de
    // código por extensión, los concatena con encabezado por archivo y
    // manda todo a la IA para evaluación. Devuelve { ok, grade, feedback,
    // ai_likelihood, ai_reasons }.
    if (body.projectCodeZipGrading) {
      const {
        zipPath,
        fileTitle,
        fileDescription,
        expectedRubric,
        maxPoints = 1,
        courseLanguage,
        courseId,
        // Contexto global del proyecto (projects.description) — se
        // inyecta para que la IA califique este componente teniendo
        // claro el alcance del proyecto entero, no solo el slot.
        projectDescription,
      } = body;
      if (!zipPath || !fileTitle) {
        throw new Error("zipPath y fileTitle requeridos");
      }
      const pfLang: "es" | "en" = courseLanguage === "en" ? "en" : "es";
      const pfLangName = pfLang === "en" ? "inglés (English)" : "español";

      // Descarga el zip via admin client (RLS + service role).
      const { data: zipBlob, error: dlErr } = await adminClient.storage
        .from("project-files")
        .download(zipPath);
      if (dlErr || !zipBlob) {
        throw new Error(`No se pudo descargar el ZIP: ${dlErr?.message ?? "missing"}`);
      }
      const zipBuf = new Uint8Array(await zipBlob.arrayBuffer());

      // Descomprime
      const fflate = await import("https://esm.sh/fflate@0.8.2");
      const unzipped = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
        fflate.unzip(zipBuf, (err, files) => (err ? reject(err) : resolve(files)));
      });

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

      const allPaths = Object.keys(unzipped).filter((p) => !p.endsWith("/"));
      const codeFiles: { path: string; content: string }[] = [];
      let totalChars = 0;
      const MAX_CHARS = 200_000; // ~ tope para no exceder context window

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
        const data = unzipped[path];
        if (!data || data.length === 0) continue;
        // Decodifica como UTF-8. Si el archivo es binario raro, ignoramos.
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: false }).decode(data);
        } catch {
          continue;
        }
        // Skip muy grandes individuales para no bloquear todo
        if (text.length > 50_000) text = text.slice(0, 50_000) + "\n…[truncado]…";
        if (totalChars + text.length > MAX_CHARS) break;
        totalChars += text.length;
        codeFiles.push({ path, content: text });
      }

      if (codeFiles.length === 0) {
        return new Response(
          JSON.stringify({
            ok: true,
            grade: 0,
            feedback:
              "El ZIP no contiene archivos de código reconocidos. Verifica que estés subiendo archivos fuente (.java, .py, .js, etc).",
            ai_likelihood: 0,
            ai_detected: false,
            ai_reasons: "",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const customSystem = await buildGradingSystemPrompt(
        "project_full",
        courseId,
        "Eres un evaluador académico imparcial y experto. Calificas un proyecto académico basándote en sus archivos. Das nota, retroalimentación detallada y una estimación de probabilidad (0..1) de que el contenido fue generado por IA, con razones claras.",
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

Contenido del ZIP (${codeFiles.length} archivo(s) de código):

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
        throw new Error("Error en gateway de IA");
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
        throw new Error("Error en gateway de IA");
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
      const fflate = await import("https://esm.sh/fflate@0.8.2");
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
        throw new Error("Error en gateway de IA");
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
    const { submissionId, questionId } = body;
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

    // Authz: el caller debe ser el dueño de la submission (caso normal:
    // el alumno dispara grading al entregar) O docente/admin (recalificar
    // desde el monitor). Si no, 403.
    if (sub.user_id !== callerId && !callerIsTeacherOrAdmin) {
      return new Response(JSON.stringify({ error: "No tienes permiso sobre esta entrega" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
    const timeLimitSec = Number((examMeta as any)?.course?.time_limit_minutes ?? 0) || 0;
    let actualSec = 0;
    if (startedAt) actualSec = Math.max(0, Math.floor((submittedAt - startedAt) / 1000));
    // El time_limit_minutes vive en exams, no en course; lo cargamos
    // explícitamente para no acoplar el join.
    const { data: examTimeRow } = await admin
      .from("exams")
      .select("time_limit_minutes")
      .eq("id", sub.exam_id)
      .maybeSingle();
    const expectedSec = Number((examTimeRow as any)?.time_limit_minutes ?? timeLimitSec) * 60 || 0;

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
        const got = userAnswer === correctIdx ? Number(q.points) : 0;
        earned += got;
        breakdown.push({ qid: q.id, type: q.type, points: q.points, earned: got });
      } else {
        if (!userAnswer || (typeof userAnswer === "string" && !userAnswer.trim())) {
          breakdown.push({
            qid: q.id,
            type: q.type,
            points: q.points,
            earned: 0,
            feedback: "Sin respuesta",
          });
          continue;
        }
        const aiRes = await aiChatCompletion({
          messages: [
            {
              role: "system",
              content: `${customExamSystem}\n\nPuntaje máximo permitido: ${q.points}.\nREGLA DE IDIOMA: responde siempre en ${examLangName}.`,
            },
            {
              role: "user",
              content: `Pregunta: ${q.content}\n\nRúbrica esperada: ${q.expected_rubric}\n\nRespuesta del estudiante: ${userAnswer}\n\nPuntaje máximo: ${q.points}\n\nIdioma de salida obligatorio: ${examLangName}.`,
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "score_answer",
                description: "Calificar respuesta y estimar si fue generada por IA",
                parameters: {
                  type: "object",
                  properties: {
                    score: { type: "number" },
                    feedback: { type: "string" },
                    ai_likelihood: {
                      type: "number",
                      description:
                        "Probabilidad 0..1 de que la respuesta haya sido generada por IA",
                    },
                    ai_reasons: {
                      type: "string",
                      description: "Razonamiento breve sobre la detección de IA",
                    },
                  },
                  required: ["score", "feedback", "ai_likelihood", "ai_reasons"],
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "score_answer" } },
        });
        if (!aiRes.ok) {
          breakdown.push({
            qid: q.id,
            type: q.type,
            points: q.points,
            earned: 0,
            feedback: "Error IA",
          });
          continue;
        }
        const aiJson = await aiRes.json();
        const tc = aiJson.choices?.[0]?.message?.tool_calls?.[0];
        const args = tc
          ? JSON.parse(tc.function.arguments)
          : { score: 0, feedback: "", ai_likelihood: 0, ai_reasons: "" };
        const score = Math.max(0, Math.min(Number(q.points), Number(args.score) || 0));
        const aiLikelihood = Math.max(0, Math.min(1, Number(args.ai_likelihood) || 0));
        earned += score;
        breakdown.push({
          qid: q.id,
          type: q.type,
          points: q.points,
          earned: score,
          feedback: args.feedback,
          ai_likelihood: aiLikelihood,
          ai_reasons: args.ai_reasons ?? "",
        });
        aiReasonBuckets.push({
          qid: q.id,
          likelihood: aiLikelihood,
          reason: args.ai_reasons ?? "",
        });
        if (aiLikelihood > maxAiLikelihood) maxAiLikelihood = aiLikelihood;
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

    return new Response(
      JSON.stringify({
        ok: true,
        grade,
        breakdown,
        ai_detected: aiDetected,
        ai_likelihood: finalAiLikelihood,
        ai_reasons: reasonsWithSpeed,
        speed_boost: speedBoost,
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
