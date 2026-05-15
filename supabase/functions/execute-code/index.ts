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

  if (response.status === 429) {
    throw new Error(
      "Demasiadas ejecuciones simultáneas. Espera unos segundos e intenta de nuevo.",
    );
  }
  if (!response.ok) {
    throw new Error(`Error del compilador remoto (OnlineCompiler.io): HTTP ${response.status}`);
  }

  const data = await response.json();

  return {
    stdout: data.output ?? "",
    stderr: data.error ?? "",
    exitCode: typeof data.exit_code === "number" ? data.exit_code : (data.status === "success" ? 0 : 1),
    executionTimeMs,
    signal: data.signal ?? null,
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

  if (!response.ok) {
    throw new Error(`Error del compilador remoto (JDoodle): HTTP ${response.status}`);
  }

  const data = await response.json();

  // JDoodle devuelve statusCode 200 pero el campo output puede incluir error del compilador
  const isError = data.statusCode !== 200 || (data.error != null);
  return {
    stdout: isError ? "" : (data.output ?? ""),
    stderr: isError ? (data.output ?? data.error ?? "Error desconocido") : "",
    exitCode: isError ? 1 : 0,
    executionTimeMs,
    signal: null,
  };
}

// ──────────────────────────────────────────────
// Handler principal
// ──────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const {
      sourceCode,
      language,
      stdin = "",
      questionId,
      submissionId,
    }: ExecutionRequest = await req.json();

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

    // Leer proveedor activo
    const { data: execSettings } = await admin
      .from("code_execution_settings")
      .select("provider")
      .eq("is_active", true)
      .maybeSingle();

    // "cheerp" se maneja en el cliente para Java; aquí fallamos silenciosamente
    // a onlinecompiler para otros lenguajes (o si el cliente olvidó manejarlo).
    const provider: string = execSettings?.provider ?? "onlinecompiler";
    const effectiveProvider = provider === "cheerp" ? "onlinecompiler" : provider;

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

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
