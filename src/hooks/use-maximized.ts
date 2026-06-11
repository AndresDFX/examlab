import { useCallback, useEffect, useState } from "react";

/**
 * Preferencia "tamaño completo" para los modales/pantallas de toma de
 * evaluación (taller, examen). Persiste en localStorage para que el alumno
 * no tenga que re-maximizar cada vez.
 *
 * Hydration-safe: NO lee localStorage en el initializer de useState (eso
 * rompería el render SSR/cliente — React #418). Inicia determinístico en
 * `false` y aplica el valor real post-mount en un effect.
 */
export function useMaximized(storageKey: string): readonly [boolean, () => void] {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    try {
      setMaximized(localStorage.getItem(storageKey) === "1");
    } catch {
      /* SSR / storage deshabilitado */
    }
  }, [storageKey]);

  const toggle = useCallback(() => {
    setMaximized((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* no-op */
      }
      return next;
    });
  }, [storageKey]);

  return [maximized, toggle] as const;
}
