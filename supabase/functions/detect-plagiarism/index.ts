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
import { adminClient as admin, userClientFromRequest } from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";
import { getActiveAiModel } from "../_shared/ai-model.ts";

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fallback del system prompt si la fila global de `plagiarism_detection`
// no está en la BD (RLS/red). El seed completo vive en la migración
// 20260508160000_ai_prompts_plagio_y_ia.sql.
const PLAGIARISM_FALLBACK = `Eres un detector de copia académica entre estudiantes. Recibes el ENUNCIADO de la pregunta y una lista numerada de respuestas a la MISMA pregunta. Identifica pares cuyas similitudes NO se justifican por el enunciado: mismos nombres de variables/funciones no pedidos, mismos strings/literales, mismos errores o typos, mismos comentarios palabra por palabra, formato/orden inusual idéntico. NO cuentan: boilerplate del lenguaje, estructura de control obvia, nombres genéricos (i, j, temp), salidas exactas que pide el enunciado, plantillas/starter code. Score 0.85+ requiere VARIOS marcadores no triviales; 0.6-0.85 al menos un marcador fuerte; <0.6 no reportes. Para cada par sospechoso devuelve idx_a, idx_b, score (0..1) y una razón breve y CONCRETA citando los marcadores específicos.`;

/**
 * Resuelve el system prompt de plagiarism_detection considerando override
 * por curso si existe. Patrón idéntico a `resolveSystemPrompt` en
 * ai-grade-submission/index.ts pero en su propia función para no acoplar
 * los dos edge functions.
 */
async function resolvePlagiarismPrompt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  courseId: string | null | undefined,
): Promise<string> {
  try {
    let q = admin
      .from("ai_prompts")
      .select("system_prompt, course_id")
      .eq("use_case", "plagiarism_detection");
    if (courseId && UUID_RE.test(courseId)) {
      q = q.or(`course_id.eq.${courseId},course_id.is.null`);
    } else {
      q = q.is("course_id", null);
    }
    const { data, error } = await q;
    if (error || !data || data.length === 0) return PLAGIARISM_FALLBACK;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sorted = [...data].sort((a: any, b: any) => {
      if (a.course_id && !b.course_id) return -1;
      if (!a.course_id && b.course_id) return 1;
      return 0;
    });
    return sorted[0]?.system_prompt || PLAGIARISM_FALLBACK;
  } catch (e) {
    console.warn("[ai_prompts] plagiarism resolve failed, using fallback:", e);
    return PLAGIARISM_FALLBACK;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  let auditActorId: string | null = null;
  let auditKind: string | null = null;
  let auditRefId: string | null = null;
  try {
    // ── Authn/Authz ──
    // La detección lee submissions de OTROS estudiantes y ejecuta IA
    // (cuesta créditos). Solo Docente/Admin puede invocarla. Sin esto
    // un estudiante con curiosidad podría exfiltrar metadatos / DoS.
    const userClient = userClientFromRequest(req);
    if (!userClient) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", u.user.id);
    const isTeacherOrAdmin = (roles ?? []).some(
      (r: { role: string }) =>
        r.role === "Admin" || r.role === "Docente" || r.role === "SuperAdmin",
    );
    if (!isTeacherOrAdmin) {
      return new Response(
        JSON.stringify({ error: "Solo docentes/admins pueden ejecutar la detección de copia" }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    auditActorId = u.user.id;
    const { kind, refId, submissionIds } = await req.json();
    if (!kind || !refId) throw new Error("kind y refId requeridos");
    if (!["exam", "workshop", "project"].includes(kind)) {
      throw new Error("kind inválido");
    }
    if (typeof refId !== "string" || !UUID_RE.test(refId)) {
      throw new Error("refId inválido");
    }
    // Filtro opcional: si el cliente manda submissionIds, solo se
    // analizan esas entregas (típicamente el último intento de cada
    // alumno). Reduce el cap de 30 items/llamada y evita comparar contra
    // intentos viejos donde el alumno ya corrigió. Si no se manda,
    // comportamiento histórico (todas las entregas válidas).
    const submissionFilter: Set<string> | null =
      Array.isArray(submissionIds) && submissionIds.length > 0
        ? new Set(
            submissionIds.filter(
              (id: unknown): id is string => typeof id === "string" && UUID_RE.test(id),
            ),
          )
        : null;
    auditKind = kind;
    auditRefId = refId;
    void auditFromEdge(admin, {
      actorId: auditActorId,
      action: "fraud.plagiarism_detection_started",
      category: "fraud",
      severity: "info",
      entityType: kind,
      entityId: refId,
      metadata: { kind },
    });

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) =>
          s.status !== "iniciado" &&
          s.answers &&
          (!submissionFilter || submissionFilter.has(s.id)),
      );
      for (const q of questions ?? []) {
        if (q.type === "cerrada" || q.type === "cerrada_multi") continue;
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
            questionLabel: `Pregunta ${q.position ?? "?"}: ${q.content ?? ""}`.slice(0, 1000),
            items,
          });
        }
      }
    } else if (kind === "workshop") {
      // Modelo nuevo: las respuestas viven en workshop_submission_answers
      // (una fila por pregunta). Comparamos por pregunta — análoga a
      // como hacemos con exámenes — para no diluir la señal mezclando
      // respuestas de preguntas distintas.
      const { data: subs, error: sErr } = await admin
        .from("workshop_submissions")
        .select("id, user_id, status, content")
        .eq("workshop_id", refId);
      if (sErr) throw sErr;
      const { data: qs, error: qErr } = await admin
        .from("workshop_questions")
        .select("id, type, content, position")
        .eq("workshop_id", refId)
        .order("position");
      if (qErr) throw qErr;

      const submissionIds = (subs ?? []).map((s: any) => s.id);
      const userBySub = new Map<string, string>();
      ((subs ?? []) as any[]).forEach((s) => userBySub.set(s.id, s.user_id));

      let answers: any[] = [];
      if (submissionIds.length > 0) {
        const { data: ans, error: aErr } = await admin
          .from("workshop_submission_answers")
          .select(
            "submission_id, question_id, answer_text, code_content, diagram_code, selected_option",
          )
          .in("submission_id", submissionIds);
        if (aErr) throw aErr;
        answers = ans ?? [];
      }

      // Agrupar por pregunta
      const ansByQ = new Map<string, any[]>();
      for (const a of answers) {
        const key = a.question_id;
        if (!ansByQ.has(key)) ansByQ.set(key, []);
        ansByQ.get(key)!.push(a);
      }

      for (const q of qs ?? []) {
        if ((q as any).type === "cerrada" || (q as any).type === "cerrada_multi") continue;
        const list = ansByQ.get((q as any).id) ?? [];
        const items: Item[] = list
          .map((a: any) => {
            const text = a.code_content ?? a.diagram_code ?? a.answer_text ?? "";
            const userId = userBySub.get(a.submission_id) ?? "";
            return {
              submissionId: a.submission_id as string,
              userId,
              text: String(text).slice(0, MAX_CHARS_PER_TEXT),
            };
          })
          .filter((x) => x.userId && x.text.trim().length >= MIN_TEXT_LENGTH);
        if (items.length >= 2) {
          groups.push({
            questionId: (q as any).id as string,
            questionLabel: `Pregunta ${(q as any).position ?? "?"}: ${
              (q as any).content ?? ""
            }`.slice(0, 1000),
            items,
          });
        }
      }

      // Fallback legacy: si NO hay preguntas configuradas o ninguna trajo
      // respuestas, intentamos el modelo viejo de "una entrega = un texto"
      // en workshop_submissions.content. Cubre talleres antiguos.
      if (groups.length === 0) {
        const items: Item[] = ((subs ?? []) as any[])
          .map((s) => ({
            submissionId: s.id as string,
            userId: s.user_id as string,
            text: ((s.content as string) ?? "").slice(0, MAX_CHARS_PER_TEXT),
          }))
          .filter((x) => x.text.trim().length >= MIN_TEXT_LENGTH);
        if (items.length >= 2) {
          groups.push({ questionId: null, questionLabel: "Entrega", items });
        }
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

    // Resolvemos el system prompt una sola vez por invocación. Si el
    // examen/taller/proyecto pertenece a un curso con override de
    // `plagiarism_detection`, ese gana. Si no, usamos el global del
    // sistema y, en último caso, el fallback hardcoded.
    const refTable = kind === "exam" ? "exams" : kind === "workshop" ? "workshops" : "projects";
    const { data: refRow } = await admin
      .from(refTable)
      .select("course_id")
      .eq("id", refId)
      .maybeSingle();
    const refCourseId = (refRow as { course_id?: string } | null)?.course_id ?? null;
    const systemPrompt = await resolvePlagiarismPrompt(admin, refCourseId);

    // Resolver provider/key/modelo activo del tenant (vía courseId).
    // Si el tenant no tiene config o la key falta, getActiveAiModel cae a
    // fallback hardcoded (Gemini) y el fetch fallará con mensaje claro.
    const activeModel = await getActiveAiModel({ courseId: refCourseId });
    let aiUrl: string;
    let aiKey: string | undefined;
    if (activeModel.provider === "openai") {
      aiUrl = "https://api.openai.com/v1/chat/completions";
      aiKey = activeModel.openai_api_key ?? Deno.env.get("OPENAI_API_KEY");
    } else {
      aiUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      aiKey = activeModel.gemini_api_key ?? Deno.env.get("GEMINI_API_KEY");
    }
    if (!aiKey) {
      throw new Error(
        `Falta la API key de ${activeModel.provider}. Configúrala en Admin → IA → Modelo.`,
      );
    }

    // Borrado idempotente: cualquier corrida re-genera los pares
    // PENDIENTES de revisar. Los pares ya marcados como revisados
    // por el docente (reviewed_at IS NOT NULL) sobreviven la corrida
    // — la idea es que la detección no re-marque algo que el docente
    // ya analizó. Los reviews quedan congelados hasta que él los
    // desmarque manualmente.
    await admin
      .from("similarity_pairs")
      .delete()
      .eq("kind", kind)
      .eq("ref_id", refId)
      .is("reviewed_at", null);

    // Pares revisados existentes: usados más abajo para NO reinsertar
    // duplicados (no podemos confiar en una UNIQUE porque la tabla
    // no la tiene; matcheamos por la tupla canónica).
    const { data: reviewedRows } = await admin
      .from("similarity_pairs")
      .select("submission_a, submission_b, question_id")
      .eq("kind", kind)
      .eq("ref_id", refId)
      .not("reviewed_at", "is", null);
    const reviewedKeys = new Set(
      (
        (reviewedRows ?? []) as Array<{
          submission_a: string;
          submission_b: string;
          question_id: string | null;
        }>
      ).map((r) => `${r.submission_a}::${r.submission_b}::${r.question_id ?? ""}`),
    );

    const inserted: any[] = [];
    for (const group of groups) {
      const items = group.items.slice(0, MAX_ITEMS_PER_CALL);
      const idxList = items.map((it, i) => `[${i}]\n${it.text}`).join("\n\n---\n\n");

      const aiRes = await fetch(aiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${aiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: activeModel.model,
          messages: [
            {
              role: "system",
              // Prompt resuelto vía ai_prompts (use_case='plagiarism_detection'):
              // override de curso > global > fallback. Editable desde
              // /app/admin/ai-prompts y /app/teacher/ai-prompts.
              content: `${systemPrompt}\n\nSolo reporta pares con score >= ${MIN_REPORT_SCORE}.`,
            },
            {
              role: "user",
              content: `Enunciado:\n${group.questionLabel}\n\nRespuestas:\n\n${idxList}\n\nDevuelve los pares sospechosos comparando contra el enunciado para distinguir similitud necesaria vs evidencia de copia.`,
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
        // Skip si este par ya quedó revisado por el docente — no
        // sobrescribimos el review.
        const key = `${subA}::${subB}::${group.questionId ?? ""}`;
        if (reviewedKeys.has(key)) continue;
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

    void auditFromEdge(admin, {
      actorId: auditActorId,
      action: "fraud.plagiarism_detected",
      category: "fraud",
      severity: inserted > 0 ? "warning" : "info",
      entityType: auditKind ?? undefined,
      entityId: auditRefId,
      metadata: {
        kind: auditKind,
        pairs_found: inserted,
        groups_compared: groups.length,
      },
    });
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
    void auditFromEdge(admin, {
      actorId: auditActorId,
      action: "fraud.plagiarism_detection_failed",
      category: "fraud",
      severity: "error",
      entityType: auditKind ?? undefined,
      entityId: auditRefId,
      metadata: { kind: auditKind, error: e instanceof Error ? e.message : String(e) },
    });
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
