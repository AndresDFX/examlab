/**
 * Caja «Generar el esquema con IA» de una pregunta SQL que va a ser CALIFICADA.
 *
 * ── Por qué es un componente y no está inline ─────────────────────────
 * Nació inline en el editor de preguntas de TALLER. El campo `setupSql` está
 * duplicado a mano en taller, examen y proyecto, así que llevar el generador al
 * examen por copia habría dejado ~180 líneas repetidas y dos generadores que se
 * desincronizan — exactamente lo que la regla de UI de CLAUDE.md prohíbe
 * («si el patrón se va a repetir, proponer el componente»).
 *
 * ── El prompt es OTRO que el de la pizarra, y es el punto ─────────────
 * El generador manda `useCase: "sql_question_schema"`, cuyo system prompt global
 * vive en la plataforma (Configuración → Prompts → «Esquema de una pregunta
 * SQL») y tiene PROHIBIDO revelar la respuesta.
 *
 * Antes esto se parcheaba pegando una directiva al mensaje del docente desde
 * acá (`DIRECTIVA_SOLO_ESQUEMA`). Era frágil por dos motivos: no era visible ni
 * editable desde la plataforma, y peleaba contra el system prompt de la pizarra
 * —que está escrito para una clase EN VIVO y entrega la consulta cuando se la
 * piden—, así que un Admin que editara ese prompt podía dejar la directiva
 * discutiendo con él. Con un use_case propio, la regla vive donde el Admin la
 * puede leer.
 *
 * ── Lo que el llamador conserva ───────────────────────────────────────
 * El estado del esquema (`setupSql` / `onChange`) sigue siendo del formulario
 * que lo contiene: esta caja no lo posee, solo le APENDE el bloque generado con
 * `appendSqlBlock`. Y expone `onReset` vía `useImperativeHandle` para que el
 * formulario limpie la preview al cambiar de pregunta — sin eso, una preview
 * colgada de la pregunta anterior ofrece «Usar como esquema» e inyecta el
 * esquema equivocado en la nueva.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { AlertTriangle, Copy, Database, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { HelpHint } from "@/components/ui/help-hint";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { friendlyError } from "@/shared/lib/db-errors";
import { appendSqlBlock } from "./sql-help";

/**
 * Tope de la instrucción del docente. El edge recorta en 2000; se deja margen
 * para que nada se pierda en silencio a mitad de una frase.
 */
const MAX_INSTRUCCION_SQL = 1800;

/** Enter genera, Shift+Enter baja renglón. */
function enterEnvia(e: React.KeyboardEvent): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
}

export interface SqlSchemaAiBoxHandle {
  /** Limpia instrucción, error y preview. Llamar al cambiar de pregunta. */
  reset: () => void;
}

export interface SqlSchemaAiBoxProps {
  /** El esquema de partida actual: se manda como contexto y se le apende. */
  setupSql: string;
  onChange: (siguiente: string) => void;
  /** Curso, para que el prompt resuelva el override del docente si existe. */
  courseId?: string | null;
}

export const SqlSchemaAiBox = forwardRef<SqlSchemaAiBoxHandle, SqlSchemaAiBoxProps>(
  function SqlSchemaAiBox({ setupSql, onChange, courseId }, ref) {
    const { t } = useTranslation();
    const [instruccion, setInstruccion] = useState("");
    const [cargando, setCargando] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [generado, setGenerado] = useState<string | null>(null);

    // Guard de desmontaje: el diálogo se cierra mucho antes de que la IA
    // responda, y sin esto el setState dispara sobre un componente muerto.
    const vivoRef = useRef(true);
    useEffect(() => {
      vivoRef.current = true;
      return () => {
        vivoRef.current = false;
      };
    }, []);

    useImperativeHandle(ref, () => ({
      reset: () => {
        setInstruccion("");
        setError(null);
        setGenerado(null);
      },
    }));

    const generar = async () => {
      const pedido = instruccion.trim();
      if (!pedido || cargando) return;
      setCargando(true);
      setError(null);
      try {
        const { data, error: invokeErr } = await supabase.functions.invoke("ai-generate-sql", {
          body: {
            prompt: pedido.slice(0, MAX_INSTRUCCION_SQL),
            setupSql: setupSql.trim() || null,
            courseId: courseId ?? null,
            // La regla de «no reveles la respuesta» vive en ESTE prompt global,
            // no pegada a la instrucción del docente.
            useCase: "sql_question_schema",
          },
        });
        // `invoke` envuelve los non-2xx en un mensaje genérico; el real (429 con
        // los segundos que faltan, API key vencida) vive en el body.
        // `extractEdgeError` consume el stream: se llama UNA sola vez.
        if (invokeErr) {
          const real = await extractEdgeError(invokeErr, data);
          throw new Error(real || t("sqlAssistant.genericError"));
        }
        if (data?.error) throw new Error(String(data.error));
        const sql = typeof data?.sql === "string" ? data.sql.trim() : "";
        if (!sql) throw new Error(t("sqlAssistant.emptyResult"));
        if (!vivoRef.current) return;
        setGenerado(sql);
      } catch (e) {
        if (!vivoRef.current) return;
        setError(friendlyError(e, t("sqlAssistant.genericError")));
      } finally {
        if (vivoRef.current) setCargando(false);
      }
    };

    const aplicar = () => {
      if (!generado) return;
      const habiaContenido = setupSql.trim().length > 0;
      onChange(appendSqlBlock(setupSql, generado));
      toast.success(
        habiaContenido ? t("sqlAssistant.appendedToSetup") : t("sqlAssistant.setAsSetup"),
      );
    };

    const copiar = async () => {
      if (!generado) return;
      try {
        await navigator.clipboard.writeText(generado);
        toast.success(t("sqlAssistant.copied"));
      } catch {
        toast.error(t("sqlAssistant.copyFailed"));
      }
    };

    return (
      <div className="rounded-md border">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
          <Wand2 className="h-3.5 w-3.5 text-primary" />
          {t("sqlAssistant.title")}
          <HelpHint>{t("sqlAssistant.hintQuestion")}</HelpHint>
        </div>
        <div className="flex flex-col gap-2 px-2.5 pb-2.5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Textarea
              value={instruccion}
              onChange={(e) => setInstruccion(e.target.value)}
              onKeyDown={(e) => {
                if (!enterEnvia(e)) return;
                e.preventDefault();
                void generar();
              }}
              disabled={cargando}
              rows={2}
              placeholder={t("sqlAssistant.placeholder")}
              className="flex-1 min-w-[160px] resize-none text-sm sm:min-w-48"
            />
            <Button
              type="button"
              variant="secondary"
              // Sin esto el botón se estira al alto de la caja de 2 renglones.
              className="sm:self-end"
              onClick={() => void generar()}
              disabled={cargando || !instruccion.trim()}
            >
              {cargando ? (
                <Spinner size="xs" className="mr-1" />
              ) : (
                <Wand2 className="mr-1 h-4 w-4" />
              )}
              {cargando ? t("sqlAssistant.generating") : t("sqlAssistant.generate")}
            </Button>
          </div>

          {cargando ? (
            <p className="text-2xs text-muted-foreground">{t("sqlAssistant.waitHint")}</p>
          ) : (
            <p className="text-2xs text-muted-foreground">{t("sqlAssistant.shortcutsHint")}</p>
          )}

          {/* El error va FIJO en el panel y no como toast: el caso más probable
              es el 429 ("reintenta en N segundos") y ese número hay que poder
              releerlo. */}
          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-2xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <strong>{t("sqlAssistant.errorTitle")}</strong> {error}
              </span>
            </div>
          )}

          {generado && (
            <div className="space-y-2">
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 font-mono text-2xs leading-relaxed">
                {generado}
              </pre>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={aplicar}>
                  <Database className="mr-1 h-4 w-4" />
                  {t("sqlAssistant.useAsSetup")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void copiar()}>
                  <Copy className="mr-1 h-4 w-4" />
                  {t("sqlAssistant.copy")}
                </Button>
              </div>
              <p className="text-3xs text-muted-foreground">{t("sqlAssistant.appendNote")}</p>
            </div>
          )}
        </div>
      </div>
    );
  },
);
