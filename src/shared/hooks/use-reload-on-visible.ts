/**
 * useReloadOnVisible — dispara `reload()` cuando el tab vuelve a estar
 * visible (Page Visibility API).
 *
 * Caso de uso: las listas del estudiante (exams/workshops/projects)
 * computan "vencido", "abierto", "próximo" comparando con `Date.now()`
 * sobre datos que vienen del último fetch. Si el docente extiende
 * `end_time` o `due_date` mientras el alumno tiene la pestaña abierta
 * (o en background), el cliente ve datos viejos y sigue marcando
 * "vencido" aunque ya no lo esté.
 *
 * Refetch al volver al tab cubre el 90% de los casos sin necesidad
 * de realtime subscriptions ni polling. Es lo mismo que ya hace
 * `use-notifications.ts:228` para mantener el bell sincronizado.
 *
 * Uso:
 *   const reload = useCallback(() => { ... fetch ... }, [deps]);
 *   useReloadOnVisible(reload);
 */
import { useEffect } from "react";

export function useReloadOnVisible(reload: () => void): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [reload]);
}
