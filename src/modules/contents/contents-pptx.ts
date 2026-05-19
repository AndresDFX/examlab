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

export interface CodeBlock {
  /** Hint de lenguaje (`python`, `js`, `sql`, …) — viene del fence ```lang. */
  lang?: string;
  /** Cuerpo del bloque con indentación original preservada. */
  code: string;
}

export interface ParsedSlide {
  title: string;
  /** Cada string es una bullet o párrafo del slide. */
  bullets: string[];
  /** Bloques de código fenced (```...```) detectados en el slide. Se
   *  renderizan como panel monoespaciado debajo de las bullets, no como
   *  bullets sueltas (que perdían indentación y se veían como texto
   *  común). */
  codeBlocks?: CodeBlock[];
  isCover?: boolean;
}

/**
 * Parser tolerante: separa el texto en líneas y agrupa cada "Slide X
 * (Título): contenido" en un objeto `ParsedSlide`. Las viñetas se
 * acumulan hasta el siguiente "Slide X" o EOF.
 *
 * Acepta variantes: "Slide 3 - Título", "Slide 3:", "Slide [3-N]:".
 *
 * Bloques de código fenced (```lang ... ```) se extraen aparte:
 * preservamos la indentación de cada línea (sin trim) y los exponemos
 * en `slide.codeBlocks`. El renderer los dibuja con fuente monoespaciada
 * sobre fondo gris.
 */
export function parseSlideBlock(raw: string): ParsedSlide[] {
  const slides: ParsedSlide[] = [];
  const lines = raw.split(/\r?\n/);

  let current: ParsedSlide | null = null;
  let codeFenceLang: string | null = null;
  let codeBuf: string[] = [];

  const ensureSlide = () => {
    if (!current) current = { title: "", bullets: [], isCover: true };
    return current;
  };

  for (const rawLine of lines) {
    // Dentro de un fence: acumulamos sin tocar la línea (queremos
    // preservar indentación). El cierre `​```` puede llegar con
    // espacios alrededor; lo detectamos con trim solo a efectos de
    // matching, no del contenido.
    if (codeFenceLang !== null) {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith("```")) {
        const slide = ensureSlide();
        slide.codeBlocks = slide.codeBlocks ?? [];
        slide.codeBlocks.push({
          lang: codeFenceLang || undefined,
          code: codeBuf.join("\n"),
        });
        codeFenceLang = null;
        codeBuf = [];
      } else {
        codeBuf.push(rawLine);
      }
      continue;
    }

    const line = rawLine.trim();
    if (!line) continue;

    // Apertura de fence: ```python o solo ```
    if (line.startsWith("```")) {
      codeFenceLang = line.replace(/^```/, "").trim();
      codeBuf = [];
      ensureSlide();
      continue;
    }

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

  // Si el cierre del fence se perdió (modelo truncó o se le olvidaron
  // los ```), emitimos lo acumulado como code block igual — mejor mostrar
  // el código que perderlo.
  if (codeFenceLang !== null && codeBuf.length > 0) {
    const slide = ensureSlide();
    slide.codeBlocks = slide.codeBlocks ?? [];
    slide.codeBlocks.push({
      lang: codeFenceLang || undefined,
      code: codeBuf.join("\n"),
    });
  }
  if (current) slides.push(current);
  return slides;
}

/**
 * Inverso de `parseSlideBlock`: re-genera el bloque texto en el formato
 * que el parser entiende. Lo usa el viewer/editor inline para persistir
 * los cambios del docente al storage + al JSONB `files[].body` sin
 * romper el contrato del downloader (que sigue llamando parseSlideBlock
 * sobre el body al construir el .pptx).
 *
 * Formato emitido (estable):
 *   Slide 1 (Título): bullet o líneas iniciales
 *   - bullet 2
 *   - bullet 3
 *
 *   Slide 2 (...): ...
 *
 * Separación con doble newline entre slides para legibilidad cuando un
 * humano abre el .pptx.txt en un editor de texto.
 */
export function serializeSlides(slides: ParsedSlide[]): string {
  return slides
    .map((s, i) => {
      const title = s.title.trim() || (s.isCover ? "Portada" : "Sin título");
      const header = `Slide ${i + 1} (${title}):`;
      const bullets = (s.bullets ?? [])
        .map((b) => b.trim())
        .filter(Boolean)
        .map((b) => `- ${b}`)
        .join("\n");
      const codeBlocks = (s.codeBlocks ?? [])
        .map((cb) => `\`\`\`${cb.lang ?? ""}\n${cb.code}\n\`\`\``)
        .join("\n");
      const parts = [header, bullets, codeBlocks].filter(Boolean);
      return parts.join("\n");
    })
    .join("\n\n");
}

/**
 * Strips inline markdown for rendering en texto plano dentro de PPTX.
 * El modelo a veces emite bullets como "**Variable**: contenedor de
 * datos" — pptxgenjs no parsea Markdown, así que el slide muestra
 * literal los asteriscos. Acá los quitamos preservando el texto.
 *
 * Cubre el inventario común que sale del modelo:
 *  - **bold** / __bold__       → bold
 *  - *italic* / _italic_       → italic
 *  - `code`                    → code
 *  - ~~strike~~                → strike
 *  - # headings                → headings
 *  - [text](url)               → text
 *  - ![alt](src)               → alt
 *
 * NO maneja markdown a nivel bloque (listas anidadas, tablas) — eso ya
 * lo separamos antes en parseSlideBlock como bullets/code blocks.
 */
export function stripInlineMarkdown(raw: string): string {
  if (!raw) return "";
  let out = raw;
  // Heading prefixes "# / ## / ###" al inicio de línea.
  out = out.replace(/^\s*#{1,6}\s+/gm, "");
  // Images: ![alt](src) → alt
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links: [text](url) → text
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Bold + italic combinados ***text*** / ___text___
  out = out.replace(/(\*\*\*|___)([^*_]+?)\1/g, "$2");
  // Bold: **text** / __text__
  out = out.replace(/(\*\*|__)([^*_]+?)\1/g, "$2");
  // Italic: *text* / _text_ — guardamos los espacios alrededor.
  out = out.replace(/(?<!\w)[*_]([^*_\n]+?)[*_](?!\w)/g, "$1");
  // Strikethrough: ~~text~~
  out = out.replace(/~~([^~]+?)~~/g, "$1");
  // Inline code: `code`
  out = out.replace(/`([^`]+?)`/g, "$1");
  // HTML tags simples: <tag>x</tag> → x
  out = out.replace(/<\/?[a-z][^>]*>/gi, "");
  return out;
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
      slide.addText(stripInlineMarkdown(s.title || documentTitle), {
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
        slide.addText(s.bullets.map(stripInlineMarkdown).filter(Boolean).join("\n"), {
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

    // Slide regular: title arriba con primary color, bullets + bloques
    // de código debajo. Si hay code blocks, las bullets ocupan menos
    // alto vertical para dejar espacio al panel de código.
    slide.addText(stripInlineMarkdown(s.title || ""), {
      x: 0.5,
      y: 0.4,
      w: 12,
      h: 0.8,
      fontSize: 28,
      bold: true,
      color: primary,
    });

    const hasCode = (s.codeBlocks?.length ?? 0) > 0;
    const bulletsH = hasCode ? 2.8 : 5.6;

    if (s.bullets.length) {
      // Limpia el markdown inline de cada bullet (pptxgenjs no parsea
      // Markdown, así que sin esto el slide muestra "**Variable**:" en
      // vez de "Variable:" o un bullet en negrita). Filtramos vacíos
      // también para no pintar bullets en blanco.
      const cleanBullets = s.bullets.map(stripInlineMarkdown).filter((b) => b.trim().length > 0);
      slide.addText(
        cleanBullets.map((b) => ({ text: b, options: { bullet: true } })),
        {
          x: 0.5,
          y: 1.4,
          w: 12,
          h: bulletsH,
          fontSize: 18,
          color: "222222",
          paraSpaceAfter: 6,
          valign: "top",
        },
      );
    }

    if (hasCode) {
      // Una textbox por code block, apiladas debajo de las bullets.
      // Fuente monoespaciada + fondo gris claro + indentación preservada.
      // Si hay varios bloques los repartimos verticalmente, hasta 3
      // visibles (más de eso queda apretado — el modelo no debería emitir
      // tantos en un slide).
      const blocks = s.codeBlocks!.slice(0, 3);
      const startY = s.bullets.length ? 1.4 + bulletsH + 0.1 : 1.4;
      const totalH = 7.0 - startY - 0.2;
      const perBlockH = totalH / blocks.length;
      blocks.forEach((cb, idx) => {
        slide.addText(cb.code, {
          x: 0.5,
          y: startY + idx * perBlockH,
          w: 12,
          h: perBlockH - 0.1,
          fontSize: 12,
          fontFace: "Consolas",
          color: "1F2937",
          fill: { color: "F3F4F6" },
          valign: "top",
          margin: 6,
          // pptxgenjs respeta \n en addText; con monospace la
          // indentación visual queda correcta sin tabular.
        });
      });
    }
  }

  // pptxgenjs.write({ outputType: "blob" }) devuelve un Blob listo
  // para descargar. Usamos esto en vez de writeFile para controlar el
  // flujo (URL.createObjectURL + <a download>) en el caller.
  const blob: Blob = await pres.write({ outputType: "blob" });
  return blob;
}
