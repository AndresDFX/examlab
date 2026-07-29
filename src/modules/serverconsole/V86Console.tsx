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
 *
 * Color: se resuelve por DOS lados independientes — la paleta ANSI de xterm
 * (`ANSI_THEME`, lado app) y un init del shell del guest (`INIT_PAYLOAD`, lado
 * VM: PS1 coloreado + alias `--color=auto`) que se inyecta por el serial dentro
 * de una ventana aislada para NO contaminar el transcript ni la lista de
 * comandos del alumno. Ver el bloque de refs `inject*` para la invariante.
 *
 * El init es el único mecanismo del componente que ESCRIBE en el guest sin que
 * el alumno lo pida, así que está construido alrededor de una sola regla: el
 * transcript calificable NUNCA puede contener un comando que el alumno no
 * escribió. De ahí las tres defensas encadenadas (gate de prompt real →
 * handshake con `\r` antes del payload → descarte del eco tardío), descritas en
 * `PROBE_TIMEOUT_MS`, `looksLikePrompt` y `scrubInitEcho`. Si alguna vez hay que
 * elegir entre perder el color y arriesgar el transcript, se pierde el color.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal as TerminalIcon, AlertTriangle, RotateCw, Square } from "lucide-react";
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
import { parseV86Answer, serializeV86Answer, v86TranscriptForDisplay } from "./v86-answer";

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

/**
 * Paleta ANSI COMPLETA de xterm. WHY: los defaults de xterm para los 16 colores
 * ANSI vienen del VGA clásico (azul `#0000ee`, negro `#000`) y asumen un fondo
 * neutro; sobre este fondo `#09090b` (zinc-950) quedan apagados o directamente
 * ilegibles — el caso extremo es el azul con el que BusyBox pinta los
 * directorios en `ls`, que es justo el color que el alumno más ve.
 *
 * Se alinea a la escala de Tailwind que YA usa el resto del componente
 * (`bg-zinc-950` de fondo, `text-zinc-100` de texto, `text-amber-400` del
 * overlay de error, emerald del badge "Linux real", violet del badge "Efímero")
 * en vez de inventar hex: ANSI 0-7 = nivel 400 y bright 8-15 = nivel 300 de la
 * misma familia, que es el rango con contraste suficiente sobre near-black sin
 * quemar en texto de código pequeño (13px).
 *
 * `black` NO es `#000`: sobre zinc-950 sería invisible, y los programas TUI lo
 * usan como "dim". Se mapea a zinc-700 (visible pero apagado), y `brightBlack`
 * a zinc-500, que es el gris de comentarios/metadatos.
 */
const ANSI_THEME = {
  background: "#09090b", // zinc-950 (igual que el `bg-zinc-950` del contenedor)
  foreground: "#f4f4f5", // zinc-100
  cursor: "#6ee7b7", // emerald-300
  cursorAccent: "#09090b",
  selectionBackground: "#3f3f4699", // zinc-700 ~60% (legible sin tapar el texto)
  black: "#3f3f46", // zinc-700
  red: "#f87171", // red-400
  green: "#4ade80", // green-400
  yellow: "#fbbf24", // amber-400
  blue: "#60a5fa", // blue-400
  magenta: "#e879f9", // fuchsia-400
  cyan: "#22d3ee", // cyan-400
  white: "#d4d4d8", // zinc-300
  brightBlack: "#71717a", // zinc-500
  brightRed: "#fca5a5", // red-300
  brightGreen: "#86efac", // green-300
  brightYellow: "#fcd34d", // amber-300
  brightBlue: "#93c5fd", // blue-300
  brightMagenta: "#f0abfc", // fuchsia-300
  brightCyan: "#67e8f9", // cyan-300
  brightWhite: "#fafafa", // zinc-50
};

/**
 * Sentinela que cierra la ventana de inicialización del shell del guest.
 * Aparece UNA sola vez en el stream (en la SALIDA del `printf`) y nunca en el
 * eco del comando, porque en el payload se escribe partido en dos literales
 * (`"…SHELL""_READY__"`) que el shell concatena al ejecutar. Así el detector no
 * puede confundir el eco con la ejecución.
 */
const INIT_TOKEN = "__EXAMLAB_SHELL_READY__";

/**
 * Init del shell del guest (BusyBox ash). Se manda como MÁXIMO una vez por VM y
 * solo después de que el handshake confirme que alguien lee el tty (ver
 * `PROBE_TIMEOUT_MS`): un segundo envío sin confirmar podría dejar dos ecos
 * pendientes, y con eso la vigilancia del eco tardío deja de ser suficiente.
 *
 * Restricciones que explican cada decisión:
 * - **Nada de bytes ESC crudos por el serial**: el line-editing de BusyBox
 *   interpreta `\x1b[` como secuencia de teclas (flechas) y mutilaría la línea.
 *   Por eso el ESC se fabrica DENTRO del guest (`E=$(printf '\033')`) y se
 *   expande al asignar PS1 (dobles comillas ⇒ PS1 queda con ESC reales), lo que
 *   además permite `unset E` para no dejar basura en el entorno del alumno.
 * - **Nada de TAB** en el payload (el line-editing lo tomaría como
 *   autocompletado).
 * - **`\w` sí se usa**: el prompt actual (`~%`) ya expande `\w`, o sea que el
 *   FANCY_PROMPT de BusyBox está compilado. No se usa `\$` (siempre somos root)
 *   ni los marcadores bash `\[ \]` (BusyBox los imprimiría literales).
 * - **Los alias se GUARDEAN con un test de soporte**: `--color=auto` no existe
 *   en todos los builds de BusyBox; sin el guard, un `ls` roto en cada comando
 *   sería mucho peor que la falta de color.
 * - Termina en `\r` (no `\n`) porque es exactamente lo que xterm manda al pulsar
 *   Enter: el mismo camino ya probado en este setup.
 *
 * Limitación conocida y ACEPTADA: la línea queda en el historial in-memory del
 * shell (flecha arriba la muestra). BusyBox ash no tiene `HISTCONTROL` ni
 * `history -c`. Es cosmético: NO entra al transcript ni a `commandsRef`, que es
 * lo que se califica.
 */
const INIT_PAYLOAD =
  "E=$(printf '\\033'); " +
  'export PS1="${E}[1;32mroot@examlab${E}[0m:${E}[1;36m\\w${E}[0m# "; ' +
  "unset E; " +
  "ls --color=auto >/dev/null 2>&1 && alias ls='ls --color=auto'; " +
  "echo x | grep --color=auto x >/dev/null 2>&1 && alias grep='grep --color=auto'; " +
  "printf '%s\\n' \"__EXAMLAB_SHELL\"\"_READY__\"\r";

/** Silencio del serial tras el cual se evalúa si el shell está esperando input. */
const INIT_QUIET_MS = 1500;
/** Techo duro de la ventana de init: si el sentinela no llega, se aborta. */
const INIT_TIMEOUT_MS = 4000;
/**
 * Handshake OBLIGATORIO antes del payload: se manda un `\r` solo (Enter en
 * vacío) y se espera a que el guest devuelva un prompt nuevo.
 *
 * WHY existe: el silencio del serial + una cola que parece prompt siguen siendo
 * heurísticas — nada prueba que haya alguien LEYENDO el tty. Y la asimetría de
 * costos es total: un `\r` que nadie lee es inocuo (cuando el shell arranque
 * imprimirá un prompt de más, indistinguible de que el alumno pulsara Enter),
 * mientras que un PAYLOAD que nadie lee se queda en el buffer del tty y se
 * ejecuta con eco cuando el shell arranca — o sea un comando que el alumno
 * nunca escribió DENTRO de su transcript calificable. Por eso el payload solo
 * sale después de un round-trip confirmado.
 */
const PROBE_TIMEOUT_MS = 1200;
/** Espera antes de reintentar el handshake que no obtuvo respuesta. */
const INIT_RETRY_MS = 2500;
/** Tope de handshakes por VM. Agotados, se renuncia al color (la paleta queda). */
const INIT_MAX_ATTEMPTS = 3;
/**
 * Ventana de vigilancia tras abortar con el payload YA enviado: si su eco
 * aparece tarde (el shell drenó el tty después de que la ventana cerrara), se
 * descarta en vez de transcribirlo. Última defensa de la respuesta calificable.
 */
const LATE_ECHO_MS = 12000;
/**
 * Techo del descarte de un eco tardío. Mucho más corto que `INIT_TIMEOUT_MS`
 * porque acá el shell YA está leyendo el tty (acaba de ecoar): el sentinela
 * llega en milisegundos. Mientras la ventana está abierta el alumno no ve su
 * propia salida, así que se cierra rápido.
 */
const LATE_SWALLOW_MS = 1500;

/**
 * Cabeza del eco del payload. Se usa como disparador del descarte tardío porque
 * es el prefijo más largo que NO puede sufrir reflow del line-editing (10 chars,
 * muy por debajo del ancho del tty) y no aparece en salida normal de Linux.
 */
const INIT_ECHO_HEAD = "E=$(printf";

/**
 * Marcas que identifican salida del init dentro de un buffer que SÍ hay que
 * volcar (caminos de aborto): permiten descartar solo esas líneas y preservar el
 * resto de la salida real del guest.
 */
const INIT_ECHO_MARKERS = [
  INIT_ECHO_HEAD,
  "export PS1=",
  "unset E",
  "alias ls=",
  "alias grep=",
  "--color=auto",
  "__EXAMLAB_SHELL",
];

/**
 * Terminador de prompt de shell. WHY tan específico: el gate anterior aceptaba
 * "cualquier cola sin newline y corta", y los init de buildroot dejan colas
 * EXACTAMENTE así cuando se cuelgan a mitad de línea (`"Starting network: "` —
 * esta imagen no tiene red, así que udhcpc no termina nunca). Un prompt de
 * verdad termina en `%`, `#`, `$` o `>`; una línea de progreso termina en `:`,
 * `.` o `…`.
 */
const PROMPT_END_RE = /[%#$>]\s*$/;

/**
 * ¿El guest quedó esperando en un PROMPT? Heurística: v86 no expone ninguna
 * señal de "shell listo", y el silencio del serial por sí solo NO alcanza —una
 * pausa del kernel a mitad del boot también es silencio—. Lo que distingue al
 * prompt es que deja el cursor A MITAD DE LÍNEA, con pocos caracteres y
 * terminando en un símbolo de prompt.
 *
 * WHY importa: es el gate que decide si se abre el handshake. Falso positivo =
 * un `\r` de más en el tty (inocuo, ver `PROBE_TIMEOUT_MS`); falso negativo =
 * se reintenta en el próximo silencio, sin quemar el intento.
 */
function looksLikePrompt(tail: string): boolean {
  if (!tail || /[\r\n]$/.test(tail)) return false;
  const lastLine = tail.slice(tail.lastIndexOf("\n") + 1);
  if (!lastLine.trim() || lastLine.length > 60) return false;
  return PROMPT_END_RE.test(lastLine);
}

/**
 * Descarta un sufijo que sea prefijo (parcial) de `INIT_ECHO_HEAD`: cubre el eco
 * cortado a mitad de la cabeza, que todavía no tiene ninguna marca reconocible.
 */
function dropPartialHead(tail: string): string {
  for (let i = Math.min(INIT_ECHO_HEAD.length - 1, tail.length); i >= 2; i--) {
    if (tail.endsWith(INIT_ECHO_HEAD.slice(0, i))) return tail.slice(0, tail.length - i);
  }
  return tail;
}

/**
 * Vuelca un buffer de la ventana de init SIN el eco del payload: corta la línea
 * del eco (conservando el prompt que la precede) y descarta sus continuaciones,
 * pero PRESERVA todo lo demás.
 *
 * WHY: el camino de aborto anterior tiraba el buffer completo —hasta 8000 chars
 * de salida REAL del boot (banner de BusyBox, primer prompt)— y escribía solo un
 * `\r\n`, dejando al alumno con una terminal en blanco y sin prompt. Ocultar el
 * init no puede costar la salida del guest.
 */
function scrubInitEcho(buf: string): string {
  if (!buf) return "";
  let out = "";
  const pushLine = (line: string, isTail: boolean) => {
    const at = line.indexOf(INIT_ECHO_HEAD);
    if (at !== -1) {
      // Línea "prompt + eco": se conserva el prompt y se corta desde el eco. El
      // `\r\n` sintético deja el prompt como si el alumno hubiera pulsado Enter.
      const before = line.slice(0, at);
      if (before.trim()) out += isTail ? before : `${before}\r\n`;
      return;
    }
    // Continuación del eco (el line-editing puede partirlo) o salida del propio
    // init: no es del alumno ni del boot.
    if (INIT_ECHO_MARKERS.some((m) => line.includes(m))) return;
    out += isTail ? dropPartialHead(line) : line;
  };
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === "\n") {
      pushLine(buf.slice(start, i + 1), false);
      start = i + 1;
    }
  }
  if (start < buf.length) pushLine(buf.slice(start), true);
  return out;
}

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

/**
 * Fase del init del guest. `probing` = handshake `\r` en vuelo; `injecting` =
 * payload en vuelo (o eco tardío siendo tragado); `done` = terminado, sin más
 * escrituras espontáneas al guest en esta VM.
 */
type InitPhase = "idle" | "probing" | "injecting" | "done";

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
  // --- Ventana de inicialización del shell del guest (color de prompt/alias).
  // INVARIANTE 1: mientras `injectingRef` está activo, NINGÚN byte del serial
  // llega a xterm ni a `transcriptRef` (se desvían a `injectBufRef`), y NINGÚN
  // byte tecleado por el alumno se manda al VM (se encola en `queuedInputRef` y
  // se reproduce al cerrar la ventana). Así el transcript —que es la respuesta
  // calificable— no puede contener el init, y el init no puede tragarse
  // actividad del alumno.
  // INVARIANTE 2: al CERRAR la ventana, lo capturado se vuelca por
  // `scrubInitEcho` (no se descarta en bloque): del buffer solo desaparece el
  // eco del payload; la salida real del guest siempre termina en xterm y en el
  // transcript.
  // INVARIANTE 3: `initPhaseRef` llega a `"done"` únicamente cuando el shell
  // CONFIRMÓ el init (sentinela) o cuando ya se gastaron los intentos. Un
  // handshake sin respuesta vuelve a `"idle"` y reintenta: el mecanismo no puede
  // quemarse a sí mismo y dejar la consola sin color y sin salida.
  const initPhaseRef = useRef<InitPhase>("idle");
  const initAttemptsRef = useRef(0);
  const injectingRef = useRef(false);
  const injectBufRef = useRef<string>("");
  const injectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const injectDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuedInputRef = useRef<string>("");
  const userTypedRef = useRef(false);
  // Vigilancia del eco tardío (ver LATE_ECHO_MS): `lateCandRef` retiene los bytes
  // que TODAVÍA podrían ser la cabeza del eco; en cuanto divergen se sueltan.
  const lateWatchRef = useRef(false);
  const lateArmedRef = useRef(false);
  const lateCandRef = useRef<string>("");
  const lateDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined" || readOnly) return;
    let cancelled = false;
    sawOutputRef.current = false;
    // Los refs sobreviven al re-run del effect (bump de `attempt` = VM nueva),
    // así que hay que resetear el estado de la ventana de init o el reinicio se
    // quedaría sin prompt coloreado.
    initPhaseRef.current = "idle";
    initAttemptsRef.current = 0;
    injectingRef.current = false;
    injectBufRef.current = "";
    queuedInputRef.current = "";
    userTypedRef.current = false;
    lateWatchRef.current = false;
    lateArmedRef.current = false;
    lateCandRef.current = "";

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
          theme: ANSI_THEME,
        });
        term.open(termHostRef.current);
        termRef.current = term;

        const emulator = new V86(bootConfig);
        emulatorRef.current = emulator;

        // Input REAL del alumno → serial del VM + captura de comandos. Extraído
        // del `onData` para poder REPRODUCIRLO tal cual si llegó encolado
        // durante la ventana de init (mismo camino ⇒ misma captura de comandos).
        const handleUserData = (data: string) => {
          userTypedRef.current = true;
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
        };

        // Único camino de escritura a xterm + transcript: ambos derivan del
        // MISMO stream y en el mismo orden (el docente revisa el transcript
        // creyendo que es lo que el alumno vio).
        const writeOut = (s: string) => {
          if (!s) return;
          term.write(s);
          transcriptRef.current += s;
          if (transcriptRef.current.length > 260_000) {
            transcriptRef.current = transcriptRef.current.slice(-200_000);
          }
          scheduleEmit();
          scheduleInit();
        };

        const closeInitWindow = () => {
          injectingRef.current = false;
          injectBufRef.current = "";
          if (injectDeadlineRef.current) {
            clearTimeout(injectDeadlineRef.current);
            injectDeadlineRef.current = null;
          }
        };

        const replayQueuedInput = () => {
          const queued = queuedInputRef.current;
          queuedInputRef.current = "";
          if (queued) handleUserData(queued);
        };

        /**
         * Arma la vigilancia del eco tardío. Se arma UNA sola vez por VM y solo
         * en el camino que la necesita (payload enviado + ventana abortada);
         * como el payload nunca se manda dos veces sin confirmación, no puede
         * quedar más de un eco pendiente.
         */
        const armLateWatch = () => {
          if (lateArmedRef.current) return;
          lateArmedRef.current = true;
          lateWatchRef.current = true;
          lateCandRef.current = "";
          lateDeadlineRef.current = setTimeout(() => disarmLateWatch(), LATE_ECHO_MS);
        };

        const disarmLateWatch = () => {
          if (!lateWatchRef.current) return;
          lateWatchRef.current = false;
          if (lateDeadlineRef.current) {
            clearTimeout(lateDeadlineRef.current);
            lateDeadlineRef.current = null;
          }
          const held = lateCandRef.current;
          lateCandRef.current = "";
          writeOut(held); // lo retenido era salida del guest: no se pierde
        };

        /**
         * Cierra la ventana con el init CONFIRMADO. `rest` = bytes emitidos
         * DESPUÉS del sentinela (el prompt nuevo ya coloreado); lo anterior es
         * eco + salida del propio init.
         */
        const finishInitOk = (rest: string) => {
          if (!injectingRef.current) return;
          closeInitWindow();
          initPhaseRef.current = "done";
          // El eco nunca se pintó, así que el cursor sigue en el prompt viejo:
          // el salto evita que el prompt nuevo se le pegue.
          writeOut(`\r\n${rest}`);
          replayQueuedInput();
        };

        /**
         * Aborta la ventana. `kind` decide lo DOS puntos delicados:
         * - `"probe"`: el payload todavía no salió ⇒ nada que ocultar, se vuelca
         *   el buffer VERBATIM y la fase vuelve a `idle` para reintentar (no se
         *   quema el intento por una pausa del boot).
         * - `"payload"`: el payload ya salió ⇒ se vuelca sin su eco y se cierra
         *   el init (no se manda un segundo payload nunca), dejando armada la
         *   vigilancia del eco tardío.
         */
        const abortInit = (kind: "probe" | "payload") => {
          if (!injectingRef.current) return;
          const buf = injectBufRef.current;
          closeInitWindow();
          if (kind === "probe") {
            initPhaseRef.current = "idle";
            writeOut(buf);
            replayQueuedInput();
            scheduleInit(INIT_RETRY_MS);
            return;
          }
          initPhaseRef.current = "done";
          const kept = scrubInitEcho(buf);
          // Si se cortó algo, el cursor quedó en el prompt viejo (el eco no se
          // pintó): hace falta el salto, salvo que lo volcado ya empiece con uno.
          const needsBreak = kept !== buf && !/^[\r\n]/.test(kept);
          writeOut(needsBreak ? `\r\n${kept}` : kept);
          armLateWatch();
          replayQueuedInput();
        };

        /**
         * Eco tardío detectado: se reabre la ventana para tragarse la línea del
         * eco y la salida del init (hasta el sentinela) SIN mandar nada al
         * guest. Si el sentinela no llega, el aborto vuelca lo capturado por
         * `scrubInitEcho`, así que tampoco acá se pierde salida real.
         */
        const swallowLateEcho = () => {
          initPhaseRef.current = "injecting";
          injectingRef.current = true;
          injectBufRef.current = INIT_ECHO_HEAD; // lo retenido pertenece al eco
          injectDeadlineRef.current = setTimeout(() => abortInit("payload"), LATE_SWALLOW_MS);
        };

        const sendInitPayload = () => {
          initPhaseRef.current = "injecting";
          injectBufRef.current = "";
          if (injectDeadlineRef.current) clearTimeout(injectDeadlineRef.current);
          injectDeadlineRef.current = setTimeout(() => abortInit("payload"), INIT_TIMEOUT_MS);
          try {
            emulator.serial0_send(INIT_PAYLOAD);
          } catch {
            abortInit("payload");
          }
        };

        /**
         * Abre el handshake (ver `PROBE_TIMEOUT_MS`). Los dos rechazos que NO
         * marcan `done` —alumno sin teclear todavía y gate de prompt— dejan la
         * fase en `idle` a propósito: el próximo silencio reintenta.
         */
        const startProbe = () => {
          if (cancelled || initPhaseRef.current !== "idle" || injectingRef.current) return;
          // El alumno ya empezó a trabajar: no interferir con su sesión.
          if (userTypedRef.current) {
            initPhaseRef.current = "done";
            return;
          }
          if (initAttemptsRef.current >= INIT_MAX_ATTEMPTS) {
            initPhaseRef.current = "done";
            return;
          }
          // Silencio pero SIN prompt a la vista (pausa o cuelgue del boot):
          // salir sin gastar intento.
          if (!looksLikePrompt(transcriptRef.current)) return;
          initAttemptsRef.current += 1;
          initPhaseRef.current = "probing";
          injectingRef.current = true;
          injectBufRef.current = "";
          injectDeadlineRef.current = setTimeout(() => abortInit("probe"), PROBE_TIMEOUT_MS);
          try {
            emulator.serial0_send("\r");
          } catch {
            abortInit("probe");
          }
        };

        // El init se dispara cuando el serial lleva `INIT_QUIET_MS` en silencio:
        // eso es la evidencia (débil, de ahí el handshake) de que el kernel
        // terminó de loguear — no hay señal explícita de "shell up".
        const scheduleInit = (delay = INIT_QUIET_MS) => {
          if (initPhaseRef.current !== "idle") return;
          if (initAttemptsRef.current >= INIT_MAX_ATTEMPTS) return;
          if (injectTimerRef.current) clearTimeout(injectTimerRef.current);
          injectTimerRef.current = setTimeout(() => startProbe(), delay);
        };

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

          // Ventana de init: el eco de INIT_PAYLOAD y su salida se desvían a un
          // buffer PRIVADO. No se pintan (el alumno no ve un comando que no
          // escribió) ni se acumulan en el transcript hasta filtrarse al cerrar.
          if (injectingRef.current) {
            injectBufRef.current += ch;
            if (initPhaseRef.current === "probing") {
              // ACK del handshake: el guest devolvió un prompt ⇒ hay alguien
              // LEYENDO el tty. Solo entonces sale el payload.
              if (looksLikePrompt(injectBufRef.current)) sendInitPayload();
              else if (injectBufRef.current.length > 4000) abortInit("probe");
              return;
            }
            const at = injectBufRef.current.indexOf(INIT_TOKEN);
            if (at !== -1) {
              const nl = injectBufRef.current.indexOf("\n", at + INIT_TOKEN.length);
              if (nl !== -1) finishInitOk(injectBufRef.current.slice(nl + 1));
            } else if (injectBufRef.current.length > 8000) {
              // Salida inesperadamente ruidosa: abortar en vez de seguir tragando.
              abortInit("payload");
            }
            return;
          }

          // Vigilancia del eco tardío: se RETIENEN los bytes mientras puedan ser
          // la cabeza del eco y se sueltan en cuanto divergen (a lo sumo 10
          // chars de retención, sin latencia perceptible). Es la última defensa
          // contra un comando fantasma en el transcript calificable.
          if (lateWatchRef.current) {
            const cand = lateCandRef.current + ch;
            if (cand === INIT_ECHO_HEAD) {
              // Puede ser el eco del ALUMNO tecleando lo mismo. Sus pulsaciones
              // se capturan en `cmdBufRef`, así que el caso se distingue sin
              // ambigüedad: si es suyo, su salida NO se toca.
              if (cmdBufRef.current.includes(INIT_ECHO_HEAD)) {
                lateCandRef.current = "";
                writeOut(cand);
                return;
              }
              lateCandRef.current = "";
              disarmLateWatch();
              swallowLateEcho();
              return;
            }
            if (INIT_ECHO_HEAD.startsWith(cand)) {
              lateCandRef.current = cand;
              return;
            }
            const held = lateCandRef.current;
            lateCandRef.current = INIT_ECHO_HEAD.startsWith(ch) ? ch : "";
            writeOut(held);
            if (lateCandRef.current) return;
          }

          writeOut(ch);
        });

        // Input del usuario (xterm) → serial del VM + captura de comandos.
        // Durante la ventana de init se ENCOLA (no se manda ni se registra) para
        // que el eco del alumno no caiga en el buffer que se va a descartar.
        term.onData((data) => {
          if (injectingRef.current) {
            if (queuedInputRef.current.length < 4096) queuedInputRef.current += data;
            return;
          }
          handleUserData(data);
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
      if (injectTimerRef.current) clearTimeout(injectTimerRef.current);
      if (injectDeadlineRef.current) clearTimeout(injectDeadlineRef.current);
      if (lateDeadlineRef.current) clearTimeout(lateDeadlineRef.current);
      injectingRef.current = false;
      lateWatchRef.current = false;
      // Los bytes retenidos por la vigilancia del eco tardío son salida real del
      // guest: van al transcript antes de la emisión final (nunca a la basura).
      if (lateCandRef.current) {
        transcriptRef.current += lateCandRef.current;
        lateCandRef.current = "";
      }
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

  // Reiniciar a una sesión LIMPIA: descarta el transcript/comandos acumulados y
  // re-bootea una VM fresca (bump de `attempt` → el effect corre de nuevo). Deja
  // explícito el carácter EFÍMERO del sandbox (nada persiste entre sesiones).
  const restartConsole = () => {
    transcriptRef.current = "";
    commandsRef.current = [];
    cmdBufRef.current = "";
    onChange?.(serializeV86Answer({ transcript: "", commands: [] }));
    setAttempt((a) => a + 1);
  };

  // Ctrl+C sin teclado. WHY existe el botón: el banner de BusyBox invita a correr
  // `udhcpc`, que en un sandbox SIN red imprime "broadcasting discover" para
  // siempre; en móvil (sin tecla Ctrl) o si xterm perdió el foco, el alumno no
  // tenía forma de cortar salvo "Reiniciar", que BORRA el transcript — es decir,
  // su respuesta calificable.
  const sendInterrupt = () => {
    try {
      emulatorRef.current?.serial0_send("\x03");
    } catch {
      /* noop */
    }
    // El shell descarta la línea a medio escribir al recibir Ctrl+C: el buffer
    // de captura de comandos debe reflejar eso o registraría un comando abortado.
    cmdBufRef.current = "";
    termRef.current?.focus();
  };

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
          {/* `v86TranscriptForDisplay` y NO `parsed.transcript`: el crudo trae los
              escapes ANSI del color y esto es un <pre>, no xterm — se verían
              literales (`ESC[1;32mroot@examlab…`). Esta vista la lee el ALUMNO en
              la hoja de consola de una pizarra, no solo el docente. El helper
              además colapsa los  de reescritura de línea. */}
          {v86TranscriptForDisplay(value)?.trim() ||
            t("serverConsole.transcriptEmpty", { defaultValue: "(sin actividad en la consola)" })}
        </pre>
      </div>
    );
  }

  return (
    // `flex flex-col` + header `shrink-0` encadenan la altura: cuando el padre
    // impone una altura definida (hoja de pizarra), el área de terminal recibe
    // solo el espacio que sobra y scrollea dentro de sí misma en vez de quedar
    // recortada por este `overflow-hidden` (que está acá para que el borde
    // redondeado recorte el fondo negro).
    <div className={`relative flex flex-col rounded-md border overflow-hidden ${className ?? ""}`}>
      <div className="bg-muted/40 px-3 py-2 text-xs shrink-0">
        <div className="flex items-center gap-1.5 font-medium">
          <TerminalIcon className="h-3.5 w-3.5" />
          {t("serverConsole.title", { defaultValue: "Consola del servidor (Linux)" })}
          {status === "ready" && (
            <span className="ml-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-3xs font-medium text-emerald-500">
              {t("serverConsole.liveBadge", { defaultValue: "Linux real" })}
            </span>
          )}
          {/* Sandbox efímero: refuerza que corre en el navegador y no toca
              infraestructura real. Se muestra siempre (no solo cuando ready). */}
          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-3xs font-medium text-violet-500">
            {t("serverConsole.ephemeralBadge", { defaultValue: "Efímero" })}
          </span>
          {/* Interrumpir (Ctrl+C) + Reiniciar → sesión limpia (nueva VM efímera).
              Solo en modo edición (readOnly = revisión, no hay VM viva). */}
          {!readOnly && status === "ready" && (
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={sendInterrupt}
                title={t("serverConsole.interruptTitle", {
                  defaultValue: "Interrumpir el comando en ejecución (envía Ctrl+C)",
                })}
                aria-label={t("serverConsole.interruptTitle", {
                  defaultValue: "Interrumpir el comando en ejecución (envía Ctrl+C)",
                })}
                className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground hover:bg-muted"
              >
                <Square className="h-3 w-3" />
                {t("serverConsole.interrupt", { defaultValue: "Interrumpir" })}
              </button>
              <button
                type="button"
                onClick={restartConsole}
                title={t("serverConsole.restartTitle", {
                  defaultValue: "Reiniciar con una sesión limpia",
                })}
                className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-3xs font-medium text-muted-foreground hover:bg-muted"
              >
                <RotateCw className="h-3 w-3" />
                {t("serverConsole.restart", { defaultValue: "Reiniciar" })}
              </button>
            </div>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5">
          {t("serverConsole.hintV86", {
            defaultValue:
              "Linux real en tu navegador: un entorno de práctica efímero y aislado donde cada sesión arranca limpia y nada afecta a un servidor real.",
          })}
        </p>
        {/* Guía de comandos: el sistema es un Linux MÍNIMO (BusyBox), sin gestor
            de paquetes ni red. Los alumnos vienen con reflejos de Ubuntu
            (sudo/apt/pip) que NO aplican acá → esta ayuda aclara qué usar. */}
        <details className="mt-1.5 group">
          <summary className="cursor-pointer text-2xs font-medium text-muted-foreground hover:text-foreground">
            {t("serverConsole.helpTitle", { defaultValue: "¿Qué comandos funcionan aquí?" })}
          </summary>
          <ul className="mt-1 space-y-0.5 text-2xs text-muted-foreground list-disc pl-4">
            <li>{t("serverConsole.helpRoot", { defaultValue: "Ya eres root: no uses sudo." })}</li>
            <li>
              {t("serverConsole.helpOffline", {
                defaultValue:
                  "Sandbox aislado sin internet: apt, apk y pip install no funcionan (no hay de dónde bajar paquetes).",
              })}
            </li>
            <li>
              {t("serverConsole.helpNoNetwork", {
                defaultValue:
                  "Sin red: los comandos que esperan internet (udhcpc, ping, wget) se quedan esperando — córtalos con Ctrl+C o el botón Interrumpir.",
              })}
            </li>
            <li>
              {t("serverConsole.helpCommands", {
                defaultValue:
                  "Es un Linux mínimo (BusyBox). Funcionan: ls, cd, pwd, cat, echo, mkdir, rm, cp, mv, touch, vi, grep, sed, awk, find, chmod, ps, wc, head, tail, tar, mount, y scripts de shell (pipes | y redirecciones > incluidos).",
              })}
            </li>
            <li>
              {t("serverConsole.helpLanguages", {
                defaultValue:
                  "¿Necesitas Python, Java o JavaScript? Usa una hoja de Código: ejecuta el lenguaje de verdad.",
              })}
            </li>
          </ul>
        </details>
      </div>

      {/* `min-h-0` deja que este bloque SE ENCOJA por debajo de su contenido
          (xterm mide rows×cols fijos, ~500px) cuando el padre acota la altura. */}
      <div className="relative min-h-0 bg-zinc-950">
        {/* Solo scroll HORIZONTAL acá: xterm se instancia con `rows: 30` fijo y
            sin FitAddon, así que su alto es intrínseco (~470px) y no se adapta.
            Un techo vertical (`max-h`) crea un segundo scroller por fuera del
            `.xterm-viewport` — y como el viewport es `absolute inset-0` sobre los
            470px completos, no sabe del recorte: la rueda la consume él (siempre
            está al fondo, porque cada byte auto-scrollea) y la fila 30, donde
            queda el prompt tras el boot, se vuelve inalcanzable. La terminal se
            ve como un rectángulo negro congelado. El scroll vertical lo da el
            contenedor de la hoja (`overflow-auto` en el track + `min-h-full` en
            el bloque); acá solo hace falta poder panear las 100 columnas en
            móvil.
            WHY el piso condicional: antes de que xterm monte (loading/booting/
            error) el host está vacío y sin `min-h` colapsaría a 0px, dejando los
            overlays `absolute inset-0` sin alto visible. */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
        <div
          ref={termHostRef}
          onClick={() => termRef.current?.focus()}
          className={`overflow-x-auto p-2 cursor-text${
            status === "ready" ? "" : " min-h-72"
          }`}
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
            {error && <span className="text-2xs text-zinc-400 max-w-md break-words">{error}</span>}
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
            <span className="text-2xs text-zinc-500 max-w-md">
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
