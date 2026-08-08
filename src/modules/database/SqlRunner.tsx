/**
 * Runner de preguntas `bd_sql`: editor de SQL + PostgreSQL REAL en el navegador.
 *
 * Mismo contrato de props que `V86Console` (`value` / `onChange` / `readOnly` /
 * `className`) para que integrarlo en cada flujo sea idéntico a lo que ya se hizo
 * con la consola Linux: la respuesta viaja serializada como string en la columna
 * de respuesta existente.
 *
 * ── Decisiones que no son obvias ──────────────────────────────────────
 *
 * **La base se crea al pulsar Ejecutar, no al montar.** Son ~16 MB de WASM: si se
 * cargaran al abrir la pregunta, un examen con 5 preguntas SQL bajaría 16 MB
 * antes de que el alumno escriba una letra, y las preguntas que no piensa
 * ejecutar pagarían el costo igual.
 *
 * **Cada ejecución arranca una base LIMPIA** (se cierra la anterior). Es
 * deliberado y es lo contrario de una consola: en SQL, dejar estado entre corridas
 * hace que un `INSERT` ejecutado dos veces duplique filas y el alumno vea
 * resultados que su script no explica. Con base limpia + `setupSql` del docente,
 * ejecutar dos veces da el MISMO resultado — que es lo que hace calificable el
 * ejercicio.
 *
 * **El `setupSql` del docente se ejecuta aparte y sus errores se muestran como
 * error del ENUNCIADO, no del alumno.** Si el docente se equivoca en el esquema,
 * el estudiante tiene que poder distinguirlo de su propio error; si no, se lleva
 * la culpa de algo que no hizo.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, Database, AlertTriangle } from "lucide-react";
import Editor from "@monaco-editor/react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  createEphemeralDb,
  type PgliteDb,
  type PgliteResult,
} from "@/modules/database/pglite-loader";
import {
  formatCell,
  MAX_PERSISTED_ROWS,
  parseSqlAnswer,
  renderTable,
  serializeSqlAnswer,
  type SqlStatementResult,
} from "@/modules/database/sql-answer";

interface Props {
  /** Respuesta serializada (o null). */
  value: string | null;
  onChange: (v: string) => void;
  readOnly?: boolean;
  className?: string;
  /** Esquema + datos de partida que preparó el docente (`options.db.setupSql`). */
  setupSql?: string | null;
  /** SQL inicial sugerido (`starter_code`). */
  starterSql?: string | null;
}

/** Convierte el resultado crudo de PGlite a nuestra forma serializable. */
function toStatementResult(sql: string, r: PgliteResult): SqlStatementResult {
  const columns = (r.fields ?? []).map((f) => f.name);
  const rows = (r.rows ?? []).slice(0, MAX_PERSISTED_ROWS).map((row) =>
    columns.map((c) => formatCell((row as Record<string, unknown>)[c])),
  );
  return {
    sql,
    columns,
    rows,
    ...(r.affectedRows !== undefined ? { affectedRows: r.affectedRows } : {}),
  };
}

export function SqlRunner({
  value,
  onChange,
  readOnly,
  className,
  setupSql,
  starterSql,
}: Props) {
  const { t } = useTranslation();
  const parsed = parseSqlAnswer(value);
  const [sql, setSql] = useState<string>(parsed?.sql ?? starterSql ?? "");
  const [results, setResults] = useState<SqlStatementResult[]>(parsed?.results ?? []);
  const [running, setRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const dbRef = useRef<PgliteDb | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      // Liberar el WASM al desmontar: sin esto, navegar entre preguntas SQL
      // deja una instancia de Postgres viva por pregunta visitada.
      void dbRef.current?.close().catch(() => {});
      dbRef.current = null;
    };
  }, []);

  /** Persiste SQL + resultados juntos: la base es efímera, la evidencia no. */
  const persist = useCallback(
    (nextSql: string, nextResults: SqlStatementResult[], executed: boolean) => {
      onChange(
        serializeSqlAnswer({
          sql: nextSql,
          results: nextResults,
          ...(executed ? { executedAt: new Date().toISOString() } : {}),
        }),
      );
    },
    [onChange],
  );

  const onSqlChange = (next: string) => {
    setSql(next);
    // Se guarda el SQL aunque no se haya ejecutado: escribir y no probar ES una
    // respuesta (ver `isSqlAnswerBlank`). Los resultados viejos se conservan.
    persist(next, results, false);
  };

  const run = async () => {
    if (running || !sql.trim()) return;
    setRunning(true);
    setLoadError(null);
    setSetupError(null);
    try {
      // Base LIMPIA por corrida — ver el encabezado del archivo.
      if (dbRef.current) {
        await dbRef.current.close().catch(() => {});
        dbRef.current = null;
      }
      const db = await createEphemeralDb();
      if (cancelledRef.current) {
        await db.close().catch(() => {});
        return;
      }
      dbRef.current = db;

      // 1) Esquema del docente. Su error NO es culpa del alumno.
      if (setupSql && setupSql.trim()) {
        try {
          await db.exec(setupSql);
        } catch (e) {
          if (cancelledRef.current) return;
          setSetupError(e instanceof Error ? e.message : String(e));
          setResults([]);
          return;
        }
      }

      // 2) SQL del alumno. Un error de Postgres NO es una excepción de la app:
      //    es el resultado del ejercicio y hay que mostrarlo tal cual, porque
      //    leer el mensaje de error es parte de aprender SQL.
      let next: SqlStatementResult[];
      try {
        const out = await db.exec(sql);
        next = (out ?? []).map((r, i) => toStatementResult(nthStatement(sql, i), r));
        if (next.length === 0) next = [{ sql: sql.trim(), columns: [], rows: [], affectedRows: 0 }];
      } catch (e) {
        next = [
          {
            sql: sql.trim(),
            columns: [],
            rows: [],
            error: e instanceof Error ? e.message : String(e),
          },
        ];
      }
      if (cancelledRef.current) return;
      setResults(next);
      persist(sql, next, true);
    } catch (e) {
      if (cancelledRef.current) return;
      // Acá solo caen fallos de CARGA del motor (red/CDN), no errores de SQL.
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!cancelledRef.current) setRunning(false);
    }
  };

  return (
    <div className={className}>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Database className="h-3.5 w-3.5 shrink-0" />
            {t("bdSql.engineLabel")}
          </span>
          {!readOnly && (
            <Button size="sm" onClick={() => void run()} disabled={running || !sql.trim()}>
              {running ? <Spinner size="xs" className="mr-1" /> : <Play className="mr-1 h-4 w-4" />}
              {running ? t("bdSql.running") : t("bdSql.run")}
            </Button>
          )}
        </div>

        {/* Primera ejecución: avisar el costo ANTES de que parezca colgado. */}
        {running && (
          <p className="text-2xs text-muted-foreground">{t("bdSql.firstRunHint")}</p>
        )}

        <div className="overflow-hidden rounded-md border">
          <Editor
            height="14rem"
            language="sql"
            value={sql}
            onChange={(v) => onSqlChange(v ?? "")}
            options={{
              readOnly: !!readOnly,
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              wordWrap: "on",
            }}
          />
        </div>

        {loadError && (
          <p className="flex items-start gap-1.5 text-2xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t("bdSql.engineLoadError", { error: loadError })}
          </p>
        )}

        {setupError && (
          <div className="rounded-md border border-amber-400/40 bg-amber-500/5 p-2 text-2xs text-amber-700 dark:text-amber-300">
            <strong>{t("bdSql.setupErrorTitle")}</strong> {setupError}
          </div>
        )}

        {results.length > 0 && (
          <div className="space-y-2">
            {results.map((r, i) => (
              <div key={i} className="rounded-md border bg-muted/30 p-2">
                <p className="mb-1 text-3xs text-muted-foreground">
                  {t("bdSql.statementN", { n: i + 1 })}
                </p>
                {r.error ? (
                  <p className="whitespace-pre-wrap break-words font-mono text-2xs text-destructive">
                    {r.error}
                  </p>
                ) : r.columns.length === 0 ? (
                  <p className="font-mono text-2xs text-muted-foreground">
                    {t("bdSql.affectedRows", { count: r.affectedRows ?? 0 })}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <pre className="font-mono text-2xs leading-relaxed">
                      {renderTable(r.columns, r.rows)}
                    </pre>
                    {r.rows.length >= MAX_PERSISTED_ROWS && (
                      <p className="mt-1 text-3xs text-muted-foreground">
                        {t("bdSql.truncated", { max: MAX_PERSISTED_ROWS })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Etiqueta de la n-ésima sentencia, solo para MOSTRAR de qué sentencia es cada
 * resultado.
 *
 * PGlite devuelve un resultado por sentencia pero no dice cuál era. El split por
 * `;` es aproximado a propósito: no vale la pena un parser de SQL para una
 * etiqueta, y un `;` dentro de un string literal o de un bloque `$$ ... $$` de
 * PL/pgSQL solo desalinea el TEXTO del encabezado — nunca el resultado, que ya
 * viene emparejado por posición desde el motor.
 */
function nthStatement(all: string, i: number): string {
  const parts = all
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts[i] ?? all.trim();
}
