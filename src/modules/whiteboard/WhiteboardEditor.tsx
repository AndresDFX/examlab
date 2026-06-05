/**
 * WhiteboardEditor — wrapper de Excalidraw con auto-guardado debounced.
 *
 * Modos de uso:
 *
 *   <WhiteboardEditor
 *     scene={loadedScene}
 *     onPersist={(next) => saveToDb(next)}
 *     readOnly={false}
 *   />
 *
 * Persistencia:
 *   - Cambios en el canvas → handler `onChange` de Excalidraw.
 *   - Debounce de 1500ms → llama `onPersist(scene)` con el JSON
 *     completo (elements + appState filtrado para no guardar info
 *     volátil tipo cursor/zoom de la sesión actual).
 *   - El padre decide qué hacer con `scene` (UPDATE en whiteboards
 *     o en attendance_sessions.whiteboard_scene).
 *
 * Importación dinámica:
 *   Excalidraw pesa ~1MB minificado. Lo cargamos vía dynamic import
 *   para que el bundle inicial de la app no se infle. Mientras carga
 *   mostramos un Spinner.
 *
 * Tema oscuro:
 *   Pasamos `theme` derivado de useTheme() para que la pizarra
 *   respete el modo claro/oscuro del resto de la app.
 *
 * Tamaño:
 *   El padre controla el alto vía `className`. Excalidraw ocupa el
 *   100% del contenedor. Para fullscreen, usar h-screen; para un
 *   dialog, h-[80vh] funciona bien.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import type { ComponentType } from "react";
import { Spinner } from "@/components/ui/spinner";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/shared/lib/utils";

/** Forma del JSON que serializamos. Es un subset del formato
 *  Excalidraw — guardamos `elements` (array de figuras) y
 *  `appState` filtrado para no incluir info de sesión. */
export interface WhiteboardScene {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  elements: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  appState?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  files?: Record<string, any>;
}

interface Props {
  /** Escena inicial. Si es undefined, se renderiza una escena vacía.
   *  Cuando cambia la referencia (ej. cargar otra pizarra), se
   *  re-monta Excalidraw para evitar mezclar estados. */
  scene?: WhiteboardScene | null;
  /** Callback de auto-save. Se invoca con la escena completa después
   *  de 1500ms sin cambios. El padre persiste a DB. */
  onPersist?: (scene: WhiteboardScene) => void | Promise<void>;
  /** Si true, deshabilita edición — solo visualización. Útil para
   *  alumnos viendo una pizarra compartida. */
  readOnly?: boolean;
  /** Clase Tailwind del contenedor — el padre controla el alto y el
   *  ancho. La pizarra ocupa el 100% del contenedor. */
  className?: string;
}

/** Importación dinámica de Excalidraw. Cargado UNA vez por sesión
 *  del browser y reutilizado entre instancias del componente. */
let cachedExcalidraw: ComponentType<Record<string, unknown>> | null = null;
async function loadExcalidraw() {
  if (cachedExcalidraw) return cachedExcalidraw;
  // CSS de Excalidraw — necesario para que el canvas se vea bien.
  await import("@excalidraw/excalidraw/index.css");
  const mod = await import("@excalidraw/excalidraw");
  cachedExcalidraw = mod.Excalidraw as ComponentType<Record<string, unknown>>;
  return cachedExcalidraw;
}

export function WhiteboardEditor({ scene, onPersist, readOnly, className }: Props) {
  const [Component, setComponent] = useState<ComponentType<Record<string, unknown>> | null>(
    cachedExcalidraw,
  );
  const { resolvedTheme } = useTheme();
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref a la última escena emitida — evita persists redundantes si el
  // contenido no cambió pero el callback se dispara (cursor moves etc).
  const lastSerializedRef = useRef<string>("");

  useEffect(() => {
    if (Component) return;
    let cancelled = false;
    void loadExcalidraw().then((C) => {
      if (cancelled) return;
      setComponent(() => C);
    });
    return () => {
      cancelled = true;
    };
  }, [Component]);

  // Limpieza del timer al desmontar — sin esto, una persist tardía
  // podría disparar después de que el padre cerró el dialog.
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, []);

  const handleChange = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (elements: readonly any[], appState: Record<string, any>) => {
      if (readOnly || !onPersist) return;
      // Filtramos `appState` para no guardar info de sesión que cambia
      // todo el tiempo (cursor, zoom, scroll). Mantenemos solo lo que
      // afecta la apariencia persistente del board.
      const persistedAppState = {
        viewBackgroundColor: appState.viewBackgroundColor,
        gridSize: appState.gridSize,
        // Sin: cursor, scrollX, scrollY, zoom, collaborators, etc.
      };
      const next: WhiteboardScene = {
        elements: Array.from(elements),
        appState: persistedAppState,
      };
      const serialized = JSON.stringify(next);
      if (serialized === lastSerializedRef.current) return;
      lastSerializedRef.current = serialized;
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        void onPersist(next);
      }, 1500);
    },
    [readOnly, onPersist],
  );

  if (!Component) {
    return (
      <div
        className={cn(
          "flex items-center justify-center gap-2 text-sm text-muted-foreground",
          className,
        )}
      >
        <Spinner size="sm" /> Cargando pizarra…
      </div>
    );
  }

  return (
    <div className={cn("relative", className)}>
      <Component
        initialData={
          scene
            ? { elements: scene.elements, appState: scene.appState ?? {}, files: scene.files }
            : undefined
        }
        onChange={handleChange}
        viewModeEnabled={!!readOnly}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        UIOptions={{
          canvasActions: {
            // Sacamos botones de "guardar/cargar archivo" porque
            // persistimos en DB. El usuario podría confundirse con
            // dos lugares donde "guardar".
            saveToActiveFile: false,
            loadScene: false,
            export: { saveFileToDisk: true },
          },
        }}
      />
    </div>
  );
}
