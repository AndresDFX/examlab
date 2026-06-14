/**
 * Muestra la última ejecución de código del estudiante para una
 * pregunta específica. Lee de `code_executions` filtrando por
 * (submission_id, question_id, user_id) y mostrando stdout, stderr y
 * exit code.
 *
 * Usado en el monitor del docente y en la revisión del estudiante para
 * que ambos vean exactamente qué imprimió el código (líneas del
 * compilador / consola), no solo el código fuente.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertTriangle, Terminal } from "lucide-react";

interface Props {
  submissionId: string;
  questionId: string;
  /** user_id de la entrega para filtrar la ejecución (RLS deja al
   *  docente ver las ejecuciones de cualquier estudiante; al estudiante
   *  solo las suyas). Si no se pasa, busca cualquiera de la submission. */
  userId?: string;
}

type Execution = {
  language: string | null;
  stdout: string | null;
  stderr: string | null;
  exit_code: number | null;
  execution_time_ms: number | null;
  status: string | null;
  created_at: string;
};

export function CodeRunOutput({ submissionId, questionId, userId }: Props) {
  const { t } = useTranslation();
  const [exec, setExec] = useState<Execution | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = (supabase as any)
        .from("code_executions")
        .select("language, stdout, stderr, exit_code, execution_time_ms, status, created_at")
        .eq("submission_id", submissionId)
        .eq("question_id", questionId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (userId) q = q.eq("user_id", userId);
      const { data } = await q;
      if (cancelled) return;
      const row = (data ?? [])[0] ?? null;
      setExec(row as Execution | null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [submissionId, questionId, userId]);

  if (loading) {
    return <div className="text-[11px] text-muted-foreground italic">{t("hc_modulesCodeCodeRunOutput.loadingConsole")}</div>;
  }
  if (!exec) {
    return (
      <div className="text-[11px] text-muted-foreground italic flex items-center gap-1.5">
        <Terminal className="h-3 w-3" />
        {t("hc_modulesCodeCodeRunOutput.noExecutions")}
      </div>
    );
  }

  const isOk = exec.exit_code === 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <Terminal className="h-3 w-3 text-muted-foreground" />
        <span className="text-muted-foreground">{t("hc_modulesCodeCodeRunOutput.lastExecution")}</span>
        {exec.language && (
          <Badge variant="outline" className="text-[9px]">
            {exec.language}
          </Badge>
        )}
        <Badge variant={isOk ? "secondary" : "destructive"} className="text-[9px] tabular-nums">
          {isOk ? (
            <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
          ) : (
            <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
          )}
          exit {exec.exit_code ?? "?"}
        </Badge>
        {typeof exec.execution_time_ms === "number" && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {exec.execution_time_ms} ms
          </span>
        )}
      </div>
      {exec.stdout && exec.stdout.trim() && (
        <pre className="text-[11px] bg-muted/40 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap">
          {exec.stdout}
        </pre>
      )}
      {exec.stderr && exec.stderr.trim() && (
        <pre className="text-[11px] bg-destructive/10 text-destructive rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap">
          {exec.stderr}
        </pre>
      )}
      {!exec.stdout?.trim() && !exec.stderr?.trim() && (
        <p className="text-[10px] text-muted-foreground italic">{t("hc_modulesCodeCodeRunOutput.noConsoleOutput")}</p>
      )}
    </div>
  );
}
