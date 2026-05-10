// Generación client-side de archivos .pptx a partir del bloque texto
// que produjo la IA (campo `body` de un FileEntry con kind='pptx-source').
//
// La IA emite estructura tipo:
//   - Slide 1 (Portada): Logo, Nombre del Tema/Curso, Institución, Autor.
//   - Slide 2 (Objetivos): ...
//   - Slide [3-N]: Desarrollo del tema con títulos y viñetas concisas
//
// Aquí parseamos esa estructura a una lista de slides (title + bullets)
// y generamos un .pptx real con `pptxgenjs`. El resultado se entrega
// como Blob para que el caller dispare la descarga vía un link <a>.
//
// Pptxgenjs admite imports en el browser; pesa ~ 200KB minified pero
// solo se carga al pulsar "Descargar .pptx" (lazy import).

// `pptxgenjs` se instala como dependencia (ver package.json). Hacemos
// import dinámico dentro de buildPptxBlob para que solo se cargue al
// pulsar "Descargar .pptx" — el bundle inicial no carga ~200KB de la
// librería innecesariamente. Tipamos como any porque sus types no
// están instalados en este proyecto.

export interface PptxBrand {
  universityName: string;
  primaryColor: string; // hex con o sin '#'
  secondaryColor: string;
  logoUrl: string | null;
  author: string | null;
}

export interface ParsedSlide {
  title: string;
  /** Cada string es una bullet o párrafo del slide. */
  bullets: string[];
  isCover?: boolean;
}

/**
 * Parser tolerante: separa el texto en líneas y agrupa cada "Slide X
 * (Título): contenido" en un objeto `ParsedSlide`. Las viñetas se
 * acumulan hasta el siguiente "Slide X" o EOF.
 *
 * Acepta variantes: "Slide 3 - Título", "Slide 3:", "Slide [3-N]:".
 */
export function parseSlideBlock(raw: string): ParsedSlide[] {
  const slides: ParsedSlide[] = [];
  const lines = raw.split(/\r?\n/);

  let current: ParsedSlide | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // "Slide 3 (Título): foo"  o  "Slide 3 - Título"  o  "- Slide 3 (Título): foo"
    const slideHead = line.match(
      /^[-*]?\s*Slide\s+\[?[\d-]+\]?\s*[(:-]\s*([^):]+)[):]?\s*:?\s*(.*)$/i,
    );
    if (slideHead) {
      if (current) slides.push(current);
      const title = slideHead[1].trim().replace(/[)\]]+$/, "");
      const rest = slideHead[2].trim();
      current = {
        title,
        bullets: rest ? [rest] : [],
        isCover: /portada|cover/i.test(title),
      };
      continue;
    }
    // viñeta: "- foo" o "* foo" o texto plano (cuelga del slide actual)
    if (current) {
      const bullet = line.replace(/^[-*•]\s*/, "").trim();
      if (bullet) current.bullets.push(bullet);
    } else {
      // Texto antes del primer "Slide …" — lo metemos como cover libre.
      current = { title: "", bullets: [line], isCover: true };
    }
  }
  if (current) slides.push(current);
  return slides;
}

function normalizeColor(c: string): string {
  // pptxgenjs requiere hex sin '#'. Devolvemos 6 chars sólidos.
  let h = c.replace("#", "").trim();
  if (h.length === 3)
    h = h
      .split("")
      .map((x) => x + x)
      .join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return "1E40AF";
  return h.toUpperCase();
}

/**
 * Construye el .pptx y retorna un Blob listo para descarga. Usa import
 * dinámico para no inflar el bundle inicial — solo se carga al pulsar
 * "Descargar .pptx".
 */
export async function buildPptxBlob(
  rawBlock: string,
  brand: PptxBrand,
  documentTitle: string,
): Promise<Blob> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // @ts-expect-error — pptxgenjs ships without bundled type defs.
  const PptxGen = ((await import(/* @vite-ignore */ "pptxgenjs")) as any).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pres: any = new PptxGen();
  pres.layout = "LAYOUT_WIDE";
  pres.title = documentTitle;
  if (brand.universityName) pres.company = brand.universityName;
  if (brand.author) pres.author = brand.author;

  const primary = normalizeColor(brand.primaryColor);
  const secondary = normalizeColor(brand.secondaryColor);

  const slides = parseSlideBlock(rawBlock);
  if (slides.length === 0) {
    // Genera al menos un slide vacío con el título para que el archivo
    // descargado nunca esté completamente vacío.
    slides.push({ title: documentTitle, bullets: ["(Sin contenido detectado)"] });
  }

  for (const s of slides) {
    const slide = pres.addSlide();
    slide.background = { color: "FFFFFF" };

    // Portada: título grande centrado, logo si existe, subtítulo con la
    // institución y el autor. Usamos el primary color como acento.
    if (s.isCover) {
      if (brand.logoUrl) {
        try {
          slide.addImage({
            path: brand.logoUrl,
            x: 0.5,
            y: 0.5,
            w: 1.6,
            h: 1.6,
          });
        } catch {
          // Logo opcional — si falla la carga no abortamos.
        }
      }
      slide.addText(s.title || documentTitle, {
        x: 0.5,
        y: 2.5,
        w: 12,
        h: 1.2,
        fontSize: 36,
        bold: true,
        color: primary,
        align: "center",
      });
      const sub = [brand.universityName, brand.author].filter(Boolean).join(" · ");
      if (sub) {
        slide.addText(sub, {
          x: 0.5,
          y: 4.2,
          w: 12,
          h: 0.6,
          fontSize: 18,
          color: secondary,
          align: "center",
        });
      }
      if (s.bullets.length) {
        slide.addText(s.bullets.join("\n"), {
          x: 0.5,
          y: 5.0,
          w: 12,
          h: 1.4,
          fontSize: 14,
          color: "333333",
          align: "center",
        });
      }
      continue;
    }

    // Slide regular: title arriba con primary color, bullets debajo.
    slide.addText(s.title || "", {
      x: 0.5,
      y: 0.4,
      w: 12,
      h: 0.8,
      fontSize: 28,
      bold: true,
      color: primary,
    });
    if (s.bullets.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: true } })),
        {
          x: 0.5,
          y: 1.4,
          w: 12,
          h: 5.6,
          fontSize: 18,
          color: "222222",
          paraSpaceAfter: 6,
        },
      );
    }
  }

  // pptxgenjs.write({ outputType: "blob" }) devuelve un Blob listo
  // para descargar. Usamos esto en vez de writeFile para controlar el
  // flujo (URL.createObjectURL + <a download>) en el caller.
  const blob: Blob = await pres.write({ outputType: "blob" });
  return blob;
}
