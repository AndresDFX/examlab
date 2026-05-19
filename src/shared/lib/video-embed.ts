/**
 * Helpers de URL de video reutilizables.
 *
 * Convierte URLs de YouTube/Vimeo/MP4 directo a la forma `embed` adecuada
 * para `<iframe>`. Antes vivía inline en `ProjectIntroVideoGate.tsx`, lo
 * extrajimos cuando más pantallas (grabaciones de sesiones, etc.) la
 * empezaron a necesitar.
 */

export type VideoKind = "youtube" | "vimeo" | "direct";

export function isHostedVideo(url: string): VideoKind {
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

export function toEmbedUrl(url: string, kind: "youtube" | "vimeo"): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (kind === "youtube") {
      // Formatos comunes:
      //   youtu.be/<id>
      //   youtube.com/watch?v=<id>
      //   youtube.com/shorts/<id>
      //   youtube.com/embed/<id>     (ya está en forma de embed)
      //   youtube.com/v/<id>
      let id: string | null = null;
      if (host === "youtu.be") {
        id = u.pathname.slice(1).split("/")[0] || null;
      } else {
        const m = u.pathname.match(/^\/(?:shorts|embed|v)\/([A-Za-z0-9_-]+)/);
        if (m) id = m[1];
        if (!id) id = u.searchParams.get("v");
      }
      if (!id) return url;
      // Estándar `youtube.com/embed/` — el dominio `youtube-nocookie.com`
      // suele disparar el muro "Accede para confirmar que no eres un bot"
      // porque YouTube lo trata como contexto sin cookies y aplica
      // protección anti-scraping.
      return `https://www.youtube.com/embed/${id}?modestbranding=1&rel=0&playsinline=1`;
    }
    // vimeo.com/<id> o vimeo.com/<id>/<hash>
    const segs = u.pathname.split("/").filter(Boolean);
    const id = segs[0] ?? null;
    if (!id) return url;
    const hash = segs[1] ?? null;
    const base = `https://player.vimeo.com/video/${id}`;
    return hash ? `${base}?h=${hash}` : base;
  } catch {
    return url;
  }
}

/**
 * Helper de alto nivel: dado un URL cualquiera devuelve `{kind, src}`
 * con el src listo para `<iframe>` (o el URL original si es MP4 directo).
 */
export function buildVideoEmbedUrl(url: string): { kind: VideoKind; src: string } {
  const kind = isHostedVideo(url);
  if (kind === "direct") return { kind, src: url };
  return { kind, src: toEmbedUrl(url, kind) };
}
