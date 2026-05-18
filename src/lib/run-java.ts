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
  cheerpjCreateDisplay?: (
    width: number,
    height: number,
    container?: HTMLElement,
  ) => void;
  cheerpjRunMain?: (cls: string, cp: string, ...args: string[]) => Promise<number>;
  cheerpOSAddStringFile?: (path: string, contents: Uint8Array) => void;
  cheerpjAddStringFile?: (path: string, contents: Uint8Array) => void;
  __cheerpjLoading?: Promise<void>;
  __cheerpjReady?: boolean;
  __toolsJarLoading?: Promise<Uint8Array>;
  __toolsJarBytes?: Uint8Array;
  __cheerpjConsoleDisplay?: HTMLElement;
};
const w = window as CheerpJWindow;

function loadCheerpJ(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  if (w.__cheerpjReady) return Promise.resolve();
  if (w.__cheerpjLoading) return w.__cheerpjLoading;

  const p = new Promise<void>((resolve, reject) => {
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
  // Si la carga falla (CDN caído, AdBlock bloqueando, red intermitente),
  // limpiamos el cache para que el siguiente intento reintente desde
  // cero. Sin esto, una falla transitoria deja al alumno sin poder
  // ejecutar nada hasta que recargue la página completa.
  p.catch(() => {
    if (w.__cheerpjLoading === p) w.__cheerpjLoading = undefined;
  });
  w.__cheerpjLoading = p;
  return p;
}

function loadToolsJar(): Promise<Uint8Array> {
  if (w.__toolsJarBytes) return Promise.resolve(w.__toolsJarBytes);
  if (w.__toolsJarLoading) return w.__toolsJarLoading;
  const p = (async () => {
    const r = await fetch(TOOLS_JAR_URL);
    if (!r.ok) throw new Error(`No se pudo descargar tools.jar (${r.status})`);
    const buf = await r.arrayBuffer();
    const bytes = new Uint8Array(buf);
    w.__toolsJarBytes = bytes;
    return bytes;
  })();
  // Misma idea que loadCheerpJ: una falla transitoria no debe envenenar
  // el cache para el resto de la sesión.
  p.catch(() => {
    if (w.__toolsJarLoading === p) w.__toolsJarLoading = undefined;
  });
  w.__toolsJarLoading = p;
  return p;
}

export function deriveMainClass(source: string): string {
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
 * Espera a que el DOM aplique los writes pendientes a textContent.
 * CheerpJ escribe a `<pre id="console">` durante la ejecución mediante
 * múltiples eventos del runtime; aunque `cheerpjRunMain` ya resolvió,
 * los últimos chunks pueden quedar en cola del scheduler. Sin esto, a
 * veces leemos textContent vacío y el alumno ve "(sin salida)" cuando
 * sí imprimió algo.
 */
function flushDom(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/**
 * Carrera entre el promise de ejecución y un timeout. Para bucles
 * infinitos en código de alumno: sin esto el botón "Ejecutar" queda
 * deshabilitado para siempre y el único recurso es recargar.
 *
 * Limitación: NO matamos la JVM. CheerpJ no expone una API para
 * cancelar; el thread sigue ejecutándose en el web worker hasta que
 * salga del bucle o el navegador lo mate por unresponsive. Pero al
 * menos liberamos el UI y el alumno puede editar y reintentar.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Tiempo de ejecución excedido (${ms / 1000}s). ¿Bucle infinito?`)),
      ms,
    );
  });
  try {
    return (await Promise.race([p, timeoutPromise])) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DEFAULT_RUN_TIMEOUT_MS = 30_000;

/**
 * Toma el control del id="console" temporalmente. Devuelve una función
 * para liberarlo. Si otro elemento ya tenía ese id (p.ej. una ventana
 * de JavaGuiRunner que lo dejó marcado), le quitamos el id mientras
 * dura nuestra ejecución y se lo restauramos al terminar.
 *
 * BUG fix: antes hacíamos `target.removeAttribute("id")` al liberar, lo
 * que dejaba al target sin SU id original (`__cj_run_console`). En la
 * siguiente ejecución, `ensureHiddenConsole` no lo encontraba y creaba
 * un pre nuevo, dejando el viejo huérfano en el DOM con texto residual
 * del run anterior. Si CheerpJ mantenía una referencia cacheada al
 * viejo elemento, escribía ahí y `consoleEl.textContent` del nuevo
 * leía vacío, pero el render acumulado mostraba ambos. Ahora preservamos
 * el id original al liberar.
 */
function claimConsole(target: HTMLElement): () => void {
  const originalTargetId = target.id;
  const previous = document.getElementById("console");
  if (previous && previous !== target) {
    previous.removeAttribute("id");
    previous.dataset.cjPrevConsole = "1";
  }
  target.id = "console";
  return () => {
    // Restauramos el id original del target (no lo dejamos sin id).
    if (originalTargetId) {
      target.id = originalTargetId;
    } else {
      target.removeAttribute("id");
    }
    if (previous && previous.dataset.cjPrevConsole === "1") {
      delete previous.dataset.cjPrevConsole;
      previous.id = "console";
    }
  };
}

function ensureHiddenConsole(): HTMLPreElement {
  // Defense-in-depth: limpia cualquier pre huérfano que pueda haber
  // quedado de versiones anteriores con el bug de claimConsole. Si
  // detectamos múltiples `__cj_run_console` (no debería ocurrir pero
  // sí ocurría antes), nos quedamos con uno y eliminamos los demás.
  const all = document.querySelectorAll<HTMLPreElement>("pre#__cj_run_console");
  if (all.length > 1) {
    for (let i = 1; i < all.length; i++) all[i].remove();
  }
  const existing = document.getElementById("__cj_run_console");
  if (existing instanceof HTMLPreElement) {
    // Limpia el buffer SIEMPRE al obtenerlo — garantiza que cada
    // run arranque con un buffer vacío sin depender de quién haga
    // el `.textContent = ""` en el caller.
    existing.textContent = "";
    return existing;
  }
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

/**
 * Aunque el código del usuario sea console-only, ciertos paths del JDK
 * tocan AWT Toolkit (initialización estática, java.awt.Toolkit$2.run en
 * el stack). Sin un display registrado CheerpJDisplay/CheerpJToolkit
 * lanzan NullPointerException al instanciarse. Mantenemos un display
 * mínimo oculto que se crea una vez por sesión.
 */
function ensureHiddenDisplay(): void {
  if (w.__cheerpjConsoleDisplay) return;
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    left: "-9999px",
    top: "-9999px",
    width: "1px",
    height: "1px",
    overflow: "hidden",
    pointerEvents: "none",
  });
  document.body.appendChild(container);
  // 100x100 mínimo: con 1x1 algunas implementaciones de Swing/AWT
  // tampoco arrancan. 100x100 es seguro y sigue oculto.
  w.cheerpjCreateDisplay?.(100, 100, container);
  w.__cheerpjConsoleDisplay = container;
}

export async function runJavaInBrowser(sourceCode: string): Promise<JavaExecutionResult> {
  const start = Date.now();
  await loadCheerpJ();
  ensureHiddenDisplay();

  const consoleEl = ensureHiddenConsole();
  consoleEl.textContent = "";

  const release = claimConsole(consoleEl);
  try {
    const className = deriveMainClass(sourceCode);
    const sourcePath = `/str/${className}.java`;
    const enc = new TextEncoder();
    const addFile = w.cheerpOSAddStringFile ?? w.cheerpjAddStringFile;
    if (typeof addFile !== "function") {
      throw new Error("CheerpJ no expone AddStringFile (carga incompleta)");
    }
    if (typeof w.cheerpjRunMain !== "function") {
      throw new Error("CheerpJ no expone runMain (carga incompleta)");
    }
    addFile(sourcePath, enc.encode(sourceCode));

    const toolsBytes = await loadToolsJar();
    addFile("/str/tools.jar", toolsBytes);

    const classPath = "/str/tools.jar:/files/";

    // Compilar — con timeout. javac suele tardar <2s pero la primera
    // vez (warm-up de la JVM + class loading) puede ir a 5-10s. 30s
    // es holgado y aún detecta cuelgues reales.
    const compileExit = await withTimeout(
      w.cheerpjRunMain(
        "com.sun.tools.javac.Main",
        classPath,
        sourcePath,
        "-d",
        "/files/",
      ),
      DEFAULT_RUN_TIMEOUT_MS,
    );
    await flushDom();
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

    const runExit = await withTimeout(
      w.cheerpjRunMain(className, classPath),
      DEFAULT_RUN_TIMEOUT_MS,
    );
    await flushDom();
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
