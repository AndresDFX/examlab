import { useCallback, useEffect, useState } from "react";

/** Clave única y global: el tamaño de letra es preferencia de la PERSONA y su
 *  pantalla, no del contenido (al revés del viewport de Excalidraw, que es por
 *  hoja). Mismo criterio que `examlab_assessment_maximized`. */
const STORAGE_KEY = "examlab_sql_zoom";

export const SQL_ZOOM_MIN = 1;
export const SQL_ZOOM_MAX = 2;
export const SQL_ZOOM_STEP = 0.25;

/** Snap al rango [1, 2] en pasos de 0.25. Basura o valor no finito → 1. */
export function clampSqlZoom(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return SQL_ZOOM_MIN;
  const snapped = Math.round(n / SQL_ZOOM_STEP) * SQL_ZOOM_STEP;
  return +Math.min(SQL_ZOOM_MAX, Math.max(SQL_ZOOM_MIN, snapped)).toFixed(2);
}

/**
 * Zoom de texto de las hojas/preguntas de SQL.
 *
 * Hydration-safe: NO lee localStorage en el initializer de useState (React
 * #418). Arranca determinístico en 1 y aplica el valor real post-mount.
 * La escritura vive DENTRO del handler (no en un effect reactivo), así no hace
 * falta la bandera `hydrated` que use-pagination necesitó para no pisar el
 * valor guardado en el primer commit.
 */
export function useSqlZoom() {
  const [zoom, setZoom] = useState(SQL_ZOOM_MIN);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null) setZoom(clampSqlZoom(raw));
    } catch {
      /* SSR / storage deshabilitado */
    }
  }, []);

  const apply = useCallback((next: number) => {
    const v = clampSqlZoom(next);
    setZoom(v);
    try {
      localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
      /* no-op */
    }
  }, []);

  return {
    zoom,
    zoomIn: () => apply(zoom + SQL_ZOOM_STEP),
    zoomOut: () => apply(zoom - SQL_ZOOM_STEP),
    reset: () => apply(SQL_ZOOM_MIN),
    atMin: zoom <= SQL_ZOOM_MIN,
    atMax: zoom >= SQL_ZOOM_MAX,
    pct: Math.round(zoom * 100),
  } as const;
}
