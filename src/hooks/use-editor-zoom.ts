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
 * ── Hidratación (React #418) ──────────────────────────────────────────
 * NO se lee localStorage en el initializer de `useState`: el HTML
 * pre-renderizado no tiene storage, así que arranca determinístico en 1 y el
 * valor real se aplica post-mount. La escritura vive DENTRO del handler (no en
 * un effect reactivo), así no hace falta la bandera `hydrated` que
 * `use-pagination` necesitó para no pisar el valor guardado en el primer commit.
 */
const STORAGE_KEY = "examlab_editor_zoom";
/** Clave de cuando el zoom vivía solo en SQL. Se lee una vez, no se escribe. */
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

export function useEditorZoom() {
  const [zoom, setZoom] = useState(EDITOR_ZOOM_MIN);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY);
      if (raw !== null) setZoom(clampEditorZoom(raw));
    } catch {
      /* SSR / storage deshabilitado */
    }
  }, []);

  const apply = useCallback((next: number) => {
    const v = clampEditorZoom(next);
    setZoom(v);
    try {
      localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
      /* no-op */
    }
  }, []);

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
