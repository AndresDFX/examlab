// AI question generator via AI Gateway (Gemini)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();

    // ── Modo: generación de DESCRIPCIÓN de proyecto (contexto global) ──
    // Body: { projectDescriptionGeneration: true, topic, courseId?, courseLanguage? }
    // Devuelve { ok, description } — un texto plano corto que sirve como
    // contexto para todas las preguntas del proyecto. La descripción se
    // inyecta en cada llamada de calificación de `ai-grade-submission`
    // para que cada pregunta se evalúe sin perder de vista el alcance.
    if (body.projectDescriptionGeneration) {
      const KEYD = Deno.env.get("LOVABLE_API_KEY");
      if (!KEYD) throw new Error("LOVABLE_API_KEY missing");
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
      const adminPD = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const fallback = `Eres un docente experto que redacta la descripción de un proyecto académico. Sé concreto y conciso (3-6 oraciones). Indica el propósito, alcance y restricciones. NO listes entregables uno por uno (van en cada pregunta). NO uses encabezados Markdown — texto plano corrido. Devuelve solo la descripción.`;
      const systemPrompt = await resolveSystemPrompt(
        adminPD,
        "project_description",
        courseId,
        fallback,
      );

      const aiResD = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEYD}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
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
        }),
      });
      if (aiResD.status === 429) {
        return new Response(JSON.stringify({ error: "Límite de uso de IA. Intenta luego." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResD.status === 402) {
        return new Response(JSON.stringify({ error: "Sin créditos de IA." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!aiResD.ok) {
        const err = await aiResD.text();
        console.error("AI error", aiResD.status, err);
        throw new Error("Error en gateway de IA");
      }
      const aiJsonD = await aiResD.json();
      const description: string = aiJsonD.choices?.[0]?.message?.content?.toString().trim() ?? "";
      return new Response(JSON.stringify({ ok: true, description }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
    // Solo aplica para proyectos: descripción global del proyecto que
    // sirve como contexto al modelo. El cliente la trae de
    // `projects.description`. Si viene vacío, no se inyecta.
    const projectDescription: string | null =
      isProject && typeof body.projectDescription === "string" && body.projectDescription.trim()
        ? body.projectDescription.trim()
        : null;
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
    // Para `codigo` (textarea de un solo archivo) y `codigo_zip` (ZIP del
    // proyecto completo) la IA usa el lenguaje sugerido para redactar
    // el enunciado. En `codigo_zip` solo es una guía — el ZIP puede
    // traer múltiples lenguajes y la IA igual califica.
    if (type === "codigo" || type === "codigo_zip") {
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

    // Para proyectos: prepende la descripción del proyecto al user
    // prompt para que las preguntas generadas estén alineadas con el
    // alcance/propósito definido por el docente, no como temas sueltos.
    const projectCtx = projectDescription
      ? `Contexto global del proyecto (úsalo para que las preguntas generadas tengan sentido dentro de este proyecto, no como temas aislados):\n${projectDescription}\n\n`
      : "";

    const userPrompt = `${projectCtx}Genera ${count} preguntas de tipo "${type}" sobre los siguientes temas: ${topics}.
${type === "cerrada" ? "Cada pregunta debe tener 4 opciones (A, B, C, D) con UNA correcta." : ""}
${type === "codigo" ? `Las preguntas deben pedir escribir código en el lenguaje ${codeLanguage}. Indica claramente en el enunciado que la solución debe implementarse en ${codeLanguage}.` : ""}
${type === "codigo_zip" ? `Cada pregunta describe un componente o módulo a implementar. El estudiante entregará UN ARCHIVO .ZIP con todo su código fuente del proyecto (varios archivos), y la IA evaluará ese ZIP contra esta rúbrica. Lenguaje principal sugerido: ${codeLanguage}. Indica en el enunciado el alcance esperado y los archivos/clases que deben formar parte del entregable.` : ""}
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
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
