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

interface ExecutionRequest {
  sourceCode: string;
  language: string;
  stdin?: string;
  questionId: string;
  submissionId?: string;
}

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
  java:       "openjdk-25",
  python:     "python-3.14",
  javascript: "typescript-deno",
  typescript: "typescript-deno",
  c:          "gcc-15",
  cpp:        "g++-15",
  csharp:     "dotnet-csharp-9",
  fsharp:     "dotnet-fsharp-9",
  go:         "go-1.26",
  rust:       "rust-1.93",
  php:        "php-8.5",
  ruby:       "ruby-4.0",
  haskell:    "haskell-9.12",
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
      "Authorization": apiKey,
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
    throw new Error(
      "Demasiadas ejecuciones simultáneas. Espera unos segundos e intenta de nuevo.",
    );
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

  const outputIsOpaque = isOpaqueApiMessage(output);
  const stdoutFinal = outputIsOpaque ? "" : output;

  // Si el output era opaco y NO encontramos detalle en ningún otro campo
  // pero exitCode marca error, dejamos un mensaje accionable. Si SÍ hay
  // detalle, lo mostramos tal cual y descartamos el opaco.
  let stderrFinal = errorField;
  if (outputIsOpaque && !errorField && exitCode !== 0) {
    stderrFinal =
      "El compilador no devolvió el detalle del error. Suele indicar un error " +
      "de compilación (sintaxis, punto y coma, llaves, imports). Revisa tu código y vuelve a intentar.";
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
  java:       { language: "java",       versionIndex: "4" },
  python:     { language: "python3",    versionIndex: "4" },
  javascript: { language: "nodejs",     versionIndex: "4" },
  typescript: { language: "typescript", versionIndex: "1" },
  c:          { language: "c",          versionIndex: "5" },
  cpp:        { language: "cpp17",      versionIndex: "1" },
  csharp:     { language: "csharp",     versionIndex: "4" },
  fsharp:     { language: "fsharp",     versionIndex: "1" },
  go:         { language: "go",         versionIndex: "4" },
  rust:       { language: "rust",       versionIndex: "4" },
  php:        { language: "php",        versionIndex: "4" },
  ruby:       { language: "ruby",       versionIndex: "4" },
  haskell:    { language: "haskell",    versionIndex: "3" },
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
    stderr: isError ? (outStr || errStr || "Error desconocido") : "",
    exitCode: isError ? 1 : 0,
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
      sourceCode,
      language,
      stdin = "",
      questionId,
      submissionId,
    }: ExecutionRequest = await req.json();

    Object.assign(requestContext, {
      language,
      questionId,
      submissionId: submissionId ?? null,
      source_length: sourceCode?.length ?? 0,
    });

    if (!sourceCode?.trim()) {
      return new Response(JSON.stringify({ error: "Código fuente requerido" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const allLanguages = new Set([
      ...Object.keys(ONLINECOMPILER_MAP),
      ...Object.keys(JDOODLE_MAP),
    ]);
    if (!allLanguages.has(language)) {
      return new Response(
        JSON.stringify({
          error: `Lenguaje no soportado: ${language}. Soportados: ${[...allLanguages].join(", ")}`,
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (sourceCode.length > 100_000) {
      return new Response(
        JSON.stringify({ error: "Código demasiado largo (máx 100 KB)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Autenticar usuario
    const userClient = userClientFromRequest(req);
    if (!userClient) throw new Error("No autenticado");
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) throw new Error("No autenticado");
    actorId = u.user.id;

    // Leer proveedor activo
    const { data: execSettings } = await admin
      .from("code_execution_settings")
      .select("provider")
      .eq("is_active", true)
      .maybeSingle();

    const provider: string = execSettings?.provider ?? "onlinecompiler";
    const effectiveProvider = provider === "cheerp" ? "onlinecompiler" : provider;
    requestContext.provider = effectiveProvider;

    const result = effectiveProvider === "jdoodle"
      ? await executeWithJDoodle(sourceCode, language, stdin)
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
