/**
 * ServerConsole — terminal de shell (bash-like) para la pregunta "Consola de
 * servidor" (`so_consola`). Análogo de `network/NetworkConsole.tsx`: renderiza
 * una consola sobre `ShellInterpreter` (input controlado + salida monoespaciada)
 * y serializa la respuesta (sistema final + historial) en cada comando vía
 * `onChange`. Se inicializa UNA vez desde `scenario` y reproduce `value` (el
 * historial) si el alumno reabre — por eso el padre DEBE pasar un `scenario`
 * estable (memoizado).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "lucide-react";
import { ShellInterpreter } from "./shell";
import { type System } from "./system";
import {
  type ServerScenario,
  initialSystemFor,
  parseServerAnswer,
  serializeServerAnswer,
} from "./scenario";

type LineKind = "sys" | "cmd" | "out";
interface Line {
  text: string;
  kind: LineKind;
}

interface Props {
  scenario: ServerScenario;
  /** Respuesta serializada previa (para reanudar). Solo se lee al montar. */
  value?: string | null;
  onChange?: (serialized: string) => void;
  readOnly?: boolean;
}

export function ServerConsole({ scenario, value, onChange, readOnly }: Props) {
  const { t } = useTranslation();
  const stateRef = useRef<{ sys: System; sh: ShellInterpreter } | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [prompt, setPrompt] = useState("$");
  const [input, setInput] = useState("");
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Init/reanudar: sistema fresco desde el escenario + replay del historial.
  // `value` se lee solo aquí (al montar / cambiar de escenario).
  useEffect(() => {
    const sys = initialSystemFor(scenario);
    const sh = new ShellInterpreter(sys);
    const initLines: Line[] = [
      {
        text: t("serverConsole.welcome", {
          defaultValue:
            "Consola del servidor. Estás como «{{user}}». Usa comandos de Linux (pwd, ls, mkdir, chmod, sudo …).",
          user: sys.user,
        }),
        kind: "sys",
      },
    ];
    const parsed = parseServerAnswer(value);
    const replay = parsed?.history;
    if (Array.isArray(replay) && replay.length) {
      for (const cmd of replay) {
        initLines.push({ text: `${sh.prompt()}${cmd}`, kind: "cmd" });
        for (const o of sh.execute(cmd)) initLines.push({ text: o, kind: "out" });
      }
    }
    stateRef.current = { sys, sh };
    setLines(initLines);
    setPrompt(sh.prompt());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const run = () => {
    const st = stateRef.current;
    if (!st || readOnly) return;
    const cmd = input;
    setInput("");
    setHistIdx(null);
    const promptLine = `${st.sh.prompt()}${cmd}`;
    const out = st.sh.execute(cmd);
    setLines((prev) => [
      ...prev,
      { text: promptLine, kind: "cmd" },
      ...out.map((o): Line => ({ text: o, kind: "out" })),
    ]);
    setPrompt(st.sh.prompt());
    onChange?.(serializeServerAnswer(st.sys, [...st.sh.history]));
  };

  const recall = (dir: -1 | 1) => {
    const st = stateRef.current;
    if (!st) return;
    const h = st.sh.history;
    if (h.length === 0) return;
    let idx = histIdx == null ? h.length : histIdx;
    idx = Math.max(0, Math.min(h.length, idx + dir));
    setHistIdx(idx);
    setInput(idx >= h.length ? "" : h[idx]);
  };

  return (
    <div className="rounded-md border overflow-hidden">
      <div className="bg-muted/40 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium">
          <Terminal className="h-3.5 w-3.5" />
          {t("serverConsole.title", { defaultValue: "Consola del servidor" })}
        </div>
        <p className="text-muted-foreground mt-0.5">
          {t("serverConsole.hint", {
            defaultValue:
              "Comandos privilegiados (useradd, apt install, systemctl) requieren `sudo`. Flechas ↑/↓ para el historial.",
          })}
        </p>
      </div>

      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div
        ref={scrollRef}
        onClick={() => inputRef.current?.focus()}
        className="bg-zinc-950 text-zinc-100 font-mono text-xs p-3 h-72 overflow-y-auto whitespace-pre-wrap cursor-text"
      >
        {lines.map((l, i) => (
          <div
            key={i}
            className={
              l.kind === "cmd" ? "text-emerald-300" : l.kind === "sys" ? "text-sky-300" : "text-zinc-200"
            }
          >
            {l.text}
          </div>
        ))}
        {!readOnly && (
          <div className="flex items-center text-emerald-300">
            <span className="shrink-0 whitespace-pre">{prompt}</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  run();
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  recall(-1);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  recall(1);
                }
              }}
              aria-label={t("serverConsole.focus", { defaultValue: "Consola del servidor" })}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              className="flex-1 bg-transparent outline-none border-0 text-zinc-100 caret-emerald-300 p-0"
            />
          </div>
        )}
      </div>
    </div>
  );
}
