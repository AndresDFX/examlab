// Detección de copia entre estudiantes (peer-to-peer plagiarism).
// Body: { kind: 'exam' | 'workshop' | 'project', refId: string }
//
// Para cada examen/taller cargamos las entregas y, por pregunta cuando
// aplica, le pasamos a Gemini la lista numerada de respuestas. Gemini
// responde solo los pares sospechosos con score >= 0.6 y una razón.
// Estrategia idempotente: borramos los similarity_pairs anteriores
// para (kind, ref_id) y reinsertamos los nuevos. Así el docente puede
// re-ejecutar la detección cuando lleguen nuevas entregas sin tener
// que limpiar manualmente.
//
// Limitaciones conocidas:
//  - Cap de 30 respuestas por llamada para no reventar el contexto.
//    Cursos con >30 entregas no obtienen comparación cruzada exhaustiva.
//  - Cap de 3000 chars por respuesta — basta para casi todo en talleres
//    cortos / preguntas de examen, pero recorta proyectos largos.
//  - 'project' (ZIP) está soportado pero solo compara metadata textual
//    accesible (ai_feedback). Implementación completa requeriría
//    descomprimir N ZIPs por llamada — caro y poco útil con muchas
//    entregas. Si se necesita, se hace en una v2.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Item {
  submissionId: string;
  userId: string;
  text: string;
}

interface Group {
  questionId: string | null;
  questionLabel: string;
  items: Item[];
}

const MAX_ITEMS_PER_CALL = 30;
const MAX_CHARS_PER_TEXT = 3000;
const MIN_TEXT_LENGTH = 30;
const MIN_REPORT_SCORE = 0.6;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!KEY) throw new Error("LOVABLE_API_KEY missing");
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { kind, refId } = await req.json();
    if (!kind || !refId) throw new Error("kind y refId requeridos");
    if (!["exam", "workshop", "project"].includes(kind)) {
      throw new Error("kind inválido");
    }

    // Construye los grupos a comparar según el tipo.
    const groups: Group[] = [];

    if (kind === "exam") {
      const { data: subs, error: sErr } = await admin
        .from("submissions")
        .select("id, user_id, answers, status")
        .eq("exam_id", refId);
      if (sErr) throw sErr;
      const { data: questions, error: qErr } = await admin
        .from("questions")
        .select("id, type, content, position")
        .eq("exam_id", refId)
        .order("position");
      if (qErr) throw qErr;

      const valid = (subs ?? []).filter(
        (s: any) => s.status !== "iniciado" && s.answers,
      );
      for (const q of questions ?? []) {
        if (q.type === "cerrada") continue;
        const items: Item[] = valid
          .map((s: any) => {
            const ans = s.answers?.[q.id];
            let text = "";
            if (typeof ans === "string") text = ans;
            else if (ans != null) text = JSON.stringify(ans);
            return {
              submissionId: s.id as string,
              userId: s.user_id as string,
              text: text.slice(0, MAX_CHARS_PER_TEXT),
            };
          })
          .filter((x) => x.text.trim().length >= MIN_TEXT_LENGTH);
        if (items.length >= 2) {
          groups.push({
            questionId: q.id as string,
            questionLabel: `Pregunta ${q.position ?? "?"}`,
            items,
          });
        }
      }
    } else if (kind === "workshop") {
      const { data: subs, error } = await admin
        .from("workshop_submissions")
        .select("id, user_id, content")
        .eq("workshop_id", refId);
      if (error) throw error;
      const items: Item[] = (subs ?? [])
        .map((s: any) => ({
          submissionId: s.id as string,
          userId: s.user_id as string,
          text: ((s.content as string) ?? "").slice(0, MAX_CHARS_PER_TEXT),
        }))
        .filter((x) => x.text.trim().length >= MIN_TEXT_LENGTH);
      if (items.length >= 2) {
        groups.push({ questionId: null, questionLabel: "Entrega", items });
      }
    } else if (kind === "project") {
      // v1: comparamos ai_feedback como proxy textual del contenido del
      // proyecto. No compara código fuente del ZIP — eso queda para v2.
      const { data: subs, error } = await admin
        .from("project_submissions")
        .select("id, user_id, ai_feedback")
        .eq("project_id", refId);
      if (error) throw error;
      const items: Item[] = (subs ?? [])
        .map((s: any) => ({
          submissionId: s.id as string,
          userId: s.user_id as string,
          text: ((s.ai_feedback as string) ?? "").slice(0, MAX_CHARS_PER_TEXT),
        }))
        .filter((x) => x.text.trim().length >= MIN_TEXT_LENGTH);
      if (items.length >= 2) {
        groups.push({ questionId: null, questionLabel: "Resumen IA", items });
      }
    }

    if (groups.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          pairs: [],
          groups_compared: 0,
          message: "No hay suficientes entregas con texto para comparar.",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Borrado idempotente: cualquier corrida re-genera los pares.
    await admin.from("similarity_pairs").delete().eq("kind", kind).eq("ref_id", refId);

    const inserted: any[] = [];
    for (const group of groups) {
      const items = group.items.slice(0, MAX_ITEMS_PER_CALL);
      const idxList = items
        .map((it, i) => `[${i}]\n${it.text}`)
        .join("\n\n---\n\n");

      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content: `Eres un detector de copia académica entre estudiantes. Recibes una lista numerada de respuestas a la MISMA pregunta o entrega. Identifica pares de respuestas que parecen copiadas entre sí (no de internet — eso es otro análisis). Para cada par sospechoso devuelve idx_a, idx_b, score 0..1 y una razón breve. Solo reporta pares con score >= ${MIN_REPORT_SCORE}. Ignora coincidencias triviales (saludos, palabras genéricas, "hola mundo", definiciones de libro de texto). Las respuestas idénticas o casi idénticas tienen score >= 0.85.`,
            },
            {
              role: "user",
              content: `${group.questionLabel}\n\nRespuestas:\n\n${idxList}\n\nDevuelve los pares sospechosos.`,
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "report_pairs",
                description: "Reportar pares de respuestas sospechosamente similares",
                parameters: {
                  type: "object",
                  properties: {
                    pairs: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          idx_a: { type: "integer" },
                          idx_b: { type: "integer" },
                          score: { type: "number" },
                          reason: { type: "string" },
                        },
                        required: ["idx_a", "idx_b", "score", "reason"],
                      },
                    },
                  },
                  required: ["pairs"],
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "report_pairs" } },
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
        continue;
      }

      const aiJson = await aiRes.json();
      const tc = aiJson.choices?.[0]?.message?.tool_calls?.[0];
      const args = tc ? JSON.parse(tc.function.arguments) : { pairs: [] };
      const pairs: Array<{
        idx_a: number;
        idx_b: number;
        score: number;
        reason: string;
      }> = Array.isArray(args.pairs) ? args.pairs : [];

      const rowsToInsert: any[] = [];
      for (const p of pairs) {
        const a = items[p.idx_a];
        const b = items[p.idx_b];
        if (!a || !b) continue;
        if (a.submissionId === b.submissionId) continue;
        const score = Math.max(0, Math.min(1, Number(p.score) || 0));
        if (score < MIN_REPORT_SCORE) continue;
        // Canonicaliza orden (submission_a < submission_b) para que el
        // CHECK constraint pase y para evitar pares duplicados a→b/b→a.
        let subA = a.submissionId;
        let subB = b.submissionId;
        let userA = a.userId;
        let userB = b.userId;
        if (subA > subB) {
          [subA, subB] = [subB, subA];
          [userA, userB] = [userB, userA];
        }
        rowsToInsert.push({
          kind,
          ref_id: refId,
          question_id: group.questionId,
          submission_a: subA,
          submission_b: subB,
          user_a: userA,
          user_b: userB,
          score,
          method: "gemini",
          reasons: p.reason ?? null,
        });
      }

      if (rowsToInsert.length > 0) {
        const { data: ins, error: insErr } = await admin
          .from("similarity_pairs")
          .insert(rowsToInsert)
          .select();
        if (insErr) {
          console.error("similarity_pairs insert", insErr);
        } else if (ins) {
          inserted.push(...ins);
        }
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        pairs: inserted,
        groups_compared: groups.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error(e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
