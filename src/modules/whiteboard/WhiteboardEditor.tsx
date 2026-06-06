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
import { Eye, Maximize2, Minimize2, Users } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/shared/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

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
  /** Clave de localStorage para persistir el viewport (scrollX, scrollY,
   *  zoom) entre montajes. Cuando se pasa, el editor:
   *    - Al MONTAR: lee el viewport guardado y lo merge a initialData.appState.
   *    - Al CAMBIAR el canvas: persiste el viewport con debounce de 500ms.
   *  Si se omite, viewport se resetea a default cada vez que el componente
   *  se monta (el comportamiento histórico). Recomendado: `examlab_wb_view:<page_id>`.
   *  No se persiste a DB para evitar bloat de la escena y para que cada
   *  device/tab tenga su propia vista. */
  viewportStorageKey?: string;
  /** Nombre de canal Supabase Realtime para sincronización colaborativa
   *  en vivo. Cuando se setea:
   *    - El editor se suscribe al canal.
   *    - Cada onChange local emite un broadcast `scene_update` con el
   *      scene completo + clientId (debounce 200ms para no saturar).
   *    - Al recibir un broadcast de OTRO clientId, aplica el scene
   *      a Excalidraw vía `excalidrawAPI.updateScene` con
   *      `commitToHistory: false`.
   *  El padre sigue siendo dueño de la persistencia a DB — el broadcast
   *  es SOLO para sync en vivo (sub-segundo). Si todos cierran el editor
   *  y vuelven, leen el último scene de DB.
   *  Ejemplo: `wb_session:<session_id>` para una pizarra de sesión. */
  realtimeChannelName?: string;
}

/** Forma persistida del viewport en localStorage. Excalidraw entiende
 *  estos campos directamente en `appState`. */
interface PersistedViewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/** Lee el viewport desde localStorage. Devuelve null si no existe o si
 *  el JSON está corrupto (no rompe el render — caemos al default). */
function readViewport(key: string | undefined): PersistedViewport | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedViewport>;
    if (
      typeof parsed.scrollX !== "number" ||
      typeof parsed.scrollY !== "number" ||
      typeof parsed.zoom !== "number" ||
      !Number.isFinite(parsed.scrollX) ||
      !Number.isFinite(parsed.scrollY) ||
      !Number.isFinite(parsed.zoom)
    ) {
      return null;
    }
    return { scrollX: parsed.scrollX, scrollY: parsed.scrollY, zoom: parsed.zoom };
  } catch {
    return null;
  }
}

function writeViewport(key: string | undefined, vp: PersistedViewport): void {
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(vp));
  } catch {
    // Quota exceeded / disabled storage — silently skip. La pérdida del
    // viewport es benigna; no merece toast ni log.
  }
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

/** clientId único de la pestaña — generado UNA vez al cargar el módulo.
 *  Lo usamos para distinguir nuestros propios broadcasts de los ajenos
 *  en el canal de Realtime. UUID via crypto.randomUUID() (disponible en
 *  navegadores modernos + Node 19+); fallback a timestamp+random para
 *  entornos sin la API (SSR sin polyfill). */
const TAB_CLIENT_ID: string =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

interface ScenePayload {
  clientId: string;
  scene: WhiteboardScene;
}

export function WhiteboardEditor({
  scene,
  onPersist,
  readOnly,
  className,
  viewportStorageKey,
  realtimeChannelName,
}: Props) {
  const [Component, setComponent] = useState<ComponentType<Record<string, unknown>> | null>(
    cachedExcalidraw,
  );
  // Ref al contenedor para Fullscreen API: requestFullscreen se llama
  // sobre el wrapper para que Excalidraw + nuestro badge "Solo lectura"
  // y el botón "Salir" queden visibles en fullscreen. Excalidraw maneja
  // sus propios shortcuts dentro del canvas, así que no compite con
  // nuestro Esc (el SO/browser sale del fullscreen y disparamos el
  // fullscreenchange handler para sincronizar el state).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      void el.requestFullscreen().catch((err) => {
        console.warn("[WhiteboardEditor] requestFullscreen failed", err);
      });
    } else {
      void document.exitFullscreen().catch(() => {});
    }
  }, []);
  // Sincronizar state con el evento del navegador — el usuario puede
  // salir del fullscreen con Esc (no podemos interceptar Esc directo)
  // o desde el menú del browser. Sin este listener, el botón
  // "Minimize" mostraría el ícono incorrecto post-Esc.
  useEffect(() => {
    const handler = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);
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

  // Debounce separado para el viewport (scrollX/Y/zoom). Cambia con MUCHA
  // más frecuencia que los elementos (cualquier pan/scroll dispara onChange),
  // así que usamos 500ms en vez de 1500ms para que el último gesto del
  // usuario quede guardado rápido pero sin pegar a localStorage en cada
  // pixel del drag.
  const viewportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastViewportRef = useRef<string>("");

  // ── Realtime broadcast (pizarra compartida) ──
  // Referencia al ExcalidrawAPI capturada via initialData callback —
  // necesaria para llamar `updateScene` cuando llega un broadcast remoto.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const excalidrawAPIRef = useRef<any>(null);
  // Canal Realtime activo. Lo guardamos para emitir broadcasts desde
  // handleChange sin pasar el canal por args.
  const channelRef = useRef<RealtimeChannel | null>(null);
  // Debounce para el broadcast — independiente del persist (1500ms) y
  // del viewport (500ms). 200ms es el sweet spot para "sub-segundo
  // perceived latency" sin saturar Supabase (Realtime tiene quotas).
  const broadcastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Estado para mostrar "Compartido" badge en el editor (UX feedback
  // de que la pizarra está en modo colaborativo).
  const [collabActive, setCollabActive] = useState(false);

  // Suscripción al canal Realtime — solo se activa cuando el padre pasa
  // `realtimeChannelName`. Se desuscribe al desmontar o al cambiar de
  // canal. Cada cliente recibe broadcasts de OTROS clientes en el canal
  // y aplica el scene al Excalidraw API.
  useEffect(() => {
    if (!realtimeChannelName) {
      setCollabActive(false);
      return;
    }
    const channel = supabase.channel(realtimeChannelName, {
      config: { broadcast: { self: false } },
    });
    channelRef.current = channel;
    channel.on("broadcast", { event: "scene_update" }, (msg) => {
      const payload = msg.payload as ScenePayload | undefined;
      if (!payload || payload.clientId === TAB_CLIENT_ID) return;
      const api = excalidrawAPIRef.current;
      if (!api || typeof api.updateScene !== "function") return;
      // commitToHistory:false → el undo del usuario local no debe
      // deshacer cambios de OTROS clientes. captureUpdate:never es la
      // nueva API equivalente en versiones recientes de Excalidraw —
      // pasamos ambas para máxima compat.
      try {
        api.updateScene({
          elements: payload.scene.elements,
          appState: payload.scene.appState,
          commitToHistory: false,
          captureUpdate: "never",
        });
      } catch (err) {
        console.warn("[WhiteboardEditor] updateScene remote failed", err);
      }
    });
    void channel.subscribe((status) => {
      if (status === "SUBSCRIBED") setCollabActive(true);
      else if (status === "CLOSED" || status === "CHANNEL_ERROR") setCollabActive(false);
    });
    return () => {
      channelRef.current = null;
      setCollabActive(false);
      void supabase.removeChannel(channel);
    };
  }, [realtimeChannelName]);

  const handleChange = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (elements: readonly any[], appState: Record<string, any>) => {
      // Persistir viewport en localStorage (no a DB) ANTES del early-return
      // de readOnly: cuando el alumno ve una pizarra read-only y panea/zoom,
      // queremos que al volver mantenga su vista. Independiente del save de
      // contenido — el viewport es local al device del usuario.
      if (viewportStorageKey) {
        const vp: PersistedViewport = {
          scrollX: typeof appState.scrollX === "number" ? appState.scrollX : 0,
          scrollY: typeof appState.scrollY === "number" ? appState.scrollY : 0,
          zoom:
            typeof appState.zoom === "number"
              ? appState.zoom
              : typeof appState.zoom?.value === "number"
                ? appState.zoom.value
                : 1,
        };
        const serialized = JSON.stringify(vp);
        if (serialized !== lastViewportRef.current) {
          lastViewportRef.current = serialized;
          if (viewportTimerRef.current) clearTimeout(viewportTimerRef.current);
          viewportTimerRef.current = setTimeout(() => {
            viewportTimerRef.current = null;
            writeViewport(viewportStorageKey, vp);
          }, 500);
        }
      }

      if (readOnly || !onPersist) return;
      // Filtramos `appState` para no guardar info de sesión que cambia
      // todo el tiempo (cursor, zoom, scroll). Mantenemos solo lo que
      // afecta la apariencia persistente del board. El viewport viaja
      // por localStorage (ver bloque arriba), no por la escena.
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

      // Broadcast del scene a otros clientes en el canal Realtime. 200ms
      // de debounce para sub-segundo perceived latency sin saturar.
      // El receptor ignora su propio clientId (config { broadcast.self:
      // false } + check explícito en el handler).
      if (channelRef.current) {
        if (broadcastTimerRef.current) clearTimeout(broadcastTimerRef.current);
        const channel = channelRef.current;
        broadcastTimerRef.current = setTimeout(() => {
          broadcastTimerRef.current = null;
          const payload: ScenePayload = { clientId: TAB_CLIENT_ID, scene: next };
          void channel.send({ type: "broadcast", event: "scene_update", payload });
        }, 200);
      }
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
    [readOnly, onPersist, viewportStorageKey],
  );

  // Cleanup del timer de viewport al unmount — sin flush porque el último
  // valor ya está en `lastViewportRef`; el writeViewport pendiente solo
  // ahorra ~500ms y no es crítico (la próxima visita usará el penúltimo).
  // Mismo trato al broadcastTimer — el último broadcast pendiente al
  // cerrar la pestaña no llega; el peer ve la versión persistida en DB
  // cuando recarga, así que la pérdida es benigna.
  useEffect(() => {
    return () => {
      if (viewportTimerRef.current) {
        clearTimeout(viewportTimerRef.current);
      }
      if (broadcastTimerRef.current) {
        clearTimeout(broadcastTimerRef.current);
      }
    };
  }, []);

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
    <div
      ref={containerRef}
      className={cn(
        "relative",
        // En fullscreen el div toma 100vh/100vw (Fullscreen API ya
        // expande, pero forzamos bg para que no se vea transparente
        // sobre la página subyacente en algunos navegadores).
        isFullscreen && "bg-background",
        className,
      )}
    >
      <Component
        // Captura del ExcalidrawAPI — lo usamos en el effect del canal
        // Realtime para aplicar scenes remotas via `updateScene`.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        excalidrawAPI={(api: any) => {
          excalidrawAPIRef.current = api;
        }}
        initialData={(() => {
          // Restauramos viewport (scrollX/scrollY/zoom) desde localStorage
          // si hay clave configurada. Lo lee UNA vez por mount — Excalidraw
          // toma `initialData` solo en el primer render. Cambios de page
          // re-montan el componente (el padre usa `key={pageId}`), así que
          // cada hoja lee SU viewport guardado.
          const viewport = readViewport(viewportStorageKey);
          const sceneAppState = scene?.appState ?? {};
          const mergedAppState = viewport
            ? {
                ...sceneAppState,
                scrollX: viewport.scrollX,
                scrollY: viewport.scrollY,
                zoom: { value: viewport.zoom },
              }
            : sceneAppState;
          if (!scene && !viewport) return undefined;
          return {
            elements: scene?.elements ?? [],
            appState: mergedAppState,
            files: scene?.files,
          };
        })()}
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
      {/* Badge "Compartida" cuando hay canal Realtime activo. Posicionado
          al lado del badge de readOnly cuando ambos aplican (poco común
          pero válido — alumno viendo una pizarra compartida con un toggle
          de read en el padre). El tinte azul lo diferencia visualmente
          del badge gris de "Solo lectura". */}
      {collabActive && (
        <div
          className={cn(
            "absolute z-10 pointer-events-none rounded-md border border-sky-300 bg-sky-50/90 dark:bg-sky-950/80 backdrop-blur-sm px-2 py-1 text-[11px] text-sky-700 dark:text-sky-300 inline-flex items-center gap-1 shadow-sm",
            // Si también hay badge readOnly arriba-derecha, este va debajo.
            readOnly ? "top-10 right-2" : "top-2 right-2",
          )}
        >
          <Users className="h-3 w-3" />
          Compartida en vivo
        </div>
      )}
      {/* Botón de pantalla completa — abajo-derecha para no competir con
          el toolbar de Excalidraw (arriba) ni el "Solo lectura" badge.
          Z-index alto para flotar sobre el canvas. El icono cambia
          según el estado actual (escapamos con Esc → fullscreenchange
          listener actualiza isFullscreen). */}
      <button
        type="button"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
        title={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
        className="absolute bottom-2 right-2 z-10 rounded-md border border-border bg-background/90 backdrop-blur-sm p-1.5 text-muted-foreground hover:text-foreground hover:bg-background transition-colors shadow-sm"
      >
        {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </button>
    </div>
  );
}
