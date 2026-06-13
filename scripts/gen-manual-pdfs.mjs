// ─────────────────────────────────────────────────────────────────────────
// Genera los PDF de los manuales a partir de los .md.
//
// Flujo de regeneración (cuando cambien los .md de docs/demos/manual/):
//   node scripts/gen-manual-pdfs.mjs            → regenera TODOS los PDF
//   node scripts/gen-manual-pdfs.mjs manual-docente   → solo ese
//
// Cómo funciona:
//   1. marked convierte cada .md → HTML.
//   2. Se envuelve en una plantilla HTML con CSS de impresión.
//   3. Se escribe un .html TEMPORAL en la MISMA carpeta del .md (para que las
//      rutas relativas de imágenes `screenshots/<rol>/...` resuelvan vía file://).
//   4. Playwright (Chromium) abre ese file:// y exporta page.pdf().
//   5. Se borra el .html temporal. El PDF queda en docs/demos/manual/pdf/.
//
// NOTA (Windows): usar NODE, no bun — bun + playwright en Windows tiene un bug
// con chromium.launch() (ver CLAUDE.md / scripts/record-tour.ts). En Mac/Linux
// también corre con node sin problema.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// `marked` está disponible vía dep transitiva estable (mermaid → marked),
// suficiente para esta herramienta LOCAL de regeneración (no es código de
// runtime). `playwright` sí es dep declarada (^1.60.0).
import { marked } from "marked";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MANUAL_DIR = join(ROOT, "docs", "demos", "manual");
const OUT_DIR = join(MANUAL_DIR, "pdf");

// Los manuales a exportar (sin extensión). El índice + los 3 por rol.
const MANUALS = ["manual", "manual-administrador", "manual-docente", "manual-estudiante"];

// CSS de impresión — limpio, legible, con la marca indigo y manejo de
// saltos de página + imágenes que no se desbordan.
const CSS = `
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1e293b; line-height: 1.55; font-size: 12.5px; margin: 0;
  }
  h1 { font-size: 26px; color: #4338ca; border-bottom: 3px solid #6366f1; padding-bottom: 8px; margin: 0 0 18px; }
  h2 { font-size: 19px; color: #4338ca; margin: 28px 0 10px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  h3 { font-size: 15px; color: #3730a3; margin: 20px 0 8px; }
  h4 { font-size: 13.5px; color: #475569; margin: 16px 0 6px; }
  p { margin: 8px 0; }
  a { color: #4f46e5; text-decoration: none; }
  ul, ol { margin: 8px 0; padding-left: 22px; }
  li { margin: 4px 0; }
  code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-family: "Cascadia Code", Consolas, monospace; font-size: 0.9em; color: #be123c; }
  pre { background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: 8px; overflow-x: auto; font-size: 11px; }
  pre code { background: none; color: inherit; padding: 0; }
  blockquote { border-left: 4px solid #a5b4fc; background: #eef2ff; margin: 12px 0; padding: 8px 14px; border-radius: 0 6px 6px 0; color: #3730a3; }
  blockquote p { margin: 4px 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 11.5px; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 9px; text-align: left; vertical-align: top; }
  th { background: #eef2ff; color: #3730a3; }
  tr:nth-child(even) td { background: #f8fafc; }
  img { max-width: 100%; height: auto; border: 1px solid #e2e8f0; border-radius: 8px; margin: 10px 0; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 20px 0; }
  h1, h2, h3 { page-break-after: avoid; }
  img, pre, table { page-break-inside: avoid; }
`;

function buildHtml(title, bodyHtml) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>${title}</title><style>${CSS}</style></head>
<body>${bodyHtml}</body></html>`;
}

const only = process.argv[2]; // opcional: un manual específico
const targets = only ? MANUALS.filter((m) => m === only || m === only.replace(/\.md$/, "")) : MANUALS;
if (only && targets.length === 0) {
  console.error(`No existe el manual "${only}". Opciones: ${MANUALS.join(", ")}`);
  process.exit(1);
}

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const name of targets) {
    const mdPath = join(MANUAL_DIR, `${name}.md`);
    if (!existsSync(mdPath)) {
      console.warn(`· saltando ${name}: no existe ${mdPath}`);
      continue;
    }
    const md = readFileSync(mdPath, "utf8");
    const bodyHtml = marked.parse(md);
    // Temp HTML en la MISMA carpeta → las rutas relativas de imágenes resuelven.
    const tmpHtml = join(MANUAL_DIR, `.__tmp_${name}.html`);
    writeFileSync(tmpHtml, buildHtml(name, bodyHtml), "utf8");
    try {
      await page.goto(pathToFileURL(tmpHtml).href, { waitUntil: "networkidle" });
      const outPdf = join(OUT_DIR, `${name}.pdf`);
      await page.pdf({
        path: outPdf,
        format: "A4",
        printBackground: true,
        margin: { top: "0", bottom: "0", left: "0", right: "0" }, // los márgenes los pone @page
      });
      console.log(`OK → docs/demos/manual/pdf/${basename(outPdf)}`);
    } finally {
      rmSync(tmpHtml, { force: true });
    }
  }
} finally {
  await browser.close();
}
