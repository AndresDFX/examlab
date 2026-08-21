/**
 * Paso final del build para Cloudflare: dejar el cascarón de SPA como
 * `index.html`.
 *
 * Por qué hace falta: el modo SPA de TanStack Start prerenderiza el cascarón
 * con el nombre `_shell.html`, pero el `not_found_handling:
 * "single-page-application"` de Cloudflare sirve `index.html` —y solo ese— para
 * las rutas que no existen en disco. Sin esta copia, la portada carga por
 * casualidad pero entrar directo a `/app/teacher/exams` devuelve 404, porque
 * ese archivo no existe: es una ruta del router del navegador.
 *
 * Se copia en vez de renombrar para que `_shell.html` siga estando: es lo que
 * el prerender declara como salida, y borrarlo haría que el build parezca roto
 * al compararlo con lo que TanStack dice que produce.
 *
 * Uso: `bun run build:cf` (corre el build y después esto).
 */
import { copyFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const clientDir = resolve(process.cwd(), "dist", "client");
const shell = resolve(clientDir, "_shell.html");
const index = resolve(clientDir, "index.html");

if (!existsSync(shell)) {
  console.error(
    `\n[build-cloudflare] No existe ${shell}.\n` +
      `El prerender de SPA no corrió. Revisá que vite.config.ts tenga\n` +
      `  tanstackStart: { spa: { enabled: true } }\n` +
      `y que el build haya terminado con "[prerender] Prerendered 1 pages".\n`,
  );
  process.exit(1);
}

copyFileSync(shell, index);

const kb = (p) => (statSync(p).size / 1024).toFixed(1);
console.log(`[build-cloudflare] _shell.html → index.html (${kb(index)} KB)`);
console.log(`[build-cloudflare] Listo para: wrangler deploy`);
