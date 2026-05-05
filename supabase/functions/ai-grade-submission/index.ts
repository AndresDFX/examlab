// AI grading: scores exam answers or workshop submissions via AI Gateway
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json();
    const KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!KEY) throw new Error("LOVABLE_API_KEY missing");

    // ── Workshop grading mode ──
    if (body.workshopGrading) {
      const {
        workshopTitle,
        workshopInstructions,
        rubric,
        maxScore,
        studentAnswer,
        courseLanguage,
      } = body;
      if (!studentAnswer) throw new Error("studentAnswer requerido");
      const wsLang: "es" | "en" = courseLanguage === "en" ? "en" : "es";
      const wsLangName = wsLang === "en" ? "inglés (English)" : "español";

      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content: `Eres un evaluador académico imparcial. Calificas entregas de talleres según las instrucciones y rúbrica proporcionadas. Devuelves un puntaje numérico entre 0 y ${maxScore ?? 100}, y una retroalimentación detallada.
REGLA DE IDIOMA: responde siempre en el idioma configurado para este curso: ${wsLangName}. Toda la retroalimentación debe estar en ${wsLangName}.`,
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
        }),
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
        : { score: 0, feedback: "No se pudo generar retroalimentación", ai_likelihood: 0, ai_reasons: "" };
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
      } = body;
      if (!studentContent || !fileTitle) {
        throw new Error("fileTitle y studentContent requeridos");
      }
      const pfLang: "es" | "en" = courseLanguage === "en" ? "en" : "es";
      const pfLangName = pfLang === "en" ? "inglés (English)" : "español";

      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content: `Eres un evaluador académico imparcial. Calificas el contenido textual de UN archivo del proyecto de un estudiante. Devuelves un puntaje entre 0 y ${maxPoints} y retroalimentación útil, además de una estimación de probabilidad (0..1) de que el contenido haya sido generado por IA.
REGLA DE IDIOMA: responde siempre en ${pfLangName}.`,
            },
            {
              role: "user",
              content: `Archivo: ${fileTitle}
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
                      description:
                        "Probabilidad 0..1 de que el contenido haya sido generado por IA",
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
        }),
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

      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content: `Eres un evaluador académico imparcial. Calificas la respuesta de un estudiante a UNA pregunta de taller. Devuelves un puntaje entre 0 y ${maxPoints}, y retroalimentación útil en ${wqLangName}.
${extraInstructions}`,
            },
            {
              role: "user",
              content: `Tipo de pregunta: ${questionType}\n\nEnunciado: ${questionContent ?? ""}\n\nRúbrica esperada: ${expectedRubric ?? "Evalúa corrección y completitud."}\n\nPuntaje máximo: ${maxPoints}\n\nRespuesta del estudiante:\n${studentAnswer}\n\nIdioma de salida obligatorio: ${wqLangName}.`,
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
        }),
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
        "py", "js", "ts", "tsx", "jsx", "java", "c", "h", "cpp", "hpp", "cs", "go",
        "rb", "php", "html", "css", "scss", "md", "txt", "json", "yaml", "yml",
        "xml", "sql", "mmd", "puml", "kt", "swift", "rs", "sh",
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

      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-pro",
          messages: [
            {
              role: "system",
              content: `Eres un evaluador académico imparcial y experto. Calificas un proyecto académico de tipo "${project.project_type}" basándote en sus archivos. Devuelves nota entre 0 y ${project.max_score}, retroalimentación detallada y una estimación de probabilidad (0..1) de que el contenido fue generado por IA, con razones.
REGLA DE IDIOMA: responde en ${langName}.`,
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
        }),
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
        const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              {
                role: "system",
                content: `Eres un evaluador imparcial. Calificas respuestas según la rúbrica dada. Devuelves: (1) puntaje entre 0 y el máximo, (2) justificación breve, (3) probabilidad 0..1 de que la respuesta haya sido generada por IA, y (4) razones de esa estimación.
REGLA DE IDIOMA: responde siempre en el idioma configurado para este curso: ${examLangName}. La retroalimentación debe estar en ${examLangName}.`,
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
          }),
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

    // Top 3 razones por likelihood. Si todas las preguntas son cerradas,
    // el bucket queda vacío y los campos ai_* quedan en sus valores por
    // defecto (false / null) — esa también es info útil para el docente.
    const topReasons = aiReasonBuckets
      .filter((b) => b.reason && b.likelihood > 0)
      .sort((a, b) => b.likelihood - a.likelihood)
      .slice(0, 3)
      .map((b) => `[${b.likelihood.toFixed(2)}] ${b.reason}`)
      .join("\n");
    const aiDetected = maxAiLikelihood >= 0.6;
    // Si el docente ya forzó "sospechoso" (proctoring), respetamos ese
    // estado. Si la IA detecta fraude, también marcamos sospechoso para
    // que entre en la cola de revisión manual.
    const newStatus =
      sub.status === "sospechoso" || aiDetected ? "sospechoso" : "completado";

    await admin
      .from("submissions")
      .update({
        ai_grade: grade,
        ai_detected: aiDetected,
        ai_detected_score: maxAiLikelihood,
        ai_detected_reasons: topReasons || null,
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
        ai_likelihood: maxAiLikelihood,
        ai_reasons: topReasons,
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
