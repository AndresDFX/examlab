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
import { useTranslation } from "react-i18next";
import {
  Eye,
  Maximize2,
  Minimize2,
  Users,
  Shapes,
  X,
  ChevronDown,
  ChevronRight,
  Boxes,
  Workflow,
  Database,
  Binary,
  Cloud,
  Network,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/shared/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  DEFAULT_LIBRARY_ITEMS,
  LIBRARY_CATEGORIES,
  instantiateLibraryElements,
  shortLibraryItemName,
  libraryItemPreview,
} from "@/modules/whiteboard/excalidraw-libraries";

// Ícono lucide por categoría (la lib expone el NOMBRE; acá lo resolvemos para
// no acoplar el módulo puro a componentes React).
const CATEGORY_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  Boxes,
  Workflow,
  Database,
  Binary,
  Cloud,
  Network,
};

/** Miniatura SVG de una figura de la paleta (estilo draw.io: se VE qué es). */
function ShapePreview({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: Record<string, any>;
}) {
  const preview = libraryItemPreview(item.elements ?? []);
  const markerId = `wb-arrow-${item.id}`;
  return (
    <svg
      viewBox={`0 0 ${preview.width} ${preview.height}`}
      className="h-12 w-full text-foreground"
      role="img"
      aria-hidden="true"
    >
      <defs>
        <marker
          id={markerId}
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
        </marker>
      </defs>
      {preview.shapes.map((s, i) => {
        if (s.kind === "rect") {
          return (
            <rect
              key={i}
              x={s.x}
              y={s.y}
              width={s.w}
              height={s.h}
              rx={s.rounded ? 3 : 0}
              fill={s.fill}
              stroke="currentColor"
              strokeWidth={1}
              strokeDasharray={s.dashed ? "3 2" : undefined}
            />
          );
        }
        if (s.kind === "ellipse") {
          return (
            <ellipse
              key={i}
              cx={s.cx}
              cy={s.cy}
              rx={s.rx}
              ry={s.ry}
              fill={s.fill}
              stroke="currentColor"
              strokeWidth={1}
            />
          );
        }
        if (s.kind === "diamond") {
          return <polygon key={i} points={s.points} fill={s.fill} stroke="currentColor" strokeWidth={1} />;
        }
        if (s.kind === "polyline") {
          return (
            <polyline
              key={i}
              points={s.points}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              strokeDasharray={s.dashed ? "3 2" : undefined}
              markerEnd={s.arrow ? `url(#${markerId})` : undefined}
            />
          );
        }
        return (
          <text
            key={i}
            x={s.x}
            y={s.y}
            fontSize={s.fontSize}
            fill="currentColor"
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {s.text}
          </text>
        );
      })}
    </svg>
  );
}

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
  const { t } = useTranslation();
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
  // Panel propio de figuras (categorizado). Excalidraw tiene su "Library"
  // pero en grilla plana sin secciones; este panel agrupa por tema
  // (Flujo, E-R, POO/UML, etc.) y se inserta al click.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Categorías expandidas en el panel (acordeón estilo draw.io). Todas abiertas
  // por defecto para que el docente vea de una qué hay; puede colapsar las que
  // no use. Estado determinístico (no toca storage) → hidratación segura.
  const [openCats, setOpenCats] = useState<Set<string>>(
    () => new Set(LIBRARY_CATEGORIES.map((c) => c.key)),
  );
  const toggleCat = useCallback((key: string) => {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // ¿El navegador soporta la Fullscreen API sobre elementos? iOS Safari en
  // iPhone NO la expone (solo en <video>), y algunos WebViews tampoco — ahí
  // `el.requestFullscreen` es `undefined` y llamarla CRASHEA (TypeError
  // reportado en /app/student/whiteboards). Detectamos soporte (estándar o
  // webkit) y, si no lo hay, ocultamos el botón y el toggle es no-op.
  const fullscreenSupported =
    typeof document !== "undefined" &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (((document as any).fullscreenEnabled ?? false) ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((document as any).webkitFullscreenEnabled ?? false));

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current as
      | (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void })
      | null;
    if (!el) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = document as any;
    const fsEl = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    try {
      if (!fsEl) {
        const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
        if (typeof req === "function") {
          void Promise.resolve(req.call(el)).catch((err: unknown) => {
            console.warn("[WhiteboardEditor] requestFullscreen failed", err);
          });
        } else {
          console.warn("[WhiteboardEditor] Fullscreen API no disponible en este navegador");
        }
      } else {
        const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
        if (typeof exit === "function") void Promise.resolve(exit.call(doc)).catch(() => {});
      }
    } catch (err) {
      console.warn("[WhiteboardEditor] fullscreen toggle error", err);
    }
  }, []);
  // Sincronizar state con el evento del navegador — el usuario puede
  // salir del fullscreen con Esc (no podemos interceptar Esc directo)
  // o desde el menú del browser. Sin este listener, el botón
  // "Minimize" mostraría el ícono incorrecto post-Esc. Escuchamos también
  // el evento webkit-prefijado (Safari).
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setIsFullscreen(Boolean((document as any).fullscreenElement ?? (document as any).webkitFullscreenElement));
    document.addEventListener("fullscreenchange", handler);
    document.addEventListener("webkitfullscreenchange", handler);
    return () => {
      document.removeEventListener("fullscreenchange", handler);
      document.removeEventListener("webkitfullscreenchange", handler);
    };
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
        const msg = err instanceof Error ? err.message : t("hc_modulesWhiteboardWhiteboardEditor.unknownError", { defaultValue: "Error desconocido" });
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
  // True mientras aplicamos un scene RECIBIDO por broadcast. El updateScene
  // dispara onChange igual que una edición local; sin este guard el receptor
  // RE-persiste el scene ajeno — pero su store de `files` está vacío (el
  // broadcast no trae binarios), así que sobreescribe en DB la escena del autor
  // (con imagen) por una SIN el binario (last-write-wins) → la imagen se pierde
  // para todos al recargar. Con el guard, solo el autor (que sí tiene los files)
  // persiste; el receptor no re-persiste ni re-emite.
  const applyingRemoteRef = useRef(false);
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
        // Si el broadcast trae binarios de imágenes, registrarlos ANTES del
        // updateScene para que los elements tipo `image` encuentren su fileId.
        // (Hoy el broadcast viaja sin files por peso; este guard queda por si
        // en el futuro se envían — es inofensivo cuando no hay.)
        if (payload.scene.files && typeof api.addFiles === "function") {
          const arr = Object.values(payload.scene.files);
          if (arr.length > 0) api.addFiles(arr);
        }
        // Marcar que el onChange que dispare este updateScene es REMOTO, para
        // que handleChange NO lo re-persista ni re-emita (ver applyingRemoteRef).
        applyingRemoteRef.current = true;
        api.updateScene({
          elements: payload.scene.elements,
          appState: payload.scene.appState,
          commitToHistory: false,
          captureUpdate: "never",
        });
        // Limpiar tras el ciclo actual (fallback por si updateScene no dispara onChange).
        setTimeout(() => {
          applyingRemoteRef.current = false;
        }, 0);
      } catch (err) {
        applyingRemoteRef.current = false;
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
    (elements: readonly any[], appState: Record<string, any>, files?: Record<string, any>) => {
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
      // Dedup sobre elements+appState (NO sobre files): el base64 de una
      // imagen puede pesar MB y `onChange` se dispara en cada trazo —
      // stringificarlo cada vez congelaría el canvas. Pegar una imagen agrega
      // un element nuevo, así que el dedup igual detecta el cambio.
      const dedupKey = JSON.stringify({
        elements: Array.from(elements),
        appState: persistedAppState,
      });
      if (dedupKey === lastSerializedRef.current) return;
      lastSerializedRef.current = dedupKey;

      // Si este cambio vino de un broadcast REMOTO, no re-emitir ni re-persistir:
      // solo el cliente que ORIGINÓ el cambio (que posee los binarios de `files`)
      // escribe a DB. Actualizamos el dedup ref arriba para mantenerlo consistente.
      if (applyingRemoteRef.current) return;

      // `files` = binarios de imágenes pegadas/insertadas (BinaryFiles de
      // Excalidraw). Se PERSISTEN a DB; sin ellos una imagen se ve mientras la
      // pizarra está abierta pero DESAPARECE al recargar (su element referencia
      // un fileId sin datos) — bug reportado: "se ven temporal y luego ya no".
      const next: WhiteboardScene = {
        elements: Array.from(elements),
        appState: persistedAppState,
        files: files && Object.keys(files).length > 0 ? files : undefined,
      };

      // Broadcast en vivo: SOLO elements+appState (sin files). Reenviar MB de
      // base64 en cada broadcast (cada 200ms mientras se dibuja) saturaría
      // Realtime y rompería el sync del trazo. Los peers ven las imágenes al
      // recargar (vienen de DB). El receptor ignora su propio clientId.
      if (channelRef.current) {
        if (broadcastTimerRef.current) clearTimeout(broadcastTimerRef.current);
        const channel = channelRef.current;
        const liveScene: WhiteboardScene = { elements: next.elements, appState: next.appState };
        broadcastTimerRef.current = setTimeout(() => {
          broadcastTimerRef.current = null;
          const payload: ScenePayload = { clientId: TAB_CLIENT_ID, scene: liveScene };
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

  // Inserta una figura del panel categorizado en el CENTRO del viewport
  // actual. Clona el template (ids/seed nuevos + groupId común vía
  // instantiateLibraryElements) y hace updateScene anexando a lo existente.
  // El onChange de Excalidraw dispara el auto-save (incluye files si los hay).
  const insertShape = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (item: Record<string, any>) => {
      const api = excalidrawAPIRef.current;
      if (!api) return;
      try {
        const st = typeof api.getAppState === "function" ? api.getAppState() : {};
        const zoom =
          typeof st?.zoom?.value === "number"
            ? st.zoom.value
            : typeof st?.zoom === "number"
              ? st.zoom
              : 1;
        const w = typeof st?.width === "number" ? st.width : 800;
        const h = typeof st?.height === "number" ? st.height : 600;
        const cx = -(st?.scrollX ?? 0) + w / 2 / zoom;
        const cy = -(st?.scrollY ?? 0) + h / 2 / zoom;
        const newEls = instantiateLibraryElements(item.elements ?? [], cx, cy);
        if (!newEls.length) return;
        const current =
          typeof api.getSceneElements === "function" ? api.getSceneElements() : [];
        api.updateScene({ elements: [...current, ...newEls] });
      } catch (err) {
        console.warn("[WhiteboardEditor] insertShape failed", err);
      }
    },
    [],
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
          message={t("hc_modulesWhiteboardWhiteboardEditor.loadErrorTitle", { defaultValue: "No pudimos cargar el editor de pizarra" })}
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
        <Spinner size="sm" /> {t("hc_modulesWhiteboardWhiteboardEditor.loading", { defaultValue: "Cargando pizarra…" })}
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
          // `libraryItems` se pasa SIEMPRE — el panel "Library" del
          // Excalidraw los lista en el aside derecho. El usuario puede
          // arrastrarlos al canvas; cada drag crea nuevos elements,
          // así que el template no muta. Si el usuario tiene libs en
          // localStorage agregadas por su cuenta, Excalidraw las
          // muestra junto a estas (no las pisa — `initialData` es
          // additive en este campo).
          if (!scene && !viewport) {
            return { libraryItems: DEFAULT_LIBRARY_ITEMS };
          }
          return {
            elements: scene?.elements ?? [],
            appState: mergedAppState,
            files: scene?.files,
            libraryItems: DEFAULT_LIBRARY_ITEMS,
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
          {t("hc_modulesWhiteboardWhiteboardEditor.readOnly", { defaultValue: "Solo lectura" })}
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
          {t("hc_modulesWhiteboardWhiteboardEditor.sharedLive", { defaultValue: "Compartida en vivo" })}
        </div>
      )}
      {/* Panel de FIGURAS por TIPO DE DIAGRAMA (solo en edición). Excalidraw
          trae su "Library" pero en grilla plana sin secciones ni nombres claros;
          este agrupa en secciones colapsables con ÍCONO + NOMBRE del diagrama
          (Clases/UML, Flujo, E-R, Estructuras, AWS) + MINIATURA de cada figura
          (estilo draw.io: se ve qué es), e inserta al click centrado en el
          viewport. Ancla abajo-derecha para no chocar con el toolbar (arriba)
          ni el zoom de Excalidraw (abajo-izquierda). */}
      {!readOnly && (
        <>
          <button
            type="button"
            onClick={() => setPaletteOpen((o) => !o)}
            aria-label={t("hc_modulesWhiteboardWhiteboardEditor.shapes", { defaultValue: "Figuras" })}
            aria-expanded={paletteOpen}
            title={t("hc_modulesWhiteboardWhiteboardEditor.shapesButtonTitle", { defaultValue: "Figuras por tipo de diagrama (clases, flujo, E-R…)" })}
            className={cn(
              "absolute bottom-2 right-12 z-20 inline-flex items-center gap-1 rounded-md border border-border bg-background/90 backdrop-blur-sm px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-background transition-colors shadow-sm",
              paletteOpen && "text-foreground bg-background",
            )}
          >
            <Shapes className="h-4 w-4" />
            <span className="hidden sm:inline">{t("hc_modulesWhiteboardWhiteboardEditor.shapes", { defaultValue: "Figuras" })}</span>
          </button>
          {paletteOpen && (
            <div className="absolute bottom-12 right-2 z-30 w-72 max-w-[calc(100vw-1rem)] max-h-[72%] overflow-y-auto rounded-md border border-border bg-background shadow-lg">
              <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-background px-3 py-2">
                <div className="min-w-0">
                  <span className="text-xs font-semibold">{t("hc_modulesWhiteboardWhiteboardEditor.shapesPanelTitle", { defaultValue: "Figuras por tipo de diagrama" })}</span>
                  <p className="text-[10px] text-muted-foreground">{t("hc_modulesWhiteboardWhiteboardEditor.shapesPanelHint", { defaultValue: "Toca una para insertarla en el centro." })}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setPaletteOpen(false)}
                  aria-label={t("common.close")}
                  className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="p-2 space-y-2">
                {LIBRARY_CATEGORIES.map((cat) => {
                  const CatIcon = CATEGORY_ICONS[cat.icon] ?? Shapes;
                  const open = openCats.has(cat.key);
                  return (
                    <div key={cat.key} className="rounded-md border border-border/60">
                      {/* Encabezado de sección: ícono + nombre del diagrama +
                          conteo. Colapsable (acordeón estilo draw.io). */}
                      <button
                        type="button"
                        onClick={() => toggleCat(cat.key)}
                        aria-expanded={open}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60 transition-colors"
                      >
                        {open ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <CatIcon className="h-4 w-4 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs font-semibold leading-tight">{cat.label}</span>
                          <span className="block text-[10px] text-muted-foreground leading-tight truncate">
                            {cat.description}
                          </span>
                        </span>
                        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
                          {cat.items.length}
                        </span>
                      </button>
                      {open && (
                        <div className="grid grid-cols-2 gap-1.5 p-1.5 pt-0.5">
                          {cat.items.map((item) => (
                            <button
                              key={item.id as string}
                              type="button"
                              onClick={() => insertShape(item)}
                              title={shortLibraryItemName(item.name as string)}
                              className="flex flex-col items-center gap-1 rounded-md border border-border/60 bg-card/40 p-1.5 hover:border-primary/50 hover:bg-muted active:bg-muted/70 transition-colors"
                            >
                              <ShapePreview item={item} />
                              <span className="w-full truncate text-center text-[10px] leading-tight text-muted-foreground">
                                {shortLibraryItemName(item.name as string)}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
      {/* Botón de pantalla completa — abajo-derecha para no competir con
          el toolbar de Excalidraw (arriba) ni el "Solo lectura" badge.
          Z-index alto para flotar sobre el canvas. El icono cambia
          según el estado actual (escapamos con Esc → fullscreenchange
          listener actualiza isFullscreen). */}
      {fullscreenSupported && (
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? t("hc_modulesWhiteboardWhiteboardEditor.exitFullscreen", { defaultValue: "Salir de pantalla completa" }) : t("hc_modulesWhiteboardWhiteboardEditor.enterFullscreen", { defaultValue: "Pantalla completa" })}
          title={isFullscreen ? t("hc_modulesWhiteboardWhiteboardEditor.exitFullscreen", { defaultValue: "Salir de pantalla completa" }) : t("hc_modulesWhiteboardWhiteboardEditor.enterFullscreen", { defaultValue: "Pantalla completa" })}
          className="absolute bottom-2 right-2 z-10 rounded-md border border-border bg-background/90 backdrop-blur-sm p-1.5 text-muted-foreground hover:text-foreground hover:bg-background transition-colors shadow-sm"
        >
          {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      )}
    </div>
  );
}
