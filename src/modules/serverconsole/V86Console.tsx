/**
 * V86Console — terminal de Linux REAL en el navegador para la pregunta
 * "Consola de servidor" (`so_consola`). Reemplaza al simulador determinista
 * (`ServerConsole` legacy): en vez de un modelo `System` en memoria, bootea un
 * x86 real (v86 → WASM) y expone su consola serial vía xterm.js, así que TODOS
 * los comandos de Linux funcionan de verdad (concepto tipo jslinux).
 *
 * Assets (v86, wasm, BIOS, xterm) se cargan por CDN — ver `v86-loader.ts`. La
 * IMAGEN del SO (varios MB) NO se puede embeber: se hostea aparte y se apunta
 * con env vars VITE_V86_*. Ver `docs/server-console-v86.md`.
 *
 * Calificación: un VM real no se auto-califica por estado (no se puede
 * introspeccionar como el simulador). La respuesta del alumno es el TRANSCRIPT
 * de su sesión (`v86-answer.ts`), que el docente revisa manualmente.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as TerminalIcon, AlertTriangle, RotateCw } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import {
  loadV86,
  loadXterm,
  V86_WASM_URL,
  V86_BIOS_URL,
  V86_VGABIOS_URL,
  V86_DEFAULT_BZIMAGE_URL,
  type V86Emulator,
  type XtermTerminal,
} from "./v86-loader";
import { parseV86Answer, serializeV86Answer } from "./v86-answer";

interface Props {
  value?: string | null;
  onChange?: (serialized: string) => void;
  readOnly?: boolean;
  className?: string;
}

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;

/**
 * Imagen por DEFAULT cuando el entorno no define ninguna env `VITE_V86_*`.
 * Buildroot con la consola serial YA integrada, ahora self-hosteada en el
 * Storage PROPIO del proyecto (ver `V86_DEFAULT_BZIMAGE_URL` en v86-loader.ts).
 * WHY se dejó de usar `i.copy.sh`: era un host de terceros best-effort — una
 * descarga fallida dejaba la consola en "No se pudo descargar un recurso del
 * sistema". Hosteada en Supabase (SW-exento, CORS `*`, content-range
 * consistente) la descarga es fiable. WHY hardcodear un default: sin él la
 * consola mostraba "sin imagen configurada" y NUNCA booteaba en el caso por
 * defecto (nadie define las env vars).
 *
 * Producción PUEDE overridear con `VITE_V86_STATE_URL` apuntando a un snapshot
 * (boot en ~1-2s en vez de bootear el kernel completo). Ver
 * docs/server-console-v86.md.
 */
const DEFAULT_BZIMAGE_URL = V86_DEFAULT_BZIMAGE_URL;
/** cmdline EXACTO que usa la demo oficial de v86 para esa imagen. */
const DEFAULT_CMDLINE = "tsc=reliable mitigations=off random.trust_cpu=on";

/** Config de boot resuelta desde env, con fallback al default público. */
function resolveBootConfig(): Record<string, unknown> | null {
  const stateUrl = env.VITE_V86_STATE_URL;
  let bzimageUrl = env.VITE_V86_BZIMAGE_URL;
  const initrdUrl = env.VITE_V86_INITRD_URL;
  const cdromUrl = env.VITE_V86_IMAGE_URL;
  const hdaUrl = env.VITE_V86_HDA_URL;
  const fsJsonUrl = env.VITE_V86_FS_JSON_URL;
  const fsBaseUrl = env.VITE_V86_FS_BASEURL;
  let cmdline = env.VITE_V86_CMDLINE;
  const memMB = Number(env.VITE_V86_MEMORY_MB) || 128;

  // Sin NINGUNA fuente de imagen en env → caer al default público booteable
  // (en vez de quedar "unconfigured" para siempre).
  if (!stateUrl && !bzimageUrl && !cdromUrl && !hdaUrl) {
    bzimageUrl = DEFAULT_BZIMAGE_URL;
    if (!cmdline) cmdline = DEFAULT_CMDLINE;
  }

  const cfg: Record<string, unknown> = {
    wasm_path: V86_WASM_URL,
    bios: { url: V86_BIOS_URL },
    vga_bios: { url: V86_VGABIOS_URL },
    memory_size: memMB * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    autostart: true,
    disable_speaker: true,
  };
  if (stateUrl) cfg.initial_state = { url: stateUrl };
  if (bzimageUrl) cfg.bzimage = { url: bzimageUrl };
  if (initrdUrl) cfg.initrd = { url: initrdUrl };
  if (cdromUrl) cfg.cdrom = { url: cdromUrl };
  if (hdaUrl) cfg.hda = { url: hdaUrl };
  if (fsJsonUrl) cfg.filesystem = { basefs: { url: fsJsonUrl }, baseurl: fsBaseUrl };
  // WHY filesystem vacío para boots por bzimage: buildroot-bzimage68.bin (y las
  // imágenes tipo jslinux de v86) montan su ROOT sobre 9p (root=host9p, baked
  // en el CONFIG_CMDLINE del kernel). v86 SOLO crea el dispositivo virtio-9p si
  // se pasa la opción `filesystem`; sin ella el kernel arranca pero NO tiene
  // rootfs → no llega a getty/busybox → terminal vacía, sin shell ni echo. El
  // ejemplo oficial examples/serial.html pasa `filesystem: {}` por esto mismo.
  else if (bzimageUrl) cfg.filesystem = {};
  // cmdline SOLO si el operador lo define (VITE_V86_CMDLINE) o el default lo
  // setea arriba. NO forzar console=ttyS0/root=/dev/ram0: rompe imágenes que
  // rootean en 9p (como la default, que ya trae su consola serial baked).
  if (cmdline) cfg.cmdline = cmdline;

  return cfg;
}

type Status = "loading" | "booting" | "ready" | "error" | "unconfigured";

export function V86Console({ value, onChange, readOnly, className }: Props) {
  const { t } = useTranslation();
  const termHostRef = useRef<HTMLDivElement>(null);
  const emulatorRef = useRef<V86Emulator | null>(null);
  const termRef = useRef<XtermTerminal | null>(null);
  const transcriptRef = useRef<string>("");
  const commandsRef = useRef<string[]>([]);
  const cmdBufRef = useRef<string>("");
  const emitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "ready" REAL = llegó el primer byte serial (evidencia de que el kernel
  // emite en ttyS0 → hay shell). El watchdog surfacea el error si NO llega
  // nada en 45s (boot fallido silencioso) en vez de fingir "ready".
  const sawOutputRef = useRef(false);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined" || readOnly) return;
    let cancelled = false;
    sawOutputRef.current = false;

    const bootConfig = resolveBootConfig();
    if (!bootConfig) {
      setStatus("unconfigured");
      return;
    }

    const emit = () => {
      onChange?.(
        serializeV86Answer({ transcript: transcriptRef.current, commands: commandsRef.current }),
      );
    };
    const scheduleEmit = () => {
      if (emitTimer.current) clearTimeout(emitTimer.current);
      emitTimer.current = setTimeout(emit, 800);
    };

    void (async () => {
      try {
        setStatus("loading");
        setError(null);
        const [V86, Xterm] = await Promise.all([loadV86(), loadXterm()]);
        if (cancelled || !termHostRef.current) return;

        const term = new Xterm({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          scrollback: 4000,
          cols: 100,
          rows: 30,
          theme: { background: "#09090b", foreground: "#f4f4f5", cursor: "#6ee7b7" },
        });
        term.open(termHostRef.current);
        termRef.current = term;

        const emulator = new V86(bootConfig);
        emulatorRef.current = emulator;

        // Salida serial del VM → xterm + transcript.
        emulator.add_listener("serial0-output-byte", (byte) => {
          // "ready" REAL: el kernel emite en ttyS0 ⇒ hay shell usable. Reemplaza
          // al timer ciego que fingía "ready" sobre una VM que nunca booteó.
          if (!sawOutputRef.current) {
            sawOutputRef.current = true;
            if (watchdogRef.current) clearTimeout(watchdogRef.current);
            if (!cancelled) {
              setStatus("ready");
              // Auto-foco: el alumno puede tipear sin clickear la terminal.
              queueMicrotask(() => termRef.current?.focus());
            }
          }
          const ch = String.fromCharCode(byte as number);
          term.write(ch);
          transcriptRef.current += ch;
          if (transcriptRef.current.length > 260_000) {
            transcriptRef.current = transcriptRef.current.slice(-200_000);
          }
          scheduleEmit();
        });

        // Input del usuario (xterm) → serial del VM + captura de comandos.
        term.onData((data) => {
          emulator.serial0_send(data);
          for (const ch of data) {
            if (ch === "\r" || ch === "\n") {
              const line = cmdBufRef.current.trim();
              if (line) commandsRef.current.push(line);
              cmdBufRef.current = "";
            } else if (ch === "\x7f" || ch === "\b") {
              cmdBufRef.current = cmdBufRef.current.slice(0, -1);
            } else if (ch >= " ") {
              cmdBufRef.current += ch;
            }
          }
        });

        // emulator-started solo dice que el CPU arrancó, NO que el SO booteó.
        // No marca "ready" — eso lo hace el primer byte serial (arriba).
        emulator.add_listener("emulator-started", () => {
          if (!cancelled) setStatus((s) => (s === "loading" ? "booting" : s));
        });

        // Fallo honesto de descarga de assets (bios/wasm/imagen). v86 los carga
        // async DESPUÉS de que el constructor retorna, así que un 404 NO rechaza
        // `new V86()` ni cae en el catch — hay que escuchar el evento, o el
        // fallo queda enmascarado como "ready" (bug reportado).
        emulator.add_listener("download-error", (e) => {
          if (cancelled || sawOutputRef.current) return;
          const url = (e as { request?: { url?: string } } | null)?.request?.url;
          setError(
            t("serverConsole.downloadError", {
              defaultValue: "No se pudo descargar un recurso del sistema: {{url}}",
              url: url ?? "(desconocido)",
            }),
          );
          setStatus("error");
        });

        setStatus("booting");

        // Watchdog: si NO llega NINGÚN byte serial en 45s, el boot falló en
        // silencio (imagen no disponible / 9p mal / assets caídos). Mostramos
        // error en vez de pintar el badge verde sobre una VM que nunca booteó.
        watchdogRef.current = setTimeout(() => {
          if (cancelled || sawOutputRef.current) return;
          setError(
            t("serverConsole.timeout", {
              defaultValue:
                "La consola no respondió a tiempo. La imagen de Linux puede no estar disponible.",
            }),
          );
          setStatus("error");
        }, 45000);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      if (emitTimer.current) clearTimeout(emitTimer.current);
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      // Emisión final del transcript antes de desmontar.
      try {
        onChange?.(
          serializeV86Answer({ transcript: transcriptRef.current, commands: commandsRef.current }),
        );
      } catch {
        /* noop */
      }
      try {
        emulatorRef.current?.destroy?.();
        emulatorRef.current?.stop?.();
      } catch {
        /* noop */
      }
      try {
        termRef.current?.dispose();
      } catch {
        /* noop */
      }
      emulatorRef.current = null;
      termRef.current = null;
    };
    // Re-boot al pulsar "Reintentar" (attempt bump).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // Modo revisión: no bootea VM, muestra el transcript guardado.
  if (readOnly) {
    const parsed = parseV86Answer(value);
    return (
      <div className={`rounded-md border overflow-hidden ${className ?? ""}`}>
        <div className="bg-muted/40 px-3 py-2 text-xs flex items-center gap-1.5 font-medium">
          <TerminalIcon className="h-3.5 w-3.5" />
          {t("serverConsole.transcriptTitle", { defaultValue: "Transcript de la sesión" })}
        </div>
        <pre className="bg-zinc-950 text-zinc-100 font-mono text-xs p-3 max-h-72 overflow-auto whitespace-pre-wrap">
          {parsed?.transcript?.trim()
            ? parsed.transcript
            : t("serverConsole.transcriptEmpty", { defaultValue: "(sin actividad en la consola)" })}
        </pre>
      </div>
    );
  }

  return (
    <div className={`relative rounded-md border overflow-hidden ${className ?? ""}`}>
      <div className="bg-muted/40 px-3 py-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium">
          <TerminalIcon className="h-3.5 w-3.5" />
          {t("serverConsole.title", { defaultValue: "Consola del servidor (Linux)" })}
          {status === "ready" && (
            <span className="ml-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
              {t("serverConsole.liveBadge", { defaultValue: "Linux real" })}
            </span>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5">
          {t("serverConsole.hintV86", {
            defaultValue:
              "Máquina Linux real ejecutándose en tu navegador. Escribe comandos como en una terminal normal.",
          })}
        </p>
      </div>

      <div className="relative bg-zinc-950">
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
        <div
          ref={termHostRef}
          onClick={() => termRef.current?.focus()}
          className="min-h-72 p-2 cursor-text"
        />

        {(status === "loading" || status === "booting") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950/80 text-zinc-200">
            <Spinner size="md" />
            <span className="text-xs">
              {status === "loading"
                ? t("serverConsole.loading", { defaultValue: "Cargando el emulador…" })
                : t("serverConsole.booting", { defaultValue: "Iniciando Linux…" })}
            </span>
          </div>
        )}

        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950/90 p-4 text-center text-zinc-200">
            <AlertTriangle className="h-6 w-6 text-amber-400" />
            <span className="text-xs">
              {t("serverConsole.error", { defaultValue: "No se pudo iniciar la consola." })}
            </span>
            {error && <span className="text-[11px] text-zinc-400 max-w-md break-words">{error}</span>}
            <button
              type="button"
              onClick={() => setAttempt((a) => a + 1)}
              className="mt-1 inline-flex items-center gap-1.5 rounded bg-zinc-700 px-2.5 py-1 text-xs text-zinc-50 hover:bg-zinc-600"
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t("common.retry", { defaultValue: "Reintentar" })}
            </button>
          </div>
        )}

        {status === "unconfigured" && (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center text-zinc-300 min-h-72">
            <AlertTriangle className="h-6 w-6 text-amber-400" />
            <span className="text-xs font-medium">
              {t("serverConsole.unconfigured", {
                defaultValue: "La consola Linux aún no tiene una imagen configurada.",
              })}
            </span>
            <span className="text-[11px] text-zinc-500 max-w-md">
              {t("serverConsole.unconfiguredHint", {
                defaultValue:
                  "El administrador debe hostear una imagen de Linux y definir VITE_V86_IMAGE_URL (o VITE_V86_STATE_URL / VITE_V86_BZIMAGE_URL). Ver docs/server-console-v86.md.",
              })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
