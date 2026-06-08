// Evalúa si la duración asignada a un examen es razonable dadas las
// preguntas. Body: { examId: string }.
// Devuelve: { suggested_minutes, verdict, explanation, current_minutes }.
// Lee el system prompt de ai_prompts use_case='exam_time_evaluation'
// (con fallback hardcodeado al texto del seed).
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { describeAiError } from "../_shared/ai-error.ts";
import {
  getActiveAiModel as resolveActiveModel,
  type ActiveModel,
} from "../_shared/ai-model.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const adminClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Multi-tenant: hint para resolver ai_model_settings por tenant del caller.
let requestModelHint: { courseId?: string | null; authHeader?: string | null } = {};
function setRequestModelHint(h: { courseId?: string | null; authHeader?: string | null }): void {
  requestModelHint = h;
}
async function getActiveAiModel(): Promise<ActiveModel> {
  return await resolveActiveModel(requestModelHint);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function aiChatCompletion(body: { messages: any[]; tools?: any[]; tool_choice?: any }) {
  const m = await getActiveAiModel();
  let url: string;
  let key: string | undefined;
  if (m.provider === "openai") {
    url = "https://api.openai.com/v1/chat/completions";
    key = m.openai_api_key ?? Deno.env.get("OPENAI_API_KEY");
    if (!key) throw new Error("Falta la API key de OpenAI");
  } else {
    url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    key = m.gemini_api_key ?? Deno.env.get("GEMINI_API_KEY");
    if (!key) throw new Error("GEMINI_API_KEY missing");
  }
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
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
    // Guard: courseId se interpola en el filtro string. Si no es UUID
    // válido, caemos al global en vez de arriesgar inyección.
    const isUuid = (s: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    if (courseId && isUuid(courseId)) {
      q = q.or(`course_id.eq.${courseId},course_id.is.null`);
    } else {
      q = q.is("course_id", null);
    }
    const { data, error } = await q;
    if (error || !data || data.length === 0) return fallback;
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

const FALLBACK_PROMPT = `Eres un experto en diseño de evaluaciones académicas. Recibes el listado de preguntas de un examen (con tipo, enunciado, puntaje y rúbrica esperada) y la duración actual asignada en minutos.

Tu tarea:
1) Estima cuánto tiempo razonable necesita un estudiante PROMEDIO para resolver cada pregunta.
2) Suma los tiempos individuales para obtener un tiempo recomendado total. Agrega 10-15% de buffer para revisión.
3) Compara contra la duración asignada y sugiere si es: HOLGADA (sobra ≥30%), AJUSTADA (±20%), CORTA (faltan 20-50%) o INSUFICIENTE (faltan >50%).
4) Devuelve suggested_minutes (entero), verdict (uno de los 4) y explanation breve.`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    // ── Authn/Authz ── Solo Docente/Admin: la función ejecuta IA
    // (cuesta créditos) y lee preguntas privadas. Estudiantes no
    // necesitan invocarla.
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
    const { data: roles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", u.user.id);
    const isTeacherOrAdmin = (roles ?? []).some(
      (r: { role: string }) =>
        r.role === "Admin" || r.role === "Docente" || r.role === "SuperAdmin",
    );
    if (!isTeacherOrAdmin) {
      return new Response(
        JSON.stringify({ error: "Solo docentes/admins pueden evaluar la duración" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { examId } = await req.json();
    if (!examId || typeof examId !== "string" || !UUID_RE.test(examId)) {
      throw new Error("examId inválido");
    }

    const { data: exam, error: eErr } = await adminClient
      .from("exams")
      .select("id, title, time_limit_minutes, course_id")
      .eq("id", examId)
      .single();
    if (eErr || !exam) throw new Error("Examen no encontrado");

    // Multi-tenant: resolver modelo activo para el curso del examen.
    setRequestModelHint({
      courseId: (exam as { course_id?: string | null }).course_id ?? null,
      authHeader: req.headers.get("Authorization"),
    });

    // Authz: el caller debe ser docente DEL curso del examen (o Admin).
    // Sin esto cualquier docente puede leer metadata de exámenes de
    // cursos ajenos. Admin / SuperAdmin pasan siempre.
    const isAdmin = (roles ?? []).some(
      (r: { role: string }) => r.role === "Admin" || r.role === "SuperAdmin",
    );
    if (!isAdmin) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const courseId = (exam as any).course_id as string | null;
      if (!courseId) {
        return new Response(JSON.stringify({ error: "Examen sin curso asignado" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: ct } = await adminClient
        .from("course_teachers")
        .select("course_id")
        .eq("course_id", courseId)
        .eq("user_id", u.user.id)
        .maybeSingle();
      if (!ct) {
        return new Response(JSON.stringify({ error: "No eres docente de este curso" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { data: questions, error: qErr } = await adminClient
      .from("questions")
      .select("id, type, content, points, expected_rubric")
      .eq("exam_id", examId)
      .order("position");
    if (qErr) throw qErr;

    if (!questions || questions.length === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "El examen no tiene preguntas para evaluar.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const systemPrompt = await resolveSystemPrompt(
      "exam_time_evaluation",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (exam as any).course_id,
      FALLBACK_PROMPT,
    );

    // Resumen compacto de las preguntas para el user message.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qList = (questions as any[])
      .map((q, i) => {
        const content = (q.content ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
        const rubric = (q.expected_rubric ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
        return `${i + 1}. [${q.type} · ${q.points} pts] ${content}${rubric ? `\n   Rúbrica: ${rubric}` : ""}`;
      })
      .join("\n");

    const currentMinutes = Number((exam as any).time_limit_minutes ?? 0);
    const userMessage = `Examen: "${(exam as any).title}"
Duración actual asignada: ${currentMinutes} minutos.
Cantidad de preguntas: ${questions.length}.

Preguntas:
${qList}

Evalúa si la duración es razonable y sugiere los minutos óptimos.`;

    const aiRes = await aiChatCompletion({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "report_time_evaluation",
            description: "Devolver la sugerencia de duración del examen",
            parameters: {
              type: "object",
              properties: {
                suggested_minutes: {
                  type: "integer",
                  description: "Minutos sugeridos (entero positivo).",
                },
                verdict: {
                  type: "string",
                  enum: ["HOLGADA", "AJUSTADA", "CORTA", "INSUFICIENTE"],
                },
                explanation: {
                  type: "string",
                  description: "Resumen breve por tipo de pregunta y justificación.",
                },
              },
              required: ["suggested_minutes", "verdict", "explanation"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "report_time_evaluation" } },
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
      throw new Error(
        await describeAiError(aiRes, cachedModel?.provider ?? "gemini", errText),
      );
    }

    const aiJson = await aiRes.json();
    const tc = aiJson.choices?.[0]?.message?.tool_calls?.[0];
    const args = tc
      ? JSON.parse(tc.function.arguments)
      : { suggested_minutes: currentMinutes, verdict: "AJUSTADA", explanation: "" };

    return new Response(
      JSON.stringify({
        ok: true,
        current_minutes: currentMinutes,
        suggested_minutes: Math.max(1, Number(args.suggested_minutes) || currentMinutes),
        verdict: String(args.verdict || "AJUSTADA"),
        explanation: String(args.explanation || ""),
        question_count: questions.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
