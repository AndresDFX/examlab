/**
 * Lee una CAPTURA de la videollamada y devuelve qué participantes se ven y en qué
 * grupo, para que el docente arme los grupos de un taller sin transcribir 30 nombres
 * a mano.
 *
 * ── El edge NO escribe nada ───────────────────────────────────────────────
 * Devuelve un BORRADOR. El docente lo revisa y el INSERT lo hace el cliente con su
 * propio JWT, bajo RLS. Es a propósito y tiene precedentes en este repo
 * (`questionIdentification`, `projectStatement`): la nota de un taller en grupo la
 * comparten todos sus integrantes, así que meter a alguien en el grupo equivocado sin
 * que nadie lo confirme afecta la nota de varias personas a la vez.
 *
 * ── Sync-only, y el motivo es estructural ─────────────────────────────────
 * La cola `ai_generation_queue` solo sabe invocar un edge y contar
 * `data.inserted.length`; todos sus kinds INSERTAN. Un resultado que es borrador para
 * revisar no tiene dónde persistirse al drenar. Por eso el cliente llama
 * `ensureAuthorized({ allowQueue: false })`.
 *
 * ── Y el modelo puede no aceptar imágenes ─────────────────────────────────
 * Ver `_shared/ai-vision.ts`: hoy todas las instituciones resuelven a un modelo de
 * Bedrock que es solo texto. Cuando pasa eso se sustituye por uno con visión SOLO
 * para esta llamada, y se reporta en la respuesta. Si no hay con qué, se devuelve 409
 * SIN llamar al proveedor: un mensaje que dice qué cambiar sirve más que un 400 del
 * proveedor que además gasta una llamada.
 *
 * Body:  { imagen: string (data URL), workshopId: string, courseId?: string|null, pista?: string|null }
 * Resp:  { ok: true, grupos, sin_grupo, ilegibles, truncado, modelo_usado, sustituido }
 */
import {
  adminClient as admin,
  corsHeaders,
  jsonError,
  jsonResponse,
  userClientFromRequest,
} from "../_shared/admin.ts";
import { getActiveAiModel, aiChatCompletionFailover } from "../_shared/ai-model.ts";
import { enforceRateLimit } from "../_shared/rate-limit.ts";
import { resolverModeloDeVision } from "../_shared/ai-vision.ts";
import {
  buildLeerGruposTool,
  normalizarLectura,
  TOOL_NAME,
} from "../_shared/grupos-imagen.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Copia del validador del cliente (`src/modules/workshops/imagen-limites.ts`).
 *  Deno no importa de `src/`; el criterio estricto se repite a propósito. */
const MAX_DATAURL_CHARS = 1_500_000;
const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const MAX_PISTA_CHARS = 300;

/**
 * INVARIANTE DE TRES LADOS: este texto tiene que ser byte-idéntico a
 * `GRUPOS_DESDE_IMAGEN_FALLBACK` de `src/modules/workshops/grupos-imagen-prompt.ts` y
 * al seed `$grupos$…$grupos$` de la migración 20262090000000. Lo fija un test en
 * `src/modules/tutor/tutor-default-prompt.test.ts`.
 *
 * Solo se usa si la fila de `ai_prompts` no está disponible (RLS, red).
 */
const FALLBACK_GRUPOS_DESDE_IMAGEN_PROMPT = `Eres un asistente que lee una CAPTURA DE PANTALLA de una videollamada (Google Meet, Zoom, Teams) y reporta qué personas se ven y a qué grupo pertenece cada una.

QUÉ TIENES QUE DEVOLVER
Llama a la herramienta leer_grupos con lo que realmente se ve en la imagen. No respondas con texto libre.

CÓMO IDENTIFICAR LOS GRUPOS
Los grupos pueden estar indicados de varias formas: rótulos de sala ("Sala 1", "Grupo A", "Equipo 3"), títulos escritos sobre la captura, bloques separados visualmente, o varias capturas pegadas una al lado de la otra. Usa el rótulo tal como aparece. Si hay bloques claramente separados pero sin rótulo, numéralos "Grupo 1", "Grupo 2" según el orden de lectura, de arriba hacia abajo y de izquierda a derecha.

Si la imagen NO muestra ninguna separación en grupos —es una sola grilla de participantes— devuelve el arreglo de grupos vacío y pon a todas las personas en sin_grupo. No inventes una división que no está en la imagen.

CÓMO LEER LOS NOMBRES
Copia el nombre EXACTAMENTE como aparece en el recuadro, sin completarlo, corregirlo ni cambiarle el orden. Si el recuadro dice "Juan P." devuelve "Juan P.". Si dice un correo, devuelve el correo. Si dice un apodo, devuelve el apodo. No traduzcas ni normalices acentos.

Quita únicamente los sufijos que agrega la plataforma: "(tú)", "(anfitrión)", "(presentando)" y equivalentes en otros idiomas.

LA CONFIANZA ES UN DATO, NO UN ADORNO
Marca alta solo si el nombre se lee completo y sin dudas. Marca media si está abreviado, cortado o parcialmente tapado por un ícono. Marca baja si estás adivinando entre varias lecturas posibles. Quien revisa esto empieza por las de confianza baja, así que exagerar la confianza le hace perder el tiempo en el lugar equivocado.

LO QUE NO SE LEE SE CUENTA, NO SE INVENTA
Si ves recuadros de participante cuyo nombre no se puede leer —cámara apagada sin nombre visible, texto cortado, resolución insuficiente— NO te los imagines: súmalos al contador de ilegibles. Un nombre inventado termina metiendo a una persona en el grupo de otra, y en un trabajo en grupo eso afecta la nota de todo el equipo.

QUÉ NO ES UN PARTICIPANTE
No incluyas: el nombre de la reunión, la hora, los botones de la interfaz, los textos del chat, las notificaciones, ni los nombres que aparezcan dentro de una presentación o un documento compartido en pantalla. Solo las personas que están en la llamada.`;

/**
 * Resuelve el prompt con las 4 capas (curso > institución > plataforma > el de acá)
 * **filtrando por el tenant del curso**.
 *
 * Se copia el resolver de `ai-grade-submission` y no el de `ai-generate-sql`: el corto
 * no filtra por tenant, y como `admin` bypassa la RLS, el global de OTRA institución
 * (rank 2) le puede ganar al de la plataforma.
 */
async function resolveSystemPrompt(courseId: string | null): Promise<string> {
  const useCase = "group_assignment_from_image";
  try {
    let q = admin
      .from("ai_prompts")
      .select("system_prompt, course_id, tenant_id")
      .eq("use_case", useCase);
    q = courseId ? q.or(`course_id.eq.${courseId},course_id.is.null`) : q.is("course_id", null);
    const { data, error } = await q;
    if (error || !data || data.length === 0) return FALLBACK_GRUPOS_DESDE_IMAGEN_PROMPT;

    let courseTenantId: string | null = null;
    if (courseId) {
      const { data: c } = await admin
        .from("courses")
        .select("tenant_id")
        .eq("id", courseId)
        .maybeSingle();
      courseTenantId = (c as { tenant_id?: string | null } | null)?.tenant_id ?? null;
    }
    const scoped = (data as { system_prompt: string; course_id: string | null; tenant_id: string | null }[])
      .filter(
        (r) =>
          (courseId && r.course_id === courseId) ||
          r.tenant_id === courseTenantId ||
          r.tenant_id === null,
      );
    if (scoped.length === 0) return FALLBACK_GRUPOS_DESDE_IMAGEN_PROMPT;
    const rank = (r: { course_id: string | null; tenant_id: string | null }) =>
      r.course_id ? 3 : r.tenant_id ? 2 : 1;
    const mejor = [...scoped].sort((a, b) => rank(b) - rank(a))[0];
    return mejor?.system_prompt || FALLBACK_GRUPOS_DESDE_IMAGEN_PROMPT;
  } catch (e) {
    console.warn("[ai_prompts] resolve failed, using fallback:", e);
    return FALLBACK_GRUPOS_DESDE_IMAGEN_PROMPT;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("Método no permitido", 405);

  const userClient = userClientFromRequest(req);
  if (!userClient) return jsonError("No autenticado", 401);
  const { data: u } = await userClient.auth.getUser();
  if (!u?.user?.id) return jsonError("No autenticado", 401);

  // Gate de rol: sin esto cualquier autenticado gasta la cuota de IA de la
  // institución llamando por REST.
  const { data: callerRoles } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", u.user.id);
  const isStaff = (callerRoles ?? []).some(
    (r: { role: string }) =>
      r.role === "Docente" || r.role === "Admin" || r.role === "SuperAdmin",
  );
  if (!isStaff) {
    return jsonError("Solo un docente o administrador puede leer los grupos de una imagen.", 403);
  }

  // Cuota PROPIA, no la compartida de generación: leer cuatro capturas en una clase no
  // puede comerse el cupo con el que ese mismo docente genera preguntas.
  const rl = await enforceRateLimit(userClient, "ai.read_groups_image", {
    max: 60,
    windowSeconds: 3600,
  });
  if (!rl.ok) return rl.response;

  let body: {
    imagen?: string;
    workshopId?: string;
    courseId?: string | null;
    pista?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError("Solicitud inválida", 400);
  }

  const workshopId = body.workshopId && UUID_RE.test(body.workshopId) ? body.workshopId : null;
  if (!workshopId) return jsonError("Falta el taller.", 400);

  // El taller tiene que ser visible PARA EL CALLER: se consulta con SU JWT, así aplica
  // la RLS. No se replica la autorización de escritura (eso lo hace el cliente bajo
  // RLS); esto evita gastar cuota por alguien que después no va a poder escribir.
  const { data: ws } = await userClient
    .from("workshops")
    .select("id, course_id, is_external, deleted_at")
    .eq("id", workshopId)
    .maybeSingle();
  const taller = ws as
    | { id: string; course_id: string | null; is_external: boolean; deleted_at: string | null }
    | null;
  if (!taller || taller.deleted_at) {
    return jsonError("El taller no existe o está en la papelera.", 403);
  }
  if (taller.is_external) {
    return jsonError("Un taller externo no tiene grupos en la plataforma.", 409);
  }

  const imagen = (body.imagen ?? "").trim();
  if (imagen.length > MAX_DATAURL_CHARS || !DATA_URL_RE.test(imagen)) {
    return jsonError(
      "La imagen no es válida o es demasiado grande. Recortá la ventana de la videollamada y volvé a intentar (PNG, JPG o WEBP).",
      400,
    );
  }

  const courseId =
    body.courseId && UUID_RE.test(body.courseId) ? body.courseId : (taller.course_id ?? null);
  const pista = (body.pista ?? "").trim().slice(0, MAX_PISTA_CHARS);

  // ── El modelo tiene que poder leer imágenes ─────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? undefined;
  const activo = await getActiveAiModel({ courseId, authHeader });
  const vision = resolverModeloDeVision(activo, !!Deno.env.get("GEMINI_API_KEY"));
  if (!vision.ok) {
    return jsonResponse(
      {
        ok: false,
        vision_unavailable: true,
        error: `El modelo de IA configurado (${vision.providerActivo}/${vision.modeloActivo}) no procesa imágenes. Un administrador de la plataforma tiene que activar un modelo con lectura de imágenes en Configuración → IA → Modelo.`,
      },
      409,
    );
  }

  const systemPrompt = await resolveSystemPrompt(courseId);
  const userText = [
    "Leé la captura y devolvé los grupos con sus participantes llamando a la herramienta.",
    "Responde en español (es-CO).",
    pista ? `Indicación del docente sobre esta captura: ${pista}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let res: Response;
  try {
    res = await aiChatCompletionFailover(vision.modelo, {
      model: vision.modelo.model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: imagen } },
          ],
        },
      ],
      tools: [buildLeerGruposTool()],
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
    });
  } catch (e) {
    console.error("[ai-read-groups-image] fetch failed:", e);
    return jsonError("No se pudo contactar al proveedor de IA. Intentá de nuevo.", 502);
  }

  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    console.error(`[ai-read-groups-image] proveedor ${res.status}: ${detalle.slice(0, 500)}`);
    // El mensaje real del proveedor sube, como en el resto de los edges de IA: sin él,
    // una key vencida y una saturación se ven exactamente igual.
    return jsonError(
      `El proveedor de IA respondió ${res.status}. ${detalle.slice(0, 300)}`,
      res.status === 429 ? 429 : 500,
    );
  }

  let args: unknown = null;
  try {
    const json = await res.json();
    const llamada = json?.choices?.[0]?.message?.tool_calls?.[0];
    if (llamada?.function?.arguments) args = JSON.parse(llamada.function.arguments);
  } catch (e) {
    console.error("[ai-read-groups-image] respuesta ilegible:", e);
  }
  if (!args) {
    return jsonError(
      "No pude leer la captura. Probá con una imagen donde los nombres se vean completos y sin recortar.",
      502,
    );
  }

  const lectura = normalizarLectura(args);
  return jsonResponse({
    ok: true,
    ...lectura,
    modelo_usado: vision.modelo.model,
    sustituido: vision.sustituido,
  });
});
