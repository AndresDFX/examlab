/**
 * Edge Function: execute-code
 * Ejecuta código según el proveedor activo en code_execution_settings.
 *
 * Proveedores soportados:
 *   onlinecompiler — OnlineCompiler.io (sync REST, ONLINE_COMPILER_API_KEY)
 *   jdoodle        — JDoodle REST API  (JDOODLE_CLIENT_ID + JDOODLE_CLIENT_SECRET)
 *   cheerp         — CheerpJ browser-side (Java en cliente); para otros lenguajes
 *                    cae en OnlineCompiler.io igual que el provider "onlinecompiler".
 */
import { adminClient as admin, corsHeaders, userClientFromRequest } from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";

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

  // Lenguajes script: concatenación con encabezado por archivo.
  return list.map((f) => `// ─── ${f.filename} ───\n${f.content}`).join("\n\n");
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

// ──────────────────────────────────────────────
// OnlineCompiler.io
// ──────────────────────────────────────────────
const ONLINECOMPILER_MAP: Record<string, string> = {
  // Versión soportada por OnlineCompiler.io. Probamos openjdk-21 antes
  // (más LTS-friendly) pero su API responde HTTP 400 — solo aceptan
  // openjdk-25 actualmente. Los compile errors opacos los limpiamos en
  // el parser de respuesta (isOpaqueApiMessage) + en el cliente.
  java: "openjdk-25",
  python: "python-3.14",
  javascript: "typescript-deno",
  typescript: "typescript-deno",
  c: "gcc-15",
  cpp: "g++-15",
  csharp: "dotnet-csharp-9",
  fsharp: "dotnet-fsharp-9",
  go: "go-1.26",
  rust: "rust-1.93",
  php: "php-8.5",
  ruby: "ruby-4.0",
  haskell: "haskell-9.12",
};

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

  const response = await fetch("https://api.onlinecompiler.io/api/run-code-sync/", {
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
const JDOODLE_MAP: Record<string, { language: string; versionIndex: string }> = {
  java: { language: "java", versionIndex: "4" },
  python: { language: "python3", versionIndex: "4" },
  javascript: { language: "nodejs", versionIndex: "4" },
  typescript: { language: "typescript", versionIndex: "1" },
  c: { language: "c", versionIndex: "5" },
  cpp: { language: "cpp17", versionIndex: "1" },
  csharp: { language: "csharp", versionIndex: "4" },
  fsharp: { language: "fsharp", versionIndex: "1" },
  go: { language: "go", versionIndex: "4" },
  rust: { language: "rust", versionIndex: "4" },
  php: { language: "php", versionIndex: "4" },
  ruby: { language: "ruby", versionIndex: "4" },
  haskell: { language: "haskell", versionIndex: "3" },
};

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

  const response = await fetch("https://api.jdoodle.com/v1/execute", {
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
const AWS_LAMBDA_LANGUAGES = new Set(["java", "python"]);

async function executeWithAwsLambda(
  sourceCode: string,
  language: string,
  stdin: string,
): Promise<ExecutionResult> {
  if (!AWS_LAMBDA_LANGUAGES.has(language)) {
    // Fallback transparente para lenguajes que el runner no soporta
    // (javascript, c, cpp, etc.). El admin que elige aws_lambda como
    // default sigue usando OnlineCompiler para esos lenguajes sin
    // necesidad de configurar otro provider — coherencia con el
    // comportamiento previo cuando solo Java estaba soportado.
    return executeWithOnlineCompiler(sourceCode, language, stdin);
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
  const response = await fetch(url, {
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
    const { data: execSettings } = await admin
      .from("code_execution_settings")
      .select("provider")
      .eq("is_active", true)
      .maybeSingle();

    const defaultProvider: string = execSettings?.provider ?? "onlinecompiler";
    const provider: string = overrideRequested ? requestedProvider! : defaultProvider;
    // 'cheerp' corre client-side, así que del lado server cae al
    // onlinecompiler para los lenguajes no-Java (Python, C, etc.).
    // El override del cliente NO acepta 'cheerp' (filtrado por la
    // whitelist arriba), pero si el default del admin es 'cheerp'
    // seguimos aplicando ese fallback.
    const effectiveProvider = provider === "cheerp" ? "onlinecompiler" : provider;
    requestContext.provider = effectiveProvider;
    requestContext.default_provider = defaultProvider;
    requestContext.provider_overridden = overrideRequested;

    const result =
      effectiveProvider === "jdoodle"
        ? await executeWithJDoodle(sourceCode, language, stdin)
        : effectiveProvider === "aws_lambda"
          ? await executeWithAwsLambda(sourceCode, language, stdin)
          : await executeWithOnlineCompiler(sourceCode, language, stdin);

    // Persistir ejecución
    await admin.from("code_executions").insert({
      submission_id: submissionId || null,
      question_id: questionId,
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
        provider: effectiveProvider,
        submission_id: submissionId ?? null,
        question_id: questionId,
        exit_code: result.exitCode,
        signal: result.signal ?? null,
        execution_time_ms: result.executionTimeMs,
        source_length: sourceCode.length,
      },
    });

    // Audit ADICIONAL si hubo error de compilación/runtime — incluye raw response
    // para poder diagnosticar mensajes como "Internal error: code execution failed".
    if (result.stderr.trim() || result.exitCode !== 0) {
      void auditFromEdge(admin, {
        actorId: u.user.id,
        action: "code.compile_error",
        category: "system",
        severity: "warning",
        entityType: "code_execution",
        entityId: questionId,
        metadata: {
          language,
          provider: effectiveProvider,
          submission_id: submissionId ?? null,
          question_id: questionId,
          exit_code: result.exitCode,
          http_status: result.httpStatus ?? null,
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
