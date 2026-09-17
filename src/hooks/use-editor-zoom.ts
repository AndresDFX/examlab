import { useCallback, useEffect, useState } from "react";

/**
 * Zoom de texto de los editores de la plataforma: la hoja/pregunta de SQL y los
 * editores de CÓDIGO (el compilador de examen y taller, y los de Java y Python
 * con interfaz gráfica).
 *
 * ── Por qué es un hook y no la opción de Monaco ───────────────────────
 * Monaco tiene `mouseWheelZoom`, pero no está activado y no serviría igual: el
 * zoom tiene que aplicar también al panel de salida y al alto del editor, que
 * viven fuera de Monaco. Y un control visible se descubre; un Ctrl+rueda que
 * nadie anunció, no.
 *
 * ── UNA sola preferencia para todos los editores ──────────────────────
 * El tamaño de letra es preferencia de la PERSONA y su pantalla, no del
 * contenido (al revés del viewport de Excalidraw, que es por hoja). Así que
 * quien lo sube en la hoja de SQL lo encuentra subido en el compilador de Java:
 * tener una clave por editor obligaría a ajustarlo cinco veces.
 *
 * La clave anterior era `examlab_sql_zoom`, de cuando el zoom existía solo en
 * SQL. Se MIGRA al leer para no resetear a quien ya lo había dejado en 150 %.
 *
 * ── `scopeKey`: por qué dejó de ser UNA sola preferencia global ────────
 * La idea original era que quien lo sube en la hoja de SQL lo encuentre subido
 * en el compilador de Java, para no ajustarlo cinco veces. En la práctica eso
 * hizo que subir el zoom en el editor de código de una PIZARRA —para leer mejor
 * en el proyector— dejara el mismo zoom pegado en el compilador de un EXAMEN o
 * un TALLER, sin relación entre sí y sin que la persona lo pidiera ahí. Reporte
 * que lo originó: el zoom "queda marcado en caché en todos los lugares donde
 * hay un compilador".
 *
 * Por eso `useEditorZoom` acepta un `scopeKey` opcional: cada superficie (una
 * pregunta de examen, una de taller, una hoja de la pizarra, la consola SQL)
 * pasa su propio identificador estable y el ajuste queda SOLO ahí. Sin
 * `scopeKey` cae en la clave compartida de siempre — así un caller que no se
 * actualice no pierde su preferencia guardada ni rompe.
 *
 * ── Hidratación (React #418) ──────────────────────────────────────────
 * NO se lee localStorage en el initializer de `useState`: el HTML
 * pre-renderizado no tiene storage, así que arranca determinístico en 1 y el
 * valor real se aplica post-mount. La escritura vive DENTRO del handler (no en
 * un effect reactivo), así no hace falta la bandera `hydrated` que
 * `use-pagination` necesitó para no pisar el valor guardado en el primer commit.
 */
const STORAGE_KEY = "examlab_editor_zoom";
/** Clave de cuando el zoom vivía solo en SQL. Se lee una vez, no se escribe.
 *  Solo aplica a la preferencia COMPARTIDA (sin `scopeKey`): una superficie
 *  nueva con su propio scope nunca tuvo un valor legado que migrar. */
const LEGACY_KEY = "examlab_sql_zoom";

export const EDITOR_ZOOM_MIN = 1;
export const EDITOR_ZOOM_MAX = 2;
export const EDITOR_ZOOM_STEP = 0.25;

/** Snap al rango [1, 2] en pasos de 0.25. Basura o valor no finito → 1. */
export function clampEditorZoom(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return EDITOR_ZOOM_MIN;
  const snapped = Math.round(n / EDITOR_ZOOM_STEP) * EDITOR_ZOOM_STEP;
  return +Math.min(EDITOR_ZOOM_MAX, Math.max(EDITOR_ZOOM_MIN, snapped)).toFixed(2);
}

/**
 * Zoom de texto de un editor puntual.
 *
 * @param scopeKey Identificador estable de ESTA superficie (ej. el id de la
 *   pregunta, el id de la hoja de la pizarra). Ausente/vacío ⇒ preferencia
 *   compartida de siempre (`examlab_editor_zoom`), para no romper callers que
 *   todavía no pasan uno.
 */
export function useEditorZoom(scopeKey?: string | null) {
  const [zoom, setZoom] = useState(EDITOR_ZOOM_MIN);
  const storageKey = scopeKey ? `${STORAGE_KEY}:${scopeKey}` : STORAGE_KEY;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey) ?? (scopeKey ? null : localStorage.getItem(LEGACY_KEY));
      setZoom(raw !== null ? clampEditorZoom(raw) : EDITOR_ZOOM_MIN);
    } catch {
      /* SSR / storage deshabilitado */
    }
    // Cambiar de superficie (otra pregunta, otra hoja) tiene que releer SU
    // propia clave, no arrastrar el zoom de la anterior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const apply = useCallback(
    (next: number) => {
      const v = clampEditorZoom(next);
      setZoom(v);
      try {
        localStorage.setItem(storageKey, String(v));
      } catch {
        /* no-op */
      }
    },
    [storageKey],
  );

  return {
    zoom,
    zoomIn: () => apply(zoom + EDITOR_ZOOM_STEP),
    zoomOut: () => apply(zoom - EDITOR_ZOOM_STEP),
    reset: () => apply(EDITOR_ZOOM_MIN),
    atMin: zoom <= EDITOR_ZOOM_MIN,
    atMax: zoom >= EDITOR_ZOOM_MAX,
    pct: Math.round(zoom * 100),
  } as const;
}
