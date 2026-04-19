// AI question generator using Lovable AI Gateway (Gemini)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { topics, type, count = 5, examId } = await req.json();
    if (!topics || !type || !examId) {
      return new Response(JSON.stringify({ error: "topics, type, examId requeridos" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!KEY) throw new Error("LOVABLE_API_KEY missing");

    const systemPrompt = `Eres un asistente experto en evaluación académica. Generas preguntas de examen claras, sin ambigüedad, en español. Para cada pregunta incluyes una rúbrica de evaluación (qué debe contener una respuesta correcta).`;

    const userPrompt = `Genera ${count} preguntas de tipo "${type}" sobre los siguientes temas: ${topics}.
${type === "cerrada" ? "Cada pregunta debe tener 4 opciones (A, B, C, D) con UNA correcta." : ""}
${type === "codigo" ? "Las preguntas deben pedir escribir código (especifica el lenguaje si aplica)." : ""}
La rúbrica debe describir los criterios para considerar correcta la respuesta.`;

    const tools = [{
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
                  options: type === "cerrada" ? {
                    type: "object",
                    properties: {
                      choices: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
                      correct_index: { type: "integer", minimum: 0, maximum: 3 },
                    },
                    required: ["choices", "correct_index"],
                  } : { type: "object", properties: {} },
                },
                required: ["content", "expected_rubric"],
              },
            },
          },
          required: ["questions"],
        },
      },
    }];

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
        tools,
        tool_choice: { type: "function", function: { name: "create_questions" } },
      }),
    });

    if (aiRes.status === 429) return new Response(JSON.stringify({ error: "Límite de uso de IA. Intenta en un momento." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (aiRes.status === 402) return new Response(JSON.stringify({ error: "Sin créditos de IA. Agrega créditos en Settings → Workspace → Usage." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (!aiRes.ok) {
      const t = await aiRes.text();
      console.error("AI error", aiRes.status, t);
      throw new Error("Error en gateway de IA");
    }

    const aiJson = await aiRes.json();
    const toolCall = aiJson.choices?.[0]?.message?.tool_calls?.[0];
    const args = toolCall ? JSON.parse(toolCall.function.arguments) : { questions: [] };
    const questions = args.questions || [];

    // Insert into DB using service role (auth checked via JWT below)
    const authHeader = req.headers.get("Authorization");
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader ?? "" } } },
    );
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return new Response(JSON.stringify({ error: "No autenticado" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // Find current max position
    const { data: existing } = await admin.from("questions").select("position").eq("exam_id", examId).order("position", { ascending: false }).limit(1);
    let pos = existing?.[0]?.position ?? -1;

    const toInsert = questions.map((q: any) => ({
      exam_id: examId,
      type,
      content: q.content,
      expected_rubric: q.expected_rubric,
      options: q.options ?? null,
      position: ++pos,
      points: 1,
    }));
    const { data: inserted, error: insErr } = await admin.from("questions").insert(toInsert).select();
    if (insErr) throw insErr;

    return new Response(JSON.stringify({ ok: true, inserted }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
