// AI question generator via AI Gateway (Gemini)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();

    // ── Modo: generación de enunciado de PROYECTO ──
    if (body.projectStatement) {
      const KEY = Deno.env.get("LOVABLE_API_KEY");
      if (!KEY) throw new Error("LOVABLE_API_KEY missing");
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

      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-pro",
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
        }),
      });

      if (aiRes.status === 429) {
        return new Response(JSON.stringify({ error: "Límite de uso de IA. Intenta luego." }), {
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
        const err = await aiRes.text();
        console.error("AI error", aiRes.status, err);
        throw new Error("Error en gateway de IA");
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

    // ── Modo: generación de ARCHIVOS esperados de un proyecto ──
    // Body: { projectFilesGeneration: true, projectId, topic, count, courseLanguage }
    // Devuelve y persiste N rows en `project_files` con title/description/expected_rubric.
    if (body.projectFilesGeneration) {
      const KEY2 = Deno.env.get("LOVABLE_API_KEY");
      if (!KEY2) throw new Error("LOVABLE_API_KEY missing");
      const { projectId, topic, count: pfCount = 3, courseLanguage: pfLang } = body;
      if (!projectId || !topic) {
        return new Response(JSON.stringify({ error: "projectId y topic requeridos" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const cnt = Math.max(1, Math.min(20, Number(pfCount) || 3));

      // Resolve course language from project → course
      const adminPF = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
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

      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY2}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
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
        }),
      });

      if (aiRes.status === 429) {
        return new Response(JSON.stringify({ error: "Límite de uso de IA. Intenta luego." }), {
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
        const err = await aiRes.text();
        console.error("AI error", aiRes.status, err);
        throw new Error("Error en gateway de IA");
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
    // targetTable: "questions" (default) | "workshop_questions" | "project_files"
    const isWorkshop = targetTable === "workshop_questions";
    const isProject = targetTable === "project_files";
    const targetId = examId;
    if (!topics || !type || !targetId) {
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
    if (type === "codigo") {
      codeLanguage = allowedLanguages.has(language) ? language : "java";
    }

    const KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!KEY) throw new Error("LOVABLE_API_KEY missing");

    const admin0 = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
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

    const systemPrompt = `Eres un asistente experto en evaluación académica. Generas preguntas de examen claras, sin ambigüedad. Para cada pregunta incluyes una rúbrica de evaluación (qué debe contener una respuesta correcta).
REGLA DE IDIOMA: Responde siempre en el idioma configurado para este curso: ${langName}. Todos los enunciados, opciones y rúbricas deben estar en ${langName}.`;

    const userPrompt = `Genera ${count} preguntas de tipo "${type}" sobre los siguientes temas: ${topics}.
${type === "cerrada" ? "Cada pregunta debe tener 4 opciones (A, B, C, D) con UNA correcta." : ""}
${type === "codigo" ? `Las preguntas deben pedir escribir código en el lenguaje ${codeLanguage}. Indica claramente en el enunciado que la solución debe implementarse en ${codeLanguage}.` : ""}
La rúbrica debe describir los criterios para considerar correcta la respuesta.
Idioma de salida obligatorio: ${langName}.`;

    const tools = [
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

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools,
        tool_choice: { type: "function", function: { name: "create_questions" } },
      }),
    });

    if (aiRes.status === 429)
      return new Response(
        JSON.stringify({ error: "Límite de uso de IA. Intenta en un momento." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    if (aiRes.status === 402)
      return new Response(
        JSON.stringify({
          error: "Sin créditos de IA. Agrega créditos en Settings → Workspace → Usage.",
        }),
        { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
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
    if (!u.user)
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const tableName = isWorkshop ? "workshop_questions" : "questions";
    const fkColumn = isWorkshop ? "workshop_id" : "exam_id";

    // Find current max position
    const { data: existing } = await admin
      .from(tableName)
      .select("position")
      .eq(fkColumn, targetId)
      .order("position", { ascending: false })
      .limit(1);
    let pos = existing?.[0]?.position ?? -1;

    const toInsert = questions.map((q: any) => ({
      [fkColumn]: targetId,
      type,
      content: q.content,
      expected_rubric: q.expected_rubric,
      options: q.options ?? null,
      position: ++pos,
      points: 1,
      language: codeLanguage,
    }));
    const { data: inserted, error: insErr } = await admin
      .from(tableName)
      .insert(toInsert)
      .select();
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
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
