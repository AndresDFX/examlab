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
    const { sourceCode, questionId, submissionId, delayMs } = body;

    Object.assign(requestContext, {
      questionId,
      submissionId: submissionId ?? null,
      source_length: sourceCode?.length ?? 0,
      delayMs: delayMs ?? null,
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

    // ── Validar provider activo ──
    // Si el admin tiene `cheerp` activo, no debería llegar acá — pero
    // protegemos por si llega un request renegado (front cacheado, etc.).
    const { data: settings } = await admin
      .from("code_execution_settings")
      .select("java_gui_provider")
      .eq("is_active", true)
      .maybeSingle();
    const javaGuiProvider = (settings?.java_gui_provider as string) ?? "cheerp";
    if (javaGuiProvider !== "aws_screenshot") {
      return jsonResponse(409, {
        error: `java_gui_provider activo es "${javaGuiProvider}", no "aws_screenshot". Cambia la configuración en Admin → Compilador.`,
      });
    }

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
      const msg = detail
        ? `Runner AWS Lambda HTTP ${lambdaRes.status}: ${detail}`
        : `Runner AWS Lambda HTTP ${lambdaRes.status}`;
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
