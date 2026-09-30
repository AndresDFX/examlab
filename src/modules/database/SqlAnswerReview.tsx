/**
 * La respuesta de una pregunta `bd_sql`, en solo lectura, para quien CALIFICA.
 *
 * La respuesta se guarda como el JSON que arma `sql-answer.ts` (el SQL más lo que
 * devolvió la base), y cualquier pantalla que la pintara «tal cual» le mostraba al
 * docente `{"bdSql":1,"sql":"…","results":[…]}`: medido en el monitor de exámenes
 * el 2026-09-29, en el Parcial 1 de Bases de Datos II. Acá se ve el SQL como código
 * y cada resultado como una tabla de verdad, con los errores marcados.
 *
 * Lo que NO se deduce mirando el resultado, y por eso se dice: la base arranca
 * LIMPIA en cada corrida y se guarda solo la ÚLTIMA ejecución. Si esa ejecución
 * fue una selección (una parte del guion), el resultado no muestra lo que pasa al
 * correrlo completo — que es lo que se califica. Sin este aviso, un «a mí me
 * funcionó» y la nota de la IA parecen contradecirse, y ninguno de los dos miente.
 */
import { useTranslation } from "react-i18next";
import { AlertTriangle, Database } from "lucide-react";
import { formatDateTime } from "@/shared/lib/format";
import {
  MAX_PERSISTED_ROWS,
  parseSqlAnswer,
  type SqlStatementResult,
} from "@/modules/database/sql-answer";
import { splitSqlStatements } from "@/modules/database/sql-split";

interface Props {
  /** El valor crudo guardado para la pregunta (el JSON de `sql-answer.ts`). */
  value: unknown;
}

function Resultado({ r, n }: { r: SqlStatementResult; n: number }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <div className="text-3xs text-muted-foreground">
        {t("sqlAnswerReview.statementN", { n })}
      </div>
      <pre className="whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1 font-mono text-2xs">
        {r.sql.trim()}
      </pre>
      {r.error ? (
        <p className="flex items-start gap-1 text-2xs text-destructive">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
          <span className="font-mono break-words">
            {t("sqlAnswerReview.error")}: {r.error}
          </span>
        </p>
      ) : r.columns.length === 0 ? (
        <p className="text-2xs text-muted-foreground">
          {t("sqlAnswerReview.affected", { count: r.affectedRows ?? 0 })}
        </p>
      ) : (
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-2xs font-mono tabular-nums">
            <thead className="bg-muted">
              <tr>
                {r.columns.map((c, i) => (
                  <th key={i} className="px-2 py-1 text-left font-medium border-b whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.rows.length === 0 ? (
                <tr>
                  <td colSpan={r.columns.length} className="px-2 py-1 text-muted-foreground italic">
                    {t("sqlAnswerReview.noRows")}
                  </td>
                </tr>
              ) : (
                r.rows.map((row, ri) => (
                  <tr key={ri} className="border-b last:border-b-0">
                    {r.columns.map((_, ci) => (
                      <td key={ci} className="px-2 py-1 whitespace-nowrap">
                        {row[ci] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {r.rows.length >= MAX_PERSISTED_ROWS && (
            <p className="px-2 py-1 text-3xs text-muted-foreground border-t">
              {t("sqlAnswerReview.truncated", { max: MAX_PERSISTED_ROWS })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function SqlAnswerReview({ value }: Readonly<Props>) {
  const { t } = useTranslation();
  const parsed = parseSqlAnswer(value);

  // Una respuesta que no es el JSON de bd_sql (formato viejo, o texto suelto): se
  // muestra tal cual, que es mejor que esconderla.
  if (!parsed) {
    const texto = typeof value === "string" ? value.trim() : "";
    return texto ? (
      <pre className="whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 font-mono text-xs">
        {texto}
      </pre>
    ) : (
      <p className="text-xs italic text-muted-foreground">{t("sqlAnswerReview.noAnswer")}</p>
    );
  }

  const sql = parsed.sql.trim();
  const sentencias = sql ? splitSqlStatements(sql).length : 0;
  const parcial = parsed.results.length > 0 && parsed.results.length < sentencias;

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <div className="text-3xs uppercase tracking-wide text-muted-foreground">
          {t("sqlAnswerReview.sqlLabel")}
        </div>
        {sql ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border bg-background p-2 font-mono text-xs">
            {sql}
          </pre>
        ) : (
          <p className="text-xs italic text-muted-foreground">{t("sqlAnswerReview.noAnswer")}</p>
        )}
      </div>

      {sql && (
        <div className="space-y-1.5 rounded border bg-muted/20 p-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-3xs uppercase tracking-wide text-muted-foreground">
            <Database className="h-3 w-3" aria-hidden />
            <span>{t("sqlAnswerReview.resultsLabel")}</span>
            {parsed.executedAt && (
              <span className="normal-case tracking-normal tabular-nums">
                · {t("sqlAnswerReview.lastRun", { date: formatDateTime(parsed.executedAt) })}
              </span>
            )}
          </div>
          {parsed.results.length === 0 ? (
            <p className="text-2xs text-muted-foreground">{t("sqlAnswerReview.notRun")}</p>
          ) : (
            <>
              {parcial && (
                <p className="flex items-start gap-1 text-2xs text-warning-on-subtle">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden />
                  <span>
                    {t("sqlAnswerReview.partialRun", {
                      shown: parsed.results.length,
                      total: sentencias,
                    })}
                  </span>
                </p>
              )}
              {parsed.results.map((r, i) => (
                <Resultado key={i} r={r} n={i + 1} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
