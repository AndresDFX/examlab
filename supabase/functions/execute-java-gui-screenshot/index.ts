/**
 * Edge Function: execute-java-gui-screenshot
 *
 * Proxy al runner AWS Lambda en modo `gui_screenshot` para preguntas
 * tipo `java_gui` cuando el admin configuró
 * `code_execution_settings.java_gui_provider = 'aws_screenshot'`.
 *
 * Diferencias con `execute-code`:
 *  - Solo Java. No hay fallback a OnlineCompiler (no tiene sentido aquí
 *    — los demás providers no pueden renderizar Swing).
 *  - Response trae `screenshotBase64` (PNG) en lugar de solo texto.
 *  - No persiste en `code_executions` (esa tabla asume output textual);
 *    el audit log captura la actividad.
 *
 * Body:
 *   { sourceCode: string, questionId: string, submissionId?: string,
 *     delayMs?: number }
 *
 * Response (200):
 *   { stdout, stderr, exitCode, screenshotBase64, pngBytes,
 *     executionTimeMs }
 *
 * Ver aws/code-runner/app.py → _handle_gui_screenshot.
 */
import { adminClient as admin, corsHeaders, userClientFromRequest } from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";

interface ScreenshotRequest {
  sourceCode: string;
  questionId: string;
  submissionId?: string;
  delayMs?: number;
  /** "swing" (default) — JDK base, AWT/Swing bajo Xvfb.
   *  "javafx" — OpenJFX 21 con `--module-path` + Prism software render.
   *  Cualquier otro valor → tratado como "swing" en Lambda. */
  framework?: "swing" | "javafx";
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let actorId: string | undefined;
  const requestContext: Record<string, unknown> = {};

  try {
    const body: ScreenshotRequest = await req.json();
    const { sourceCode, questionId, submissionId, delayMs, framework } = body;
    // Normalizar framework. Lambda también valida defensivamente.
    const normalizedFramework: "swing" | "javafx" = framework === "javafx" ? "javafx" : "swing";

    Object.assign(requestContext, {
      questionId,
      submissionId: submissionId ?? null,
      source_length: sourceCode?.length ?? 0,
      delayMs: delayMs ?? null,
      framework: normalizedFramework,
    });

    if (!sourceCode?.trim()) return jsonResponse(400, { error: "sourceCode requerido" });
    if (sourceCode.length > 100_000) {
      return jsonResponse(400, { error: "Código demasiado largo (máx 100 KB)" });
    }
    if (!questionId) return jsonResponse(400, { error: "questionId requerido" });

    // ── Auth ──
    const userClient = userClientFromRequest(req);
    if (!userClient) return jsonResponse(401, { error: "No autenticado" });
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return jsonResponse(401, { error: "Token inválido" });
    actorId = u.user.id;

    // ── Provider activo (sólo para audit) ──
    // No bloqueamos por mismatch: el estudiante puede haber elegido
    // explícitamente `aws_screenshot` via CodeRunnerPicker / JavaGuiRunner
    // aunque el default del admin sea `cheerp`. Esa es justamente la
    // razón de ser del override per-question (ver CLAUDE.md §"Selector
    // de runner por pregunta"). Registramos default vs override para
    // auditoría.
    const { data: settings } = await admin
      .from("code_execution_settings")
      .select("java_gui_provider")
      .eq("is_active", true)
      .maybeSingle();
    const defaultJavaGuiProvider = (settings?.java_gui_provider as string) ?? "cheerp";
    Object.assign(requestContext, {
      default_java_gui_provider: defaultJavaGuiProvider,
      provider_overridden: defaultJavaGuiProvider !== "aws_screenshot",
    });

    // ── Llamar Lambda ──
    const url = Deno.env.get("AWS_RUNNER_URL");
    const apiKey = Deno.env.get("AWS_RUNNER_API_KEY");
    if (!url || !apiKey) {
      const missing: string[] = [];
      if (!url) missing.push("AWS_RUNNER_URL");
      if (!apiKey) missing.push("AWS_RUNNER_API_KEY");
      return jsonResponse(503, {
        error:
          `Faltan env vars: ${missing.join(", ")}. Re-ejecuta aws/code-runner/deploy.sh ` +
          `y copia los valores en Edge Function Secrets.`,
      });
    }

    const startTime = Date.now();
    const lambdaRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({
        mode: "gui_screenshot",
        sourceCode,
        delayMs: typeof delayMs === "number" ? delayMs : undefined,
        framework: normalizedFramework,
      }),
    });
    const totalMs = Date.now() - startTime;
    const rawText = await lambdaRes.text();
    let data: Record<string, unknown> = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = { _nonJsonBody: rawText.slice(0, 2000) };
    }

    if (!lambdaRes.ok) {
      const detail =
        typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : typeof (data as { _nonJsonBody?: unknown })._nonJsonBody === "string"
            ? (data as { _nonJsonBody: string })._nonJsonBody
            : "";
      // 401/403 desde API Gateway → API key inválida o ausente. La causa
      // típica es que el admin redeployó el Lambda y la nueva URL/API_KEY
      // no se actualizó en Supabase Edge Function Secrets. Damos un
      // mensaje específico con el paso a seguir en lugar del HTTP code crudo.
      let msg: string;
      if (lambdaRes.status === 401 || lambdaRes.status === 403) {
        msg =
          `El runner AWS Lambda rechazó la autenticación (HTTP ${lambdaRes.status}). ` +
          `Probablemente las Edge Function Secrets de Supabase no coinciden con la última ` +
          `corrida de \`./deploy.sh\`. Ve a Supabase Dashboard → Settings → Edge Function ` +
          `Secrets y actualiza AWS_RUNNER_URL y AWS_RUNNER_API_KEY con los valores que imprimió ` +
          `el script al final del deploy.`;
      } else if (lambdaRes.status === 404) {
        msg =
          `El endpoint del runner AWS no existe (HTTP 404). Verifica que AWS_RUNNER_URL en ` +
          `Edge Function Secrets termine en "/run" y apunte a la API Gateway actual.`;
      } else {
        msg = detail
          ? `Runner AWS Lambda HTTP ${lambdaRes.status}: ${detail}`
          : `Runner AWS Lambda HTTP ${lambdaRes.status}`;
      }
      void auditFromEdge(admin, {
        actorId,
        action: "java_gui.screenshot_failed",
        category: "system",
        severity: "error",
        entityType: "code_execution",
        entityId: questionId,
        metadata: {
          ...requestContext,
          http_status: lambdaRes.status,
          raw: data,
          edge_time_ms: totalMs,
        },
      });
      return jsonResponse(502, { error: msg });
    }

    const stdout = typeof data.stdout === "string" ? data.stdout : "";
    const stderr = typeof data.stderr === "string" ? data.stderr : "";
    const exitCode = typeof data.exitCode === "number" ? data.exitCode : 0;
    const screenshotBase64 =
      typeof data.screenshotBase64 === "string" ? data.screenshotBase64 : null;
    const pngBytes = typeof data.pngBytes === "number" ? data.pngBytes : 0;
    const executionTimeMs =
      typeof data.executionTimeMs === "number" ? data.executionTimeMs : totalMs;

    // Audit en cada ejecución para fraud / debugging. El base64 NO va al
    // audit (puede pesar cientos de KB) — solo el size.
    void auditFromEdge(admin, {
      actorId,
      action: "java_gui.screenshot_executed",
      category: "system",
      severity: exitCode === 0 && screenshotBase64 ? "info" : "warning",
      entityType: "code_execution",
      entityId: questionId,
      metadata: {
        ...requestContext,
        exit_code: exitCode,
        png_bytes: pngBytes,
        has_screenshot: !!screenshotBase64,
        stderr_preview: stderr.slice(0, 500),
        execution_time_ms: executionTimeMs,
        edge_time_ms: totalMs,
      },
    });

    return jsonResponse(200, {
      stdout,
      stderr,
      exitCode,
      screenshotBase64,
      pngBytes,
      executionTimeMs,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void auditFromEdge(admin, {
      actorId,
      action: "java_gui.screenshot_error",
      category: "system",
      severity: "error",
      entityType: "code_execution",
      metadata: { ...requestContext, error: msg },
    });
    return jsonResponse(500, { error: msg });
  }
});
