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
import { Eye } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
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
  // Si el dynamic import de Excalidraw falla (chunk corrupto, red caída
  // a media descarga del chunk grande, etc.), mostramos un ErrorState
  // con botón "Reintentar" en lugar de un Spinner infinito. Era el bug
  // de "se queda cargando para siempre" que reportó QA.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const { resolvedTheme } = useTheme();
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref a la última escena emitida — evita persists redundantes si el
  // contenido no cambió pero el callback se dispara (cursor moves etc).
  const lastSerializedRef = useRef<string>("");
  // Ref a la última escena PENDIENTE de persistir (con timer activo).
  // Si el componente se desmonta antes de que el debounce dispare,
  // hacemos un flush sincrónico para no perder los últimos cambios.
  // Era el bug "cerrar el dialog rápido pierde lo último que dibujé".
  const pendingSceneRef = useRef<WhiteboardScene | null>(null);
  // El onPersist más reciente — refeado para que el cleanup del
  // effect (que solo corre al unmount) no pegue contra una closure
  // stale del primer render.
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  useEffect(() => {
    if (Component) return;
    let cancelled = false;
    setLoadError(null);
    loadExcalidraw()
      .then((C) => {
        if (cancelled) return;
        setComponent(() => C);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Error desconocido";
        setLoadError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [Component, retryNonce]);

  // Cleanup al desmontar: si hay un timer activo (debounce de 1500ms
  // sin disparar todavía) Y hay una escena pendiente, hacemos flush
  // SINCRÓNICO antes de cancelar. Sin esto, cerrar el dialog o salir
  // de la ruta justo después de dibujar perdía el último cambio.
  //
  // El padre ya está desmontado al llegar acá, así que NINGÚN error
  // boundary captura. Sin .catch explícito, una rejection del onPersist
  // (red caída, sesión expirada, RLS panic) burbujea como
  // "unhandled rejection" al handler global → audit log ruidoso. Lo
  // capturamos con Promise.resolve(...).catch — el padre ya hizo lo
  // que pudo en su propio try/finally; acá solo evitamos el log.
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        const pending = pendingSceneRef.current;
        const fn = onPersistRef.current;
        if (pending && fn) {
          Promise.resolve(fn(pending)).catch((err) => {
            console.error("[WhiteboardEditor] flush on unmount failed", err);
          });
        }
      }
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
      // Guardamos la escena pendiente en ref para que el cleanup del
      // unmount pueda hacer flush si el timer no alcanzó a dispararse.
      pendingSceneRef.current = next;
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        pendingSceneRef.current = null;
        persistTimerRef.current = null;
        // `void onPersist(next)` cortaba la stack y dejaba la rejection
        // como unhandled — fuente principal de los logs
        // `app.unhandled_rejection` TypeError que aparecían en auditoría
        // (el debounce dispara cada 1.5s mientras se dibuja). Envolver
        // en Promise.resolve + .catch garantiza que CUALQUIER rejection
        // (red caída, sesión expirada, RLS panic) se loguea local pero
        // no llega al handler global.
        Promise.resolve(onPersist(next)).catch((err) => {
          console.error("[WhiteboardEditor] auto-save onPersist rejected", err);
        });
      }, 1500);
    },
    [readOnly, onPersist],
  );

  if (loadError) {
    return (
      <div className={cn("flex items-center justify-center p-4", className)}>
        <ErrorState
          message="No pudimos cargar el editor de pizarra"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }
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
      {/* Badge "Solo lectura" cuando readOnly. Excalidraw oculta los
          tools de edición en viewModeEnabled, pero la pizarra sigue
          viéndose idéntica al editor — el alumno no sabe si "ya está
          en modo lectura" o "le faltan permisos". Este badge lo
          explicita. pointer-events-none para no bloquear interacción
          con el canvas (zoom, pan, export). */}
      {readOnly && (
        <div className="absolute top-2 right-2 z-10 pointer-events-none rounded-md border border-border bg-background/90 backdrop-blur-sm px-2 py-1 text-[11px] text-muted-foreground inline-flex items-center gap-1 shadow-sm">
          <Eye className="h-3 w-3" />
          Solo lectura
        </div>
      )}
    </div>
  );
}
