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
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { auditFromEdge } from "../_shared/audit.ts";
import { describeAiError } from "../_shared/ai-error.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const adminClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

type AiProvider = "lovable" | "openai" | "gemini";
let cachedModel: { provider: AiProvider; model: string } | null = null;
async function getActiveAiModel() {
  if (cachedModel) return cachedModel;
  try {
    const { data } = await adminClient
      .from("ai_model_settings")
      .select("provider, model")
      .eq("is_active", true)
      .maybeSingle();
    if (
      data &&
      (data.provider === "lovable" || data.provider === "openai" || data.provider === "gemini")
    ) {
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
  let url: string;
  let key: string | undefined;
  if (m.provider === "openai") {
    url = "https://api.openai.com/v1/chat/completions";
    key = Deno.env.get("OPENAI_API_KEY");
  } else if (m.provider === "gemini") {
    url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    key = Deno.env.get("GEMINI_API_KEY");
  } else {
    url = "https://ai.gateway.lovable.dev/v1/chat/completions";
    key = Deno.env.get("LOVABLE_API_KEY");
  }
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
 * Resuelve el system prompt orquestador `content_generation` aplicando
 * la jerarquía:
 *   1) override POR CONTENIDO en `gen.prompt_overrides.content_generation`
 *   2) global Admin en `ai_prompts WHERE use_case='content_generation' AND course_id IS NULL`
 *   3) string vacío (el modelo cae al user message; raro pero no rompe)
 *
 * La lógica vive duplicada con `src/lib/content-prompts.ts` porque las
 * edge functions corren en Deno y no comparten el bundle del browser.
 * El test unitario del helper TS cubre el comportamiento esperado; este
 * código sigue el mismo contrato.
 */
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveContentPrompt(gen: any): Promise<string> {
  const override = gen?.prompt_overrides?.content_generation;
  if (typeof override === "string" && override.trim().length > 0) return override;
  const { data } = await adminClient
    .from("ai_prompts")
    .select("system_prompt")
    .eq("use_case", "content_generation")
    .is("course_id", null)
    .maybeSingle();
  return (data?.system_prompt as string) ?? "";
}

/** Sub-prompts por tag — uno por tipo de archivo. El edge function carga
 *  desde DB SOLO los tags activos y los concatena al user message. Si
 *  algún use_case falta en la tabla, se usa string vacío y el modelo
 *  cae al instructivo genérico del system prompt. */
type TagPrompts = {
  presentacion: string;
  guia_docente: string;
  taller_practico: string;
  ejercicio: string;
  examen: string;
};

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadTagPrompts(gen: any, activeTags: string[]): Promise<TagPrompts> {
  const tags = new Set(activeTags);
  const wanted: string[] = [];
  if (tags.has("teorico")) wanted.push("content.presentacion", "content.guia_docente");
  if (tags.has("practico")) wanted.push("content.taller_practico", "content.ejercicio");
  if (tags.has("examen")) wanted.push("content.examen");

  const out: TagPrompts = {
    presentacion: "",
    guia_docente: "",
    taller_practico: "",
    ejercicio: "",
    examen: "",
  };
  if (wanted.length === 0) return out;

  // Cargamos los globales en una sola query y los indexamos por use_case.
  // Después aplicamos la jerarquía override-por-contenido > global para cada uno.
  const { data } = await adminClient
    .from("ai_prompts")
    .select("use_case, system_prompt")
    .in("use_case", wanted)
    .is("course_id", null);
  const globals: Record<string, string> = {};
  for (const row of (data ?? []) as Array<{ use_case: string; system_prompt: string }>) {
    globals[row.use_case] = row.system_prompt;
  }
  // override > global. Si ambos vacíos, queda "" y el código de
  // composeFileSections usa un fallback inline corto.
  const overrides = (gen?.prompt_overrides ?? {}) as Record<string, unknown>;
  const pick = (key: string): string => {
    const ov = overrides[key];
    if (typeof ov === "string" && ov.trim().length > 0) return ov;
    return globals[key] ?? "";
  };
  out.presentacion = pick("content.presentacion");
  out.guia_docente = pick("content.guia_docente");
  out.taller_practico = pick("content.taller_practico");
  out.ejercicio = pick("content.ejercicio");
  out.examen = pick("content.examen");
  return out;
}

/** Deriva los tags a usar para esta generación. Fuente de verdad =
 *  `gen.tags` (columna nueva). Fallback para filas viejas que aún no
 *  tienen tags: usar `modality` para inferirlo. */
function resolveTags(gen: { tags?: string[] | null; modality?: string | null }): string[] {
  if (Array.isArray(gen.tags) && gen.tags.length > 0) return gen.tags;
  switch (gen.modality) {
    case "teorica":
      return ["teorico"];
    case "practica":
      return ["practico"];
    case "teorico_practica":
      return ["teorico", "practico"];
    default:
      return ["teorico", "practico"];
  }
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
  /** Tema puntual de la clase a regenerar. NO sobrescribe `gen.topic`
   *  (que es el tema general del curso). Se inyecta en el user message
   *  como "TEMA DE ESTA CLASE" — el modelo lo usa como foco específico,
   *  manteniendo el contexto del curso. Solo aplica con `target_class`. */
  class_topic?: string;
  /** Instrucciones puntuales para esta clase. Si NO se envía, el edge
   *  usa `gen.instructions` (las del curso). Si se envía vacío, ignora
   *  el campo y usa las del curso. Solo aplica con `target_class`. */
  class_instructions?: string | null;
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

  // La generación de un curso completo (8 clases × varios archivos × Gemini Pro)
  // tarda varios minutos. El cliente invoca fire-and-forget, pero si la conexión
  // HTTP se cancela antes de que el handler termine, el worker se mata y la fila
  // queda atascada en 'processing'. Movemos el trabajo pesado a EdgeRuntime.waitUntil
  // y respondemos 202 de inmediato — el polling del cliente sigue el progreso vía DB.
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  const heavyWork = (async () => {
    try {
      const promptTemplate = await resolveContentPrompt(gen);
      // Tags activos para esta generación (teorico / practico / examen).
      // Fuente de verdad = columna `tags`; filas viejas caen al fallback
      // por `modality`. Solo cargamos los sub-prompts de los tags activos.
      const activeTags = resolveTags(gen);
      const tagPrompts = await loadTagPrompts(gen, activeTags);
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
          if (looksHtml) {
            throw new Error(
              `[${label}] AI Gateway devolvió HTML (típicamente 504/timeout). Reintenta; si persiste, reduce la duración por clase o cambia a modalidad teorica/practica.`,
            );
          }
          // describeAiError detecta API key inválida y devuelve mensaje
          // accionable; en otros casos retorna status + snippet.
          const detail = await describeAiError(
            aiRes,
            cachedModel?.provider ?? "lovable",
            rawText,
          );
          throw new Error(`[${label}] ${detail}`);
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

      /** Componen la sección "OBJETIVOS DE PROFUNDIDAD POR ARCHIVO" con
       *  SOLO los tipos correspondientes a los tags activos. Cada bloque
       *  viene del sub-prompt de DB (`content.*`) — si está vacío usamos
       *  un fallback corto inline para que el modelo igual produzca el
       *  archivo. Pluraliza el ejercicio (estudiante + solución como un
       *  par) y agrega EXAMEN solo cuando el tag está activo. */
      const composeFileSections = (): string => {
        const sections: string[] = [];
        if (activeTags.includes("teorico")) {
          sections.push(
            tagPrompts.presentacion ||
              "- PRESENTACION: 9–18 slides con título + 3–6 viñetas + ejemplos.",
          );
          sections.push(
            tagPrompts.guia_docente ||
              "- GUIA_DOCENTE: ≥500 palabras, paso-a-paso para docente sin conocimiento previo.",
          );
        }
        if (activeTags.includes("practico")) {
          sections.push(
            tagPrompts.taller_practico ||
              "- TALLER_PRACTICO: 5–8 pasos con herramienta SaaS específica + criterios medibles.",
          );
          sections.push(
            tagPrompts.ejercicio ||
              "- EJERCICIO_ESTUDIANTE + EJERCICIO_SOLUCION: enunciado autocontenido (≥250 palabras); solución paso-a-paso para el docente con el mismo enunciado palabra-por-palabra.",
          );
        }
        if (activeTags.includes("examen")) {
          sections.push(
            tagPrompts.examen ||
              "- EXAMEN: 5–10 preguntas (cerradas + desarrollo) con clave + rúbrica. SOLO para el docente — el estudiante no debe verlo.",
          );
        }
        return sections.join("\n\n");
      };

      /**
       * Mensaje user para UNA clase específica de un curso_completo.
       * Compone los sub-prompts de los tags activos. Si el tag examen
       * está activo, le decimos al modelo que emita EXAMEN_CLASE_N.MD
       * adicionalmente.
       */
      // `class_topic` (opcional, viene del dialog "Regenerar clase"):
      // tema puntual de esta clase, distinto del tema general del curso.
      // Cuando llega, se inyecta como instrucción de foco — el modelo
      // sigue viendo el contexto del curso (`commonContext` con
      // `gen.topic`) pero sabe que ESTA clase debe enfocarse en este
      // sub-tema. Si no llega, no se agrega nada — comportamiento previo.
      const classTopicOverride =
        typeof body.class_topic === "string" && body.class_topic.trim().length > 0
          ? body.class_topic.trim()
          : null;
      const classInstructionsOverride =
        typeof body.class_instructions === "string" && body.class_instructions.trim().length > 0
          ? body.class_instructions.trim()
          : null;
      const buildClassMessage = (classNum: number, totalClasses: number) => {
        const classFocus = classTopicOverride
          ? `\n### TEMA ESPECÍFICO DE ESTA CLASE (PRIORIDAD MÁXIMA)\n${classTopicOverride}\n` +
            `El tema general del curso sigue siendo "${gen.topic}", pero ESTA CLASE en particular debe ` +
            `enfocarse en el sub-tema indicado arriba. Ajusta todos los ejemplos, ejercicios y explicaciones ` +
            `al sub-tema concreto sin perder coherencia con el curso global.\n`
          : "";
        const classInstr = classInstructionsOverride
          ? `\n### INSTRUCCIONES PUNTUALES PARA ESTA CLASE\n${classInstructionsOverride}\n`
          : "";
        return (
          `Modo seleccionado: GENERAR UNA CLASE de un curso de ${totalClasses} clases.\n\n` +
          `${commonContext}\nClase a generar: ${classNum} de ${totalClasses}\n` +
          classFocus +
          classInstr +
          `\nGenera ÚNICAMENTE los archivos de la clase ${classNum}, con sufijo "_CLASE_${classNum}" en cada filename. ` +
          `NO incluyas la introducción del curso ni material de otras clases.\n\n` +
          `### TIPOS DE ARCHIVO A GENERAR (según tags activos)\n` +
          `Tags activos: ${activeTags.join(", ")}\n\n` +
          composeFileSections()
        );
      };

      // Intro del curso = portada PPTX. Solo tiene sentido cuando el
      // docente quiere presentación (tag `teorico`). Si no hay teorico
      // la intro no se genera — el feedback es coherente con los tags.
      const buildIntroMessage = (totalClasses: number) =>
        `Modo seleccionado: GENERAR INTRODUCCIÓN DEL CURSO.\n\n` +
        `${commonContext}\nCantidad total de clases: ${totalClasses}\n\n` +
        `Genera ÚNICAMENTE el archivo INTRO_CURSO.PPTX con la portada institucional, los objetivos del curso (5+ objetivos de aprendizaje accionables), justificación (≥150 palabras explicando por qué este curso importa y para quién está pensado) y el cronograma de las ${totalClasses} clases (un slide con tabla resumen: clase N · título · objetivo principal). NO generes archivos de clases individuales — esos se generan en pases separados.`;

      let aggregatedRaw = "";
      let allBlocks: Array<{ name: string; body: string }> = [];

      // Defensa contra el bug clásico del multi-pase: el modelo a veces
      // ignora la instrucción de añadir `_CLASE_<N>` al filename. Si dos
      // clases generan `TALLER_PRACTICO.MD`, ambas suben al MISMO
      // storagePath y se sobrescriben (upsert). Resultado: spinner se
      // muestra en todas las chips de ese tipo y la descarga trae siempre
      // el último archivo. Forzamos el sufijo aquí.
      const tagWithClass = (blocks: Array<{ name: string; body: string }>, k: number) =>
        blocks.map((b) => {
          if (classFromName(b.name) !== null) return b;
          const newName = b.name.replace(/(\.[A-Za-z0-9]+)?$/, `_CLASE_${k}$1`);
          return { ...b, name: newName };
        });

      if (isPartial) {
        // Regen de UNA clase puntual — un único pase, igual que antes.
        const tn = body.target_class!;
        const userMsg = buildClassMessage(tn, gen.n_classes ?? tn);
        const { blocks: pb, rawOutput } = await runOnePass(userMsg, `Clase ${tn}`);
        aggregatedRaw = rawOutput;
        allBlocks = tagWithClass(pb, tn);
      } else if (gen.mode === "curso_completo") {
        // Pase ÚNICO con composición por tags. El modelo recibe la lista
        // de archivos a generar por clase derivada de `activeTags`
        // (teorico → PRESENTACION + GUIA_DOCENTE; practico → TALLER +
        // EJERCICIO; examen → EXAMEN). Si el tag examen está activo, el
        // EXAMEN_CLASE_N.MD se entrega junto con los demás archivos.
        const n = Math.max(1, Math.min(Number(gen.n_classes) || 1, 40));
        const sections = composeFileSections();
        const includeIntro = activeTags.includes("teorico");
        const fileListIntro = includeIntro
          ? `1. INTRO_CURSO.PPTX con portada, objetivos del curso (5+), justificación (≥150 palabras) y cronograma de las ${n} clases.\n` +
            `2. Para CADA clase (de 1 a ${n}), los archivos con sufijo "_CLASE_<N>" en el filename, según los tipos listados abajo.`
          : `Para CADA clase (de 1 a ${n}), los archivos con sufijo "_CLASE_<N>" en el filename, según los tipos listados abajo (sin INTRO_CURSO porque el tag teórico no está activo).`;
        const userMsg =
          `Modo seleccionado: GENERAR CURSO COMPLETO.\n\n` +
          `${commonContext}\nCantidad total de clases: ${n}\n` +
          `Tags activos: ${activeTags.join(", ")}\n\n` +
          `Genera EN UNA SOLA RESPUESTA todos los archivos del curso:\n` +
          `${fileListIntro}\n\n` +
          `### TIPOS DE ARCHIVO POR CLASE\n${sections}\n\n` +
          `CRÍTICO: cada filename DEBE incluir "_CLASE_<N>" para que los archivos de distintas clases no colisionen al guardar. Usa los marcadores [INICIO_ARCHIVO: NAME] / [FIN_ARCHIVO: NAME] alrededor de cada archivo.`;
        const r = await runOnePass(userMsg, `Curso completo (${n} clases)`);
        aggregatedRaw = r.rawOutput;
        // tagWithClass de seguridad por archivo: si el modelo ignoró el
        // sufijo _CLASE_<N> en alguno (lo hace a veces), classFromName lo
        // detecta o lo deja sin tag — la intro queda sin tag (correcto).
        // El número de clase real se infiere del filename en el cliente.
        allBlocks = r.blocks;
      } else {
        // material_individual: una sola sesión, un solo pase con énfasis
        // en profundidad por archivo. Reusa `composeFileSections` para
        // listar solo los archivos correspondientes a los tags activos.
        const sections = composeFileSections();
        const userMsg =
          `Modo seleccionado: MATERIAL INDIVIDUAL.\n\n${commonContext}\n` +
          `Tags activos: ${activeTags.join(", ")}\n\n` +
          `Genera el material completo de UNA sola sesión sobre el tema. NO uses sufijo _CLASE_N — usa los nombres base.\n\n` +
          `### TIPOS DE ARCHIVO A GENERAR\n${sections}\n\n` +
          `Usa los marcadores [INICIO_ARCHIVO: NAME] / [FIN_ARCHIVO: NAME] alrededor de cada archivo.`;
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
        if (upload.error)
          throw new Error(`Upload failed for ${storedName}: ${upload.error.message}`);
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

      void auditFromEdge(adminClient, {
        actorId: gen.teacher_id ?? null,
        action: "content.generated",
        category: "course",
        severity: "info",
        entityType: "generated_content",
        entityId: gen.id,
        entityName: gen.topic ?? null,
        courseId: gen.course_id ?? null,
        metadata: {
          mode: gen.mode,
          n_classes: gen.n_classes,
          modality: gen.modality,
          tags: activeTags,
          files_count: files.length,
        },
      });

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
        void auditFromEdge(adminClient, {
          actorId: gen.teacher_id ?? null,
          action: "content.regeneration_failed",
          category: "course",
          severity: "error",
          entityType: "generated_content",
          entityId: gen.id,
          entityName: gen.topic ?? null,
          courseId: gen.course_id ?? null,
          metadata: {
            mode: gen.mode,
            target_class: body.target_class,
            error: msg,
          },
        });
        return new Response(JSON.stringify({ ok: false, partial: true, error: msg }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      await adminClient
        .from("generated_contents")
        .update({ status: "failed", error: msg })
        .eq("id", gen.id);
      void auditFromEdge(adminClient, {
        actorId: gen.teacher_id ?? null,
        action: "content.generation_failed",
        category: "course",
        severity: "error",
        entityType: "generated_content",
        entityId: gen.id,
        entityName: gen.topic ?? null,
        courseId: gen.course_id ?? null,
        metadata: { mode: gen.mode, n_classes: gen.n_classes, error: msg },
      });
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  })();

  // Si EdgeRuntime.waitUntil existe, lo usamos para mantener vivo al worker
  // hasta que termine el trabajo en background. Si no (entorno local), igual
  // dejamos correr la promise — Deno.serve no la espera, pero el cliente sigue
  // por polling.
  if (runtime?.waitUntil) {
    runtime.waitUntil(heavyWork);
  }

  return new Response(JSON.stringify({ ok: true, accepted: true, id: gen.id }), {
    status: 202,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
