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
  // Editor de texto (nano/vi/vim). Cuando != null se muestra el overlay del
  // editor sobre la consola; `content` es la copia de trabajo del textarea.
  const [editor, setEditor] = useState<{ display: string; content: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    if (editor) setTimeout(() => editorRef.current?.focus(), 0);
  }, [editor]);

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
    // nano/vi/vim: el comando abrió un editor → mostramos el overlay y
    // serializamos recién al guardar/cancelar.
    if (st.sh.editorRequest) {
      setEditor({ display: st.sh.editorRequest.display, content: st.sh.editorRequest.content });
      return;
    }
    onChange?.(serializeServerAnswer(st.sys, [...st.sh.history]));
  };

  const closeEditor = (save: boolean) => {
    const st = stateRef.current;
    if (!st || !editor) return;
    const out = save ? st.sh.saveEditor(editor.content) : (st.sh.cancelEditor(), [] as string[]);
    if (out.length) {
      setLines((prev) => [...prev, ...out.map((o): Line => ({ text: o, kind: "out" }))]);
    }
    onChange?.(serializeServerAnswer(st.sys, [...st.sh.history]));
    setEditor(null);
    setTimeout(() => inputRef.current?.focus(), 0);
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
    <div className="relative rounded-md border overflow-hidden">
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
                } else if (e.key === "Tab") {
                  // Autocompletado como en una terminal real (NO mover el foco).
                  e.preventDefault();
                  const st = stateRef.current;
                  if (!st) return;
                  const res = st.sh.complete(input);
                  if (res.line !== input) setInput(res.line);
                  if (res.candidates.length > 1) {
                    setLines((prev) => [
                      ...prev,
                      { text: `${st.sh.prompt()}${input}`, kind: "cmd" },
                      { text: res.candidates.join("   "), kind: "out" },
                    ]);
                  }
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

      {/* Editor de texto (nano/vi/vim) — overlay tipo pantalla completa de nano. */}
      {editor && (
        <div className="absolute inset-0 z-10 flex flex-col bg-zinc-950 font-mono text-xs">
          <div className="flex items-center justify-between bg-zinc-100 text-zinc-900 px-3 py-1 font-medium">
            <span>GNU nano</span>
            <span className="truncate max-w-[60%]">
              {editor.display || t("serverConsole.editorNewBuffer", { defaultValue: "Buffer nuevo" })}
            </span>
          </div>
          <textarea
            ref={editorRef}
            value={editor.content}
            onChange={(e) => setEditor((ed) => (ed ? { ...ed, content: e.target.value } : ed))}
            onKeyDown={(e) => {
              // ^O / ^S = guardar y salir · ^X / Esc = salir sin guardar.
              if ((e.ctrlKey || e.metaKey) && (e.key === "o" || e.key === "s" || e.key === "x")) {
                e.preventDefault();
                closeEditor(e.key !== "x");
              } else if (e.key === "Escape") {
                e.preventDefault();
                closeEditor(false);
              }
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            className="flex-1 resize-none bg-zinc-950 text-zinc-100 caret-emerald-300 p-3 outline-none whitespace-pre"
          />
          <div className="flex items-center gap-3 bg-zinc-900 text-zinc-300 px-3 py-1.5 text-[11px]">
            <button
              type="button"
              onClick={() => closeEditor(true)}
              className="rounded bg-emerald-700 px-2 py-1 text-zinc-50 hover:bg-emerald-600"
            >
              {t("serverConsole.editorSave", { defaultValue: "^O Guardar y salir" })}
            </button>
            <button
              type="button"
              onClick={() => closeEditor(false)}
              className="rounded bg-zinc-700 px-2 py-1 text-zinc-50 hover:bg-zinc-600"
            >
              {t("serverConsole.editorExit", { defaultValue: "^X Salir" })}
            </button>
            <span className="text-zinc-500 hidden sm:inline">
              {t("serverConsole.editorHint", { defaultValue: "Ctrl+O guardar · Ctrl+X / Esc salir" })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
