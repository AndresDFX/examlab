/**
 * Ejecuta código Java en el browser vía CheerpJ — reemplazo client-side
 * del path Java de la edge function `execute-code` (que dependía de
 * JDoodle, con cuota de 20 ejecuciones/día compartidas).
 *
 * Comparte estado vía window globals con JavaGuiRunner (singleton del
 * loader y de tools.jar): si el alumno ya abrió un ejercicio Swing o si
 * ya hay tools.jar cacheado en memoria, el primer "Ejecutar" en una
 * pregunta de código no vuelve a bajar nada.
 *
 * stdout/stderr se capturan leyendo el elemento DOM con id="console"
 * que CheerpJ usa implícitamente como destino de System.out/err. Para
 * no chocar con la ventana visible de JavaGuiRunner ni mezclar buffers
 * entre runners, mantenemos un <pre id="__cj_run_console"> oculto y
 * SOLO le ponemos id="console" mientras corre la compilación/ejecución.
 */
const CHEERPJ_SRC = "https://cjrtnc.leaningtech.com/4.3/loader.js";
const TOOLS_JAR_URL = "/tools.jar";

// Las declaraciones globales de cheerpj* y __cheerpj/__toolsJar* viven
// en JavaGuiRunner.tsx (el primero que las introdujo). No las repetimos
// aquí para no chocar con TS2717 "Subsequent property declarations".
// Solo nos referimos a window con un cast donde haga falta.
type CheerpJWindow = Window & {
  cheerpjInit?: (opts?: { status?: string }) => Promise<void>;
  cheerpjRunMain?: (cls: string, cp: string, ...args: string[]) => Promise<number>;
  cheerpOSAddStringFile?: (path: string, contents: Uint8Array) => void;
  cheerpjAddStringFile?: (path: string, contents: Uint8Array) => void;
  __cheerpjLoading?: Promise<void>;
  __cheerpjReady?: boolean;
  __toolsJarLoading?: Promise<Uint8Array>;
  __toolsJarBytes?: Uint8Array;
};
const w = window as CheerpJWindow;

function loadCheerpJ(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  if (w.__cheerpjReady) return Promise.resolve();
  if (w.__cheerpjLoading) return w.__cheerpjLoading;

  w.__cheerpjLoading = new Promise<void>((resolve, reject) => {
    const ready = async () => {
      try {
        if (typeof w.cheerpjInit !== "function") {
          throw new Error("CheerpJ no expuso cheerpjInit");
        }
        await w.cheerpjInit({ status: "none" });
        w.__cheerpjReady = true;
        resolve();
      } catch (e) {
        reject(e);
      }
    };
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${CHEERPJ_SRC}"]`,
    );
    if (existing) {
      if (w.cheerpjInit) void ready();
      else existing.addEventListener("load", ready, { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("No se pudo cargar CheerpJ")),
        { once: true },
      );
      return;
    }
    const s = document.createElement("script");
    s.src = CHEERPJ_SRC;
    s.async = true;
    s.onload = ready;
    s.onerror = () => reject(new Error("No se pudo cargar CheerpJ"));
    document.head.appendChild(s);
  });
  return w.__cheerpjLoading;
}

function loadToolsJar(): Promise<Uint8Array> {
  if (w.__toolsJarBytes) return Promise.resolve(w.__toolsJarBytes);
  if (w.__toolsJarLoading) return w.__toolsJarLoading;
  w.__toolsJarLoading = (async () => {
    const r = await fetch(TOOLS_JAR_URL);
    if (!r.ok) throw new Error(`No se pudo descargar tools.jar (${r.status})`);
    const buf = await r.arrayBuffer();
    const bytes = new Uint8Array(buf);
    w.__toolsJarBytes = bytes;
    return bytes;
  })();
  return w.__toolsJarLoading;
}

function deriveMainClass(source: string): string {
  const m = source.match(/public\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
  return m ? m[1] : "Main";
}

export interface JavaExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionTimeMs: number;
}

/**
 * Toma el control del id="console" temporalmente. Devuelve una función
 * para liberarlo. Si otro elemento ya tenía ese id (p.ej. una ventana
 * de JavaGuiRunner que lo dejó marcado), le quitamos el id mientras
 * dura nuestra ejecución y se lo restauramos al terminar.
 */
function claimConsole(target: HTMLElement): () => void {
  const previous = document.getElementById("console");
  if (previous && previous !== target) {
    previous.removeAttribute("id");
    previous.dataset.cjPrevConsole = "1";
  }
  target.id = "console";
  return () => {
    target.removeAttribute("id");
    if (previous && previous.dataset.cjPrevConsole === "1") {
      delete previous.dataset.cjPrevConsole;
      previous.id = "console";
    }
  };
}

function ensureHiddenConsole(): HTMLPreElement {
  const existing = document.getElementById("__cj_run_console");
  if (existing instanceof HTMLPreElement) return existing;
  const el = document.createElement("pre");
  el.id = "__cj_run_console";
  Object.assign(el.style, {
    position: "fixed",
    left: "-9999px",
    top: "-9999px",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    whiteSpace: "pre-wrap",
  });
  document.body.appendChild(el);
  return el;
}

export async function runJavaInBrowser(sourceCode: string): Promise<JavaExecutionResult> {
  const start = Date.now();
  await loadCheerpJ();

  const consoleEl = ensureHiddenConsole();
  consoleEl.textContent = "";

  const release = claimConsole(consoleEl);
  try {
    const className = deriveMainClass(sourceCode);
    const sourcePath = `/str/${className}.java`;
    const enc = new TextEncoder();
    const addFile = w.cheerpOSAddStringFile ?? w.cheerpjAddStringFile;
    if (!addFile) throw new Error("CheerpJ AddStringFile no disponible");
    addFile(sourcePath, enc.encode(sourceCode));

    const toolsBytes = await loadToolsJar();
    addFile("/str/tools.jar", toolsBytes);

    const classPath = "/str/tools.jar:/files/";

    // Compilar
    const compileExit = await w.cheerpjRunMain?.(
      "com.sun.tools.javac.Main",
      classPath,
      sourcePath,
      "-d",
      "/files/",
    );
    if (compileExit !== 0) {
      const compileLog = consoleEl.textContent ?? "";
      return {
        stdout: "",
        stderr: compileLog || "Error de compilación",
        exitCode: compileExit ?? 1,
        executionTimeMs: Date.now() - start,
      };
    }

    // Reset buffer entre compilación y ejecución para que stderr sea solo runtime
    consoleEl.textContent = "";

    const runExit = await w.cheerpjRunMain?.(className, classPath);
    const runtimeLog = consoleEl.textContent ?? "";

    if (runExit === 0) {
      return {
        stdout: runtimeLog,
        stderr: "",
        exitCode: 0,
        executionTimeMs: Date.now() - start,
      };
    }
    return {
      stdout: "",
      stderr: runtimeLog || "Error en ejecución",
      exitCode: runExit ?? 1,
      executionTimeMs: Date.now() - start,
    };
  } finally {
    release();
  }
}
