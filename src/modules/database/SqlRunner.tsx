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
 *
 * **Si hay texto seleccionado, se ejecuta SOLO eso.** Es el gesto que espera
 * cualquiera que venga de un cliente SQL (DBeaver, pgAdmin, DataGrip): en una
 * hoja con el esquema, los INSERT y varias consultas, correr el archivo entero
 * para ver UNA consulta significa recrear la base cada vez y leer la respuesta
 * al final de una lista de resultados. El docente que explica en vivo necesita
 * justo lo contrario: parar en una línea, correrla y hablar sobre ella. El
 * `setupSql` SIEMPRE corre antes, incluso con selección, porque la base es
 * limpia por corrida y sin esquema la selección no tendría contra qué correr.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, Database, AlertTriangle } from "lucide-react";
import Editor, { type OnMount } from "@monaco-editor/react";
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
  /**
   * Con `readOnly`, deja el botón Ejecutar visible y funcional (el alumno
   * puede correr la consulta fija del docente para ver el resultado) pero
   * SIN persistir — la corrida queda solo en memoria local. Mismo contrato
   * que `CodePageEditor`/`V86Console` en la pizarra: "puede ejecutar para
   * probar, pero su salida no se persiste". Sin esto, `readOnly` esconde el
   * botón entero (comportamiento de revisión post-hoc, que es lo único que
   * usan hoy los flujos de examen/taller).
   */
  readOnlyAllowRun?: boolean;
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
  readOnlyAllowRun,
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
  /** Instancia de Monaco: es la única fuente de la selección del usuario. */
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  /** Solo para la etiqueta del botón; el texto real se relee al ejecutar. */
  const [hasSelection, setHasSelection] = useState(false);
  /**
   * El atajo Ctrl/Cmd+Enter se registra en Monaco UNA sola vez al montar, así
   * que capturaría el `run` de ese primer render (con el `sql` vacío y el
   * `setupSql` viejo). La ref lo mantiene apuntando a la versión actual.
   */
  const runRef = useRef<() => void>(() => {});

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
    // Defensivo: con Monaco en readOnly el usuario no puede tipear, así que
    // esto no debería dispararse — pero si algún caller cambia `readOnly` en
    // caliente, no queremos persistir un cambio que no debió pasar.
    if (readOnly) return;
    setSql(next);
    // Se guarda el SQL aunque no se haya ejecutado: escribir y no probar ES una
    // respuesta (ver `isSqlAnswerBlank`). Los resultados viejos se conservan.
    persist(next, results, false);
  };

  /**
   * Texto seleccionado en el editor, o `""` si no hay selección real.
   *
   * Se leen TODAS las selecciones (Monaco permite multi-cursor con Alt+clic) y
   * se unen en el orden en que están en el documento, no en el orden en que se
   * hicieron los clics: si no, dos líneas elegidas de abajo hacia arriba se
   * ejecutarían al revés y un INSERT correría antes que su CREATE TABLE.
   */
  const selectedSql = useCallback((): string => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return "";
    const ranges = (editor.getSelections() ?? [])
      .filter((r) => !r.isEmpty())
      .sort((a, b) =>
        a.startLineNumber !== b.startLineNumber
          ? a.startLineNumber - b.startLineNumber
          : a.startColumn - b.startColumn,
      );
    return ranges
      .map((r) => model.getValueInRange(r))
      .join("\n")
      .trim();
  }, []);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      // La etiqueta del botón tiene que decir la verdad sobre lo que va a
      // correr, así que el estado se sincroniza con cada cambio de selección.
      editor.onDidChangeCursorSelection(() => {
        setHasSelection(!!selectedSql());
      });
      // Ctrl/Cmd+Enter: el atajo que ya trae aprendido quien usa un cliente SQL.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        void runRef.current();
      });
    },
    [selectedSql],
  );

  const run = async () => {
    // Con selección se corre SOLO eso; sin selección, la hoja entera.
    const selected = selectedSql();
    const sqlToRun = selected || sql;
    if (running || !sqlToRun.trim()) return;
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
        const out = await db.exec(sqlToRun);
        next = (out ?? []).map((r, i) => toStatementResult(nthStatement(sqlToRun, i), r));
        if (next.length === 0)
          next = [{ sql: sqlToRun.trim(), columns: [], rows: [], affectedRows: 0 }];
      } catch (e) {
        next = [
          {
            sql: sqlToRun.trim(),
            columns: [],
            rows: [],
            error: e instanceof Error ? e.message : String(e),
          },
        ];
      }
      if (cancelledRef.current) return;
      setResults(next);
      // En modo readOnly (alumno probando la consulta fija del docente en la
      // pizarra) la corrida NO se persiste — mismo trade-off que el output
      // local de CodePageEditor.
      // Se persiste la hoja COMPLETA como respuesta (es lo que el alumno
      // escribió) junto con los resultados de lo que realmente corrió; cada
      // resultado ya lleva su propia sentencia, así que la evidencia sigue
      // diciendo qué produjo cada tabla aunque se haya corrido una selección.
      if (!readOnly) persist(sql, next, true);
    } catch (e) {
      if (cancelledRef.current) return;
      // Acá solo caen fallos de CARGA del motor (red/CDN), no errores de SQL.
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!cancelledRef.current) setRunning(false);
    }
  };

  useEffect(() => {
    runRef.current = run;
  });

  return (
    <div className={className}>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <Database className="h-3.5 w-3.5 shrink-0" />
            {t("bdSql.engineLabel")}
          </span>
          {(!readOnly || readOnlyAllowRun) && (
            <Button
              size="sm"
              onClick={() => void run()}
              disabled={running || !sql.trim()}
              title={t("bdSql.runShortcut")}
            >
              {running ? <Spinner size="xs" className="mr-1" /> : <Play className="mr-1 h-4 w-4" />}
              {running
                ? t("bdSql.running")
                : hasSelection
                  ? t("bdSql.runSelection")
                  : t("bdSql.run")}
            </Button>
          )}
        </div>

        {/* Primera ejecución: avisar el costo ANTES de que parezca colgado. */}
        {running && (
          <p className="text-2xs text-muted-foreground">{t("bdSql.firstRunHint")}</p>
        )}

        {/* Que se pueda correr un fragmento no se descubre solo: sin este
            aviso el usuario asume que el botón siempre corre la hoja entera. */}
        {!running && hasSelection && (
          <p className="text-2xs text-muted-foreground">{t("bdSql.selectionHint")}</p>
        )}

        <div className="overflow-hidden rounded-md border">
          <Editor
            height="14rem"
            language="sql"
            value={sql}
            onChange={(v) => onSqlChange(v ?? "")}
            onMount={handleMount}
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
