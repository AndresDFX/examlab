// Edge function: generate-contents
//
// Genera material académico (.pptx + .md) a partir de un tópico y un
// modo (curso completo / material individual). Llama al modelo IA con
// el system prompt almacenado en `ai_prompts.use_case='content_generation'`,
// parsea los bloques [INICIO_ARCHIVO]/[FIN_ARCHIVO], y persiste cada
// bloque como archivo de texto en el bucket `generated-contents`. La
// transformación a .pptx real se hace client-side con pptxgenjs en el
// momento de descarga (no requiere libs nativas en Deno).
//
// Body esperado: { id: uuid }  → id del row en `generated_contents`.
// El cliente debe haber INSERT antes con status='queued'; este handler
// pasa a 'processing', llama IA, parsea, sube archivos y deja 'done'.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const adminClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

let cachedModel: { provider: "lovable" | "openai"; model: string } | null = null;
async function getActiveAiModel() {
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
    console.warn("[ai_model_settings]", e);
  }
  cachedModel = { provider: "lovable", model: "google/gemini-2.5-pro" };
  return cachedModel;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function aiChat(messages: any[]): Promise<Response> {
  const m = await getActiveAiModel();
  const url =
    m.provider === "openai"
      ? "https://api.openai.com/v1/chat/completions"
      : "https://ai.gateway.lovable.dev/v1/chat/completions";
  const key =
    m.provider === "openai" ? Deno.env.get("OPENAI_API_KEY") : Deno.env.get("LOVABLE_API_KEY");
  if (!key) throw new Error(`${m.provider.toUpperCase()}_API_KEY missing`);
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: m.model, messages }),
  });
}

/**
 * Resuelve el system prompt global para el use_case `content_generation`.
 * Hace fallback al texto vacío si la tabla viene mal — la edge function
 * imprime warning pero igual responde para no romper la generación.
 */
async function resolveContentPrompt(): Promise<string> {
  const { data } = await adminClient
    .from("ai_prompts")
    .select("system_prompt")
    .eq("use_case", "content_generation")
    .is("course_id", null)
    .maybeSingle();
  return (data?.system_prompt as string) ?? "";
}

/**
 * Sustituye los placeholders del system prompt con los valores
 * concretos de la generación. Usamos {{key}} para mantener el contrato
 * con el prompt que el admin edita.
 */
function applyPlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? "");
}

/**
 * Parsea bloques [INICIO_ARCHIVO: NAME]…[FIN_ARCHIVO: NAME] del output
 * crudo de la IA. Devuelve `{ name, body }[]` en el orden en que
 * aparecen. Tolera espacios extra y mayúsculas/minúsculas en NAME.
 */
function parseFileBlocks(raw: string): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = [];
  // Regex laxo: captura cualquier nombre hasta `]`, body lazy hasta el
  // siguiente FIN_ARCHIVO con el MISMO nombre. Usamos [\s\S] para que .
  // matchee newlines.
  const re = /\[INICIO_ARCHIVO:\s*([^\]]+?)\s*\]([\s\S]*?)\[FIN_ARCHIVO:\s*\1\s*\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const name = match[1].trim();
    const body = match[2].trim();
    blocks.push({ name, body });
  }
  return blocks;
}

/**
 * Heurística para clasificar el bloque: si el nombre termina en .PPTX
 * lo guardamos como `pptx-source` (el cliente lo convierte). Si termina
 * en .MD es markdown directo. Cualquier otro queda como `txt`.
 */
function blockKind(name: string): "pptx-source" | "md" | "txt" {
  const n = name.toUpperCase();
  if (n.endsWith(".PPTX")) return "pptx-source";
  if (n.endsWith(".MD")) return "md";
  return "txt";
}

/**
 * Sanea el nombre para usarlo como filename del bucket. Reemplaza
 * caracteres no seguros y conserva la extensión.
 */
function safeFileName(name: string, fallbackIndex: number): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (!base || base === "_") return `archivo_${fallbackIndex}.txt`;
  return base;
}

interface RequestBody {
  id: string;
}

interface FileEntry {
  name: string;
  path: string;
  kind: "pptx-source" | "md" | "txt";
  body: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!body?.id) {
    return new Response(JSON.stringify({ error: "Missing 'id'" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Cargamos la fila de generación + la marca activa de la institución
  // en paralelo. La marca puede estar vacía si Admin no la configuró
  // todavía — en ese caso interpolamos strings vacíos pero sin romper.
  const [{ data: gen, error: genErr }, { data: brand }] = await Promise.all([
    adminClient.from("generated_contents").select("*").eq("id", body.id).maybeSingle(),
    adminClient.from("content_brand_config").select("*").maybeSingle(),
  ]);

  if (genErr || !gen) {
    return new Response(JSON.stringify({ error: genErr?.message ?? "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (gen.status === "done" || gen.status === "processing") {
    return new Response(JSON.stringify({ ok: true, skipped: true, status: gen.status }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Marca como processing para evitar dobles ejecuciones.
  await adminClient
    .from("generated_contents")
    .update({ status: "processing", error: null })
    .eq("id", gen.id);

  try {
    const promptTemplate = await resolveContentPrompt();
    // Etiqueta legible para `modality` — el modelo entiende mejor un
    // string descriptivo que el enum interno. Si no llega, asumimos
    // teorico_practica (el default histórico).
    const modalityLabel =
      gen.modality === "teorica"
        ? "Teórica (solo presentación + guía docente)"
        : gen.modality === "practica"
          ? "Práctica (solo taller práctico, sin presentación)"
          : "Teórico-práctica (presentación + guía + taller)";
    const vars: Record<string, string> = {
      university_name: brand?.university_name ?? "",
      logo_url: brand?.logo_url ?? "",
      primary_color: brand?.primary_color ?? "#1e40af",
      secondary_color: brand?.secondary_color ?? "#64748b",
      topic: gen.topic ?? "",
      n_classes: gen.n_classes != null ? String(gen.n_classes) : "",
      duration_minutes: gen.duration_minutes != null ? String(gen.duration_minutes) : "60",
      modality: gen.modality ?? "teorico_practica",
      modality_label: modalityLabel,
      // RAG queda placeholder por ahora. Cuando agreguemos
      // content_rag_documents este string traerá los chunks reseleccionados.
      rag_context_documents: "(sin contexto histórico disponible)",
    };
    const systemPrompt = applyPlaceholders(promptTemplate, vars);

    // El user message le indica al modelo qué modo se eligió y refuerza
    // los parámetros concretos. Mantener este texto corto y declarativo
    // — el grueso del prompt vive en el system.
    const commonContext = `Tema: ${gen.topic}\nDuración por clase: ${vars.duration_minutes} minutos\nModalidad: ${modalityLabel}\nIdioma: ${gen.language}\nAutor: ${gen.author ?? brand?.author_default ?? ""}`;
    const userMessage =
      gen.mode === "curso_completo"
        ? `Modo seleccionado: CURSO COMPLETO.\n\n${commonContext}\nCantidad de clases: ${gen.n_classes}\n\nGenera la introducción del curso y luego el material por cada una de las ${gen.n_classes} sesiones, respetando duración y modalidad.`
        : `Modo seleccionado: MATERIAL INDIVIDUAL.\n\n${commonContext}\n\nGenera el material completo de UNA sola sesión sobre el tema, respetando la duración y la modalidad indicada.`;

    const aiRes = await aiChat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ]);
    if (!aiRes.ok) {
      const errText = await aiRes.text().catch(() => "");
      throw new Error(`AI Gateway ${aiRes.status}: ${errText.slice(0, 400)}`);
    }
    const aiJson = await aiRes.json();
    const rawOutput: string =
      aiJson.choices?.[0]?.message?.content ??
      // Algunos providers ponen el contenido en `output_text` (legacy).
      aiJson.choices?.[0]?.message?.output_text ??
      "";

    if (!rawOutput.trim()) throw new Error("AI returned empty content");

    const blocks = parseFileBlocks(rawOutput);
    if (blocks.length === 0) {
      // No bloques → guardamos el output crudo igual para inspección,
      // pero marcamos como failed con un mensaje claro al docente.
      await adminClient
        .from("generated_contents")
        .update({
          status: "failed",
          raw_output: rawOutput,
          error:
            "La IA no produjo bloques [INICIO_ARCHIVO]…[FIN_ARCHIVO] reconocibles. Revisa el prompt o reintenta.",
        })
        .eq("id", gen.id);
      return new Response(JSON.stringify({ ok: false, error: "no_blocks" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Sube cada bloque al bucket. Layout:
    //   <teacher_id>/<content_id>/<safe-name>
    // Esto matchea las RLS policies sobre storage.objects.
    const files: FileEntry[] = [];
    let i = 0;
    for (const b of blocks) {
      i += 1;
      const fileName = safeFileName(b.name, i);
      // Guardamos los .pptx como .pptx.txt para que el cliente los reconozca
      // como "fuente" y los convierta on-demand a binario .pptx con pptxgenjs.
      const storedName = blockKind(b.name) === "pptx-source" ? `${fileName}.txt` : fileName;
      const storagePath = `${gen.teacher_id}/${gen.id}/${storedName}`;
      const upload = await adminClient.storage
        .from("generated-contents")
        .upload(storagePath, new Blob([b.body], { type: "text/plain; charset=utf-8" }), {
          upsert: true,
          contentType: "text/plain; charset=utf-8",
        });
      if (upload.error) throw new Error(`Upload failed for ${storedName}: ${upload.error.message}`);
      files.push({
        name: fileName,
        path: storagePath,
        kind: blockKind(b.name),
        body: b.body,
      });
    }

    await adminClient
      .from("generated_contents")
      .update({
        status: "done",
        files,
        raw_output: rawOutput,
        error: null,
      })
      .eq("id", gen.id);

    return new Response(JSON.stringify({ ok: true, count: files.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await adminClient
      .from("generated_contents")
      .update({ status: "failed", error: msg })
      .eq("id", gen.id);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
