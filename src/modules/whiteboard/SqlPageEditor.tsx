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
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { HelpHint } from "@/components/ui/help-hint";
import { SqlRunner } from "@/modules/database/SqlRunner";
import { cn } from "@/shared/lib/utils";

interface Props {
  pageId: string;
  setupSql: string | null;
  answer: string | null;
  readOnly?: boolean;
  /** El padre persiste el patch en `whiteboard_pages` + actualiza su state. */
  onPersist: (patch: Record<string, unknown>) => void;
  className?: string;
}

export function SqlPageEditor({ pageId, setupSql, answer, readOnly, onPersist, className }: Props) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<string>(setupSql ?? "");
  const [setupOpen, setSetupOpen] = useState<boolean>(!!setupSql?.trim());

  // Debounce de ambos campos (esquema + respuesta serializada), con flush al
  // desmontar — mismo patrón que CodePageEditor/TextPageEditor: el usuario
  // cambia de hoja o cierra la pizarra antes de que venza el timer, y sin el
  // flush se perdería el último cambio.
  const pendingRef = useRef<Record<string, unknown> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  useEffect(() => {
    return () => {
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
    schedulePatch({ sql_answer: v });
  };

  return (
    <div className={cn("flex flex-col h-full min-h-0 overflow-y-auto p-3 gap-3", className)}>
      {/* Esquema/datos de partida — solo el docente lo edita. El alumno corre
          contra el esquema TAL COMO lo dejó el docente (setup en solo lectura
          via prop `setup`, sin UI de edición). */}
      {!readOnly && (
        <div className="rounded-md border">
          <button
            type="button"
            onClick={() => setSetupOpen((o) => !o)}
            className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {setupOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {t("bdSql.setupSqlLabel")}
            <HelpHint>{t("bdSql.setupSqlHint")}</HelpHint>
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
          {!setup.trim() && <p className="px-2.5 pb-2 text-2xs text-muted-foreground">{t("bdSql.noSetupHint")}</p>}
        </div>
      )}
      <SqlRunner
        value={answer}
        onChange={onAnswerChange}
        setupSql={setup}
        readOnly={readOnly}
        readOnlyAllowRun
        className="flex-1"
      />
    </div>
  );
}
