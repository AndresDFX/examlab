// AI question generator. Las llamadas IA se enrutan al provider activo
// configurado en `ai_model_settings` (openai | gemini), mismo patrón
// que `ai-grade-submission` y `generate-contents`.
import { adminClient, userClientFromRequest } from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";
import { enforceRateLimit } from "../_shared/rate-limit.ts";
import { describeAiError as describeSharedAiError } from "../_shared/ai-error.ts";
import {
  getActiveAiModel as resolveActiveModel,
  aiChatCompletionFailover,
  type ActiveModel,
  type AiProvider,
} from "../_shared/ai-model.ts";
import {
  isNotebook,
  isOfficeDoc,
  notebookToReadableText,
  docxXmlToText,
  pptxSlideXmlToText,
} from "./material-extract.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Multi-tenant: hint del request para resolver ai_model_settings por
// tenant. Se setea al inicio del handler con courseId del body / auth.
let requestModelHint: { courseId?: string | null; authHeader?: string | null } = {};

function setRequestModelHint(h: { courseId?: string | null; authHeader?: string | null }): void {
  requestModelHint = h;
}

// Último modelo activo resuelto, cacheado a nivel módulo. `describeAiError`
// lo lee para nombrar el provider correcto (OPENAI / GEMINI) en el mensaje
// de error. `aiChatCompletion` SIEMPRE llama `getActiveAiModel()` antes del
// fetch, así que para cuando un error dispara `describeAiError` esta variable
// ya está poblada. Antes `describeAiError` referenciaba un `cachedModel`
// inexistente → ReferenceError "cachedModel is not defined" enmascarado como
// fallo de generación (audit: ai.questions_generation_failed).
let cachedModel: ActiveModel | null = null;

async function getActiveAiModel(): Promise<ActiveModel> {
  const m = await resolveActiveModel(requestModelHint);
  cachedModel = m;
  return m;
}
export type { AiProvider };

/**
 * Wrapper de chat completions. Decide URL/key/modelo según el provider
 * activo. Todos los providers hablan el formato OpenAI chat-completions
 * estándar → el `body` viaja idéntico, solo cambian endpoint + auth.
 *
 * El caller pasa `messages`, opcionalmente `tools` y `tool_choice`. NO
 * pasa `model` — eso lo resuelve esta función desde `ai_model_settings`.
 *
 * `modelOverride` permite especificar un modelo distinto al de settings
 * dentro del mismo provider (ej. usar `gemini-2.5-pro` para una llamada
 * pesada cuando settings tiene `flash`). Si no se pasa, usa el del DB.
 */
async function aiChatCompletion(body: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool_choice?: any;
  modelOverride?: string;
}): Promise<Response> {
  const m = await getActiveAiModel();
  // El `model` final: si el caller pasó override, lo usa; si no, el de settings.
  const finalModel = body.modelOverride ?? m.model;
  const { modelOverride: _ignore, ...rest } = body;
  void _ignore;
  // Failover de API keys (principal → respaldo → env) + retry-with-backoff
  // transitorio en la última key viven en el helper compartido. Si TODAS las
  // keys agotan cuota (429), devuelve el 429 final y el caller (handlers de
  // abajo) muestra el mensaje amigable / 200-para-sync.
  return aiChatCompletionFailover(m, { model: finalModel, ...rest });
}

/**
 * Wrapper sobre el helper compartido. Inyecta el provider activo desde
 * `cachedModel` para que el mensaje de "API key inválida" nombre el
 * secret correcto (OPENAI / GEMINI). Ver `_shared/ai-error.ts`.
 */
async function describeAiError(res: Response): Promise<string> {
  return describeSharedAiError(res, cachedModel?.provider ?? "gemini");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resuelve el system prompt para un use_case dado, considerando override
 * por curso si existe. Mismo patrón que `ai-grade-submission` —
 * duplicado intencionalmente para no acoplar las dos edge functions.
 *
 *   1. Si `courseId` es UUID válido → busca course override + global.
 *   2. Sin courseId → solo global (course_id IS NULL).
 *   3. Sin filas en BD → fallback hardcoded.
 *
 * Course override gana sobre global cuando ambos existen.
 */
async function resolveSystemPrompt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  useCase: string,
  courseId: string | null | undefined,
  fallback: string,
): Promise<string> {
  try {
    let q = admin.from("ai_prompts").select("system_prompt, course_id").eq("use_case", useCase);
    if (courseId && UUID_RE.test(courseId)) {
      q = q.or(`course_id.eq.${courseId},course_id.is.null`);
    } else {
      q = q.is("course_id", null);
    }
    const { data, error } = await q;
    if (error || !data || data.length === 0) return fallback;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sorted = [...data].sort((a: any, b: any) => {
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

// ── Extracción del CONTENIDO del curso para generación de Kahoot (Goal #18) ──
// Mismo patrón que `tutor-chat`: lee `generated_contents.files[]` y extrae el
// TEXTO real (inline / notebook / docx-pptx vía unzip + cache-back). Permite
// generar preguntas Kahoot a partir del material del curso (una sesión o todo)
// en vez de pedirle al docente que escriba los temas a mano.
const MATERIAL_PER_DOC_CHARS = 6000;
const MATERIAL_TOTAL_CHARS = 22000;
const MAX_STORAGE_EXTRACTIONS = 18; // cota de descargas por request (latencia)
const CONTENTS_BUCKET = "generated-contents";

type MaterialFile = { name?: string; path?: string; kind?: string; body?: string };
type MaterialRow = {
  id: string;
  topic: string;
  display_name: string;
  files: MaterialFile[] | null;
};

/** Descomprime un docx/pptx (ZIP) y extrae su texto interno. Best-effort.
 *  Copia del helper homónimo de `tutor-chat/index.ts`. */
async function extractOfficeText(buf: Uint8Array, ext: string): Promise<string> {
  const fflate = await import("npm:fflate@0.8.2");
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    fflate.unzip(buf, (err: Error | null, f: Record<string, Uint8Array>) =>
      err ? reject(err) : resolve(f),
    ),
  );
  const dec = new TextDecoder();
  if (ext === "docx") {
    const xml = files["word/document.xml"];
    return xml ? docxXmlToText(dec.decode(xml)) : "";
  }
  const slideNames = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)![1], 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)![1], 10);
      return na - nb;
    });
  const parts = slideNames
    .map((n, i) => {
      const t = pptxSlideXmlToText(dec.decode(files[n]));
      return t ? `(Diapositiva ${i + 1})\n${t}` : "";
    })
    .filter(Boolean);
  return parts.join("\n\n");
}

/** Texto legible de UN archivo (inline o extraído de Storage). */
async function readMaterialFileText(
  f: MaterialFile,
): Promise<{ text: string; extracted: boolean }> {
  const name = String(f.name ?? "");
  if (typeof f.body === "string" && f.body.trim()) {
    const text = isNotebook(name) ? notebookToReadableText(f.body) : f.body.trim();
    return { text, extracted: false };
  }
  if (isOfficeDoc(name) && f.path) {
    try {
      const dl = await adminClient.storage.from(CONTENTS_BUCKET).download(f.path);
      if (dl.data) {
        const buf = new Uint8Array(await dl.data.arrayBuffer());
        const ext = name.toLowerCase().endsWith(".pptx") ? "pptx" : "docx";
        const text = await extractOfficeText(buf, ext);
        return { text, extracted: text.length > 0 };
      }
    } catch {
      /* best-effort: si falla la descarga/descompresión, se omite el archivo */
    }
  }
  return { text: "", extracted: false };
}

/**
 * Concatena el texto extraído de todas las filas de contenido provistas,
 * respetando topes per-doc / globales. Cachea de vuelta el texto extraído de
 * archivos Office en `files[].body` (self-healing, como tutor-chat). Opcional
 * `allowedPaths`: si viene, solo considera archivos cuyo `path` esté en el set
 * (lo usa el scope de sesión cuando el docente eligió un subconjunto explícito).
 */
async function buildCourseMaterial(
  rows: MaterialRow[],
  allowedPaths: Set<string> | null,
): Promise<string> {
  type Entry = { docTitle: string; fileName: string; text: string };
  const entries: Entry[] = [];
  let extractions = 0;

  for (const row of rows) {
    const files = Array.isArray(row.files) ? row.files : [];
    const docTitle = (row.display_name || row.topic || "(sin título)").trim();
    let rowDirty = false;
    for (const f of files) {
      if (!f || !f.name) continue;
      if (allowedPaths && (!f.path || !allowedPaths.has(f.path))) continue;
      const name = String(f.name);
      const hasInline = typeof f.body === "string" && f.body.trim().length > 0;
      const needsExtraction = !hasInline && isOfficeDoc(name) && !!f.path;
      if (needsExtraction && extractions >= MAX_STORAGE_EXTRACTIONS) continue;
      if (needsExtraction) extractions++;
      const { text, extracted } = await readMaterialFileText(f);
      if (extracted) {
        f.body = text.slice(0, MATERIAL_PER_DOC_CHARS * 2);
        rowDirty = true;
      }
      if (!text.trim()) continue;
      entries.push({ docTitle, fileName: name, text: text.trim() });
    }
    if (rowDirty) {
      try {
        await adminClient.from("generated_contents").update({ files }).eq("id", row.id);
      } catch {
        /* el cache-back es opcional; si falla, la próxima vez se re-extrae */
      }
    }
  }

  let acc = "";
  for (const e of entries) {
    if (acc.length >= MATERIAL_TOTAL_CHARS) break;
    const excerpt =
      e.text.length > MATERIAL_PER_DOC_CHARS
        ? e.text.slice(0, MATERIAL_PER_DOC_CHARS).trimEnd() + " …"
        : e.text;
    const header = `\n\n### ${e.docTitle} — ${e.fileName}\n`;
    const block = header + excerpt;
    if (acc.length + block.length > MATERIAL_TOTAL_CHARS) {
      acc += block.slice(0, MATERIAL_TOTAL_CHARS - acc.length);
      break;
    }
    acc += block;
  }
  return acc.trim();
}

/**
 * Resuelve el material del curso para el modo Kahoot según el scope pedido.
 *
 *  - scope "course": todo el material `done` del curso (mismo query que el
 *    tutor IA).
 *  - scope "session": solo el material de la sesión `sessionId` — se lee su
 *    `content_id` (+ `content_file_paths` para acotar a un subconjunto, o
 *    `content_class_index` para una clase del curso_completo).
 *
 * Devuelve `{ material, error }`. `error` (string) cuando la sesión no tiene
 * contenido o el material extraído queda vacío, para que el handler devuelva
 * un mensaje accionable en vez de generar sin contexto.
 */
async function resolveKahootMaterial(
  scope: "session" | "course",
  courseId: string | null,
  sessionId: string | null,
): Promise<{ material: string; error: string | null }> {
  if (scope === "course") {
    if (!courseId) return { material: "", error: "courseId requerido para leer el material del curso" };
    const { data: rows } = await adminClient
      .from("generated_contents")
      .select("id, topic, display_name, files")
      .eq("course_id", courseId)
      .eq("status", "done")
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(30);
    const material = await buildCourseMaterial((rows ?? []) as MaterialRow[], null);
    if (!material.trim()) {
      return {
        material: "",
        error:
          "El curso no tiene material legible asociado. Genera o sube contenido, o genera el reto en vivo por temas.",
      };
    }
    return { material, error: null };
  }
  // scope === "session"
  if (!sessionId) return { material: "", error: "sessionId requerido cuando la fuente es una sesión" };
  const { data: session } = await adminClient
    .from("attendance_sessions")
    .select("content_id, content_class_index, content_file_paths")
    .eq("id", sessionId)
    .is("deleted_at", null)
    .maybeSingle();
  // deno-lint-ignore no-explicit-any
  const s = session as any;
  if (!s || !s.content_id) {
    return {
      material: "",
      error:
        "La sesión no tiene material asociado. Asígnale un contenido en Asistencia o genera el reto en vivo por temas.",
    };
  }
  const { data: rows } = await adminClient
    .from("generated_contents")
    .select("id, topic, display_name, files")
    .eq("id", s.content_id)
    .is("deleted_at", null);
  let materialRows = (rows ?? []) as MaterialRow[];
  // Acotamiento por subconjunto explícito (content_file_paths) o por clase
  // (content_class_index) — mismo orden de prioridad que `filesForSession`
  // del estudiante (paths > class_index > todo).
  let allowedPaths: Set<string> | null = null;
  if (Array.isArray(s.content_file_paths)) {
    allowedPaths = new Set(s.content_file_paths as string[]);
  } else if (typeof s.content_class_index === "number") {
    const classIdx = s.content_class_index as number;
    const paths: string[] = [];
    for (const row of materialRows) {
      for (const f of Array.isArray(row.files) ? row.files : []) {
        if (!f?.name || !f.path) continue;
        if (classNumberFromFilename(f.name) === classIdx) paths.push(f.path);
      }
    }
    // Solo aplicamos el filtro por clase si encontró archivos (si no, todo el
    // contenido, igual que el fallback del estudiante).
    if (paths.length > 0) allowedPaths = new Set(paths);
  }
  const material = await buildCourseMaterial(materialRows, allowedPaths);
  if (!material.trim()) {
    return {
      material: "",
      error:
        "El material de la sesión está vacío o no es legible. Asígnale contenido con texto, o genera el reto en vivo por temas.",
    };
  }
  return { material, error: null };
}

/**
 * Extrae el número de clase del nombre del archivo (sufijo CLASE_N, trailing
 * _N, o leading N_). Copia mínima de `classNumberFromFilename`
 * (`src/modules/contents/contents-extract.ts`) para acotar el material de una
 * sesión a su `content_class_index` (curso_completo). Restringido a 1..100.
 */
function classNumberFromFilename(name: string): number | null {
  const m1 = name.match(/(?:CLASE|CLASS|SESION|SESSION)[_\s-]*(\d+)/i);
  if (m1) {
    const n = Number(m1[1]);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n;
  }
  const m2 = name.match(/[_-](\d{1,3})(?:\.[A-Za-z0-9]+)?$/);
  if (m2) {
    const n = Number(m2[1]);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n;
  }
  const m3 = name.match(/^(\d{1,3})[_-]/);
  if (m3) {
    const n = Number(m3[1]);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  // Auth interna (verify_jwt=false en config.toml). Aceptamos:
  //   1. Bearer = SUPABASE_SERVICE_ROLE_KEY  →  caller es server-side
  //      (ai-generation-worker drenando la cola). Match exacto por string
  //      funciona sea cual sea el formato del key (JWT legacy o sb_secret_*),
  //      a diferencia del verify_jwt del gateway que rebota los no-JWT.
  //   2. user JWT válido  →  caller es el frontend (Admin/Docente desde
  //      el flujo sync de generación). El rate limit interno aplica.
  // Sin auth → 401. Esto evita que cualquiera con la URL gaste créditos
  // de IA o inyecte preguntas via service_role bypass de RLS.
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const expectedServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const isServiceRoleCaller = bearer.length > 0 && bearer === expectedServiceKey;
  if (!isServiceRoleCaller) {
    const probe = userClientFromRequest(req);
    if (!probe) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: probeUser } = await probe.auth.getUser();
    if (!probeUser?.user) {
      return new Response(JSON.stringify({ error: "JWT inválido o expirado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }
  // Capturamos contexto para el catch global (modo + caller) — útil para
  // que la auditoría del fallo identifique qué se intentaba generar.
  let auditMode = "unknown";
  let auditActorId: string | null = null;
  try {
    const body = await req.json();
    setRequestModelHint({
      courseId: (body as { courseId?: string | null }).courseId ?? null,
      authHeader: req.headers.get("Authorization"),
    });
    auditMode = body.projectDescriptionGeneration
      ? "project_description"
      : body.projectQuestionsAndAssets
        ? "project_questions_assets"
        : body.projectFilesGeneration
          ? "project_files"
          : body.workshopQuestionsGeneration
            ? "workshop_questions"
            : body.examQuestionsGeneration
              ? "exam_questions"
              : "unknown";

    // Rate limit antes de hacer trabajo (gastar créditos de IA). 30
    // calls/hora por usuario es generoso para uso interactivo y atrapa
    // scripts que entren en loop. Si la migración del RPC no está
    // aplicada, el helper deja pasar (best-effort).
    const rlClient = userClientFromRequest(req);
    if (rlClient) {
      const { data: uPre } = await rlClient.auth.getUser();
      if (uPre?.user) auditActorId = uPre.user.id;
      const rl = await enforceRateLimit(rlClient, "ai.generate_questions", {
        max: 30,
        windowSeconds: 3600,
      });
      if (!rl.ok) return rl.response;
    }

    // ── Modo: generación de DESCRIPCIÓN de proyecto (contexto global) ──
    // Body: { projectDescriptionGeneration: true, topic, courseId?, courseLanguage? }
    // Devuelve { ok, description } — un texto plano corto que sirve como
    // contexto para todas las preguntas del proyecto. La descripción se
    // inyecta en cada llamada de calificación de `ai-grade-submission`
    // para que cada pregunta se evalúe sin perder de vista el alcance.
    if (body.projectDescriptionGeneration) {
      // Provider validation vive en `aiChatCompletion` según `ai_model_settings`.
      const { topic, courseId, courseLanguage } = body;
      if (!topic || typeof topic !== "string" || !topic.trim()) {
        return new Response(JSON.stringify({ error: "topic requerido" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const lang: "es" | "en" =
        courseLanguage === "en" || courseLanguage === "es" ? courseLanguage : "es";
      const langName = lang === "en" ? "inglés (English)" : "español";
      // Mantener nombre `adminPD` por consistencia con los pasos siguientes
      // del modo project_description. El cliente subyacente es el singleton
      // compartido (`adminClient` de `_shared/admin.ts`).
      const adminPD = adminClient;
      const fallback = `Eres un docente experto que redacta la descripción de un proyecto académico. Sé concreto y conciso (3-6 oraciones). Indica el propósito, alcance y restricciones. NO listes entregables uno por uno (van en cada pregunta). NO uses encabezados Markdown — texto plano corrido. Devuelve solo la descripción.`;
      const systemPrompt = await resolveSystemPrompt(
        adminPD,
        "project_description",
        courseId,
        fallback,
      );

      const aiResD = await aiChatCompletion({
        messages: [
          {
            role: "system",
            content: `${systemPrompt}\n\nIdioma de salida obligatorio: ${langName}.`,
          },
          {
            role: "user",
            content: `Tema del proyecto: ${topic.trim()}\n\nDevuelve solo la descripción en ${langName}.`,
          },
        ],
      });
      // Caller-aware (ver bloque principal): worker → status real; sync → 200+{error}.
      if (aiResD.status === 429) {
        return new Response(
          JSON.stringify({ ok: false, error: "Límite de uso de IA. Intenta en un momento.", rate_limited: true }),
          { status: isServiceRoleCaller ? 429 : 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (aiResD.status === 402) {
        return new Response(
          JSON.stringify({ ok: false, error: "Sin créditos de IA. Agrega créditos en Settings → Workspace → Usage.", no_credits: true }),
          { status: isServiceRoleCaller ? 402 : 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (!aiResD.ok) {
        throw new Error(await describeAiError(aiResD));
      }
      const aiJsonD = await aiResD.json();
      const description: string = aiJsonD.choices?.[0]?.message?.content?.toString().trim() ?? "";
      return new Response(JSON.stringify({ ok: true, description }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Modo: generación de enunciado de PROYECTO ──
    if (body.projectStatement) {
      const {
        topic,
        projectType = "escrito", // 'escrito' | 'codigo' | 'diagrama'
        maxFiles = 5,
        courseLanguage,
      } = body;
      if (!topic) throw new Error("topic requerido");
      const lang: "es" | "en" =
        courseLanguage === "en" || courseLanguage === "es" ? courseLanguage : "es";
      const langName = lang === "en" ? "inglés (English)" : "español";

      const aiRes = await aiChatCompletion({
        messages: [
          {
            role: "system",
            content: `Eres un docente experto que diseña enunciados de proyectos académicos claros, retadores y bien estructurados.
Devuelve un enunciado completo en ${langName} con: contexto/objetivo, alcance, entregables (respetando exactamente el número máximo de archivos), criterios de evaluación y restricciones técnicas según el tipo de proyecto.`,
          },
          {
            role: "user",
            content: `Tema: ${topic}
Tipo de proyecto: ${projectType} (escrito = ensayo/informe; codigo = solución de programación; diagrama = modelado UML/ER/flujo)
Número máximo de archivos a entregar: ${maxFiles}
El estudiante deberá subir los archivos comprimidos en un ZIP.
Idioma obligatorio: ${langName}.`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "build_project_statement",
              description: "Devuelve el enunciado del proyecto",
              parameters: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  instructions: {
                    type: "string",
                    description: "Enunciado completo en Markdown con secciones",
                  },
                },
                required: ["title", "description", "instructions"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "build_project_statement" } },
      });

      // Caller-aware (ver bloque principal): worker → status real; sync → 200+{error}.
      if (aiRes.status === 429) {
        return new Response(
          JSON.stringify({ ok: false, error: "Límite de uso de IA. Intenta en un momento.", rate_limited: true }),
          { status: isServiceRoleCaller ? 429 : 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (aiRes.status === 402) {
        return new Response(
          JSON.stringify({ ok: false, error: "Sin créditos de IA. Agrega créditos en Settings → Workspace → Usage.", no_credits: true }),
          { status: isServiceRoleCaller ? 402 : 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (!aiRes.ok) {
        throw new Error(await describeAiError(aiRes));
      }
      const aiJson = await aiRes.json();
      const tc = aiJson.choices?.[0]?.message?.tool_calls?.[0];
      const args = tc
        ? JSON.parse(tc.function.arguments)
        : { title: topic, description: "", instructions: "" };
      return new Response(JSON.stringify({ ok: true, ...args }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Modo: generación AUTOMÁTICA de PREGUNTAS de un proyecto ──
    // Body: { projectQuestionsAutoGeneration: true, projectId, description,
    //         courseId?, courseLanguage? }
    // A diferencia de `projectFilesGeneration`, aquí la IA NO recibe un
    // tema corto sino la DESCRIPCIÓN COMPLETA del proyecto y decide qué
    // preguntas son útiles para evaluar (con tipo). Restricción dura:
    // siempre exactamente UNA pregunta de tipo `codigo_zip`; el resto
    // (entre 2 y 5) son a criterio de la IA con type ∈
    // {abierta, diagrama, cerrada}.
    if (body.projectQuestionsAutoGeneration) {
      const {
        projectId,
        description,
        courseId,
        courseLanguage: pqaLang,
      } = body as {
        projectId?: string;
        description?: string;
        courseId?: string | null;
        courseLanguage?: string;
      };
      if (!projectId || !description || !description.trim()) {
        return new Response(JSON.stringify({ error: "projectId y description son requeridos" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const adminPQA = adminClient;
      // Idioma: explícito del cliente o derivado del curso.
      let pqaLangCode: "es" | "en" = "es";
      if (pqaLang === "en" || pqaLang === "es") {
        pqaLangCode = pqaLang;
      } else {
        const { data: pRow } = await adminPQA
          .from("projects")
          .select("course:courses(language)")
          .eq("id", projectId)
          .maybeSingle();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lng = (pRow as any)?.course?.language;
        if (lng === "en" || lng === "es") pqaLangCode = lng;
      }
      const pqaLangName = pqaLangCode === "en" ? "inglés (English)" : "español";

      const fallbackPQA = `Eres un docente experto que diseña la estructura de evaluación de un proyecto. Devuelve EXACTAMENTE 1 pregunta tipo "codigo_zip" (donde el estudiante sube el ZIP del código) y entre 2 y 5 preguntas adicionales con tipo entre "abierta" | "diagrama" | "cerrada" para evaluar análisis y diseño por separado. Cada pregunta debe tener title, description, type y expected_rubric.`;
      const systemPromptPQA = await resolveSystemPrompt(
        adminPQA,
        "project_questions",
        courseId ?? null,
        fallbackPQA,
      );

      const aiResPQA = await aiChatCompletion({
        messages: [
          {
            role: "system",
            content: `${systemPromptPQA}\n\nIdioma de salida obligatorio: ${pqaLangName}.`,
          },
          {
            role: "user",
            content: `Descripción del proyecto:\n${description.trim()}\n\nGenera el set de preguntas evaluativas en ${pqaLangName} respetando las reglas del system prompt.`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "build_project_questions",
              description:
                "Devuelve el set de preguntas evaluativas del proyecto. Exactamente una con type='codigo_zip', el resto con type entre 'abierta'|'diagrama'|'cerrada'.",
              parameters: {
                type: "object",
                properties: {
                  questions: {
                    type: "array",
                    minItems: 3,
                    maxItems: 6,
                    items: {
                      type: "object",
                      properties: {
                        title: { type: "string" },
                        description: { type: "string" },
                        type: {
                          type: "string",
                          enum: ["codigo_zip", "abierta", "diagrama", "cerrada"],
                        },
                        expected_rubric: { type: "string" },
                      },
                      required: ["title", "description", "type", "expected_rubric"],
                    },
                  },
                },
                required: ["questions"],
              },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "build_project_questions" },
        },
      });

      // Caller-aware (ver bloque principal): worker → status real; sync → 200+{error}.
      if (aiResPQA.status === 429) {
        return new Response(
          JSON.stringify({ ok: false, error: "Límite de uso de IA. Intenta en un momento.", rate_limited: true }),
          { status: isServiceRoleCaller ? 429 : 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (aiResPQA.status === 402) {
        return new Response(
          JSON.stringify({ ok: false, error: "Sin créditos de IA. Agrega créditos en Settings → Workspace → Usage.", no_credits: true }),
          { status: isServiceRoleCaller ? 402 : 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (!aiResPQA.ok) {
        throw new Error(await describeAiError(aiResPQA));
      }

      const aiJsonPQA = await aiResPQA.json();
      const tcPQA = aiJsonPQA.choices?.[0]?.message?.tool_calls?.[0];
      const argsPQA = tcPQA ? JSON.parse(tcPQA.function.arguments) : { questions: [] };
      type PQ = {
        title: string;
        description: string;
        type: "codigo_zip" | "abierta" | "diagrama" | "cerrada";
        expected_rubric: string;
      };
      let questions: PQ[] = (argsPQA.questions ?? []).filter((q: PQ) => q && q.title && q.type);

      // Enforce hard rule: exactamente UN codigo_zip. Si vienen varios,
      // dejamos solo el primero (los demás los degradamos a `abierta`).
      // Si no viene ninguno, prependemos uno por defecto. Nunca devolvemos
      // cero `codigo_zip`.
      const zipQs = questions.filter((q) => q.type === "codigo_zip");
      if (zipQs.length === 0) {
        questions.unshift({
          title:
            pqaLangCode === "en" ? "Project source code (ZIP)" : "Código fuente del proyecto (ZIP)",
          description:
            pqaLangCode === "en"
              ? "Upload a ZIP file containing all the source code of your project."
              : "Sube un archivo ZIP con todo el código fuente de tu proyecto.",
          type: "codigo_zip",
          expected_rubric:
            pqaLangCode === "en"
              ? "The ZIP must contain compilable/runnable source code that fulfills the scope of the project."
              : "El ZIP debe contener código fuente compilable/ejecutable que cumpla con el alcance del proyecto.",
        });
      } else if (zipQs.length > 1) {
        let kept = false;
        questions = questions.map((q) => {
          if (q.type !== "codigo_zip") return q;
          if (!kept) {
            kept = true;
            return q;
          }
          return { ...q, type: "abierta" as const };
        });
      }
      // Cap final por seguridad (máx 6 entregables totales).
      questions = questions.slice(0, 6);

      // Continuar la posición desde el último existente
      const { data: existingQ } = await adminPQA
        .from("project_files")
        .select("position")
        .eq("project_id", projectId)
        .order("position", { ascending: false })
        .limit(1);
      let posQ = (existingQ?.[0]?.position ?? -1) as number;

      const toInsertQ = questions.map((q) => ({
        project_id: projectId,
        title: q.title,
        description: q.description ?? null,
        expected_rubric: q.expected_rubric ?? null,
        type: q.type,
        position: ++posQ,
        points: 1,
      }));

      const { data: insertedQ, error: insErrQ } = await adminPQA
        .from("project_files")
        .insert(toInsertQ)
        .select();
      if (insErrQ) throw insErrQ;

      return new Response(JSON.stringify({ ok: true, inserted: insertedQ }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Modo: generación de ARCHIVOS esperados de un proyecto ──
    // Body: { projectFilesGeneration: true, projectId, topic, count, courseLanguage }
    // Devuelve y persiste N rows en `project_files` con title/description/expected_rubric.
    if (body.projectFilesGeneration) {
      const { projectId, topic, count: pfCount = 3, courseLanguage: pfLang } = body;
      if (!projectId || !topic) {
        return new Response(JSON.stringify({ error: "projectId y topic requeridos" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const cnt = Math.max(1, Math.min(20, Number(pfCount) || 3));

      // Resolve course language from project → course
      const adminPF = adminClient;
      let pfCourseLang: "es" | "en" = "es";
      if (pfLang === "en" || pfLang === "es") {
        pfCourseLang = pfLang;
      } else {
        const { data: pRow } = await adminPF
          .from("projects")
          .select("course:courses(language)")
          .eq("id", projectId)
          .maybeSingle();
        const lng = (pRow as any)?.course?.language;
        if (lng === "en" || lng === "es") pfCourseLang = lng;
      }
      const pfLangName = pfCourseLang === "en" ? "inglés (English)" : "español";

      const aiRes = await aiChatCompletion({
        messages: [
          {
            role: "system",
            content: `Eres un docente experto que diseña proyectos académicos. Dado un tema, debes producir EXACTAMENTE ${cnt} archivos esperados que un estudiante debe entregar para completar el proyecto. Cada archivo es una pieza textual independiente (documento de diseño, código, evidencias, manual de usuario, etc.) que el estudiante pegará en una caja de texto y la IA calificará con la rúbrica que tú escribas.
REGLA DE IDIOMA: responde siempre en ${pfLangName}.`,
          },
          {
            role: "user",
            content: `Tema del proyecto: ${topic}
Número exacto de archivos: ${cnt}
Para cada archivo devuelve: title (corto), description (qué debe contener desde la perspectiva del estudiante), expected_rubric (criterios objetivos para calificar).
Idioma obligatorio: ${pfLangName}.`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "build_project_files",
              description: "Devuelve los archivos esperados del proyecto",
              parameters: {
                type: "object",
                properties: {
                  files: {
                    type: "array",
                    minItems: cnt,
                    maxItems: cnt,
                    items: {
                      type: "object",
                      properties: {
                        title: { type: "string" },
                        description: { type: "string" },
                        expected_rubric: { type: "string" },
                      },
                      required: ["title", "description", "expected_rubric"],
                    },
                  },
                },
                required: ["files"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "build_project_files" } },
      });

      // Caller-aware (ver bloque principal): worker → status real; sync → 200+{error}.
      if (aiRes.status === 429) {
        return new Response(
          JSON.stringify({ ok: false, error: "Límite de uso de IA. Intenta en un momento.", rate_limited: true }),
          { status: isServiceRoleCaller ? 429 : 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (aiRes.status === 402) {
        return new Response(
          JSON.stringify({ ok: false, error: "Sin créditos de IA. Agrega créditos en Settings → Workspace → Usage.", no_credits: true }),
          { status: isServiceRoleCaller ? 402 : 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (!aiRes.ok) {
        throw new Error(await describeAiError(aiRes));
      }

      const aiJson = await aiRes.json();
      const tc = aiJson.choices?.[0]?.message?.tool_calls?.[0];
      const args = tc ? JSON.parse(tc.function.arguments) : { files: [] };
      const generated: Array<{ title: string; description: string; expected_rubric: string }> =
        args.files ?? [];

      // Continuar la posición desde el último existente
      const { data: existing } = await adminPF
        .from("project_files")
        .select("position")
        .eq("project_id", projectId)
        .order("position", { ascending: false })
        .limit(1);
      let pos = (existing?.[0]?.position ?? -1) as number;

      const toInsert = generated.map((g) => ({
        project_id: projectId,
        title: g.title,
        description: g.description ?? null,
        expected_rubric: g.expected_rubric ?? null,
        position: ++pos,
        points: 1,
      }));

      const { data: inserted, error: insErr } = await adminPF
        .from("project_files")
        .insert(toInsert)
        .select();
      if (insErr) throw insErr;

      return new Response(JSON.stringify({ ok: true, inserted }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { topics, type, count = 5, examId, language, targetTable } = body;
    // Goal #18 — generar Kahoot LEYENDO el contenido del curso. Params
    // opcionales del body (solo aplican al modo Kahoot; default = comportamiento
    // anterior con `topics`):
    //   materialScope: "none" (default, solo topics) | "session" | "course"
    //   sessionId:     requerido cuando materialScope === "session"
    //   courseId:      curso para el scope "course" (también lo usa el model hint)
    const materialScope: "none" | "session" | "course" =
      body.materialScope === "session" || body.materialScope === "course"
        ? body.materialScope
        : "none";
    const materialSessionId: string | null =
      typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;
    const materialCourseId: string | null =
      typeof body.courseId === "string" && body.courseId.trim() ? body.courseId.trim() : null;
    // targetTable: "questions" (default) | "workshop_questions" | "project_files"
    const isWorkshop = targetTable === "workshop_questions";
    const isProject = targetTable === "project_files";
    // Kahoot: el quiz vive en `polls` (poll_type='kahoot'); las preguntas en
    // kahoot_questions + kahoot_question_options (2 tablas, distinto del flujo
    // genérico de 1 tabla). `examId` se reutiliza como poll_id.
    const isKahoot = targetTable === "kahoot_questions";
    // Banco de preguntas: inserta en question_bank (1 tabla, columnas propias:
    // suggested_points, sin position/exam_id). `examId` se reutiliza como
    // course_id (el banco vive por curso). Usa el MISMO prompt/tool genérico
    // (no el de Kahoot), ya que el banco soporta todos los tipos.
    const isBank = targetTable === "question_bank";
    // Guard: un targetTable DESCONOCIDO NO debe caer al insert por defecto en
    // `questions` (insertaría un type inválido — ej. 'kahoot' — y violaría
    // questions_type_check). Falla fuerte y claro.
    const KNOWN_TARGETS = [
      "questions",
      "workshop_questions",
      "project_files",
      "kahoot_questions",
      "question_bank",
    ];
    if (targetTable && !KNOWN_TARGETS.includes(targetTable)) {
      return new Response(JSON.stringify({ error: `targetTable desconocido: ${targetTable}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const targetId = examId;
    // Solo aplica para proyectos: descripción global del proyecto que
    // sirve como contexto al modelo. El cliente la trae de
    // `projects.description`. Si viene vacío, no se inyecta.
    const projectDescription: string | null =
      isProject && typeof body.projectDescription === "string" && body.projectDescription.trim()
        ? body.projectDescription.trim()
        : null;
    // Kahoot desde el contenido del curso (Goal #18): cuando el docente pide
    // leer el material, `topics` es opcional (el material lo sustituye). En el
    // resto de los modos `topics` sigue siendo obligatorio.
    const kahootFromMaterial = isKahoot && materialScope !== "none";
    if ((!topics && !kahootFromMaterial) || !type || !targetId) {
      return new Response(
        JSON.stringify({ error: "topics, type y (examId|workshopId|projectId) requeridos" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const allowedLanguages = new Set(["java", "python", "javascript"]);
    let codeLanguage: string | null = null;
    // Para `codigo` (textarea de un solo archivo) y `codigo_zip` (ZIP del
    // proyecto completo) la IA usa el lenguaje sugerido para redactar
    // el enunciado. En `codigo_zip` solo es una guía — el ZIP puede
    // traer múltiples lenguajes y la IA igual califica.
    if (type === "codigo" || type === "codigo_zip") {
      codeLanguage = allowedLanguages.has(language) ? language : "java";
    }

    // Singleton compartido (`adminClient`) en vez de createClient inline.
    // Antes se llamaba `createClient` directo sin importarlo — y rompía
    // con "createClient is not defined" cada vez que entraba al path de
    // resolver `courseLanguage` desde DB. Bug visible en audit logs como
    // ai.questions_generation_failed { error: 'createClient is not defined' }.
    const admin0 = adminClient;
    let courseLanguage: "es" | "en" = "es";
    if (body.courseLanguage === "en" || body.courseLanguage === "es") {
      courseLanguage = body.courseLanguage;
    } else if (targetId) {
      if (isWorkshop) {
        const { data: wRow } = await admin0
          .from("workshops")
          .select("course:courses(language)")
          .eq("id", targetId)
          .maybeSingle();
        const lng = (wRow as any)?.course?.language;
        if (lng === "en" || lng === "es") courseLanguage = lng;
      } else if (isProject) {
        const { data: pRow } = await admin0
          .from("projects")
          .select("course:courses(language)")
          .eq("id", targetId)
          .maybeSingle();
        const lng = (pRow as any)?.course?.language;
        if (lng === "en" || lng === "es") courseLanguage = lng;
      } else if (isKahoot) {
        const { data: pollRow } = await admin0
          .from("polls")
          .select("course:courses(language)")
          .eq("id", targetId)
          .maybeSingle();
        const lng = (pollRow as any)?.course?.language;
        if (lng === "en" || lng === "es") courseLanguage = lng;
      } else if (isBank) {
        // targetId ES el course_id en el banco.
        const { data: courseRow } = await admin0
          .from("courses")
          .select("language")
          .eq("id", targetId)
          .maybeSingle();
        const lng = (courseRow as any)?.language;
        if (lng === "en" || lng === "es") courseLanguage = lng;
      } else {
        const { data: examRow } = await admin0
          .from("exams")
          .select("course:courses(language)")
          .eq("id", targetId)
          .maybeSingle();
        const lng = (examRow as any)?.course?.language;
        if (lng === "en" || lng === "es") courseLanguage = lng;
      }
    }
    const langName = courseLanguage === "en" ? "inglés (English)" : "español";

    // ── Kahoot desde el contenido del curso (Goal #18) ──
    // Si el docente pidió leer el material (una sesión o todo el curso), lo
    // extraemos ACÁ y lo inyectamos como ÚNICA fuente del quiz. `courseId` lo
    // tomamos del body o, si no vino, del poll (targetId = poll_id).
    let kahootMaterial = "";
    if (kahootFromMaterial) {
      let courseIdForMaterial = materialCourseId;
      if (!courseIdForMaterial && materialScope === "course") {
        const { data: pollRow } = await admin0
          .from("polls")
          .select("course_id")
          .eq("id", targetId)
          .maybeSingle();
        courseIdForMaterial = (pollRow as any)?.course_id ?? null;
      }
      const { material, error: matErr } = await resolveKahootMaterial(
        materialScope,
        courseIdForMaterial,
        materialSessionId,
      );
      if (matErr) {
        return new Response(JSON.stringify({ error: matErr }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      kahootMaterial = material;
    }

    const systemPrompt = isKahoot
      ? `Eres un diseñador de cuestionarios interactivos tipo Kahoot. Generas preguntas dinámicas, claras y sin ambigüedad para un quiz EN VIVO. Cada pregunta tiene entre 2 y 4 opciones CORTAS (deben caber en un botón). Una pregunta puede tener UNA sola respuesta correcta o VARIAS: pon multi_select=true SOLO cuando hay más de una opción correcta, e incluí en correct_indices TODOS los índices correctos (0-based). Cuando es de una sola respuesta, correct_indices tiene exactamente un índice y multi_select=false. Evita preguntas triviales o capciosas; varía la dificultad.${
          kahootMaterial
            ? "\nBASA las preguntas EXCLUSIVAMENTE en el material del curso que se te entrega en el mensaje del usuario; no inventes temas fuera de ese material."
            : ""
        }
REGLA DE IDIOMA: Responde siempre en ${langName}. Todos los enunciados y opciones en ${langName}.`
      : `Eres un asistente experto en evaluación académica. Generas preguntas de examen claras, sin ambigüedad. Para cada pregunta incluyes una rúbrica de evaluación (qué debe contener una respuesta correcta).
REGLA DE IDIOMA: Responde siempre en el idioma configurado para este curso: ${langName}. Todos los enunciados, opciones y rúbricas deben estar en ${langName}.`;

    // Para proyectos: prepende la descripción del proyecto al user
    // prompt para que las preguntas generadas estén alineadas con el
    // alcance/propósito definido por el docente, no como temas sueltos.
    const projectCtx = projectDescription
      ? `Contexto global del proyecto (úsalo para que las preguntas generadas tengan sentido dentro de este proyecto, no como temas aislados):\n${projectDescription}\n\n`
      : "";

    // Para Kahoot con material: el bloque de contenido va primero (fuente
    // única) y `topics` —si vino— se usa como "enfócate en estos temas dentro
    // del material". Sin material, comportamiento previo (solo temas).
    const kahootUserPrompt = kahootMaterial
      ? `Material del curso (ÚNICA fuente para las preguntas):\n<material>\n${kahootMaterial}\n</material>\n\nGenera ${count} preguntas para un quiz Kahoot a partir del material anterior.${
          topics && topics.trim()
            ? ` Dentro de ese material, enfócate especialmente en: ${topics.trim()}.`
            : ""
        } Cada pregunta: enunciado breve + entre 2 y 4 opciones cortas. Si una pregunta tiene naturalmente más de una respuesta correcta, márcala como múltiple (multi_select=true) e incluí TODOS los índices correctos; si no, una sola correcta (multi_select=false). Idioma de salida obligatorio: ${langName}.`
      : `Genera ${count} preguntas para un quiz Kahoot sobre los siguientes temas: ${topics}. Cada pregunta: enunciado breve + entre 2 y 4 opciones cortas. Si una pregunta tiene naturalmente más de una respuesta correcta, márcala como múltiple (multi_select=true) e incluí TODOS los índices correctos; si no, una sola correcta (multi_select=false). Idioma de salida obligatorio: ${langName}.`;

    const userPrompt = isKahoot
      ? kahootUserPrompt
      : `${projectCtx}Genera ${count} preguntas de tipo "${type}" sobre los siguientes temas: ${topics}.
${type === "cerrada" ? "Cada pregunta debe tener 4 opciones (A, B, C, D) con UNA correcta." : ""}
${type === "codigo" ? `Las preguntas deben pedir escribir código en el lenguaje ${codeLanguage}. Indica claramente en el enunciado que la solución debe implementarse en ${codeLanguage}.` : ""}
${type === "codigo_zip" ? `Cada pregunta describe un componente o módulo a implementar. El estudiante entregará UN ARCHIVO .ZIP con todo su código fuente del proyecto (varios archivos), y la IA evaluará ese ZIP contra esta rúbrica. Lenguaje principal sugerido: ${codeLanguage}. Indica en el enunciado el alcance esperado y los archivos/clases que deben formar parte del entregable.` : ""}
La rúbrica debe describir los criterios para considerar correcta la respuesta.
Idioma de salida obligatorio: ${langName}.`;

    const kahootTool = {
      type: "function",
      function: {
        name: "create_kahoot_questions",
        description: "Devuelve preguntas de quiz Kahoot (opciones cortas, 1+ correctas)",
        parameters: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
                  correct_indices: {
                    type: "array",
                    items: { type: "integer", minimum: 0, maximum: 3 },
                    minItems: 1,
                  },
                  multi_select: { type: "boolean" },
                },
                required: ["text", "options", "correct_indices", "multi_select"],
              },
            },
          },
          required: ["questions"],
        },
      },
    };
    const tools = isKahoot
      ? [kahootTool]
      : [
      {
        type: "function",
        function: {
          name: "create_questions",
          description: "Devuelve preguntas estructuradas",
          parameters: {
            type: "object",
            properties: {
              questions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    content: { type: "string" },
                    expected_rubric: { type: "string" },
                    options:
                      type === "cerrada"
                        ? {
                            type: "object",
                            properties: {
                              choices: {
                                type: "array",
                                items: { type: "string" },
                                minItems: 4,
                                maxItems: 4,
                              },
                              correct_index: { type: "integer", minimum: 0, maximum: 3 },
                            },
                            required: ["choices", "correct_index"],
                          }
                        : { type: "object", properties: {} },
                  },
                  required: ["content", "expected_rubric"],
                },
              },
            },
            required: ["questions"],
          },
        },
      },
    ];

    const aiRes = await aiChatCompletion({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools,
      tool_choice: {
        type: "function",
        function: { name: isKahoot ? "create_kahoot_questions" : "create_questions" },
      },
    });

    // Rate-limit / sin-créditos del proveedor IA. Respuesta CONSCIENTE DEL CALLER:
    //  - Worker (service_role): status REAL (429/402) para que su lógica de
    //    retry/requeue actúe normalmente.
    //  - Caller SÍNCRONO (docente en el form): 200 con el error en el body.
    //    Motivo: supabase.functions.invoke envuelve los no-2xx en un
    //    FunctionsHttpError cuyo body el cliente DESPLEGADO no lee (el fix de
    //    extractEdgeError que lee el body de un 429 aún no está publicado en el
    //    frontend), así que el docente veía el genérico "non-2xx". Con 200+{error}
    //    el path `data.error` del cliente —que SÍ funciona en el build actual—
    //    muestra el motivo real SIN requerir deploy del frontend. Es un "soft
    //    error" para que el cliente lo presente; el éxito se distingue por
    //    `data.inserted`, no por el status. Cuando se publique el fix de
    //    extractEdgeError este 200-para-sync sigue siendo compatible.
    if (aiRes.status === 429) {
      const msg = "Límite de uso de IA. Intenta en un momento.";
      return new Response(JSON.stringify({ ok: false, error: msg, rate_limited: true }), {
        status: isServiceRoleCaller ? 429 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (aiRes.status === 402) {
      const msg = "Sin créditos de IA. Agrega créditos en Settings → Workspace → Usage.";
      return new Response(JSON.stringify({ ok: false, error: msg, no_credits: true }), {
        status: isServiceRoleCaller ? 402 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!aiRes.ok) {
      throw new Error(await describeAiError(aiRes));
    }

    const aiJson = await aiRes.json();
    const toolCall = aiJson.choices?.[0]?.message?.tool_calls?.[0];
    const args = toolCall ? JSON.parse(toolCall.function.arguments) : { questions: [] };
    const questions = args.questions || [];

    // Insert into DB using service role. La auth ya se validó al inicio del
    // handler (isServiceRoleCaller || user JWT válido). Acá resolvemos el
    // ACTOR real:
    //   - frontend (user JWT): u.user.id.
    //   - worker drenando la cola (Bearer = service_role_key): NO trae user
    //     JWT (getUser → null), así que el actor viene en body.created_by
    //     (lo setea quien encola). Sin este fallback el path async devolvía
    //     401 antes de insertar — la generación encolada nunca corría.
    const userClient = userClientFromRequest(req);
    const { data: u } = userClient
      ? await userClient.auth.getUser()
      : { data: { user: null } };
    if (!isServiceRoleCaller && !u?.user) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const actorId: string | null =
      u?.user?.id ?? (body as { created_by?: string }).created_by ?? null;

    // Reusamos el singleton — antes era otro `createClient` inline.
    const admin = adminClient;

    // ── Kahoot: inserción a DOS tablas (kahoot_questions + _options) ──
    // El modelo devuelve {text, options[], correct_indices[], multi_select}.
    // single → forzamos exactamente 1 correcta; multiple → el set marcado.
    if (isKahoot) {
      const { data: existingK } = await admin
        .from("kahoot_questions")
        .select("position")
        .eq("poll_id", targetId)
        .order("position", { ascending: false })
        .limit(1);
      let kpos = (existingK?.[0]?.position ?? -1) as number;
      const insertedK: { id: string }[] = [];
      for (const q of questions as any[]) {
        const opts: string[] = Array.isArray(q.options) ? q.options.slice(0, 4) : [];
        if (!q.text || opts.length < 2) continue;
        const correct: number[] = Array.isArray(q.correct_indices)
          ? q.correct_indices.filter((n: unknown) => Number.isInteger(n))
          : [];
        const multi = !!q.multi_select && correct.length > 1;
        // single → una sola correcta (la primera marcada, o la opción 0).
        const correctSet = new Set<number>(multi ? correct : [correct[0] ?? 0]);
        const { data: qRow, error: qErr } = await admin
          .from("kahoot_questions")
          .insert({
            poll_id: targetId,
            text: String(q.text).slice(0, 500),
            // time_limit_seconds OMITIDO a propósito → hereda el DEFAULT 20 de
            // la columna (mig 20260989). Antes insertaba 10 literal, saltándose
            // el default (fix de auditoría del ajuste "tiempo por defecto 20s").
            points: 1000,
            multi_select: multi,
            position: ++kpos,
          })
          .select("id")
          .single();
        if (qErr || !qRow) {
          console.error("[ai-generate-questions] kahoot question insert", qErr);
          continue;
        }
        const optRows = opts.map((label, idx) => ({
          question_id: qRow.id,
          label: String(label).slice(0, 200),
          is_correct: correctSet.has(idx),
          position: idx,
        }));
        // Defensa: garantizar ≥1 correcta si el modelo no marcó ninguna válida.
        if (!optRows.some((o) => o.is_correct)) optRows[0].is_correct = true;
        const { error: oErr } = await admin.from("kahoot_question_options").insert(optRows);
        if (oErr) {
          console.error("[ai-generate-questions] kahoot options insert", oErr);
          // Limpiar la pregunta huérfana sin opciones.
          await admin.from("kahoot_questions").delete().eq("id", qRow.id);
          continue;
        }
        insertedK.push({ id: qRow.id });
      }
      return new Response(JSON.stringify({ ok: true, inserted: insertedK }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Banco de preguntas: inserta en question_bank (course_id = targetId) ──
    // Usa el prompt/tool genérico (no el de Kahoot). Columnas propias del
    // banco: suggested_points (no `points`), sin position/exam_id.
    if (isBank) {
      const isCodeType = type === "codigo" || type === "java_gui" || type === "python_gui";
      const toInsert = questions.map((q: any) => ({
        course_id: targetId,
        created_by: actorId,
        type,
        content: q.content,
        options: q.options ?? null,
        expected_rubric: q.expected_rubric ?? null,
        language: isCodeType ? codeLanguage : null,
        suggested_points: 1,
      }));
      const { data: insertedB, error: bErr } = await admin
        .from("question_bank")
        .insert(toInsert)
        .select("id");
      if (bErr) {
        console.error("[ai-generate-questions] question_bank insert", bErr);
        return new Response(
          JSON.stringify({ error: bErr.message ?? "Error al insertar en el banco" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, inserted: insertedB }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tableName = isProject ? "project_files" : isWorkshop ? "workshop_questions" : "questions";
    const fkColumn = isProject ? "project_id" : isWorkshop ? "workshop_id" : "exam_id";

    const { data: existing } = await admin
      .from(tableName)
      .select("position")
      .eq(fkColumn, targetId)
      .order("position", { ascending: false })
      .limit(1);
    let pos = existing?.[0]?.position ?? -1;

    const javaGuiStarter = `import javax.swing.*;\nimport java.awt.*;\n\npublic class Main {\n  public static void main(String[] args) {\n    JFrame f = new JFrame(\"Hola\");\n    f.setSize(320, 200);\n    f.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);\n    f.add(new JLabel(\"Hola Mundo\", SwingConstants.CENTER));\n    f.setVisible(true);\n  }\n}\n`;

    const toInsert = questions.map((q: any) => {
      const base: any = {
        [fkColumn]: targetId,
        type,
        expected_rubric: q.expected_rubric,
        options: q.options ?? null,
        position: ++pos,
        points: 1,
        language: type === "java_gui" ? "java" : codeLanguage,
        starter_code: type === "java_gui" ? javaGuiStarter : null,
      };
      if (isProject) {
        // project_files uses `title` as the prompt body
        base.title = q.content;
        base.description = null;
      } else {
        base.content = q.content;
      }
      return base;
    });
    const { data: inserted, error: insErr } = await admin.from(tableName).insert(toInsert).select();
    if (insErr) {
      console.error("Insert error:", insErr);
      return new Response(
        JSON.stringify({
          error: insErr.message ?? "Error al insertar preguntas",
          details: insErr.details ?? null,
          code: insErr.code ?? null,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ ok: true, inserted }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("ai-generate-questions error:", e);
    const msg =
      e instanceof Error
        ? e.message
        : typeof e === "object" && e !== null
          ? JSON.stringify(e)
          : String(e);
    // Auditoría del fallo. El modo se capturó antes de que tirara la
    // excepción, así que sabemos qué se intentaba generar.
    void auditFromEdge(adminClient, {
      actorId: auditActorId,
      action: "ai.questions_generation_failed",
      category: "system",
      severity: "error",
      entityType: "ai_generation",
      metadata: { mode: auditMode, error: msg },
    });
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
