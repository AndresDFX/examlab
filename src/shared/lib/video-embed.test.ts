import { describe, expect, it } from "vitest";
import { buildVideoEmbedUrl, isHostedVideo, toEmbedUrl } from "./video-embed";

describe("isHostedVideo", () => {
  it("detecta youtube.com clasico", () => {
    expect(isHostedVideo("https://www.youtube.com/watch?v=abc123")).toBe("youtube");
  });

  it("detecta youtu.be (URL corta)", () => {
    expect(isHostedVideo("https://youtu.be/abc123")).toBe("youtube");
  });

  it("detecta youtube-nocookie como youtube", () => {
    expect(isHostedVideo("https://www.youtube-nocookie.com/embed/abc123")).toBe("youtube");
  });

  it("detecta subdominios de youtube (m., music.)", () => {
    expect(isHostedVideo("https://m.youtube.com/watch?v=abc123")).toBe("youtube");
    expect(isHostedVideo("https://music.youtube.com/watch?v=abc123")).toBe("youtube");
  });

  it("detecta vimeo.com y player.vimeo.com", () => {
    expect(isHostedVideo("https://vimeo.com/123456789")).toBe("vimeo");
    expect(isHostedVideo("https://player.vimeo.com/video/123456789")).toBe("vimeo");
  });

  it("retorna 'direct' para MP4 directo o cualquier otro host", () => {
    expect(isHostedVideo("https://cdn.example.com/video.mp4")).toBe("direct");
  });

  it("retorna 'direct' cuando el URL es invalido (no throwea)", () => {
    expect(isHostedVideo("no-es-un-url")).toBe("direct");
    expect(isHostedVideo("")).toBe("direct");
  });
});

describe("toEmbedUrl - youtube", () => {
  it("convierte watch?v= a /embed/<id> con params standard", () => {
    expect(toEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube")).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?modestbranding=1&rel=0&playsinline=1",
    );
  });

  it("convierte youtu.be/<id> a /embed/<id>", () => {
    expect(toEmbedUrl("https://youtu.be/dQw4w9WgXcQ", "youtube")).toBe(
      "https://www.youtube.com/embed/dQw4w9WgXcQ?modestbranding=1&rel=0&playsinline=1",
    );
  });

  it("convierte /shorts/<id> a /embed/<id>", () => {
    expect(toEmbedUrl("https://www.youtube.com/shorts/abc123XYZ", "youtube")).toBe(
      "https://www.youtube.com/embed/abc123XYZ?modestbranding=1&rel=0&playsinline=1",
    );
  });

  it("normaliza youtube-nocookie a www.youtube.com para evitar muro anti-bot", () => {
    // Documentado en el comentario inline: nocookie dispara el "Accede para confirmar
    // que no eres un bot". Forzamos www.youtube.com como host del embed.
    expect(toEmbedUrl("https://www.youtube-nocookie.com/embed/abc123", "youtube")).toBe(
      "https://www.youtube.com/embed/abc123?modestbranding=1&rel=0&playsinline=1",
    );
  });

  it("retorna URL original si no puede extraer el id", () => {
    const noId = "https://www.youtube.com/feed/subscriptions";
    expect(toEmbedUrl(noId, "youtube")).toBe(noId);
  });

  it("retorna URL original si el input es invalido", () => {
    expect(toEmbedUrl("no-es-un-url", "youtube")).toBe("no-es-un-url");
  });
});

describe("toEmbedUrl - vimeo", () => {
  it("convierte vimeo.com/<id> a player.vimeo.com/video/<id>", () => {
    expect(toEmbedUrl("https://vimeo.com/123456789", "vimeo")).toBe(
      "https://player.vimeo.com/video/123456789",
    );
  });

  it("preserva el hash de privacidad (vimeo.com/<id>/<hash>)", () => {
    expect(toEmbedUrl("https://vimeo.com/123456789/abc123def", "vimeo")).toBe(
      "https://player.vimeo.com/video/123456789?h=abc123def",
    );
  });

  it("retorna URL original si no hay id", () => {
    const noId = "https://vimeo.com/";
    expect(toEmbedUrl(noId, "vimeo")).toBe(noId);
  });
});

describe("buildVideoEmbedUrl", () => {
  it("happy path youtube: { kind: 'youtube', src: embed }", () => {
    const result = buildVideoEmbedUrl("https://www.youtube.com/watch?v=abc123");
    expect(result.kind).toBe("youtube");
    expect(result.src).toBe(
      "https://www.youtube.com/embed/abc123?modestbranding=1&rel=0&playsinline=1",
    );
  });

  it("happy path vimeo con hash", () => {
    const result = buildVideoEmbedUrl("https://vimeo.com/123456789/abc123");
    expect(result.kind).toBe("vimeo");
    expect(result.src).toBe("https://player.vimeo.com/video/123456789?h=abc123");
  });

  it("direct: devuelve URL original sin transformar", () => {
    const mp4 = "https://cdn.example.com/video.mp4";
    expect(buildVideoEmbedUrl(mp4)).toEqual({ kind: "direct", src: mp4 });
  });

  it("input invalido cae a 'direct' con el string tal cual", () => {
    expect(buildVideoEmbedUrl("no-es-un-url")).toEqual({
      kind: "direct",
      src: "no-es-un-url",
    });
  });
});
