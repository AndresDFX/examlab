/**
 * NetworkConsole — terminal tipo IOS para la pregunta "Red consola". Renderiza
 * una consola sobre `IosInterpreter` (sin xterm.js: input controlado + área de
 * salida monoespaciada) más un resumen textual de la topología. Serializa la
 * respuesta (topología final + historial) en cada comando vía `onChange`.
 *
 * El componente es "no controlado" respecto al estado del intérprete: se
 * inicializa UNA vez desde `scenario` (y reproduce `value` si el alumno
 * reabre), y a partir de ahí mantiene su propio estado. Por eso el padre DEBE
 * pasar un `scenario` estable (memoizado) — si cambia la identidad del objeto,
 * la consola se reinicia.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "lucide-react";
import { IosInterpreter } from "./ios-interpreter";
import { type Topology } from "./topology";
import {
  type NetworkScenario,
  cloneTopology,
  parseNetworkAnswer,
  serializeNetworkAnswer,
} from "./scenario";

type LineKind = "sys" | "cmd" | "out";
interface Line {
  text: string;
  kind: LineKind;
}

interface Props {
  scenario: NetworkScenario;
  /** Respuesta serializada previa (para reanudar). Solo se lee al montar. */
  value?: string | null;
  onChange?: (serialized: string) => void;
  readOnly?: boolean;
}

export function NetworkConsole({ scenario, value, onChange, readOnly }: Props) {
  const { t } = useTranslation();
  const stateRef = useRef<{ topo: Topology; ios: IosInterpreter } | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [prompt, setPrompt] = useState(">");
  const [input, setInput] = useState("");
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Init/reanudar. `value` se usa solo aquí (al montar / cambiar de escenario);
  // omitirlo de deps es intencional para no reiniciar mientras el alumno teclea.
  useEffect(() => {
    const topo = cloneTopology(scenario);
    const target =
      topo.devices.find((d) => d.id === scenario.targetDeviceId) ?? topo.devices[0];
    if (!target) {
      stateRef.current = null;
      setLines([{ text: t("networkConsole.noDevice", { defaultValue: "Escenario sin dispositivo." }), kind: "sys" }]);
      return;
    }
    const ios = new IosInterpreter({ device: target, topology: topo });
    const initLines: Line[] = [
      {
        text: t("networkConsole.welcome", {
          defaultValue: "Consola de {{device}}. Escribe comandos IOS (enable, configure terminal, …).",
          device: target.name || target.id,
        }),
        kind: "sys",
      },
    ];
    const parsed = parseNetworkAnswer(value);
    const replay = parsed?.histories?.[target.id];
    if (Array.isArray(replay) && replay.length) {
      for (const cmd of replay) {
        initLines.push({ text: `${ios.prompt()} ${cmd}`, kind: "cmd" });
        for (const o of ios.execute(cmd)) initLines.push({ text: o, kind: "out" });
      }
    }
    stateRef.current = { topo, ios };
    setLines(initLines);
    setPrompt(ios.prompt());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario]);

  // Auto-scroll al fondo cuando entran líneas nuevas.
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
    const promptLine = `${st.ios.prompt()} ${cmd}`;
    const out = st.ios.execute(cmd);
    setLines((prev) => [
      ...prev,
      { text: promptLine, kind: "cmd" },
      ...out.map((o): Line => ({ text: o, kind: "out" })),
    ]);
    setPrompt(st.ios.prompt());
    onChange?.(serializeNetworkAnswer(st.topo, { [st.ios.device.id]: [...st.ios.history] }));
  };

  const recall = (dir: -1 | 1) => {
    const st = stateRef.current;
    if (!st) return;
    const h = st.ios.history;
    if (h.length === 0) return;
    let idx = histIdx == null ? h.length : histIdx;
    idx = Math.max(0, Math.min(h.length, idx + dir));
    setHistIdx(idx);
    setInput(idx >= h.length ? "" : h[idx]);
  };

  return (
    <div className="rounded-md border overflow-hidden">
      {/* Resumen textual de la topología (sustituye a la vista GUI en el MVP). */}
      <div className="bg-muted/40 px-3 py-2 text-xs space-y-1">
        <div className="flex items-center gap-1.5 font-medium">
          <Terminal className="h-3.5 w-3.5" />
          {t("networkConsole.topologyTitle", { defaultValue: "Topología" })}
        </div>
        <ul className="text-muted-foreground space-y-0.5">
          {scenario.devices.map((d) => (
            <li key={d.id}>
              <span className="font-mono">{d.name || d.id}</span>{" "}
              <span className="opacity-70">({t(`networkConsole.kind.${d.kind}`, { defaultValue: d.kind })})</span>
              {d.interfaces.some((i) => i.ip) && (
                <span className="opacity-70">
                  {" — "}
                  {d.interfaces
                    .filter((i) => i.ip)
                    .map((i) => `${i.name}: ${i.ip}`)
                    .join(", ")}
                </span>
              )}
            </li>
          ))}
          {scenario.links.map((l, i) => (
            <li key={i} className="opacity-70">
              {l.a.device}:{l.a.iface} ↔ {l.b.device}:{l.b.iface}
            </li>
          ))}
        </ul>
      </div>

      {/* Terminal. onClick enfoca el input real (que maneja el teclado); el
          contenedor no es un control semántico, por eso el disable a11y. No
          usamos <button> como wrapper: anidar <input> dentro de <button> es
          HTML inválido y dispara un warning de React DOM. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div
        ref={scrollRef}
        onClick={() => inputRef.current?.focus()}
        className="bg-zinc-950 text-zinc-100 font-mono text-xs p-3 h-64 overflow-y-auto whitespace-pre-wrap cursor-text"
      >
        {lines.map((l, i) => (
          <div
            key={i}
            className={
              l.kind === "cmd"
                ? "text-emerald-300"
                : l.kind === "sys"
                  ? "text-sky-300"
                  : "text-zinc-200"
            }
          >
            {l.text}
          </div>
        ))}
        {!readOnly && (
          <div className="flex items-center text-emerald-300">
            <span className="shrink-0">{prompt}&nbsp;</span>
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
              aria-label={t("networkConsole.focus", { defaultValue: "Consola de red" })}
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
