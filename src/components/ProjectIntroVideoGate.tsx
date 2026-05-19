/**
 * ProjectIntroVideoGate — Reproduce el video explicativo del proyecto y
 * fuerza que el alumno lo vea entero antes de habilitar la entrega.
 *
 * Lógica de control:
 *  - El `<video>` nativo dispara `timeupdate` ~4 veces por segundo. En
 *    cada evento guardamos `Math.max(prevMax, currentTime)` en una ref
 *    — eso nos dice el punto MÁS LEJANO que el alumno ha visto.
 *  - Si el alumno arrastra el slider hacia ADELANTE más allá del punto
 *    máximo + 1s de tolerancia (para no penalizar seek-and-release de
 *    1-frame), el `seeking` handler lo devuelve al punto máximo. Hacia
 *    atrás no hay límite — puede rebobinar libremente.
 *  - `onEnded` marca `done=true` y dispara el callback `onWatched()`
 *    una sola vez. El padre persiste `video_watched_at` y des-bloquea
 *    el botón de entrega.
 *
 * Para YouTube/Vimeo iframes: NO podemos controlar seeking porque la
 * API embeddable de cada plataforma es distinta y bloquearla aporta
 * fricción. Detectamos esos hosts y mostramos un iframe simple SIN
 * gate (la confianza en YouTube es razonable: la mayoría de estudiantes
 * no manipula el reproductor). Si quieres gate estricto, sube MP4/WebM
 * directo (a Storage o tu CDN) y la URL pasará por el camino estricto.
 *
 * Persistencia: si `initialWatched` es true (porque ya completó antes),
 * arrancamos en estado `done` sin re-forzar la reproducción.
 */
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Check, PlayCircle, AlertTriangle } from "lucide-react";

interface Props {
  videoUrl: string;
  /** Si true, el alumno ya completó el video en una sesión previa.
   *  Saltamos el gate pero renderizamos el video con badge "✓ Visto". */
  initialWatched: boolean;
  /** Disparado UNA sola vez cuando el alumno termina el video en esta
   *  sesión. El padre debe persistir el estado en DB. */
  onWatched: () => void;
}

function isHostedVideo(url: string): "youtube" | "vimeo" | "direct" {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // Acepta: youtube.com, www.youtube.com, m.youtube.com, music.youtube.com,
    // youtube-nocookie.com (variantes con/sin punto inicial), youtu.be.
    if (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com") ||
      host === "youtu.be"
    ) {
      return "youtube";
    }
    if (host === "vimeo.com" || host.endsWith(".vimeo.com") || host === "player.vimeo.com") {
      return "vimeo";
    }
    return "direct";
  } catch {
    return "direct";
  }
}

function toEmbedUrl(url: string, kind: "youtube" | "vimeo"): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (kind === "youtube") {
      // Soporta los formatos comunes:
      //   youtu.be/<id>
      //   youtube.com/watch?v=<id>
      //   youtube.com/shorts/<id>
      //   youtube.com/embed/<id>     (ya está en forma de embed)
      //   youtube.com/v/<id>
      let id: string | null = null;
      if (host === "youtu.be") {
        id = u.pathname.slice(1).split("/")[0] || null;
      } else {
        // /shorts/<id>, /embed/<id>, /v/<id>
        const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([A-Za-z0-9_-]+)/);
        if (m) id = m[1];
        if (!id) id = u.searchParams.get("v");
      }
      if (!id) return url;
      // youtube-nocookie no requiere cookies de tracking — mejor para
      // entornos educativos con políticas estrictas. El comportamiento
      // de reproducción es idéntico.
      return `https://www.youtube-nocookie.com/embed/${id}?modestbranding=1&rel=0`;
    }
    if (kind === "vimeo") {
      // vimeo.com/<id> o vimeo.com/<id>/<hash>
      const segs = u.pathname.split("/").filter(Boolean);
      const id = segs[0] ?? null;
      if (!id) return url;
      // Si hay un hash de privacidad (vimeo.com/<id>/<hash>), lo
      // adjuntamos como `h=<hash>` que es el formato que requiere el
      // player para videos privados.
      const hash = segs[1] ?? null;
      const base = `https://player.vimeo.com/video/${id}`;
      return hash ? `${base}?h=${hash}` : base;
    }
  } catch {
    /* fall through */
  }
  return url;
}

export function ProjectIntroVideoGate({ videoUrl, initialWatched, onWatched }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const maxSeenRef = useRef(0);
  const [done, setDone] = useState(initialWatched);
  // Progress 0..1 para la barra de progreso visible — separada del
  // seek interno del <video>. Solo informativo.
  const [progress, setProgress] = useState(0);
  const firedRef = useRef(initialWatched);

  const kind = isHostedVideo(videoUrl);

  useEffect(() => {
    if (initialWatched) {
      setDone(true);
      firedRef.current = true;
    }
  }, [initialWatched]);

  // ── Camino YouTube/Vimeo ──
  // Sin control de seek. Si el docente confía en esto, perfecto. Si
  // necesita garantías, debe subir un MP4 directo (rama "direct" abajo).
  if (kind !== "direct") {
    return (
      <Card className="border-primary/20 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <PlayCircle className="h-5 w-5 text-primary" />
            Video introductorio del proyecto
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-black">
            <iframe
              src={toEmbedUrl(videoUrl, kind)}
              title="Video introductorio del proyecto"
              className="absolute inset-0 w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
          <Alert>
            <PlayCircle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Mira el video de introducción antes de entregar. Cuando termines, marca el botón de
              abajo para habilitar la entrega.
            </AlertDescription>
          </Alert>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                if (firedRef.current) return;
                firedRef.current = true;
                setDone(true);
                onWatched();
              }}
              disabled={done}
              className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {done ? <Check className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
              {done ? "Marcado como visto" : "Ya vi el video completo"}
            </button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Camino directo (MP4/WebM) — gate estricto ──
  // controlsList="nodownload nofullscreen noremoteplayback" reduce el
  // riesgo de bypass via picture-in-picture. preload="metadata" carga
  // dimensiones+duración sin descargar todo (ahorra ancho de banda si
  // el alumno se va antes de mirar).
  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <PlayCircle className="h-5 w-5 text-primary" />
          Video introductorio del proyecto
          {done && (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
              <Check className="h-3.5 w-3.5" /> Visto
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-black">
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            controlsList="nodownload"
            preload="metadata"
            className="absolute inset-0 w-full h-full object-contain"
            // Bloqueamos seek hacia adelante: si el alumno arrastra el
            // slider, devolvemos al `maxSeenRef + 1s` máximo.
            onSeeking={() => {
              const v = videoRef.current;
              if (!v) return;
              const max = maxSeenRef.current;
              // Tolerancia 1s — algunos browsers emiten seeking durante
              // playback normal por buffering.
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
              setDone(true);
              setProgress(1);
              onWatched();
            }}
          />
        </div>
        {/* Barra de progreso secundaria — el slider del browser ya muestra
            el avance, pero esta barra deja claro al alumno cuánto le falta
            sin necesidad de hover. */}
        <div className="h-1.5 w-full rounded bg-muted overflow-hidden">
          <div
            className={`h-full transition-all ${done ? "bg-emerald-500" : "bg-primary"}`}
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        {!done && (
          <Alert className="border-amber-300/60 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <AlertDescription className="text-xs text-amber-700 dark:text-amber-300">
              Debes ver el video hasta el final para habilitar la entrega. El reproductor no permite
              adelantar — puedes pausar o rebobinar libremente.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
