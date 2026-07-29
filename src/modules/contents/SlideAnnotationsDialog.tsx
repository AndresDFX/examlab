/**
 * SlideAnnotationsDialog — "Presentar y anotar": proyecta las diapositivas de
 * un contenido y deja RAYARLAS encima, con puntero LÁSER, y decidir AL FINAL
 * si las anotaciones se guardan o se descartan.
 *
 * ── Cómo se compone la pantalla ───────────────────────────────────────────
 * El escenario tiene dos capas apiladas:
 *   1. FONDO (no interactivo): la diapositiva. Si viene de la presentación
 *      generada por IA es el mockup HTML (`SlideMockup`, el MISMO que usa el
 *      visor de pptx); si es una imagen subida, un <img> del objeto de Storage.
 *      Se dibuja en una caja de tamaño CANÓNICO (SLIDE_W x SLIDE_H) y se
 *      escala/desplaza con un transform.
 *   2. CANVAS de anotación: `WhiteboardEditor` con fondo TRANSPARENTE encima.
 *
 * Las anotaciones viven en coordenadas de escena canónicas (960x540), NO en
 * píxeles de pantalla, y el transform del fondo se recalcula desde el viewport
 * real del canvas (`onViewportChange`). Consecuencia: lo que el docente raya en
 * un proyector cae en el mismo lugar de la diapositiva en un celular, y el
 * fondo acompaña al pan/zoom en vez de "despegarse".
 *
 * ── Persistencia (una fila por contenido) ─────────────────────────────────
 * Tabla `content_slide_annotations(content_id PK, slides JSONB)` donde
 * `slides = { "<file_path>#<slide_index>": escena }`. POR DIAPOSITIVA: rayar
 * la 3 no aparece en la 4 porque cada una tiene su clave y su propia escena.
 * Guardar = UN upsert con el mapa completo (atómico, sin merges parciales).
 *
 * ── Semántica de EDITOR (lo que más importa acá) ──────────────────────────
 *  - `autoPersist={false}`: el editor de pizarra NO auto-guarda. Nada toca la
 *    DB hasta que el docente pulsa "Guardar".
 *  - Cerrar con cambios sin guardar pide confirmación destructiva.
 *  - Si el guardado FALLA, el mapa de trabajo NO se toca y el diálogo NO se
 *    cierra: el error se muestra y el docente puede reintentar. Un fallo
 *    silencioso acá se lleva las anotaciones de toda una clase.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronLeft,
  ChevronRight,
  Eraser,
  Presentation as PresentationIcon,
  Save,
  Scan,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/shared/lib/db-errors";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { WhiteboardEditor, type WhiteboardScene } from "@/modules/whiteboard/WhiteboardEditor";
import { SlideMockup } from "@/modules/contents/SlideMockup";
import { mediaMimeForName } from "@/modules/contents/media-files";
import {
  MAX_ANNOTATIONS_BYTES,
  SLIDE_H,
  SLIDE_W,
  buildSlideDeck,
  deckSlideLabel,
  estimateAnnotationsBytes,
  fitViewport,
  sanitizeAnnotations,
  stageTransform,
  type ContentFileLike,
  type StageViewport,
} from "@/modules/contents/slide-deck";
import {
  EMPTY_ANNOTATIONS_EDITOR_STATE,
  applyClearSlide,
  applySaveSucceeded,
  applySceneChange,
  canvasMountId,
  editorAnnotatedKeys,
  isAnnotationsEditorDirty,
  loadedAnnotationsState,
  type AnnotationsEditorState,
} from "@/modules/contents/slide-annotations-state";

// `content_slide_annotations` no está en types.ts auto-generado (igual que
// whiteboards / generated_contents — ver CLAUDE.md).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;
const BUCKET = "generated-contents";
const TABLE = "content_slide_annotations";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `generated_contents.id` — dueño de las anotaciones. */
  contentId: string | null;
  /** Nombre visible del contenido (para el título). */
  contentName: string;
  /** `generated_contents.files[]`. El deck se arma con los anotables. */
  files: ContentFileLike[];
  /** Solo ver las anotaciones (sin editar, sin guardar, sin confirmaciones). */
  readOnly?: boolean;
}

export function SlideAnnotationsDialog({
  open,
  onOpenChange,
  contentId,
  contentName,
  files,
  readOnly,
}: Readonly<Props>) {
  const { t } = useTranslation();
  const confirm = useConfirm();

  const deck = useMemo(() => buildSlideDeck(files), [files]);
  const [idx, setIdx] = useState(0);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // El estado del editor (mapa guardado + mapa de trabajo + eco de montaje)
  // vive en un REF, no en state: Excalidraw dispara onChange en cada frame del
  // trazo y un setState por frame re-renderiza el diálogo (y con él el canvas)
  // — inaceptable en tablet. Del ref derivamos solo dos datos "gruesos" a
  // state: si hay cambios sin guardar y qué diapositivas tienen marcas. Ambos
  // setState son no-ops cuando el valor no cambió, así que dibujar no
  // re-renderiza. Las TRANSICIONES son puras y viven (con sus tests) en
  // slide-annotations-state.ts — acá solo se despachan.
  const stateRef = useRef<AnnotationsEditorState>(EMPTY_ANNOTATIONS_EDITOR_STATE);
  const [dirty, setDirty] = useState(false);
  const [annotatedKeys, setAnnotatedKeys] = useState<string[]>([]);
  // Fuerza el re-montaje del canvas cuando cambiamos la escena "por fuera"
  // (borrar las marcas de la diapositiva actual): Excalidraw ignora
  // `initialData` después del mount.
  const [editorNonce, setEditorNonce] = useState(0);

  const current = deck[Math.min(idx, Math.max(deck.length - 1, 0))] ?? null;
  const currentKey = current?.key ?? "";

  /** Vuelca a state lo poco que la UI necesita del ref (ver arriba). */
  const syncDerived = useCallback(() => {
    const st = stateRef.current;
    const nextDirty = isAnnotationsEditorDirty(st);
    setDirty((prev) => (prev === nextDirty ? prev : nextDirty));
    const keys = editorAnnotatedKeys(st);
    setAnnotatedKeys((prev) =>
      prev.length === keys.length && prev.every((k, i) => k === keys[i]) ? prev : keys,
    );
  }, []);

  // ── Carga de las anotaciones guardadas ──
  useEffect(() => {
    if (!open || !contentId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      const { data, error } = await db
        .from(TABLE)
        .select("slides")
        .eq("content_id", contentId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setLoadError(friendlyError(error));
        setLoading(false);
        return;
      }
      stateRef.current = loadedAnnotationsState(sanitizeAnnotations(data?.slides));
      syncDerived();
      setSaveError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contentId, retryNonce, syncDerived]);

  // Reset al cerrar — que reabrir no muestre el estado de la sesión anterior.
  useEffect(() => {
    if (open) return;
    setIdx(0);
    setSaveError(null);
    stateRef.current = EMPTY_ANNOTATIONS_EDITOR_STATE;
    setDirty(false);
    setAnnotatedKeys([]);
  }, [open]);

  // ── Escenario: medida del área + viewport del canvas ──
  const stageRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<HTMLDivElement | null>(null);
  /**
   * Elemento que entra en PANTALLA COMPLETA al proyectar: envuelve la barra de
   * navegación + el escenario (fondo con la diapositiva + canvas de anotación).
   * Tiene que ser un ANCESTRO de las dos capas: si se proyecta solo el canvas
   * (que es transparente), en el proyector se ven los trazos flotando sobre
   * negro, sin diapositiva. Incluir la barra además deja pasar de diapositiva
   * mientras se proyecta.
   */
  const projectionRef = useRef<HTMLDivElement | null>(null);
  /** Medidas del área con las que se calculó el último encaje ("w x h"). */
  const fittedBoxRef = useRef<string>("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiRef = useRef<any>(null);
  const viewportRef = useRef<StageViewport | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setBox(null);
      viewportRef.current = null;
      // Reabrir vuelve a medir y a encajar desde cero.
      fittedBoxRef.current = "";
      return;
    }
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox((prev) =>
        prev && Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1
          ? prev
          : { w: r.width, h: r.height },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, loading, deck.length]);

  /** Aplica el transform al fondo por DOM directo — sin state, así el pan/zoom
   *  no re-renderiza el canvas en cada frame. */
  const applyViewport = useCallback((vp: StageViewport) => {
    const el = bgRef.current;
    if (el) el.style.transform = stageTransform(vp);
  }, []);

  const onViewportChange = useCallback(
    (vp: StageViewport) => {
      viewportRef.current = vp;
      applyViewport(vp);
    },
    [applyViewport],
  );

  /** Encaja la diapositiva en un área de `w x h` — fondo Y canvas. */
  const fitToBox = useCallback(
    (w: number, h: number) => {
      const vp = fitViewport(w, h, SLIDE_W, SLIDE_H);
      viewportRef.current = vp;
      applyViewport(vp);
      const api = apiRef.current;
      try {
        api?.updateScene?.({
          appState: { scrollX: vp.scrollX, scrollY: vp.scrollY, zoom: { value: vp.zoom } },
        });
      } catch {
        // Si la versión de Excalidraw no acepta el appState, el fondo ya quedó
        // encajado; el canvas se ajusta con su propio zoom. No es crítico.
      }
    },
    [applyViewport],
  );

  // Viewport: se conserva entre diapositivas (navegar no debería "saltar" la
  // vista) pero se RE-ENCAJA cuando cambia el TAMAÑO del área — entrar o salir
  // de pantalla completa para proyectar, o rotar la tablet. Sin esto la
  // diapositiva se queda con el zoom del área anterior: al proyectar aparece
  // chiquita en una esquina, justo en el momento en que más importa.
  useEffect(() => {
    if (!box || !current) return;
    const boxSig = `${Math.round(box.w)}x${Math.round(box.h)}`;
    if (fittedBoxRef.current !== boxSig) {
      fittedBoxRef.current = boxSig;
      fitToBox(box.w, box.h);
      return;
    }
    if (!viewportRef.current) viewportRef.current = fitViewport(box.w, box.h, SLIDE_W, SLIDE_H);
    applyViewport(viewportRef.current);
  }, [box, current, currentKey, editorNonce, applyViewport, fitToBox]);

  const fitToStage = useCallback(() => {
    if (box) fitToBox(box.w, box.h);
  }, [box, fitToBox]);

  /**
   * Sale de pantalla completa si estamos proyectando. Los diálogos de
   * confirmación (AlertDialog de Radix) se portalizan al `<body>`, que el
   * navegador TAPA con el elemento en fullscreen: pedir una confirmación
   * mientras se proyecta mostraría un modal invisible y la app parecería
   * colgada. Se llama antes de cualquier `confirm()`.
   */
  const leaveProjection = useCallback(async () => {
    if (typeof document === "undefined") return;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    const fsEl = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
    const stage = projectionRef.current;
    if (!fsEl || !stage || !(fsEl.contains(stage) || stage.contains(fsEl))) return;
    const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    if (typeof exit !== "function") return;
    try {
      await Promise.resolve(exit.call(doc));
    } catch {
      // Si el navegador rechaza el exit, el confirm igual se muestra (tapado):
      // no hay nada más que podamos hacer desde acá.
    }
  }, []);

  // ── Imagen de fondo (diapositivas que son archivos de imagen) ──
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);
  useEffect(() => {
    setImgUrl(null);
    setImgError(null);
    if (!open || !current || current.kind !== "image") return;
    let cancelled = false;
    let url: string | null = null;
    void (async () => {
      const { data, error } = await supabase.storage.from(BUCKET).download(current.filePath);
      if (cancelled) return;
      if (error || !data) {
        setImgError(
          friendlyError(
            error,
            t("slideAnnotations.imageLoadError", {
              defaultValue: "No pudimos cargar la imagen de la diapositiva.",
            }),
          ),
        );
        return;
      }
      url = URL.createObjectURL(new Blob([data], { type: mediaMimeForName(current.fileName) }));
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      setImgUrl(url);
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [open, current, t]);

  // ── Cambios en el canvas ──
  // La disciplina del "eco de montaje" (el onChange que Excalidraw dispara al
  // restaurar una escena, que NO es una edición del docente) vive en
  // slide-annotations-state.ts con sus tests: acá solo se despacha el evento
  // con la identidad del montaje que lo emitió.
  const handleSceneChange = useCallback(
    (scene: WhiteboardScene) => {
      if (!currentKey) return;
      stateRef.current = applySceneChange(stateRef.current, {
        key: currentKey,
        mountId: canvasMountId(currentKey, editorNonce),
        scene,
      });
      syncDerived();
    },
    [currentKey, editorNonce, syncDerived],
  );

  const clearCurrentSlide = useCallback(async () => {
    if (!currentKey) return;
    // El AlertDialog se portaliza al <body>, que queda TAPADO por el elemento
    // en pantalla completa — hay que salir de la proyección o el docente vería
    // la app colgada contra un modal invisible.
    await leaveProjection();
    const ok = await confirm({
      title: t("slideAnnotations.clearSlideConfirmTitle", {
        defaultValue: "¿Borrar las marcas de esta diapositiva?",
      }),
      description: t("slideAnnotations.clearSlideConfirmDesc", {
        defaultValue:
          "Se quitan todos los trazos de esta diapositiva. Las demás no se tocan. Esta acción no se puede deshacer.",
      }),
      confirmLabel: t("slideAnnotations.clearSlideConfirmAction", {
        defaultValue: "Borrar marcas",
      }),
      cancelLabel: t("common.cancel"),
      tone: "destructive",
    });
    if (!ok) return;
    stateRef.current = applyClearSlide(stateRef.current, currentKey);
    syncDerived();
    setEditorNonce((n) => n + 1);
  }, [currentKey, confirm, leaveProjection, syncDerived, t]);

  // ── Guardar / descartar ──
  const handleSave = useCallback(async () => {
    if (!contentId) return;
    const map = stateRef.current.working;
    const bytes = estimateAnnotationsBytes(map);
    if (bytes > MAX_ANNOTATIONS_BYTES) {
      // Avisamos ANTES del round-trip: el trigger de la tabla rechaza >5 MB y
      // el error de Postgres no diría qué hacer.
      const msg = t("slideAnnotations.tooBig", {
        defaultValue:
          "Las anotaciones de este contenido pesan demasiado (máximo 5 MB). Borra las marcas de alguna diapositiva e intenta de nuevo.",
      });
      setSaveError(msg);
      toast.error(msg);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const { error } = await db
        .from(TABLE)
        .upsert({ content_id: contentId, slides: map }, { onConflict: "content_id" });
      if (error) throw error;
      // Solo acá movemos la línea base de "guardado", y al mapa EXACTO que se
      // escribió. Si el upsert falla, nadie la mueve: el mapa de trabajo queda
      // intacto y `dirty` sigue en true. Si el docente siguió rayando durante
      // el await, ese trazo todavía NO está en la DB → sigue pendiente y
      // cerrar seguirá pidiendo confirmación.
      stateRef.current = applySaveSucceeded(stateRef.current, map);
      syncDerived();
      toast.success(t("slideAnnotations.savedToast", { defaultValue: "Anotaciones guardadas." }));
    } catch (e) {
      const msg = friendlyError(e);
      setSaveError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }, [contentId, syncDerived, t]);

  const requestClose = useCallback(async () => {
    if (readOnly || !dirty) {
      onOpenChange(false);
      return;
    }
    await leaveProjection();
    const ok = await confirm({
      title: t("slideAnnotations.discardTitle", { defaultValue: "¿Descartar las anotaciones?" }),
      description: t("slideAnnotations.discardDesc", {
        defaultValue:
          "Hay marcas sin guardar sobre las diapositivas. Si cierras ahora se pierden. Esta acción no se puede deshacer.",
      }),
      confirmLabel: t("slideAnnotations.discardConfirm", { defaultValue: "Descartar y cerrar" }),
      cancelLabel: t("slideAnnotations.discardCancel", { defaultValue: "Seguir anotando" }),
      tone: "destructive",
    });
    if (ok) onOpenChange(false);
  }, [readOnly, dirty, confirm, leaveProjection, onOpenChange, t]);

  const go = useCallback(
    (delta: number) => {
      setIdx((prev) => {
        const next = prev + delta;
        if (next < 0 || next >= deck.length) return prev;
        return next;
      });
    },
    [deck.length],
  );

  const annotatedSet = useMemo(() => new Set(annotatedKeys), [annotatedKeys]);
  const currentAnnotated = currentKey ? annotatedSet.has(currentKey) : false;

  // Viewport con el que arranca el canvas: el último que usó el docente
  // (se conserva al navegar entre diapositivas) o el de encaje.
  const initialVp = box
    ? (viewportRef.current ?? fitViewport(box.w, box.h, SLIDE_W, SLIDE_H))
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else void requestClose();
      }}
    >
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-6xl h-[calc(100dvh-2rem)] overflow-hidden gap-3">
        <DialogHeader className="shrink-0 pr-10">
          <DialogTitle className="flex items-center gap-2 text-base min-w-0">
            <PresentationIcon className="h-5 w-5 text-primary shrink-0" />
            <span className="truncate">{contentName}</span>
            {deck.length > 0 && (
              <Badge variant="outline" className="text-[10px] tabular-nums shrink-0">
                {t("slideAnnotations.position", {
                  defaultValue: "{{current}} / {{total}}",
                  current: Math.min(idx + 1, deck.length),
                  total: deck.length,
                })}
              </Badge>
            )}
            {annotatedKeys.length > 0 && (
              <Badge variant="secondary" className="text-[10px] tabular-nums shrink-0">
                {/* Clave con plurales (_one/_other) — sin defaultValue inline
                    a propósito: el defaultValue no soporta pluralización. */}
                {t("slideAnnotations.annotatedCount", { count: annotatedKeys.length })}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {readOnly
              ? t("slideAnnotations.subtitleReadOnly", {
                  defaultValue:
                    "Anotaciones que dejó el docente sobre las diapositivas. Solo lectura.",
                })
              : t("slideAnnotations.subtitle", {
                  defaultValue:
                    "Raya encima de cada diapositiva. El puntero láser deja un trazo que se desvanece y no se guarda. Nada se guarda hasta que pulses Guardar.",
                })}
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <ErrorState
            message={t("slideAnnotations.loadErrorTitle", {
              defaultValue: "No pudimos cargar las anotaciones",
            })}
            hint={loadError}
            onRetry={() => setRetryNonce((n) => n + 1)}
          />
        ) : deck.length === 0 ? (
          <EmptyState
            icon={PresentationIcon}
            title={t("slideAnnotations.emptyTitle", {
              defaultValue: "Este contenido no tiene diapositivas que se puedan anotar",
            })}
            hint={t("slideAnnotations.emptyHint", {
              defaultValue:
                "Se pueden anotar las presentaciones generadas con IA y las imágenes (PNG/JPG). Un .pptx o .pdf subido no se puede dibujar encima: exporta sus diapositivas como imágenes y súbelas al contenido.",
            })}
          />
        ) : (
          /* Área de PROYECCIÓN: es este bloque el que entra en pantalla
             completa (ver projectionRef), no solo el canvas. Incluye la barra
             de navegación para poder pasar de diapositiva mientras se proyecta.
             La clase `projection-stage` le da fondo opaco en fullscreen (el
             ::backdrop del navegador es negro y el escenario usa un fondo
             semitransparente pensado para el diálogo). */
          <div ref={projectionRef} className="projection-stage flex flex-1 min-h-0 flex-col gap-2">
            {/* Navegación — botones grandes (usable en tablet) + selector con
                marca de las diapositivas que ya tienen anotaciones. */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="h-9 px-2"
                onClick={() => go(-1)}
                disabled={idx <= 0}
                aria-label={t("slideAnnotations.prev", { defaultValue: "Anterior" })}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 px-2"
                onClick={() => go(1)}
                disabled={idx >= deck.length - 1}
                aria-label={t("slideAnnotations.next", { defaultValue: "Siguiente" })}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Select
                value={String(Math.min(idx, deck.length - 1))}
                onValueChange={(v) => setIdx(Number(v))}
              >
                <SelectTrigger className="h-9 flex-1 min-w-[160px] sm:min-w-64 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {deck.map((s, i) => (
                    <SelectItem key={s.key} value={String(i)} className="text-xs">
                      {annotatedSet.has(s.key) ? "✎ " : ""}
                      {deckSlideLabel(s, i + 1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={fitToStage}
                title={t("slideAnnotations.fitHint", {
                  defaultValue: "Volver a encajar la diapositiva en pantalla",
                })}
              >
                <Scan className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">
                  {t("slideAnnotations.fit", { defaultValue: "Ajustar" })}
                </span>
              </Button>
              {!readOnly && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9"
                  onClick={() => void clearCurrentSlide()}
                  disabled={!currentAnnotated}
                  title={t("slideAnnotations.clearSlideHint", {
                    defaultValue: "Borrar las marcas de esta diapositiva (aún sin guardar)",
                  })}
                >
                  <Eraser className="h-4 w-4 sm:mr-1" />
                  <span className="hidden sm:inline">
                    {t("slideAnnotations.clearSlide", { defaultValue: "Borrar marcas" })}
                  </span>
                </Button>
              )}
            </div>

            {/* Escenario: fondo (diapositiva) + canvas de anotación encima. */}
            <div
              ref={stageRef}
              className="relative flex-1 min-h-0 overflow-hidden rounded-md border bg-muted/40"
            >
              {/* Capa de fondo. pointer-events-none: TODO el gesto va al canvas.
                  La caja interna mide exactamente SLIDE_W x SLIDE_H (960x540 —
                  mantener sincronizado con las constantes de slide-deck.ts) y el
                  transform lo escribe applyViewport(). */}
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div
                  ref={bgRef}
                  className="absolute left-0 top-0 h-[540px] w-[960px] origin-top-left bg-white shadow-md"
                >
                  {current?.kind === "text" && current.slide ? (
                    <SlideMockup
                      slide={current.slide}
                      index={idx}
                      total={deck.length}
                      className="h-full w-full"
                    />
                  ) : imgUrl ? (
                    <img
                      src={imgUrl}
                      alt={current?.fileName ?? ""}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center p-4 text-center text-sm text-slate-500">
                      {imgError ?? (
                        <span className="inline-flex items-center gap-2">
                          <Spinner size="sm" />
                          {t("slideAnnotations.loadingSlide", {
                            defaultValue: "Cargando diapositiva…",
                          })}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Canvas de anotación. Se monta cuando ya medimos el área (para
                  que el zoom inicial encaje) y se RE-MONTA por diapositiva:
                  cada una tiene su propia escena, así lo que se raya en la 3 no
                  aparece en la 4. */}
              {loading || !initialVp ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Spinner size="lg" className="text-muted-foreground" />
                </div>
              ) : (
                <WhiteboardEditor
                  key={canvasMountId(currentKey, editorNonce)}
                  className="absolute inset-0"
                  scene={currentKey ? (stateRef.current.working[currentKey] ?? null) : null}
                  readOnly={readOnly}
                  autoPersist={false}
                  enableLaser
                  themeOverride="light"
                  // Proyectar SOLO el canvas (transparente) mostraría los trazos
                  // sobre negro: el fullscreen tiene que abarcar el escenario
                  // completo, diapositiva de fondo incluida.
                  fullscreenTargetRef={projectionRef}
                  onSceneChange={handleSceneChange}
                  onViewportChange={onViewportChange}
                  onApiReady={(api) => {
                    apiRef.current = api;
                  }}
                  initialAppState={{
                    // Canvas transparente → se ve la diapositiva de abajo.
                    viewBackgroundColor: "transparent",
                    scrollX: initialVp.scrollX,
                    scrollY: initialVp.scrollY,
                    zoom: { value: initialVp.zoom },
                    // Rojo por defecto: es lo que se espera de "rayar" encima
                    // de una diapositiva, y contrasta sobre fondo claro.
                    currentItemStrokeColor: "#e03131",
                    currentItemStrokeWidth: 2,
                  }}
                />
              )}
            </div>
          </div>
        )}

        <DialogFooter className="shrink-0 flex-wrap gap-2 sm:gap-2">
          {saveError && <p className="mr-auto max-w-sm text-xs text-destructive">{saveError}</p>}
          {!saveError && dirty && !readOnly && (
            <p className="mr-auto text-xs text-amber-600 dark:text-amber-400">
              {t("slideAnnotations.unsaved", { defaultValue: "Hay cambios sin guardar." })}
            </p>
          )}
          <Button variant="ghost" size="sm" onClick={() => void requestClose()} disabled={saving}>
            {t("common.close")}
          </Button>
          {!readOnly && deck.length > 0 && (
            <Button size="sm" onClick={() => void handleSave()} disabled={saving || !dirty}>
              {saving ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Save className="h-3.5 w-3.5 mr-1" />
              )}
              {t("slideAnnotations.save", { defaultValue: "Guardar anotaciones" })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
