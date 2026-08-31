/**
 * SqlPageEditor — hoja de SQL de una pizarra (`whiteboard_pages.page_type='sql'`).
 *
 * Tercera hoja "ejecutable" junto a `CodePageEditor` (compilador) y
 * `V86Console` (Linux real): el docente muestra una consulta SQL en vivo
 * contra un PostgreSQL REAL en el navegador (PGlite/WASM), sin tener que
 * crear un examen ni un taller. Reusa `SqlRunner` TAL CUAL — mismo motor,
 * mismo serializado de respuesta (`sql-answer.ts`) que la pregunta `bd_sql`.
 *
 * El padre (`MultiPageWhiteboard`) persiste vía `onPersist(patch)` (escribe en
 * `whiteboard_pages` + sincroniza su state), igual que
 * `persistTextPage`/`persistCodePage`.
 *
 * Modo readOnly (alumno): puede ejecutar la consulta del docente para probar
 * (via `SqlRunner readOnlyAllowRun`), pero ni el esquema ni la corrida se
 * persisten — mismo trade-off que `CodePageEditor`.
 *
 * ── Generador de SQL con IA (solo docente) ────────────────────────────
 * Escribir a mano los CREATE TABLE / INSERT frente al curso es lento, así que
 * la hoja trae una caja donde el docente pide en español lo que quiere mostrar
 * ("clientes y pedidos con 10 filas", "el cliente con más pedidos", "un GRANT
 * de solo lectura") y recibe el SQL comentado para insertarlo en el esquema de
 * partida o en el editor. Decisiones que no son obvias:
 *
 *  - **Se manda el esquema de partida como contexto.** Sin eso la IA inventa
 *    nombres de tabla y la consulta generada falla contra una base vacía —
 *    justo el error que arruina la demostración en vivo.
 *  - **Insertar AGREGA al final, nunca reemplaza.** Estamos proyectando frente
 *    al curso: pisar en silencio lo que el docente ya escribió es el peor
 *    resultado posible, y un diálogo de confirmación en medio de la clase es
 *    fricción. Agregar es reversible a ojo (el bloque nuevo se ve al final);
 *    reemplazar no.
 *  - **El error de la IA se muestra FIJO en el panel, no como toast.** El toast
 *    se va a los segundos y el docente está mirando el proyector, no la
 *    esquina de su pantalla.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownLeft,
  Database,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { HelpHint } from "@/components/ui/help-hint";
import { SqlRunner } from "@/modules/database/SqlRunner";
import { parseSqlAnswer, serializeSqlAnswer } from "@/modules/database/sql-answer";
import { hasSchemaSummary, summarizeSetupSql } from "@/modules/database/sql-schema";
import { supabase } from "@/integrations/supabase/client";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { friendlyError } from "@/shared/lib/db-errors";
import { enterEnvia } from "@/shared/lib/submit-on-enter";
import { cn } from "@/shared/lib/utils";

interface Props {
  pageId: string;
  setupSql: string | null;
  answer: string | null;
  readOnly?: boolean;
  /** Curso de la pizarra, si tiene. Solo se usa como contexto de la
   *  generación con IA: permite que el docente tenga un prompt propio del
   *  curso (`ai_prompts.course_id`) y que el modelo/keys se resuelvan por el
   *  tenant del curso. La hoja funciona igual sin él. */
  courseId?: string | null;
  /** El padre persiste el patch en `whiteboard_pages` + actualiza su state. */
  onPersist: (patch: Record<string, unknown>) => void;
  className?: string;
}

/** Agrega `addition` al final de `base` dejando una línea en blanco entre
 *  bloques. Nunca pisa lo que ya estaba — ver el encabezado del archivo. */
function appendSqlBlock(base: string, addition: string): string {
  const head = (base ?? "").trimEnd();
  const tail = (addition ?? "").trim();
  if (!tail) return head;
  return head ? `${head}\n\n${tail}\n` : `${tail}\n`;
}

export function SqlPageEditor({
  pageId,
  setupSql,
  answer,
  readOnly,
  courseId,
  onPersist,
  className,
}: Props) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<string>(setupSql ?? "");
  const [setupOpen, setSetupOpen] = useState<boolean>(!!setupSql?.trim());

  // Resumen de tablas/vistas del esquema. Derivado en cada render a propósito:
  // son unas regex sobre un texto corto, y memoizarlo agregaría una dependencia
  // que hay que mantener sincronizada por un ahorro imperceptible.
  const schema = summarizeSetupSql(setup);

  // Respuesta serializada de la hoja. `answerRef` sigue el valor vigente
  // (lo escribe el propio SqlRunner en cada tecla, sin re-renderizar este
  // componente); `answerSeed` + `runnerNonce` solo cambian cuando la IA
  // inserta SQL: remontar el runner es la forma de que tome el valor nuevo,
  // porque su editor lee `value` únicamente al montar.
  const answerRef = useRef<string | null>(answer ?? null);
  const [answerSeed, setAnswerSeed] = useState<string | null>(answer ?? null);
  const [runnerNonce, setRunnerNonce] = useState(0);

  // Generador con IA (solo docente).
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSql, setAiSql] = useState<string | null>(null);

  // Debounce de ambos campos (esquema + respuesta serializada), con flush al
  // desmontar — mismo patrón que CodePageEditor/TextPageEditor: el usuario
  // cambia de hoja o cierra la pizarra antes de que venza el timer, y sin el
  // flush se perdería el último cambio.
  const pendingRef = useRef<Record<string, unknown> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPersistRef = useRef(onPersist);
  const aliveRef = useRef(true);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        if (pendingRef.current) onPersistRef.current(pendingRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schedulePatch = (patch: Record<string, unknown>) => {
    if (readOnly) return;
    pendingRef.current = { ...pendingRef.current, ...patch };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (pendingRef.current) onPersistRef.current(pendingRef.current);
      pendingRef.current = null;
      saveTimer.current = null;
    }, 1200);
  };

  const onSetupChange = (v: string) => {
    setSetup(v);
    schedulePatch({ sql_setup: v });
  };

  const onAnswerChange = (v: string) => {
    answerRef.current = v;
    schedulePatch({ sql_answer: v });
  };

  const generateSql = async () => {
    const instruction = aiPrompt.trim();
    if (!instruction || aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const { data, error } = await supabase.functions.invoke("ai-generate-sql", {
        body: {
          prompt: instruction,
          setupSql: setup.trim() || null,
          courseId: courseId ?? null,
        },
      });
      // `invoke` envuelve los non-2xx en un error genérico; el mensaje real
      // (ej. "la API key está expirada") vive en el body de la respuesta.
      if (error) {
        const real = await extractEdgeError(error, data);
        throw new Error(real || t("sqlAssistant.genericError"));
      }
      if (data?.error) throw new Error(String(data.error));
      const generated = typeof data?.sql === "string" ? data.sql.trim() : "";
      if (!generated) throw new Error(t("sqlAssistant.emptyResult"));
      if (!aliveRef.current) return;
      setAiSql(generated);
    } catch (e) {
      if (!aliveRef.current) return;
      setAiError(friendlyError(e, t("sqlAssistant.genericError")));
    } finally {
      if (aliveRef.current) setAiLoading(false);
    }
  };

  const applyToSetup = () => {
    if (!aiSql) return;
    const hadContent = setup.trim().length > 0;
    const next = appendSqlBlock(setup, aiSql);
    setSetup(next);
    setSetupOpen(true);
    schedulePatch({ sql_setup: next });
    toast.success(hadContent ? t("sqlAssistant.appendedToSetup") : t("sqlAssistant.setAsSetup"));
  };

  const applyToEditor = () => {
    if (!aiSql) return;
    const current = parseSqlAnswer(answerRef.current);
    const hadContent = !!current?.sql.trim();
    const nextSql = appendSqlBlock(current?.sql ?? "", aiSql);
    // Los resultados anteriores ya no corresponden al SQL nuevo: se descartan
    // para que nadie lea una tabla vieja como si fuera de esta consulta.
    const serialized = serializeSqlAnswer({ sql: nextSql, results: [] });
    answerRef.current = serialized;
    setAnswerSeed(serialized);
    setRunnerNonce((n) => n + 1);
    schedulePatch({ sql_answer: serialized });
    toast.success(hadContent ? t("sqlAssistant.appendedToEditor") : t("sqlAssistant.setInEditor"));
  };

  const copyGenerated = async () => {
    if (!aiSql) return;
    try {
      await navigator.clipboard.writeText(aiSql);
      toast.success(t("sqlAssistant.copied"));
    } catch {
      toast.error(t("sqlAssistant.copyFailed"));
    }
  };

  return (
    <div className={cn("flex flex-col h-full min-h-0 overflow-y-auto p-3 gap-3", className)}>
      {/* Generador con IA — herramienta del docente. En readOnly (alumno
          viendo la pizarra compartida) no se renderiza; el edge además
          rechaza a quien no sea Docente/Admin. */}
      {!readOnly && (
        <div className="rounded-md border">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
            <Wand2 className="h-3.5 w-3.5 text-primary" />
            {t("sqlAssistant.title")}
            <HelpHint>{t("sqlAssistant.hint")}</HelpHint>
          </div>
          <div className="flex flex-col gap-2 px-2.5 pb-2.5">
            <div className="flex flex-col gap-2 sm:flex-row">
              {/* Caja de VARIOS renglones y no un `<Input>`: lo que se pide acá es la
                  descripción de un esquema ("clientes y pedidos, 10 filas, un GRANT
                  de solo lectura"), y en un `<input>` no cabe un salto de línea ni
                  con Shift+Enter — la tecla no tiene dónde escribirlo. */}
              <Textarea
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  // Enter genera; Shift+Enter baja renglón. La regla vive en
                  // `enterEnvia` porque este manejador la tenía mal: hacía
                  // `preventDefault()` en CUALQUIER Enter, así que Shift+Enter
                  // generaba en vez de bajar.
                  if (!enterEnvia(e)) return;
                  e.preventDefault();
                  void generateSql();
                }}
                disabled={aiLoading}
                rows={2}
                placeholder={t("sqlAssistant.placeholder")}
                className="flex-1 min-w-[160px] resize-none text-sm sm:min-w-48"
              />
              <Button
                variant="secondary"
                // Sin esto el botón se estira al alto de la caja de 2 renglones.
                className="sm:self-end"
                onClick={() => void generateSql()}
                disabled={aiLoading || !aiPrompt.trim()}
              >
                {aiLoading ? (
                  <Spinner size="xs" className="mr-1" />
                ) : (
                  <Wand2 className="mr-1 h-4 w-4" />
                )}
                {aiLoading ? t("sqlAssistant.generating") : t("sqlAssistant.generate")}
              </Button>
            </div>

            {/* Expectativa explícita mientras corre (la generación tarda
                varios segundos y el docente está frente al curso). En reposo, el
                mismo renglón dice el atajo: la caja acepta varios renglones y
                nadie descubre solo que el salto es Shift+Enter. */}
            {aiLoading ? (
              <p className="text-2xs text-muted-foreground">{t("sqlAssistant.waitHint")}</p>
            ) : (
              <p className="text-2xs text-muted-foreground">{t("sqlAssistant.shortcutsHint")}</p>
            )}

            {aiError && (
              <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-2xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  <strong>{t("sqlAssistant.errorTitle")}</strong> {aiError}
                </span>
              </div>
            )}

            {aiSql && (
              <div className="space-y-2">
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 font-mono text-2xs leading-relaxed">
                  {aiSql}
                </pre>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={applyToSetup}>
                    <Database className="mr-1 h-4 w-4" />
                    {t("sqlAssistant.useAsSetup")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={applyToEditor}>
                    <CornerDownLeft className="mr-1 h-4 w-4" />
                    {t("sqlAssistant.insertInEditor")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void copyGenerated()}>
                    <Copy className="mr-1 h-4 w-4" />
                    {t("sqlAssistant.copy")}
                  </Button>
                </div>
                <p className="text-3xs text-muted-foreground">{t("sqlAssistant.appendNote")}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Esquema/datos de partida — solo el docente lo edita. El alumno corre
          contra el esquema TAL COMO lo dejó el docente (setup en solo lectura
          via prop `setup`, sin UI de edición).

          Los pasos van NUMERADOS ("1 · Esquema" / "2 · Consulta") porque la hoja
          tiene DOS editores de SQL y nada indicaba cuál se escribe primero ni
          que el de arriba corre antes que el de abajo. Sin la numeración se leen
          como dos cajas independientes — era el motivo principal de que la hoja
          no se entendiera. */}
      {!readOnly && (
        <div className="rounded-md border">
          <button
            type="button"
            onClick={() => setSetupOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium hover:text-foreground"
          >
            {setupOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            {t("bdSql.stepSetup")}
            {/* Hint propio de la PIZARRA: el compartido dice "antes del SQL del
                estudiante", y acá no hay estudiante — el docente escribe su
                propia demostración. */}
            <HelpHint>{t("bdSql.setupSqlHintBoard")}</HelpHint>
          </button>
          {setupOpen && (
            <Textarea
              value={setup}
              onChange={(e) => onSetupChange(e.target.value)}
              rows={6}
              spellCheck={false}
              className="rounded-t-none border-t font-mono text-xs"
              placeholder={t("hc_modulesWhiteboardSqlPageEditor.setupPlaceholder", {
                defaultValue: "CREATE TABLE ...\nINSERT INTO ...",
              })}
            />
          )}
          {/* Qué tablas quedó definiendo el esquema. Con 30 líneas de DDL hay que
              releerlas para recordar si la tabla es `cliente` o `clientes`; acá
              se ve de un vistazo y confirma que el esquema se leyó bien ANTES de
              ejecutar. Se oculta si no se detecta nada (ver sql-schema.ts). */}
          {hasSchemaSummary(schema) && (
            <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2 pt-1.5 text-2xs text-muted-foreground">
              {schema.tables.length > 0 && (
                <>
                  <span className="font-medium">{t("bdSql.schemaTables")}</span>
                  {schema.tables.map((n) => (
                    <code key={`t-${n}`} className="rounded bg-muted px-1 py-0.5 font-mono">
                      {n}
                    </code>
                  ))}
                </>
              )}
              {schema.views.length > 0 && (
                <>
                  <span className="font-medium">{t("bdSql.schemaViews")}</span>
                  {schema.views.map((n) => (
                    <code key={`v-${n}`} className="rounded bg-muted px-1 py-0.5 font-mono">
                      {n}
                    </code>
                  ))}
                </>
              )}
              <HelpHint>{t("bdSql.schemaFromSetup")}</HelpHint>
            </div>
          )}
          {!setup.trim() && (
            <p className="px-2.5 pb-2 text-2xs text-muted-foreground">
              {t("bdSql.noSetupHintBoard")}
            </p>
          )}
        </div>
      )}
      <SqlRunner
        key={`${pageId}:${runnerNonce}`}
        value={answerSeed}
        onChange={onAnswerChange}
        setupSql={setup}
        readOnly={readOnly}
        readOnlyAllowRun
        queryLabel={readOnly ? undefined : t("bdSql.stepQuery")}
        className="flex-1"
      />
    </div>
  );
}
