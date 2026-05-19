/**
 * Hook + helper para visibilidad de módulos por rol.
 *
 * Lee `module_visibility` de la DB (RLS deja leer a cualquier
 * autenticado) y construye un mapa { module: { role: enabled } }.
 *
 * Default `true` cuando no hay fila — coherente con el helper SQL
 * `is_module_enabled`. Módulos NUEVOS que se agregan en el código
 * antes de seed-ear la tabla aparecen visibles por default.
 *
 * Cache simple a nivel de módulo: la primera llamada va a DB, las
 * siguientes (en la misma carga de página) reusan el resultado. Si el
 * Admin cambia un toggle en el panel, no se refleja inmediato en otras
 * tabs — debe recargar para ver el cambio. Aceptable para una opción
 * de configuración que se toca rara vez.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type ModuleKey =
  | "workshops"
  | "projects"
  | "exams"
  | "courses"
  | "gradebook"
  | "grades"
  | "attendance"
  | "forum"
  | "calendar"
  | "certificates"
  | "tutor"
  | "question_bank"
  | "ai_prompts"
  | "messages"
  | "dashboard";

export type RoleKey = "Admin" | "Docente" | "Estudiante";

export type VisibilityMap = Partial<Record<ModuleKey, Partial<Record<RoleKey, boolean>>>>;

let cached: VisibilityMap | null = null;
let pending: Promise<VisibilityMap> | null = null;

async function fetchVisibilityMap(): Promise<VisibilityMap> {
  if (cached) return cached;
  if (pending) return pending;
  pending = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from("module_visibility")
      .select("module_key, role, enabled");
    if (error) {
      // En error caemos a mapa vacío → todos los módulos visibles
      // (default true). Mejor mostrar de más que romper la app por una
      // tabla no migrada todavía.
      console.warn("[module-visibility] fetch failed, defaulting to all-enabled:", error.message);
      cached = {};
      return cached;
    }
    const map: VisibilityMap = {};
    for (const row of (data ?? []) as Array<{
      module_key: ModuleKey;
      role: RoleKey;
      enabled: boolean;
    }>) {
      const slot = map[row.module_key] ?? {};
      slot[row.role] = row.enabled;
      map[row.module_key] = slot;
    }
    cached = map;
    return cached;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/**
 * Limpia el cache. Útil tras editar la tabla desde el panel admin —
 * lo llamamos después de un UPDATE exitoso para que el nav refresque
 * sin recarga.
 */
export function invalidateModuleVisibility(): void {
  cached = null;
  pending = null;
}

/**
 * Devuelve true si el módulo está habilitado para el rol dado.
 * Llamada síncrona contra el mapa ya cargado — pide `map` del hook
 * o usa el helper async `isModuleEnabledAsync` si no tienes el hook.
 */
export function isModuleEnabled(
  map: VisibilityMap,
  module: ModuleKey,
  role: RoleKey | null | undefined,
): boolean {
  if (!role) return true; // Sin rol todavía → no bloquear (loading).
  const slot = map[module];
  if (!slot) return true; // Módulo no listado → visible.
  const v = slot[role];
  if (v == null) return true; // Sin fila para ese rol → visible.
  return v === true;
}

/**
 * Hook React. Devuelve `{ map, loading }`. `map` arranca vacío y se
 * llena tras el fetch. Mientras `loading` es true, llamadas a
 * isModuleEnabled siempre devuelven true (no bloquear navegación
 * antes de saber).
 */
export function useModuleVisibility(): { map: VisibilityMap; loading: boolean } {
  const [map, setMap] = useState<VisibilityMap>(cached ?? {});
  const [loading, setLoading] = useState(cached == null);
  useEffect(() => {
    if (cached) {
      setMap(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void fetchVisibilityMap().then((m) => {
      if (cancelled) return;
      setMap(m);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return { map, loading };
}
