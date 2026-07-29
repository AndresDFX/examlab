/**
 * Edge Function: execute-code
 * Ejecuta código según el proveedor activo en code_execution_settings.
 *
 * Proveedores soportados:
 *   aws_lambda     — Runner PROPIO. Es la VM donde corre JUDGE0: si `JUDGE0_URL`
 *                    está configurada se habla su API (`/submissions`); si no,
 *                    el protocolo propio de `aws/code-runner/app.py`
 *                    (AWS_RUNNER_URL + AWS_RUNNER_API_KEY). Judge0 NO es un
 *                    proveedor aparte — es la implementación de este.
 *   onlinecompiler — OnlineCompiler.io (sync REST, ONLINE_COMPILER_API_KEY)
 *   jdoodle        — JDoodle REST API  (JDOODLE_CLIENT_ID + JDOODLE_CLIENT_SECRET)
 *   cheerp         — CheerpJ browser-side (Java en cliente); server-side se
 *                    resuelve a otro proveedor.
 *
 * QUÉ LENGUAJE PUEDE CADA UNO: mapeo oficial en `./language-support.ts`
 * (réplica de `src/modules/code/language-support.ts`). Ese archivo es la fuente
 * única — acá NO se declaran tablas de lenguajes. El proveedor efectivo lo
 * decide `resolveProviderFor(language, configurado)`, así que un lenguaje que el
 * proveedor configurado no soporta se rutea al que sí, en vez de fallar.
 *
 * El proveedor configurado se resuelve con el RPC
 * `get_active_code_execution_settings()`: override de la institución → default
 * de plataforma → defaults duros. La UI llama al MISMO RPC, así que el
 * "compilador por defecto" es uno solo en toda la app.
 */
import { adminClient as admin, corsHeaders, userClientFromRequest } from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";
import {
  AWS_LAMBDA_LANGUAGES as AWS_LANGS,
  JDOODLE_ID,
  JUDGE0_LANGUAGE_ID,
  ONLINECOMPILER_ID,
  resolveProviderFor,
  type CodeLanguage,
  type CodeProvider,
} from "./language-support.ts";

/** Un archivo de código: nombre lógico + contenido. */
interface CodeFile {
  filename: string;
  content: string;
}

interface ExecutionRequest {
  /** Fuente single-archivo (modo legacy / mayoría de callers). */
  sourceCode?: string;
  /**
   * Modo multi-archivo: lista de archivos { filename, content }. Cuando
   * llega y tiene ≥1 archivo, tiene prioridad sobre `sourceCode`. Para
   * los providers remotos que solo aceptan UN string (OnlineCompiler,
   * JDoodle, AWS Lambda actual) los combinamos en un solo `sourceCode`
   * via `combineFiles` antes de mandar. Cuando el runner soporte FS
   * multi-archivo (AWS app.py — TODO), se podrá pasar `files` crudo.
   */
  files?: CodeFile[];
  language: string;
  stdin?: string;
  questionId: string;
  submissionId?: string;
  /**
   * Override del proveedor desde el cliente. Pensado para que el
   * estudiante elija un compilador alterno DURANTE el examen si el
   * default (configurado por Admin) está caído. Cuando se omite se usa
   * el activo en `code_execution_settings`. La auditoría registra el
   * provider efectivamente usado más un flag `provider_overridden`.
   */
  provider?: string;
}

/**
 * Detecta si un fuente Java declara `public static void main(String[])`.
 * Tolera `String[] args` / `String args[]` / `String... args`.
 */
function javaHasMain(source: string): boolean {
  return /\bpublic\s+static\s+void\s+main\s*\(\s*(?:final\s+)?String\s*(?:\[\s*\]|\.\.\.)\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\[\s*\])?\s*\)/.test(
    source,
  );
}

/**
 * Combina N archivos en un único string que los providers single-source
 * pueden compilar/ejecutar.
 *
 * Java: en una sola compilation unit NO puede haber 2 `public class`. Por
 * eso ponemos el archivo con `main` primero (su public class manda) y a
 * los demás les degradamos `public class X` → `class X` (package-private,
 * visible dentro del mismo paquete default). Se quitan los `package ...;`
 * de los archivos secundarios para no romper la unit. Funciona para el
 * caso común "una clase con main + clases helper".
 *
 * Otros lenguajes (python, js, etc.): concatenación simple con un
 * comentario-encabezado por archivo. El orden coloca primero el que
 * parezca el "principal".
 */
function combineFiles(files: CodeFile[], language: string): string {
  const nonEmpty = files.filter((f) => (f.content ?? "").trim().length > 0);
  const list = nonEmpty.length > 0 ? nonEmpty : files;
  if (list.length === 0) return "";
  if (list.length === 1) return list[0].content;

  if (language === "java") {
    // Entrada primero. Si ninguno tiene main, dejamos el orden original.
    const mainIdx = list.findIndex((f) => javaHasMain(f.content));
    const ordered =
      mainIdx > 0 ? [list[mainIdx], ...list.filter((_, i) => i !== mainIdx)] : list;
    const parts = ordered.map((f, idx) => {
      let body = f.content;
      if (idx > 0) {
        // Quitar package declarations de secundarios.
        body = body.replace(/^\s*package\s+[^;]+;\s*/m, "");
        // Degradar public class/enum/record/interface a package-private.
        body = body.replace(
          /\bpublic\s+((?:final\s+|abstract\s+)?(?:class|enum|record|interface)\b)/g,
          "$1",
        );
      }
      return body;
    });
    return parts.join("\n\n");
  }

  // Lenguajes script: concatenación con encabezado por archivo. El marcador de
  // comentario depende del lenguaje: `//` en Python es división entera (no
  // comentario) → una línea que empieza con `//` es SyntaxError. Usar `#`.
  // INVARIANTE: idéntico a combine-files.ts del cliente (ver CLAUDE.md).
  const commentPrefix = language === "python" ? "#" : "//";
  return list.map((f) => `${commentPrefix} ─── ${f.filename} ───\n${f.content}`).join("\n\n");
}

/** Providers válidos para el override del cliente. Debe coincidir con
 *  el CHECK constraint de code_execution_settings.provider. `cheerp`
 *  no se puede mandar desde el cliente porque corre client-side y no
 *  llega a esta edge function (la UI ramifica antes). */
const ALLOWED_PROVIDER_OVERRIDES = new Set(["onlinecompiler", "jdoodle", "aws_lambda"]);

interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
  signal?: number | null;
  /** Raw API response — incluida en audit metadata cuando hay error. */
  rawResponse?: unknown;
  /** HTTP status del API remoto. */
  httpStatus?: number;
}

/**
 * fetch con timeout duro vía AbortController. Sin esto, un provider colgado
 * deja la edge esperando hasta el timeout global de Supabase (~150s) y el
 * estudiante ve un spinner eterno. Con el timeout recibe un error claro y
 * accionable (reintentar / elegir otro compilador) en segundos.
 */
async function fetchWithTimeout(
  url: string,
  opts: RequestInit,
  ms = 45_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(
        `El compilador no respondió en ${Math.round(ms / 1000)}s (timeout). ` +
          `Intenta de nuevo o elige otro compilador.`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────
// OnlineCompiler.io
// ──────────────────────────────────────────────
// Los ids de cada compilador viven en `./language-support.ts` — mapeo OFICIAL,
// réplica exacta de `src/modules/code/language-support.ts` (Deno no puede
// importar de src/). Estos alias mantienen los usos de abajo sin cambios.
const ONLINECOMPILER_MAP = ONLINECOMPILER_ID as Record<string, string>;

async function executeWithOnlineCompiler(
  sourceCode: string,
  language: string,
  stdin: string,
): Promise<ExecutionResult> {
  const apiKey = Deno.env.get("ONLINE_COMPILER_API_KEY");
  if (!apiKey) throw new Error("ONLINE_COMPILER_API_KEY no configurado en el servidor");

  const compiler = ONLINECOMPILER_MAP[language];
  if (!compiler) throw new Error(`Lenguaje no soportado por OnlineCompiler.io: ${language}`);

  const startTime = Date.now();

  const response = await fetchWithTimeout("https://api.onlinecompiler.io/api/run-code-sync/", {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      compiler,
      code: sourceCode,
      ...(stdin ? { input: stdin } : {}),
    }),
  });

  const executionTimeMs = Date.now() - startTime;
  const httpStatus = response.status;

  if (response.status === 429) {
    throw new Error("Demasiadas ejecuciones simultáneas. Espera unos segundos e intenta de nuevo.");
  }

  // Capturamos el body siempre para incluirlo en audit aunque haya 5xx.
  const rawText = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    // Respuesta no-JSON — la incluimos cruda en rawResponse para diagnóstico
    data = { _nonJsonBody: rawText.slice(0, 2000) };
  }

  if (!response.ok) {
    const err = new Error(
      `Error del compilador remoto (OnlineCompiler.io): HTTP ${response.status}`,
    ) as Error & { rawResponse?: unknown; httpStatus?: number };
    err.rawResponse = data;
    err.httpStatus = httpStatus;
    throw err;
  }

  // OnlineCompiler.io a veces pone el mensaje genérico
  // "Internal error: code execution failed" en `output` y deja el
  // traceback real en otros campos. Escaneamos múltiples nombres
  // posibles para no perder el detalle al usuario.
  const pickString = (...keys: string[]): string => {
    for (const k of keys) {
      const v = (data as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) return v;
    }
    return "";
  };

  const output = pickString("output", "stdout");
  const errorField = pickString(
    "error",
    "stderr",
    "compile_output",
    "compileOutput",
    "compile_error",
    "compileError",
    "compileMessage",
    "build_output",
    "buildOutput",
    "compile_stderr",
  );
  const exitCodeRaw = (data as { exit_code?: unknown }).exit_code;
  const statusField = (data as { status?: unknown }).status;
  const signalField = (data as { signal?: unknown }).signal;

  const exitCode =
    typeof exitCodeRaw === "number" ? exitCodeRaw : statusField === "success" ? 0 : 1;

  // OnlineCompiler.io devuelve "Internal error: code execution failed"
  // en `output` cuando hay error de compilación; el detalle real (línea,
  // mensaje del compilador) va en `compile_output`/`error`/`stderr`/etc.
  // El mensaje opaco no aporta nada al alumno — lo descartamos siempre
  // que el exitCode indique error.
  const isOpaqueApiMessage = (s: string): boolean =>
    /^\s*internal error: code execution failed\s*\.?\s*$/i.test(s) ||
    /^\s*error: code execution failed\s*\.?\s*$/i.test(s);

  // El mensaje opaco puede llegar tanto en `output` (stdout) como en
  // `error` (stderr) según el caso del API. Lo limpiamos de ambos lados.
  const outputIsOpaque = isOpaqueApiMessage(output);
  const errorIsOpaque = isOpaqueApiMessage(errorField);
  const stdoutFinal = outputIsOpaque ? "" : output;
  let stderrFinal = errorIsOpaque ? "" : errorField;

  // Si después de limpiar no queda nada útil y el exitCode indica error
  // (incluido el -1 que el API devuelve cuando falla internamente),
  // sustituimos por un mensaje accionable. El raw_response completo
  // queda en audit_logs (action: code.compile_error) para que el admin
  // pueda diagnosticar qué devolvió el provider.
  if (!stdoutFinal && !stderrFinal && exitCode !== 0) {
    stderrFinal =
      "El compilador remoto no devolvió detalle del error. Suele indicar un error " +
      "de compilación (falta `;`, llaves desbalanceadas, import erróneo, nombre " +
      "de clase incorrecto). Revisa tu código línea por línea y vuelve a intentar.";
  }

  return {
    stdout: stdoutFinal,
    stderr: stderrFinal,
    exitCode,
    executionTimeMs,
    signal: typeof signalField === "number" ? signalField : null,
    rawResponse: data,
    httpStatus,
  };
}

// ──────────────────────────────────────────────
// JDoodle
// ──────────────────────────────────────────────
const JDOODLE_MAP = JDOODLE_ID as Record<string, { language: string; versionIndex: string }>;

async function executeWithJDoodle(
  sourceCode: string,
  language: string,
  stdin: string,
): Promise<ExecutionResult> {
  const clientId = Deno.env.get("JDOODLE_CLIENT_ID");
  const clientSecret = Deno.env.get("JDOODLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("JDOODLE_CLIENT_ID o JDOODLE_CLIENT_SECRET no configurados en el servidor");
  }

  const mapping = JDOODLE_MAP[language];
  if (!mapping) throw new Error(`Lenguaje no soportado por JDoodle: ${language}`);

  const startTime = Date.now();

  const response = await fetchWithTimeout("https://api.jdoodle.com/v1/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      script: sourceCode,
      language: mapping.language,
      versionIndex: mapping.versionIndex,
      stdin: stdin || "",
      clientId,
      clientSecret,
    }),
  });

  const executionTimeMs = Date.now() - startTime;
  const httpStatus = response.status;

  const rawText = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { _nonJsonBody: rawText.slice(0, 2000) };
  }

  if (!response.ok) {
    const err = new Error(
      `Error del compilador remoto (JDoodle): HTTP ${response.status}`,
    ) as Error & { rawResponse?: unknown; httpStatus?: number };
    err.rawResponse = data;
    err.httpStatus = httpStatus;
    throw err;
  }

  const statusCode = (data as { statusCode?: unknown }).statusCode;
  const errorField = (data as { error?: unknown }).error;
  const outputField = (data as { output?: unknown }).output;
  const isError = statusCode !== 200 || errorField != null;
  const outStr = typeof outputField === "string" ? outputField : "";
  const errStr = typeof errorField === "string" ? errorField : "";

  return {
    stdout: isError ? "" : outStr,
    stderr: isError ? outStr || errStr || "Error desconocido" : "",
    exitCode: isError ? 1 : 0,
    executionTimeMs,
    signal: null,
    rawResponse: data,
    httpStatus,
  };
}

// ──────────────────────────────────────────────
// AWS Lambda runner (self-hosted)
// ──────────────────────────────────────────────
// Lambda Function URL configurada en env vars:
//   AWS_RUNNER_URL     — output `FunctionUrl` del stack CloudFormation
//   AWS_RUNNER_API_KEY — shared secret (SSM Parameter `/examlab-code-runner/api-key`)
// El handler en aws/code-runner/app.py valida el X-API-Key y compila +
// ejecuta. Soporta Java (javac + java) y Python (python3 AL2023 con
// tkinter incluido). Para lenguajes que el runner no soporta cae
// automáticamente a OnlineCompiler.io más abajo.
const AWS_LAMBDA_LANGUAGES = new Set<string>(AWS_LANGS);

/**
 * Judge0 self-hosted (VM propia). Es el único proveedor de infraestructura
 * propia que ejecuta Kotlin, y no cobra por corrida ni tiene cuota de terceros.
 *
 * Soporta las DOS formas de la API a propósito, porque el modo síncrono depende
 * de la config de la VM (`ENABLE_WAIT_RESULT` en judge0.conf):
 *   - `?wait=true` → la respuesta ya trae el resultado.
 *   - si la instancia lo tiene deshabilitado devuelve solo un `token` → se
 *     consulta el resultado por polling.
 * Sin este doble camino, una VM con la config por defecto haría fallar TODAS
 * las corridas con un error que no dice nada útil.
 */
async function executeWithJudge0(
  sourceCode: string,
  language: string,
  stdin: string,
): Promise<ExecutionResult> {
  const baseRaw = Deno.env.get("JUDGE0_URL");
  if (!baseRaw) {
    throw new Error(
      "JUDGE0_URL no configurado en el servidor (Lovable → Edge Function Secrets).",
    );
  }
  const base = baseRaw.replace(/\/+$/, "");
  const authToken = Deno.env.get("JUDGE0_AUTH_TOKEN"); // opcional: solo si la VM lo exige

  const languageId = JUDGE0_LANGUAGE_ID[language as CodeLanguage];
  if (!languageId) throw new Error(`Lenguaje no soportado por Judge0: ${language}`);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["X-Auth-Token"] = authToken;

  const started = Date.now();
  const createRes = await fetch(`${base}/submissions?base64_encoded=false&wait=true`, {
    method: "POST",
    headers,
    body: JSON.stringify({ source_code: sourceCode, language_id: languageId, stdin: stdin || "" }),
  });

  const createText = await createRes.text();
  if (!createRes.ok) {
    // Errores de INFRA/config (VM caída, token inválido, id de lenguaje
    // inexistente). Se LANZA para que el caller aplique el fallback a otro
    // proveedor — los errores de CÓDIGO del alumno no pasan por acá.
    throw new Error(`Judge0 HTTP ${createRes.status}: ${createText.slice(0, 300)}`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(createText) as Record<string, unknown>;
  } catch {
    throw new Error(`Judge0 devolvió una respuesta no-JSON: ${createText.slice(0, 200)}`);
  }

  // Modo asíncrono: llegó solo el token → polling hasta que salga de la cola.
  // status.id 1=In Queue, 2=Processing; cualquier otro es terminal.
  if (payload.status === undefined && typeof payload.token === "string") {
    const token = payload.token;
    const DEADLINE_MS = 20_000;
    const POLL_MS = 600;
    while (Date.now() - started < DEADLINE_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const pollRes = await fetch(`${base}/submissions/${token}?base64_encoded=false`, { headers });
      if (!pollRes.ok) continue; // reintenta hasta el deadline
      const pollJson = (await pollRes.json()) as Record<string, unknown>;
      const statusId = (pollJson.status as { id?: number } | undefined)?.id ?? 0;
      if (statusId > 2) {
        payload = pollJson;
        break;
      }
    }
    if (payload.status === undefined) {
      throw new Error("Judge0 no devolvió resultado antes del tiempo límite.");
    }
  }

  const status = (payload.status ?? {}) as { id?: number; description?: string };
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  const stderrRaw = typeof payload.stderr === "string" ? payload.stderr : "";
  // `compile_output` es DONDE aparece el error de compilación, y para Kotlin
  // (compilado) es lo único que el alumno necesita leer. Sin volcarlo a stderr
  // el alumno veía una salida vacía ante un error de sintaxis.
  const compileOutput = typeof payload.compile_output === "string" ? payload.compile_output : "";
  const message = typeof payload.message === "string" ? payload.message : "";

  const stderr = [compileOutput, stderrRaw, status.id !== 3 ? message : ""]
    .filter((s) => s && s.trim())
    .join("\n")
    .trim();

  // `time` viene en segundos como string ("0.032").
  const reportedMs = Number(payload.time) > 0 ? Math.round(Number(payload.time) * 1000) : null;

  return {
    stdout,
    stderr,
    // status.id 3 = Accepted. Todo lo demás (6 = Compilation Error,
    // 5 = Time Limit Exceeded, 7-12 = runtime) es fallo del código del alumno.
    exitCode: typeof payload.exit_code === "number" ? payload.exit_code : status.id === 3 ? 0 : 1,
    executionTimeMs: reportedMs ?? Date.now() - started,
    rawResponse: payload,
    httpStatus: createRes.status,
  };
}

async function executeWithAwsLambda(
  sourceCode: string,
  language: string,
  stdin: string,
): Promise<ExecutionResult> {
  // Judge0 corre EN esta misma VM: `aws_lambda` es el slot del runner propio y
  // Judge0 su implementación, no un proveedor aparte. Si está configurado,
  // hablamos su API; si no, seguimos con el protocolo propio (`mode: run`) del
  // handler en `aws/code-runner/app.py`. El doble camino existe para que
  // migrar la VM a Judge0 no requiera un deploy coordinado del edge.
  if (Deno.env.get("JUDGE0_URL")) {
    return executeWithJudge0(sourceCode, language, stdin);
  }

  if (!AWS_LAMBDA_LANGUAGES.has(language)) {
    // Lenguaje sin runtime en el runner propio. El fallback lo decide el MAPEO,
    // no una constante: antes era `onlinecompiler` fijo, y con Kotlin eso
    // rompía —OnlineCompiler.io no lo soporta— mandándolo a un compilador que
    // no lo conoce.
    const alt = resolveProviderFor(language as CodeLanguage, "onlinecompiler" as CodeProvider);
    if (alt === "jdoodle") return executeWithJDoodle(sourceCode, language, stdin);
    if (alt === "onlinecompiler") return executeWithOnlineCompiler(sourceCode, language, stdin);
    throw new Error(`Ningún compilador configurado ejecuta ${language}.`);
  }
  const url = Deno.env.get("AWS_RUNNER_URL");
  const apiKey = Deno.env.get("AWS_RUNNER_API_KEY");
  if (!url || !apiKey) {
    // Mensaje accionable: el admin ve EXACTAMENTE qué env var falta.
    const missing: string[] = [];
    if (!url) missing.push("AWS_RUNNER_URL");
    if (!apiKey) missing.push("AWS_RUNNER_API_KEY");
    throw new Error(
      `Faltan env vars en Supabase Edge Function Secrets: ${missing.join(", ")}. ` +
        `Ejecuta 'bash aws/code-runner/deploy.sh' y copia los valores que imprime al final.`,
    );
  }
  // Defensa de path: detecta URL mal formado y devuelve mensaje claro
  // diferenciando los 3 casos típicos.
  const urlTrimmed = url.replace(/\/+$/, "");
  const isFunctionUrl = /\.lambda-url\.[a-z0-9-]+\.on\.aws/i.test(url);
  const isApiGateway = /\.execute-api\.[a-z0-9-]+\.amazonaws\.com/i.test(url);
  if (isFunctionUrl) {
    // El URL que tiene es un Lambda Function URL VIEJO — ya no usamos
    // ese modelo (causaba HTTP 403 por SCPs). Migramos a API Gateway.
    throw new Error(
      `AWS_RUNNER_URL tiene un Lambda Function URL (*.lambda-url.*.on.aws) ` +
        `que era el modelo VIEJO. La arquitectura actual usa API Gateway. ` +
        `Re-ejecuta 'bash aws/code-runner/deploy.sh' y copia el nuevo AWS_RUNNER_URL ` +
        `del output (debe terminar en /run y el dominio ser *.execute-api.*.amazonaws.com).`,
    );
  }
  if (isApiGateway && !urlTrimmed.endsWith("/run") && !urlTrimmed.includes("/run?")) {
    throw new Error(
      `AWS_RUNNER_URL apunta al API Gateway correcto pero le falta la ruta /run al final. ` +
        `Valor actual: "${url}". Esperado: "${urlTrimmed}/run".`,
    );
  }
  if (!isApiGateway && !urlTrimmed.endsWith("/run")) {
    throw new Error(
      `AWS_RUNNER_URL no parece ser un endpoint de AWS válido. ` +
        `Esperado: "https://<api-id>.execute-api.<region>.amazonaws.com/run". ` +
        `Valor actual: "${url}". ` +
        `Re-ejecuta 'bash aws/code-runner/deploy.sh' y copia el output.`,
    );
  }
  // NOTA: si seteaste un valor nuevo en Admin → Configuración → Secretos
  // y sigues viendo el viejo, es cache de Supabase Edge Functions —
  // espera ~15 min a que reciclen los containers o redespliegua los
  // edge functions para aplicar inmediato.

  const startTime = Date.now();
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    // `language` lo añadimos cuando el runner ganó soporte para Python
    // (antes solo Java implícito). Mandarlo siempre — el handler default
    // a 'java' si no llega, así que vieja Lambda + nuevo edge sigue
    // funcionando para Java mientras se hace el redeploy.
    body: JSON.stringify({ sourceCode, language, stdin: stdin || "" }),
  });

  const executionTimeMs = Date.now() - startTime;
  const httpStatus = response.status;
  const rawText = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { _nonJsonBody: rawText.slice(0, 2000) };
  }

  if (!response.ok) {
    // Construimos un mensaje útil con el detalle del response, no solo
    // "HTTP 403". Para 4xx/5xx el body de la Lambda/API Gateway suele
    // tener un campo { error } o { message } con la causa real.
    const detail =
      typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : typeof (data as { message?: unknown }).message === "string"
          ? (data as { message: string }).message
          : typeof (data as { _nonJsonBody?: unknown })._nonJsonBody === "string"
            ? (data as { _nonJsonBody: string })._nonJsonBody
            : "";
    const fullMsg = detail
      ? `Error del runner AWS Lambda (HTTP ${response.status}): ${detail}`
      : `Error del runner AWS Lambda: HTTP ${response.status}`;
    const err = new Error(fullMsg) as Error & {
      rawResponse?: unknown;
      httpStatus?: number;
    };
    err.rawResponse = data;
    err.httpStatus = httpStatus;
    throw err;
  }

  const stdout =
    typeof (data as { stdout?: unknown }).stdout === "string"
      ? (data as { stdout: string }).stdout
      : "";
  const stderr =
    typeof (data as { stderr?: unknown }).stderr === "string"
      ? (data as { stderr: string }).stderr
      : "";
  const exitCode =
    typeof (data as { exitCode?: unknown }).exitCode === "number"
      ? (data as { exitCode: number }).exitCode
      : 0;

  return {
    stdout,
    stderr,
    exitCode,
    executionTimeMs,
    signal: null,
    rawResponse: data,
    httpStatus,
  };
}

// ──────────────────────────────────────────────
// Handler principal
// ──────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Capturamos contexto pronto para que el catch global pueda loguear con detalles
  let actorId: string | undefined;
  const requestContext: Record<string, unknown> = {};

  try {
    const {
      sourceCode: sourceCodeRaw,
      files,
      language,
      stdin = "",
      questionId,
      submissionId,
      provider: requestedProvider,
    }: ExecutionRequest = await req.json();

    // Modo multi-archivo: si llega `files` con contenido, lo combinamos en
    // un único string para los providers single-source. Si no, usamos
    // `sourceCode` legacy. Esto mantiene compat total con los callers que
    // siguen mandando un solo `sourceCode`.
    const hasFiles = Array.isArray(files) && files.length > 0;
    const sourceCode = hasFiles ? combineFiles(files!, language) : (sourceCodeRaw ?? "");

    // Si el cliente mandó un override del provider, validamos contra la
    // whitelist. Provider inválido = 400 explícito (mejor que silenciar y
    // caer al default — al estudiante le ayuda saber que el modo elegido
    // no es válido). Provider válido pero sin secret configurado el
    // executor lanzará su propio error de runtime — eso se captura en
    // el audit y se devuelve como stderr al alumno.
    const overrideRequested = typeof requestedProvider === "string" && requestedProvider.length > 0;
    if (overrideRequested && !ALLOWED_PROVIDER_OVERRIDES.has(requestedProvider)) {
      return new Response(
        JSON.stringify({
          error: `Provider inválido: "${requestedProvider}". Opciones: ${[
            ...ALLOWED_PROVIDER_OVERRIDES,
          ].join(", ")}.`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    Object.assign(requestContext, {
      language,
      questionId,
      submissionId: submissionId ?? null,
      source_length: sourceCode?.length ?? 0,
      file_count: hasFiles ? files!.length : 1,
      requested_provider: overrideRequested ? requestedProvider : null,
    });

    if (!sourceCode?.trim()) {
      return new Response(JSON.stringify({ error: "Código fuente requerido" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const allLanguages = new Set([...Object.keys(ONLINECOMPILER_MAP), ...Object.keys(JDOODLE_MAP)]);
    if (!allLanguages.has(language)) {
      return new Response(
        JSON.stringify({
          error: `Lenguaje no soportado: ${language}. Soportados: ${[...allLanguages].join(", ")}`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (sourceCode.length > 100_000) {
      return new Response(JSON.stringify({ error: "Código demasiado largo (máx 100 KB)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Autenticar usuario
    const userClient = userClientFromRequest(req);
    if (!userClient) throw new Error("No autenticado");
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) throw new Error("No autenticado");
    actorId = u.user.id;

    // Leer proveedor activo configurado por el Admin. El cliente puede
    // sobreescribirlo vía `provider` en el body (caso "Lambda caído →
    // estudiante elige onlinecompiler manualmente para no perder la
    // pregunta"). En cualquier caso registramos AMBOS para auditoría.
    // El ajuste efectivo lo resuelve el RPC, NO un SELECT directo: precedencia
    // override de la institución → default de plataforma → defaults duros.
    // Así el "compilador por defecto" es el mismo que ve la UI (que llama al
    // mismo RPC) en vez de dos lecturas que pueden discrepar.
    // Se invoca con el cliente del USUARIO para que `current_tenant_id()`
    // resuelva su institución; con `admin` (service_role) daría NULL y todos
    // caerían al default de plataforma.
    const { data: effSettings } = await userClient.rpc("get_active_code_execution_settings");
    const settingsRow = (Array.isArray(effSettings) ? effSettings[0] : effSettings) as
      | { provider?: string }
      | null;
    const defaultProvider: string = settingsRow?.provider ?? "onlinecompiler";
    const provider: string = overrideRequested ? requestedProvider! : defaultProvider;

    // El proveedor efectivo lo decide el MAPEO, no una constante. Antes el
    // fallback era `onlinecompiler` hardcodeado, lo que con Kotlin se rompe:
    // OnlineCompiler.io no lo soporta, así que una institución con ese default
    // habría mandado Kotlin a un compilador que no lo conoce. `cheerp` también
    // se resuelve acá (corre client-side; server-side siempre va a otro).
    const routed = resolveProviderFor(language as CodeLanguage, provider as CodeProvider);
    if (!routed) {
      // Ningún compilador soporta el lenguaje: error EXPLÍCITO, no un intento
      // a ciegas que termina en un 500 opaco.
      return new Response(
        JSON.stringify({
          error: `El lenguaje "${language}" no está soportado por ningún compilador configurado.`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const effectiveProvider: string = routed;
    requestContext.provider = effectiveProvider;
    requestContext.default_provider = defaultProvider;
    requestContext.provider_overridden = overrideRequested;
    requestContext.provider_routed = effectiveProvider !== provider;

    const runWithProvider = (p: string): Promise<ExecutionResult> =>
      p === "jdoodle"
        ? executeWithJDoodle(sourceCode, language, stdin)
        : p === "aws_lambda"
          ? executeWithAwsLambda(sourceCode, language, stdin)
          : executeWithOnlineCompiler(sourceCode, language, stdin);

    // Resiliencia: si el provider elegido NO está disponible (secret faltante,
    // caído, timeout de red) y no es ya onlinecompiler, reintentamos con
    // onlinecompiler para no hacerle perder la corrida al estudiante. Los
    // errores de CÓDIGO del alumno NO llegan acá (los executors devuelven un
    // ExecutionResult con exitCode!=0; solo LANZAN ante fallos de
    // infraestructura/config del provider), así que el fallback nunca
    // enmascara un error legítimo de compilación/ejecución.
    let result: ExecutionResult;
    let usedProvider = effectiveProvider;
    try {
      result = await runWithProvider(effectiveProvider);
    } catch (provErr) {
      // El proveedor de respaldo debe SOPORTAR el lenguaje. Antes se reintentaba
      // con `onlinecompiler` fijo: para Kotlin eso cambiaba un fallo de infra por
      // un "lenguaje no soportado", que es peor porque confunde al alumno.
      const backup = ((): string | null => {
        for (const cand of ["aws_lambda", "jdoodle", "onlinecompiler"] as CodeProvider[]) {
          if (cand === effectiveProvider) continue;
          if (resolveProviderFor(language as CodeLanguage, cand) === cand) return cand;
        }
        return null;
      })();
      if (backup) {
        usedProvider = backup;
        void auditFromEdge(admin, {
          actorId: u.user.id,
          action: "code.provider_fallback",
          category: "system",
          severity: "warning",
          entityType: "code_execution",
          entityId: questionId,
          metadata: {
            ...requestContext,
            failed_provider: effectiveProvider,
            fallback_provider: backup,
            reason: provErr instanceof Error ? provErr.message : String(provErr),
          },
        });
        result = await runWithProvider(backup);
      } else {
        throw provErr;
      }
    }
    requestContext.provider_used = usedProvider;

    // Persistir ejecución. question_id es FK a questions(id): SOLO el flujo de
    // EXAMEN pasa un questions.id genuino (y siempre trae submissionId). Los
    // runners de snippet de sesión / contenido / notebook pasan un id que NO es
    // de questions (o undefined) → enlazar question_id ahí violaba el FK/NOT NULL
    // y la ejecución nunca se persistía (falla silenciosa). Solo lo enlazamos
    // cuando hay submissionId (examen); si no, queda NULL (columna nullable tras
    // la migración de code_executions).
    const { error: insErr } = await admin.from("code_executions").insert({
      submission_id: submissionId || null,
      question_id: submissionId ? questionId : null,
      user_id: u.user.id,
      language,
      source_code: sourceCode,
      stdin,
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exitCode,
      execution_time_ms: result.executionTimeMs,
      status: result.exitCode === 0 ? "completed" : "error",
    });
    if (insErr) {
      void auditFromEdge(admin, {
        actorId: u.user.id,
        action: "code.execution_persist_failed",
        category: "system",
        severity: "warning",
        entityType: "code_execution",
        metadata: { ...requestContext, error: insErr.message },
      });
    }

    // Audit de éxito (info — para historial general)
    void auditFromEdge(admin, {
      actorId: u.user.id,
      action: "code.executed",
      category: "system",
      severity: "info",
      entityType: "code_execution",
      entityId: questionId,
      metadata: {
        language,
        provider: usedProvider,
        submission_id: submissionId ?? null,
        question_id: questionId,
        exit_code: result.exitCode,
        signal: result.signal ?? null,
        execution_time_ms: result.executionTimeMs,
        source_length: sourceCode.length,
      },
    });

    // Audit de ERROR solo si es un FALLO DE INFRAESTRUCTURA (el runner/edge no
    // pudo ejecutar): 5xx del provider, proceso matado (signal/timeout), sin
    // salida alguna, o el mensaje opaco "Internal error: code execution failed".
    // Un exit!=0 CON stderr real (traceback) y http 200 es un error del CÓDIGO
    // DEL ALUMNO — salida NORMAL de terminal (esperada al aprender): ya se ve en
    // la consola y quedó en `code.executed` (info); NO se audita como warning.
    // Antes TODO exit!=0 emitía un warning "code.compile_error" que ensuciaba el
    // panel de Errores con errores normales de los estudiantes.
    const isInfraFailure =
      (result.httpStatus != null && result.httpStatus >= 500) ||
      !!result.signal ||
      (!result.stdout.trim() && !result.stderr.trim()) ||
      /internal\s+error:\s*code execution failed/i.test(result.stderr);
    if (isInfraFailure) {
      void auditFromEdge(admin, {
        actorId: u.user.id,
        action: "code.compile_error",
        category: "system",
        severity: "warning",
        entityType: "code_execution",
        entityId: questionId,
        metadata: {
          language,
          provider: usedProvider,
          submission_id: submissionId ?? null,
          question_id: questionId,
          exit_code: result.exitCode,
          http_status: result.httpStatus ?? null,
          signal: result.signal ?? null,
          stderr_preview: result.stderr.slice(0, 2000),
          stdout_preview: result.stdout.slice(0, 500),
          raw_response: result.rawResponse,
          source_length: sourceCode.length,
        },
      });
    }

    return new Response(
      JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        executionTimeMs: result.executionTimeMs,
        signal: result.signal ?? null,
        providerUsed: usedProvider,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    const stack = e instanceof Error ? e.stack : undefined;
    const errWithExtras = e as { rawResponse?: unknown; httpStatus?: number };

    // Log audit del fallo completo — esto se ve en /app/admin/audit-logs
    // y permite saber qué pasó cuando el cliente muestra "Error: ..."
    void auditFromEdge(admin, {
      actorId,
      action: "code.execute_failed",
      category: "system",
      severity: "error",
      entityType: "code_execution",
      metadata: {
        ...requestContext,
        error: msg,
        stack: stack?.slice(0, 2000) ?? null,
        http_status: errWithExtras.httpStatus ?? null,
        raw_response: errWithExtras.rawResponse ?? null,
      },
    });

    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
