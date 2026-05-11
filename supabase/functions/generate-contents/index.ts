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
  /** Si está definido, se regenera ÚNICAMENTE esa clase y los archivos
   *  resultantes se mergean con los existentes (mantienen la intro y
   *  las otras clases intactas). Sin este campo, regen completa. */
  target_class?: number;
}

/** Extrae el número de clase del nombre del archivo. Replica de la
 *  helper del cliente — duplicada acá porque Deno edge functions no
 *  comparten src/lib con el bundle del browser. */
function classFromName(name: string): number | null {
  // Mantenemos el mismo orden de patrones que el cliente (ver
  // src/lib/contents-extract.ts → classNumberFromFilename). Sin esto,
  // un regen parcial del modelo que devuelva `PRESENTACION_3.PPTX`
  // (sin el infix `CLASE_`) NO matchearía el filtro de borrado de
  // archivos previos y dejaríamos huérfanos al hacer el merge.
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
  const isPartial = typeof body.target_class === "number" && body.target_class > 0;
  // Para regen completa: si ya está done/processing, no hacemos nada
  // (el cliente debe poner status='queued' antes de invocar).
  // Para regen parcial: aceptamos status='done' (queremos volver a
  // generar UNA clase sin tocar el resto), pero rechazamos 'processing'
  // para no pisar otra ejecución en curso.
  if (gen.status === "processing") {
    return new Response(JSON.stringify({ ok: true, skipped: true, status: gen.status }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!isPartial && gen.status === "done") {
    return new Response(JSON.stringify({ ok: true, skipped: true, status: gen.status }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Marca como processing para evitar dobles ejecuciones (igual para
  // regen completa y parcial). El polling del cliente lo verá y refresca.
  await adminClient
    .from("generated_contents")
    .update({ status: "processing", error: null })
    .eq("id", gen.id);

  // Para regen parcial, borramos del bucket los archivos previos de la
  // clase target ANTES de subir los nuevos — así no quedan huérfanos
  // si el modelo decide cambiar el nombre del archivo (e.g. de
  // GUIA_CLASE_3.MD a MATERIAL_CLASE_3.MD). El upload usa upsert para
  // los que sí coincidan en path.
  if (isPartial) {
    const existing = (gen.files ?? []) as FileEntry[];
    const tn = body.target_class!;
    const oldClassFiles = existing.filter((f) => classFromName(f.name) === tn);
    if (oldClassFiles.length > 0) {
      const paths = oldClassFiles.map((f) => f.path).filter(Boolean);
      if (paths.length > 0) {
        await adminClient.storage.from("generated-contents").remove(paths);
      }
    }
  }

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
          : "Teórico-práctica (presentación teórica con cierre práctico + guía + taller + ejercicio para el estudiante + ejercicio resuelto para el docente)";
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
    // — el grueso del prompt vive en el system. Si el docente añadió
    // instrucciones libres al crear la generación, las apilamos al
    // final del user message como un bloque etiquetado para que el
    // modelo las trate con prioridad sobre los defaults del system
    // prompt sin que necesitemos editarlo cada vez.
    const commonContext = `Tema: ${gen.topic}\nDuración por clase: ${vars.duration_minutes} minutos\nModalidad: ${modalityLabel}\nIdioma: ${gen.language}\nAutor: ${gen.author ?? brand?.author_default ?? ""}`;
    const teacherInstructions =
      typeof gen.instructions === "string" && gen.instructions.trim().length > 0
        ? `\n\n### INSTRUCCIONES ADICIONALES DEL DOCENTE (PRIORIDAD ALTA)\n${gen.instructions.trim()}`
        : "";

    /**
     * Hace UNA llamada al modelo con el user message dado y devuelve
     * los bloques parseados. Centraliza el manejo de errores (HTML del
     * gateway, JSON inválido, output vacío) para que el orquestador
     * de abajo solo se preocupe por iterar pases.
     */
    const runOnePass = async (
      userMessage: string,
      label: string,
    ): Promise<{
      blocks: Array<{ name: string; body: string }>;
      rawOutput: string;
    }> => {
      const fullMsg = userMessage + teacherInstructions;
      const aiRes = await aiChat([
        { role: "system", content: systemPrompt },
        { role: "user", content: fullMsg },
      ]);
      const rawText = await aiRes.text();
      const looksHtml = rawText.trimStart().startsWith("<");
      if (!aiRes.ok || looksHtml) {
        const reason = looksHtml
          ? `[${label}] AI Gateway devolvió HTML (típicamente 504/timeout). Reintenta; si persiste, reduce la duración por clase o cambia a modalidad teorica/practica.`
          : `[${label}] AI Gateway ${aiRes.status}: ${rawText.slice(0, 400)}`;
        throw new Error(reason);
      }
      let aiJson: Record<string, unknown> = {};
      try {
        aiJson = JSON.parse(rawText);
      } catch {
        throw new Error(
          `[${label}] Respuesta inválida (no es JSON). Primeros 300 chars: ${rawText.slice(0, 300)}`,
        );
      }
      const rawOutput: string =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (aiJson as any).choices?.[0]?.message?.content ??
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (aiJson as any).choices?.[0]?.message?.output_text ??
        "";
      if (!rawOutput.trim()) throw new Error(`[${label}] La IA devolvió contenido vacío`);
      return { blocks: parseFileBlocks(rawOutput), rawOutput };
    };

    /**
     * Mensaje user para UNA clase específica de un curso_completo.
     * El system prompt ya conoce las plantillas; acá le pedimos que
     * SOLO produzca los archivos de esa clase, con sufijo `_CLASE_<N>`,
     * y le recordamos los objetivos de profundidad (paso-a-paso para
     * docente sin conocimiento previo + longitud por archivo).
     */
    const buildClassMessage = (classNum: number, totalClasses: number) =>
      `Modo seleccionado: GENERAR UNA CLASE de un curso de ${totalClasses} clases.\n\n` +
      `${commonContext}\nClase a generar: ${classNum} de ${totalClasses}\n\n` +
      `Genera ÚNICAMENTE los archivos de la clase ${classNum}, con sufijo "_CLASE_${classNum}" en cada filename. ` +
      `NO incluyas la introducción del curso ni material de otras clases.\n\n` +
      `### OBJETIVOS DE PROFUNDIDAD POR ARCHIVO\n` +
      `- **PRESENTACION**: 9–22 slides según duración. Cada slide debe tener título + 3–6 viñetas concretas. No abusar de generalidades — incluir ejemplos, definiciones técnicas precisas y al menos 2 slides con casos concretos. Aplica el color {{primary_color}} en títulos.\n` +
      `- **GUIA_DOCENTE**: extensión mínima 800 palabras. Asume que el docente JAMÁS ha enseñado este tema antes — explica los conceptos clave PASO A PASO, anticipa preguntas frecuentes de los estudiantes con sus respuestas, sugiere analogías para conceptos abstractos. Incluye una sección "Errores comunes que cometen los estudiantes" con al menos 3 entradas y "Cómo retroalimentarlos" debajo de cada una. NO sea genérico ("explicar el concepto") — escribe el guion exacto que el docente puede leer.\n` +
      `- **TALLER_PRACTICO**: 5–8 pasos secuenciados. Cada paso incluye: objetivo (1 línea), instrucciones detalladas con la herramienta SaaS específica + URL, capturas verbales esperadas ("deberías ver X en la esquina Y") y un entregable verificable. Criterios de éxito con métricas observables (no "lo hizo bien" — "completa la tarea en <10 min con 0 errores de sintaxis").\n` +
      `- **EJERCICIO_ESTUDIANTE** (solo teorico_practica): enunciado autocontenido, ≥300 palabras. Incluye contexto, datos de entrada concretos, restricciones, formato del entregable y rubrica de evaluación visible para el estudiante.\n` +
      `- **EJERCICIO_SOLUCION** (solo teorico_practica): MISMO enunciado palabra-por-palabra + solución paso-a-paso completa con justificación pedagógica + respuesta final + 3+ errores comunes con guía de retroalimentación.`;

    const buildIntroMessage = (totalClasses: number) =>
      `Modo seleccionado: GENERAR INTRODUCCIÓN DEL CURSO.\n\n` +
      `${commonContext}\nCantidad total de clases: ${totalClasses}\n\n` +
      `Genera ÚNICAMENTE el archivo INTRO_CURSO.PPTX con la portada institucional, los objetivos del curso (5+ objetivos de aprendizaje accionables), justificación (≥150 palabras explicando por qué este curso importa y para quién está pensado) y el cronograma de las ${totalClasses} clases (un slide con tabla resumen: clase N · título · objetivo principal). NO generes archivos de clases individuales — esos se generan en pases separados.`;

    let aggregatedRaw = "";
    let allBlocks: Array<{ name: string; body: string }> = [];

    if (isPartial) {
      // Regen de UNA clase puntual — un único pase, igual que antes.
      const tn = body.target_class!;
      const userMsg = buildClassMessage(tn, gen.n_classes ?? tn);
      const { blocks: pb, rawOutput } = await runOnePass(userMsg, `Clase ${tn}`);
      aggregatedRaw = rawOutput;
      allBlocks = pb;
    } else if (gen.mode === "curso_completo") {
      // Multi-pase: 1 llamada para la intro + 1 por cada clase. Cada
      // pase produce archivos más profundos que la era monolítica
      // anterior porque no hay que comprimir todo el curso en una
      // sola respuesta del modelo.
      const n = Math.max(1, Math.min(Number(gen.n_classes) || 1, 40));
      const introRes = await runOnePass(buildIntroMessage(n), "Intro");
      aggregatedRaw += `### Intro\n${introRes.rawOutput}\n\n`;
      allBlocks.push(...introRes.blocks);
      for (let k = 1; k <= n; k++) {
        const r = await runOnePass(buildClassMessage(k, n), `Clase ${k}`);
        aggregatedRaw += `### Clase ${k}\n${r.rawOutput}\n\n`;
        allBlocks.push(...r.blocks);
      }
    } else {
      // material_individual: una sola sesión, un solo pase con énfasis
      // en profundidad por archivo (mismas guías que el per-class).
      const userMsg =
        `Modo seleccionado: MATERIAL INDIVIDUAL.\n\n${commonContext}\n\n` +
        `Genera el material completo de UNA sola sesión sobre el tema. NO uses sufijo _CLASE_N — usa los nombres base.\n\n` +
        `### OBJETIVOS DE PROFUNDIDAD POR ARCHIVO\n` +
        `- PRESENTACION: 9–22 slides según duración; cada slide con título + 3–6 viñetas + ejemplos concretos.\n` +
        `- GUIA_DOCENTE: ≥800 palabras, paso-a-paso para docente sin conocimiento previo, con errores comunes y cómo retroalimentar.\n` +
        `- TALLER_PRACTICO: 5–8 pasos con herramienta SaaS específica + criterios de éxito medibles.\n` +
        `- EJERCICIO_ESTUDIANTE + EJERCICIO_SOLUCION (solo teorico_practica): mismo enunciado palabra-por-palabra, el segundo añade solución paso-a-paso.`;
      const r = await runOnePass(userMsg, "Material individual");
      aggregatedRaw = r.rawOutput;
      allBlocks = r.blocks;
    }

    const rawOutput = aggregatedRaw;
    const blocks = allBlocks;
    if (blocks.length === 0) {
      // No bloques. Para regen completa marcamos failed; para regen
      // parcial rollback a 'done' (los archivos previos siguen válidos)
      // y devolvemos el error en la respuesta para que el cliente lo
      // muestre como toast sin alarmar con un status='failed'.
      if (isPartial) {
        await adminClient
          .from("generated_contents")
          .update({ status: "done", error: null })
          .eq("id", gen.id);
        return new Response(
          JSON.stringify({
            ok: false,
            partial: true,
            error:
              "La IA no produjo bloques [INICIO_ARCHIVO]…[FIN_ARCHIVO] reconocibles para esa clase. Reintenta.",
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
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

    if (isPartial) {
      // Merge: conserva los archivos que NO pertenecen a la clase target,
      // reemplaza/agrega los nuevos. Mantenemos el `raw_output` original
      // del curso completo — el regen parcial no debe sobrescribirlo.
      const tn = body.target_class!;
      const existing = (gen.files ?? []) as FileEntry[];
      const kept = existing.filter((f) => classFromName(f.name) !== tn);
      const merged = [...kept, ...files];
      await adminClient
        .from("generated_contents")
        .update({ status: "done", files: merged, error: null })
        .eq("id", gen.id);
      return new Response(
        JSON.stringify({ ok: true, partial: true, target_class: tn, count: files.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
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
    // Regen parcial: rollback a 'done' y dejamos `error` limpio. Los
    // archivos previos del row siguen siendo válidos, así que el row
    // no debe aparecer como failed en el grid.
    if (isPartial) {
      await adminClient
        .from("generated_contents")
        .update({ status: "done", error: null })
        .eq("id", gen.id);
      return new Response(JSON.stringify({ ok: false, partial: true, error: msg }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
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
