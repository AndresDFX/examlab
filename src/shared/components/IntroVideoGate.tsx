/**
 * IntroVideoGate — Lista de N videos introductorios en ORDEN ESTRICTO.
 * El estudiante debe ver cada video hasta el final antes de desbloquear
 * el siguiente; cuando todos están vistos, el padre puede habilitar la
 * acción gateada (entregar proyecto, entregar taller, etc.).
 *
 * Genérico: lo usan proyectos (`project_intro_videos`/`project_submission_video_views`)
 * y talleres (`workshop_intro_videos`/`workshop_submission_video_views`).
 * La persistencia de "video visto" la hace el caller — este componente
 * solo emite `onVideoWatched(videoId)` cuando termina el activo. Los
 * `watchedIds` son fuente de verdad del padre.
 *
 * UX:
 *   - Renderizamos TODOS los videos en lista con un badge por fila:
 *     ✓ Visto, ▶ Ver ahora, 🔒 Bloqueado.
 *   - Solo el "Ver ahora" (primer no visto) tiene el reproductor
 *     expandido. Vistos y bloqueados muestran solo cabecera.
 *
 * Gate de seek (video directo MP4/WebM):
 *   El `<video>` nativo dispara `timeupdate`; trackeamos `maxSeen` y
 *   bloqueamos seek hacia adelante. Hacia atrás libre. YouTube/Vimeo
 *   en iframe NO tienen control de seek — el alumno marca "ya vi" a
 *   mano (la API embeddable no expone control sin extra setup).
 */
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Check, PlayCircle, AlertTriangle, Lock, RotateCcw } from "lucide-react";
import { isHostedVideo, toEmbedUrl } from "@/shared/lib/video-embed";

export interface IntroVideo {
  id: string;
  url: string;
  title: string | null;
  position: number;
}

interface Props {
  /** Videos del recurso (proyecto / taller) en orden ascendente. */
  videos: IntroVideo[];
  /** IDs de videos que el estudiante YA completó. */
  watchedIds: ReadonlySet<string>;
  /** Disparado cuando el alumno completa UN video. El padre persiste
   *  la view (RPC `mark_*_video_watched`) y actualiza `watchedIds`. */
  onVideoWatched: (videoId: string) => void;
}

export function IntroVideoGate({ videos, watchedIds, onVideoWatched }: Props) {
  if (videos.length === 0) return null;

  // Orden estricto: el primer video NO visto es el "activo". Los
  // anteriores están vistos; los siguientes bloqueados.
  const ordered = [...videos].sort((a, b) => a.position - b.position);
  const activeIndex = ordered.findIndex((v) => !watchedIds.has(v.id));
  const allDone = activeIndex === -1;

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <PlayCircle className="h-5 w-5 text-primary" />
          {ordered.length === 1
            ? "Video introductorio"
            : `Videos introductorios (${ordered.length})`}
          {allDone && (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
              <Check className="h-3.5 w-3.5" /> Todos vistos
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!allDone && (
          <Alert>
            <PlayCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Mira los videos en orden. El siguiente se desbloquea cuando termines el actual.
              {ordered.length > 1 && (
                <>
                  {" "}
                  Llevas <strong>{watchedIds.size}</strong> de <strong>{ordered.length}</strong>.
                </>
              )}
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          {ordered.map((v, idx) => {
            const isWatched = watchedIds.has(v.id);
            const isActive = idx === activeIndex;
            const isLocked = !isWatched && !isActive;
            const label = v.title?.trim() || `Video ${idx + 1}`;
            return (
              <div
                key={v.id}
                className={
                  isActive
                    ? "rounded-lg border-2 border-primary/40 bg-background"
                    : "rounded-lg border bg-background/60"
                }
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  {isWatched ? (
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 shrink-0">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  ) : isActive ? (
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-primary shrink-0">
                      <PlayCircle className="h-3.5 w-3.5" />
                    </span>
                  ) : (
                    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground shrink-0">
                      <Lock className="h-3 w-3" />
                    </span>
                  )}
                  <div className="text-xs flex-1 min-w-0">
                    <div className="font-medium truncate">
                      {idx + 1}. {label}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {isWatched ? "Visto" : isActive ? "Ver ahora" : "Bloqueado"}
                    </div>
                  </div>
                </div>
                {isActive && (
                  <div className="px-3 pb-3">
                    <SingleVideoPlayer video={v} onWatched={() => onVideoWatched(v.id)} />
                  </div>
                )}
                {isLocked && (
                  <div className="px-3 pb-3">
                    <p className="text-[11px] text-muted-foreground italic">
                      Termina los videos anteriores para desbloquearlo.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Reproductor de UN video con gate de seek. MP4/WebM directo tiene
 * gate estricto; YouTube/Vimeo iframe NO tiene gate técnico (el alumno
 * marca "ya vi" a mano).
 */
function SingleVideoPlayer({
  video,
  onWatched,
}: {
  video: IntroVideo;
  onWatched: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const maxSeenRef = useRef(0);
  const [progress, setProgress] = useState(0);
  const firedRef = useRef(false);
  // Un video roto (URL caída / formato no soportado) NUNCA dispara
  // `onEnded`, así que sin esta ruta de error el alumno quedaba trabado
  // sin poder satisfacer el gate → no podía entregar. `loadError` muestra
  // un fallback con "Reintentar" + "Continuar de todos modos".
  const [loadError, setLoadError] = useState(false);
  // Bumpea el `key` del <video> para forzar un remount (reintento de carga).
  const [reloadNonce, setReloadNonce] = useState(0);
  const kind = isHostedVideo(video.url);

  const markWatched = () => {
    if (firedRef.current) return;
    firedRef.current = true;
    onWatched();
  };

  // Reset al cambiar de video (el `key` del map padre desmonta+monta
  // este SingleVideoPlayer al avanzar el activo, pero el reset
  // defensivo cubre el caso de prop update sin remount).
  useEffect(() => {
    maxSeenRef.current = 0;
    firedRef.current = false;
    setProgress(0);
    setLoadError(false);
    setReloadNonce(0);
  }, [video.id]);

  // Camino hosted (YouTube/Vimeo) — sin gate técnico. Un iframe roto NO
  // bloquea la entrega: el alumno igual dispone del botón "Ya vi este
  // video completo", que satisface el gate independientemente de si el
  // embed cargó (los iframes cross-origin tampoco emiten onError fiable).
  if (kind !== "direct") {
    return (
      <div className="space-y-2">
        <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-black">
          <iframe
            src={toEmbedUrl(video.url, kind)}
            title={video.title ?? "Video introductorio"}
            className="absolute inset-0 w-full h-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={markWatched}
            className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground inline-flex items-center gap-1.5"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            Ya vi este video completo
          </button>
        </div>
      </div>
    );
  }

  // Camino directo (MP4/WebM) — el video no cargó: fallback que NO
  // bloquea la entrega. El alumno puede reintentar o continuar de todos
  // modos (un video roto no debe impedirle entregar).
  if (loadError) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription className="space-y-2 text-xs">
          <p>
            No se pudo cargar el video. Es posible que el enlace esté roto o que el formato no sea
            compatible con tu navegador.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLoadError(false);
                setReloadNonce((n) => n + 1);
              }}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              Reintentar
            </Button>
            <Button size="sm" onClick={markWatched}>
              <Check className="h-3.5 w-3.5 mr-1" />
              Continuar de todos modos
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  // Camino directo (MP4/WebM) — gate estricto.
  return (
    <div className="space-y-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-black">
        <video
          key={reloadNonce}
          ref={videoRef}
          src={video.url}
          controls
          controlsList="nodownload"
          preload="metadata"
          className="absolute inset-0 w-full h-full object-contain"
          onError={() => setLoadError(true)}
          onSeeking={() => {
            const v = videoRef.current;
            if (!v) return;
            const max = maxSeenRef.current;
            if (v.currentTime > max + 1) {
              v.currentTime = max;
            }
          }}
          onTimeUpdate={() => {
            const v = videoRef.current;
            if (!v) return;
            if (v.currentTime > maxSeenRef.current) {
              maxSeenRef.current = v.currentTime;
            }
            const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
            if (dur > 0) {
              setProgress(Math.min(1, v.currentTime / dur));
            }
          }}
          onEnded={() => {
            setProgress(1);
            markWatched();
          }}
        />
      </div>
      <div className="h-1.5 w-full rounded bg-muted overflow-hidden">
        <div
          className="h-full bg-primary transition-all"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <Alert className="border-amber-300/60 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <AlertDescription className="text-xs text-amber-700 dark:text-amber-300">
          Mira el video hasta el final. El reproductor no permite adelantar — puedes pausar o
          rebobinar libremente.
        </AlertDescription>
      </Alert>
    </div>
  );
}
