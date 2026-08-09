/**
 * Edge Function: ai-generate-sql
 *
 * Genera una sentencia (o bloque) de SQL a partir de una instrucción en
 * lenguaje natural del DOCENTE, para la hoja SQL de la pizarra
 * (`whiteboard_pages.page_type='sql'`). El docente dicta clase con el motor
 * PostgreSQL real del navegador (PGlite) y, en vez de teclear a mano los
 * CREATE TABLE / INSERT / SELECT frente al curso, los pide en español y los
 * inserta como esquema de partida o directamente en el editor.
 *
 * Por qué un edge y no llamar la IA desde el front: la API key del proveedor
 * vive como secret server-side. Mismo patrón que `ai-generate-report`.
 *
 * SÍNCRONO POR DISEÑO: NO respeta `ai_model_settings.processing_mode='async'`
 * ni encola en `ai_generation_queue`. Igual que `tutor-chat`, el usuario está
 * esperando la respuesta EN VIVO (acá literalmente, proyectando frente al
 * curso): una generación encolada que se resuelve dentro de una hora no sirve
 * para este caso de uso.
 *
 * Auth: `verify_jwt=true` (el gateway ya exige un JWT válido) + gate de rol
 * server-side (Docente / Admin / SuperAdmin). Sin el gate, cualquier
 * estudiante autenticado podría gastar la cuota de IA de la institución con
 * prompts arbitrarios — es la misma razón por la que `ai-generate-report` lo
 * tiene. No hay caller service_role, así que NO se apaga verify_jwt.
 *
 * Body:  { prompt: string, setupSql?: string | null, courseId?: string | null }
 * Resp:  { ok: true, sql: string }
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

/**
 * System prompt por defecto (`use_case = 'sql_generation'`).
 *
 * INVARIANTE cross-file (ver CLAUDE.md): BYTE-IDÉNTICO con
 *   - src/modules/database/sql-generation-prompt.ts (SQL_GENERATION_FALLBACK,
 *     el `defaultPrompt` de AdminPromptsPanel)
 *   - el seed de supabase/migrations/20261620000000_ai_prompt_sql_generation.sql
 * Copia literal porque Deno no puede importar de `src/`.
 */
const FALLBACK_SQL_GENERATION_PROMPT = `Eres un asistente experto en SQL sobre PostgreSQL. Ayudas a un docente que está dando clase EN VIVO: él te describe en lenguaje natural lo que quiere mostrar y tú devuelves la sentencia (o el bloque de sentencias) lista para ejecutar y explicar frente al curso.

## Dónde se ejecuta
- El SQL corre en un PostgreSQL REAL dentro del navegador. La sintaxis válida es la de PostgreSQL: nada de MySQL, SQL Server ni Oracle.
- La base es temporal y arranca LIMPIA en cada ejecución. No existe ninguna tabla previa salvo las que se creen en el mismo bloque o las que aparezcan en el esquema de partida que te entreguen.
- No hay usuarios reales del motor ni permisos que sobrevivan entre ejecuciones: las sentencias de control de acceso sirven para EXPLICAR el concepto.
- No uses extensiones, tablespaces, replicación, acceso a archivos del sistema ni metacomandos del cliente psql (los que empiezan con barra invertida): en este entorno no existen.

## Qué debes devolver
- SOLO código SQL ejecutable. Sin texto introductorio, sin explicaciones fuera del código y sin cercas de Markdown: la respuesta se inserta tal cual en el editor del docente.
- Toda explicación va como COMENTARIO SQL, con dos guiones al inicio de la línea o entre /* y */. El docente los va a leer en voz alta mientras explica, así que escríbelos en español (es-CO), claros y didácticos: qué hace la sentencia y por qué.
- Cada sentencia termina en punto y coma.
- Prefiere el ejemplo más pequeño que demuestre bien el concepto: en clase, un bloque corto se explica; uno largo se salta.

## Según lo que pida el docente
- DDL (CREATE, ALTER, DROP): declara llaves primarias y foráneas explícitas, tipos apropiados (INTEGER, TEXT, NUMERIC, DATE, TIMESTAMPTZ, BOOLEAN) y las restricciones que valga la pena explicar (NOT NULL, UNIQUE, CHECK).
- DML (INSERT, UPDATE, DELETE): cuando pidan datos de ejemplo, genera filas realistas, en español y coherentes entre tablas relacionadas; un INSERT con varias filas es preferible a muchos INSERT sueltos. En UPDATE y DELETE incluye SIEMPRE un WHERE y comenta qué pasaría sin él.
- DQL (SELECT): usa el nivel que pida el docente — JOIN, GROUP BY con HAVING, subconsultas, CTE con WITH y funciones de ventana con OVER y PARTITION BY. Alias legibles y ORDER BY para que el resultado sea estable al proyectarlo.
- DCL (GRANT, REVOKE): crea el rol con CREATE ROLE antes de otorgarle nada, otorga el privilegio mínimo del ejemplo y comenta la diferencia entre privilegios sobre tablas, sobre esquemas y sobre columnas.
- TCL (BEGIN, COMMIT, ROLLBACK, SAVEPOINT): úsalas cuando el tema sea transacciones.

## Sobre el esquema de partida
- Si el mensaje del docente incluye un esquema de partida, ese es el estado REAL de la base: usa EXACTAMENTE esos nombres de tabla y de columna, y no inventes otros.
- Si lo que se pide necesita una tabla que no aparece en ese esquema, créala e insértale datos en el mismo bloque, antes de usarla.
- Si NO hay esquema de partida y te piden una consulta, incluye primero el CREATE TABLE y los INSERT mínimos para que la consulta corra: una consulta contra tablas inexistentes falla y arruina la demostración en clase.`;

/** Tope de la instrucción del docente. Es una frase, no un documento. */
const MAX_PROMPT_CHARS = 2000;
/** Tope del esquema de partida que se manda como contexto. */
const MAX_SETUP_CHARS = 8000;
/** Tope del SQL devuelto (el editor de la hoja no persiste más que esto). */
const MAX_OUTPUT_CHARS = 20000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resuelve el system prompt de `sql_generation` desde `ai_prompts` con la
 * jerarquía estándar (course override > tenant global > platform default) y
 * cae al FALLBACK hardcodeado. Mismo patrón que `resolveReportSystemPrompt`.
 */
async function resolveSystemPrompt(courseId: string | null): Promise<string> {
  try {
    let q = admin
      .from("ai_prompts")
      .select("system_prompt, course_id, tenant_id")
      .eq("use_case", "sql_generation");
    if (courseId && UUID_RE.test(courseId)) {
      q = q.or(`course_id.eq.${courseId},course_id.is.null`);
    } else {
      q = q.is("course_id", null);
    }
    const { data, error } = await q;
    if (error || !data || data.length === 0) return FALLBACK_SQL_GENERATION_PROMPT;
    const rank = (row: { course_id: string | null; tenant_id: string | null }): number => {
      if (row.course_id) return 3;
      if (row.tenant_id) return 2;
      return 1;
    };
    const sorted = [...data].sort((a, b) => rank(b) - rank(a));
    return sorted[0]?.system_prompt || FALLBACK_SQL_GENERATION_PROMPT;
  } catch (e) {
    console.warn("[ai-generate-sql] resolve prompt failed, using fallback:", e);
    return FALLBACK_SQL_GENERATION_PROMPT;
  }
}

// El retry transitorio + failover de keys vive en aiChatCompletionFailover;
// acá RETRYABLE_STATUS solo clasifica el status FINAL para el mensaje friendly.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isRetryableAiBody(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('"status":"internal"') ||
    lower.includes('"status":"unavailable"') ||
    lower.includes('"status":"resource_exhausted"') ||
    lower.includes("rate limit") ||
    lower.includes("overloaded")
  );
}

async function callAi(
  messages: Array<{ role: string; content: string }>,
  hint: { courseId?: string | null; authHeader?: string | null },
): Promise<string> {
  const m = await getActiveAiModel(hint);
  const res = await aiChatCompletionFailover(m, { model: m.model, messages });
  if (res.ok) {
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? "";
  }
  const errText = await res.text();
  const isKeyInvalid =
    res.status === 401 ||
    res.status === 403 ||
    errText.includes("API_KEY_INVALID") ||
    errText.includes("invalid_api_key") ||
    errText.toLowerCase().includes("invalid api key");
  if (isKeyInvalid) {
    throw new Error(
      `La API key del proveedor de IA (${m.provider}) está inválida o expirada. ` +
        `Pídele al administrador que la actualice o cambie el proveedor activo ` +
        `desde Configuración → IA → Modelo.`,
    );
  }
  if (RETRYABLE_STATUS.has(res.status) || isRetryableAiBody(errText)) {
    throw new Error(
      "El proveedor de IA está saturado en este momento. Intenta de nuevo en unos segundos.",
    );
  }
  throw new Error(`AI error ${res.status}: ${errText.slice(0, 500)}`);
}

/**
 * Quita las cercas de Markdown que el modelo agrega aunque el prompt lo
 * prohíba. El resultado se inserta TAL CUAL en el editor SQL: una cerca
 * suelta hace que la primera ejecución falle con un error de sintaxis que no
 * tiene nada que ver con lo que el docente está explicando.
 */
function stripCodeFences(raw: string): string {
  let s = (raw ?? "").trim();
  const fence = "```";
  if (!s.startsWith(fence)) return s;
  // Primera línea: la cerca de apertura (con o sin lenguaje: ```sql / ```).
  const firstBreak = s.indexOf("\n");
  s = firstBreak === -1 ? "" : s.slice(firstBreak + 1);
  const closing = s.lastIndexOf(fence);
  if (closing !== -1) s = s.slice(0, closing);
  return s.trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("Método no permitido", 405);

  const userClient = userClientFromRequest(req);
  if (!userClient) return jsonError("No autenticado", 401);
  const { data: u } = await userClient.auth.getUser();
  if (!u?.user?.id) return jsonError("No autenticado", 401);

  // Gate de rol: esta es una herramienta del docente. El estudiante que ve la
  // pizarra compartida NO tiene la caja de generación en la UI; el gate cierra
  // el camino por REST directo.
  const { data: callerRoles } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", u.user.id);
  const isStaff = (callerRoles ?? []).some(
    (r: { role: string }) =>
      r.role === "Docente" || r.role === "Admin" || r.role === "SuperAdmin",
  );
  if (!isStaff) {
    return jsonError("Solo un docente o administrador puede generar SQL con IA.", 403);
  }

  // Rate limit antes de gastar créditos. 60/hora es holgado para una clase
  // (una generación cada minuto) y ataja un script en bucle.
  const rl = await enforceRateLimit(userClient, "ai.generate_sql", {
    max: 60,
    windowSeconds: 3600,
  });
  if (!rl.ok) return rl.response;

  let body: { prompt?: string; setupSql?: string | null; courseId?: string | null };
  try {
    body = await req.json();
  } catch {
    return jsonError("Solicitud inválida", 400);
  }

  const instruction = (body.prompt ?? "").trim().slice(0, MAX_PROMPT_CHARS);
  if (!instruction) return jsonError("Escribí qué querés generar.", 400);
  const setupSql = (body.setupSql ?? "").trim().slice(0, MAX_SETUP_CHARS);
  const courseId = body.courseId && UUID_RE.test(body.courseId) ? body.courseId : null;

  const systemPrompt = await resolveSystemPrompt(courseId);

  // Los datos dinámicos van en el mensaje del USUARIO, no en placeholders del
  // system prompt (convención del repo: el Admin no puede romper el contrato
  // olvidando un placeholder). El esquema de partida se manda cuando existe
  // para que la IA referencie tablas que SÍ están creadas — sin esto, pedir
  // "muéstrame los clientes" produce un SELECT contra una tabla inexistente y
  // la demostración falla en vivo.
  const userMessage = [
    "Petición del docente:",
    instruction,
    "",
    setupSql
      ? "Esquema y datos de partida que ya se ejecutan antes de la consulta (estado real de la base):"
      : "La base no tiene esquema de partida: arranca completamente vacía.",
    ...(setupSql ? [setupSql] : []),
  ].join("\n");

  try {
    const content = await callAi(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      { courseId, authHeader: req.headers.get("Authorization") },
    );
    const sql = stripCodeFences(content).slice(0, MAX_OUTPUT_CHARS);
    if (!sql) {
      return jsonError(
        "La IA no devolvió ninguna sentencia. Reformulá la petición con más detalle.",
        502,
      );
    }
    return jsonResponse({ ok: true, sql });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "No se pudo generar el SQL con IA.";
    return jsonError(msg, 500);
  }
});
