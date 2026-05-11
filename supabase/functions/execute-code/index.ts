/**
 * Edge Function: execute-code
 * Compiles and runs code in an isolated environment.
 * Currently supports Java via JDoodle API (extensible to Python/JS).
 * Architecture: Strategy pattern for easy language addition.
 */
import { adminClient as admin, corsHeaders, userClientFromRequest } from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";

interface ExecutionRequest {
  sourceCode: string;
  language: "java" | "python" | "javascript";
  stdin?: string;
  questionId: string;
  submissionId?: string;
}

interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
}

// Language configuration for JDoodle API
const JDOODLE_LANGUAGES: Record<string, { language: string; versionIndex: string }> = {
  java: { language: "java", versionIndex: "4" },
  python: { language: "python3", versionIndex: "4" },
  javascript: { language: "nodejs", versionIndex: "4" },
};

async function executeWithJDoodle(
  sourceCode: string,
  language: string,
  stdin: string,
): Promise<ExecutionResult> {
  const clientId = Deno.env.get("JDOODLE_CLIENT_ID");
  const clientSecret = Deno.env.get("JDOODLE_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    // Fallback: simulate execution for development
    return simulateExecution(sourceCode, language);
  }

  const config = JDOODLE_LANGUAGES[language];
  if (!config) throw new Error(`Lenguaje no soportado: ${language}`);

  const startTime = Date.now();

  const response = await fetch("https://api.jdoodle.com/v1/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId,
      clientSecret,
      script: sourceCode,
      stdin,
      language: config.language,
      versionIndex: config.versionIndex,
    }),
  });

  const result = await response.json();
  const executionTimeMs = Date.now() - startTime;

  return {
    stdout: result.output ?? "",
    stderr:
      (result.error ?? result.statusCode === 200) ? "" : (result.error ?? "Error de ejecución"),
    exitCode: result.statusCode === 200 ? 0 : 1,
    executionTimeMs,
  };
}

function simulateExecution(sourceCode: string, language: string): ExecutionResult {
  // Development fallback: basic simulation
  const hasMain = language === "java" ? sourceCode.includes("public static void main") : true;

  if (!hasMain && language === "java") {
    return {
      stdout: "",
      stderr:
        "Error: No se encontró el método main. Asegúrate de incluir 'public static void main(String[] args)'.",
      exitCode: 1,
      executionTimeMs: 50,
    };
  }

  // Extract print statements for simulation
  const printRegex =
    language === "java"
      ? /System\.out\.println\(["'](.+?)["']\)/g
      : language === "python"
        ? /print\(["'](.+?)["']\)/g
        : /console\.log\(["'](.+?)["']\)/g;

  const outputs: string[] = [];
  let match;
  while ((match = printRegex.exec(sourceCode)) !== null) {
    outputs.push(match[1]);
  }

  return {
    stdout:
      outputs.length > 0
        ? outputs.join("\n") + "\n"
        : `[Simulación] Código ${language} recibido (${sourceCode.length} caracteres). Configure JDOODLE_CLIENT_ID para ejecución real.\n`,
    stderr: "",
    exitCode: 0,
    executionTimeMs: 100,
  };
}

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

    if (!JDOODLE_LANGUAGES[language]) {
      return new Response(JSON.stringify({ error: `Lenguaje no soportado: ${language}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Security: limit code size
    if (sourceCode.length > 10000) {
      return new Response(
        JSON.stringify({ error: "Código demasiado largo (máx 10,000 caracteres)" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Authenticate user
    const userClient = userClientFromRequest(req);
    if (!userClient) throw new Error("No autenticado");
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) throw new Error("No autenticado");

    // Execute code
    const result = await executeWithJDoodle(sourceCode, language, stdin);
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

    // Auditoría: una fila por ejecución. Útil para detectar abuso (un
    // estudiante intentando spamear JDoodle). NO logueamos el código
    // fuente (ya queda en `code_executions`) — solo metadata.
    void auditFromEdge(admin, {
      actorId: u.user.id,
      action: "code.executed",
      category: "system",
      severity: "info",
      entityType: "code_execution",
      entityId: questionId,
      metadata: {
        language,
        submission_id: submissionId ?? null,
        question_id: questionId,
        exit_code: result.exitCode,
        execution_time_ms: result.executionTimeMs,
        source_length: sourceCode.length,
      },
    });

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message ?? "Error interno" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
