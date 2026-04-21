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
                description: "Calificar entrega de taller",
                parameters: {
                  type: "object",
                  properties: {
                    score: { type: "number", description: `Puntaje entre 0 y ${maxScore ?? 100}` },
                    feedback: {
                      type: "string",
                      description: "Retroalimentación detallada en español",
                    },
                  },
                  required: ["score", "feedback"],
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
        : { score: 0, feedback: "No se pudo generar retroalimentación" };
      const score = Math.max(0, Math.min(Number(maxScore ?? 100), Number(args.score) || 0));

      return new Response(JSON.stringify({ ok: true, grade: score, feedback: args.feedback }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
      .select("course:courses(language)")
      .eq("id", sub.exam_id)
      .maybeSingle();
    const examLang: "es" | "en" = examMeta?.course?.language === "en" ? "en" : "es";
    const examLangName = examLang === "en" ? "inglés (English)" : "español";

    const answers: Record<string, any> = sub.answers || {};
    const prevBreakdown: any[] = Array.isArray(answers.__breakdown) ? answers.__breakdown : [];
    const prevById = new Map(prevBreakdown.map((b: any) => [b.qid, b]));
    let totalPoints = 0;
    let earned = 0;
    const breakdown: any[] = [];

    for (const q of questions || []) {
      // If only one question is requested, skip the rest but preserve prior scores
      if (questionId && q.id !== questionId) {
        const prev = prevById.get(q.id);
        totalPoints += Number(q.points);
        if (prev) {
          earned += Number(prev.earned) || 0;
          breakdown.push(prev);
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
                content: `Eres un evaluador imparcial. Calificas respuestas según la rúbrica dada. Devuelves un puntaje entre 0 y el máximo, y una breve justificación.
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
                  description: "Calificar respuesta",
                  parameters: {
                    type: "object",
                    properties: {
                      score: { type: "number" },
                      feedback: { type: "string" },
                    },
                    required: ["score", "feedback"],
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
        const args = tc ? JSON.parse(tc.function.arguments) : { score: 0, feedback: "" };
        const score = Math.max(0, Math.min(Number(q.points), Number(args.score) || 0));
        earned += score;
        breakdown.push({
          qid: q.id,
          type: q.type,
          points: q.points,
          earned: score,
          feedback: args.feedback,
        });
      }
    }

    const grade = totalPoints > 0 ? Number(((earned / totalPoints) * 10).toFixed(2)) : 0;

    await admin
      .from("submissions")
      .update({
        ai_grade: grade,
        status: sub.status === "sospechoso" ? "sospechoso" : "completado",
        submitted_at: sub.submitted_at ?? new Date().toISOString(),
        answers: { ...answers, __breakdown: breakdown },
      })
      .eq("id", submissionId);

    return new Response(JSON.stringify({ ok: true, grade, breakdown }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
