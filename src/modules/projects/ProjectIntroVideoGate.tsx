/**
 * ProjectIntroVideoGate — Lista de N videos introductorios en ORDEN
 * ESTRICTO. El estudiante debe ver cada video hasta el final antes de
 * desbloquear el siguiente; cuando todos están vistos, el padre puede
 * habilitar la entrega.
 *
 * Modelo (después de la migración 20260603180000):
 *   - Lista de videos: `project_intro_videos` ordenados por `position`.
 *   - Tracking: `project_submission_video_views` (una fila por video
 *     completo). El padre pasa los IDs ya vistos como Set.
 *
 * UX:
 *   - Renderizamos TODOS los videos en lista con un badge de estado por
 *     fila: ✓ Visto, ▶ Ver ahora, 🔒 Bloqueado.
 *   - Solo el "Ver ahora" (el primero no visto) tiene el reproductor
 *     expandido. Los vistos y los bloqueados muestran solo cabecera.
 *   - Cuando el activo termina → `onVideoWatched(videoId)`.
 *
 * Gate de seek (video directo MP4/WebM):
 *   El `<video>` nativo dispara `timeupdate`; trackeamos `maxSeen` y
 *   bloqueamos seek hacia adelante. Hacia atrás libre. YouTube/Vimeo
 *   iframe NO tiene control de seek — el alumno marca "ya vi" a mano.
 */
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Check, PlayCircle, AlertTriangle, Lock } from "lucide-react";
import { isHostedVideo, toEmbedUrl } from "@/shared/lib/video-embed";

export interface ProjectIntroVideo {
  id: string;
  url: string;
  title: string | null;
  position: number;
}

interface Props {
  /** Videos del proyecto en orden ascendente por `position`. */
  videos: ProjectIntroVideo[];
  /** IDs de videos que el estudiante YA completó. */
  watchedIds: ReadonlySet<string>;
  /** Disparado cuando el alumno completa UN video (en cualquier orden,
   *  pero el gate solo desbloquea uno a la vez). El padre persiste
   *  la view y actualiza `watchedIds`. */
  onVideoWatched: (videoId: string) => void;
}

export function ProjectIntroVideoGate({ videos, watchedIds, onVideoWatched }: Props) {
  if (videos.length === 0) return null;

  // Orden estricto: el primer video NO visto es el "activo". Los
  // anteriores ya están vistos; los siguientes bloqueados.
  const ordered = [...videos].sort((a, b) => a.position - b.position);
  const activeIndex = ordered.findIndex((v) => !watchedIds.has(v.id));
  const allDone = activeIndex === -1;

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <PlayCircle className="h-5 w-5 text-primary" />
          {ordered.length === 1 ? "Video introductorio" : `Videos introductorios (${ordered.length})`}
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
 * Reproductor de UN video con gate de seek. Mismo comportamiento que
 * el componente legacy: directo MP4/WebM tiene gate estricto; YouTube/
 * Vimeo iframe NO tiene gate técnico (el alumno marca "ya vi" a mano).
 */
function SingleVideoPlayer({
  video,
  onWatched,
}: {
  video: ProjectIntroVideo;
  onWatched: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const maxSeenRef = useRef(0);
  const [progress, setProgress] = useState(0);
  const firedRef = useRef(false);
  const kind = isHostedVideo(video.url);

  // Reset al cambiar de video (cuando el padre avanza el `activeIndex`,
  // este SingleVideoPlayer se desmonta y monta de nuevo gracias al `key`
  // del map padre). Pero por defensa, reseteamos refs al cambiar url.
  useEffect(() => {
    maxSeenRef.current = 0;
    firedRef.current = false;
    setProgress(0);
  }, [video.id]);

  // Camino hosted (YouTube/Vimeo) — sin gate técnico.
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
            onClick={() => {
              if (firedRef.current) return;
              firedRef.current = true;
              onWatched();
            }}
            className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground inline-flex items-center gap-1.5"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            Ya vi este video completo
          </button>
        </div>
      </div>
    );
  }

  // Camino directo (MP4/WebM) — gate estricto.
  return (
    <div className="space-y-2">
      <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-black">
        <video
          ref={videoRef}
          src={video.url}
          controls
          controlsList="nodownload"
          preload="metadata"
          className="absolute inset-0 w-full h-full object-contain"
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
            if (firedRef.current) return;
            firedRef.current = true;
            setProgress(1);
            onWatched();
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
