/**
 * Estado de carga del editor de código (Monaco), compartido por toda la sesión.
 *
 * ── Por qué no alcanza con la prop `loading` de `<Editor>` ────────────
 *
 * `@monaco-editor/react` inicializa así (`dist/index.mjs`):
 *
 *     loader.init().then(m => (ref.current = m) && setLoading(false))
 *                  .catch(e => e?.type !== "cancelation" && console.error(...))
 *
 * O sea: **si la carga falla, solo escribe en la consola**. `isEditorReady`
 * queda en `false` para siempre y el componente sigue pintando su nodo
 * `loading` —por defecto el literal `"Loading..."`, sin traducir— sin decir que
 * pasó nada. En una pregunta `bd_sql` eso NO es un detalle estético: esa caja es
 * el único lugar donde se puede responder, así que la pregunta se vuelve
 * incontestable y el alumno solo ve «Loading...» hasta que se acaba el examen.
 *
 * Con la carga en nuestras manos sabemos si está pendiente, si llegó o si falló,
 * y podemos ofrecer la caja de texto plano.
 *
 * ── El TIEMPO es el caso importante, no el error ──────────────────────
 *
 * El loader solo rechaza cuando el `<script>` de `loader.js` dispara `onerror`
 * (404, dominio bloqueado, sin red). Una red LENTA no rechaza nunca: se queda
 * cargando. Y esa es justamente la situación de un salón — por eso `lento` (un
 * plazo) importa más que `estado === "error"`, y es lo que destraba al alumno.
 *
 * ── Por qué NO hay «Reintentar» ───────────────────────────────────────
 *
 * `loader.init()` marca `isInitialized: true` en la primera llamada y devuelve
 * SIEMPRE la misma promesa (`wrapperPromise`, creada una vez con su `resolve` /
 * `reject` capturados). Después de un rechazo, volver a llamarlo entrega esa
 * misma promesa ya rechazada: un botón «Reintentar» fallaría al instante,
 * siempre, y parecería roto. La salida real es la caja de texto.
 */

import { useEffect, useState } from "react";
import { loader } from "@monaco-editor/react";

export type EstadoMonaco = "cargando" | "listo" | "error";

/** Por qué se está escribiendo en la caja de texto en vez del editor. */
export type MotivoTextoPlano = "manual" | "lento" | "error";

/**
 * ¿Hay que pasar a la caja de texto sin que nadie lo pida?
 *
 * PURO para poder fijarlo con tests, porque tiene dos trampas que no se ven:
 *
 * 1. **Una vez elegido, no se cambia.** Quien pidió escribir a mano no puede
 *    quedarse sin su caja porque el editor llegó tarde, y quien está escribiendo
 *    no puede perder el foco a mitad de una consulta.
 * 2. **Con el editor ya disponible no se cambia NUNCA solo**, ni siquiera si el
 *    plazo se había cumplido antes. Sin esa condición, pulsar «Usar el editor»
 *    después de una espera larga devolvía `null` y el efecto volvía a poner
 *    «lento» en el acto: el botón parecía no hacer nada.
 */
export function decidirModoTexto(
  actual: MotivoTextoPlano | null,
  estado: EstadoMonaco,
  lento: boolean,
): MotivoTextoPlano | null {
  if (actual) return actual;
  if (estado === "listo") return null;
  if (estado === "error") return "error";
  return lento ? "lento" : null;
}

/** Plazo tras el cual se deja de esperar al editor y se ofrece escribir igual.
 *  8 s: con una conexión normal esto no se ve nunca (el editor llega en ~1-2 s),
 *  y con una mala evita que alguien mire una caja vacía sin saber qué hacer. */
export const ESPERA_EDITOR_MS = 8000;

/** Compartido por toda la sesión: el segundo editor no vuelve a bajar nada. */
let estadoGlobal: EstadoMonaco = "cargando";
let carga: Promise<void> | null = null;

/**
 * Arranca la carga de Monaco. Idempotente y **nunca rechaza**: el fallo se
 * registra en `estadoGlobal`. Si rechazara, un `precalentarMonaco()` sin
 * `catch` dejaría una promesa sin manejar en la consola del alumno.
 */
function iniciar(): Promise<void> {
  if (!carga) {
    carga = loader.init().then(
      () => {
        estadoGlobal = "listo";
      },
      () => {
        estadoGlobal = "error";
      },
    );
  }
  return carga;
}

/**
 * Empieza a bajar el editor sin esperarlo (dispara y olvida).
 *
 * Se llama desde la pantalla previa al examen: ver `tipos-con-editor.ts`.
 */
export function precalentarMonaco(): void {
  if (typeof window === "undefined") return;
  void iniciar();
}

/**
 * `{ estado, lento }` del editor.
 *
 * `lento` es «pasó el plazo y todavía no llegó», no un error: el editor puede
 * aparecer después, y si aparece el caller puede volver a ofrecerlo.
 */
export function useMonacoListo(esperaMs: number = ESPERA_EDITOR_MS): {
  estado: EstadoMonaco;
  lento: boolean;
} {
  // Lee el estado del módulo, no una API del navegador: la segunda pregunta SQL
  // de un examen no parpadea «cargando» si el editor ya está en memoria.
  const [estado, setEstado] = useState<EstadoMonaco>(estadoGlobal);
  const [lento, setLento] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (estadoGlobal === "listo") {
      setEstado("listo");
      return;
    }
    const temporizador = window.setTimeout(() => {
      if (!cancelled) setLento(true);
    }, esperaMs);
    void iniciar().then(() => {
      if (cancelled) return;
      setEstado(estadoGlobal);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(temporizador);
    };
  }, [esperaMs]);

  return { estado, lento };
}
