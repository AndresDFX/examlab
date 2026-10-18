#!/usr/bin/env node
/**
 * Sirve el build estático (`dist/client`) como lo sirve Cloudflare: el archivo si existe
 * y, si no, el cascarón de la SPA (`not_found_handling: "single-page-application"` en
 * `wrangler.jsonc`). Sin eso, entrar directo a `/app/student/projects` daría 404.
 *
 * Una ruta CON extensión que no existe (un chunk viejo) responde 404 y no el cascarón:
 * devolver HTML con 200 para un .js fue lo que dejó a Safari «cargando» para siempre.
 *
 * Uso: node e2e/servidor-estatico.mjs [puerto]   (lo arranca playwright.config.ts)
 */
import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const puerto = Number(process.argv[2] ?? 4173);
const raiz = resolve(process.cwd(), "dist", "client");
const cascaron = [join(raiz, "index.html"), join(raiz, "_shell.html")].find((f) => existsSync(f));

if (!cascaron) {
  console.error("[e2e] No hay build en dist/client. Corre antes: bun run build:cf");
  process.exit(1);
}

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
};

http
  .createServer((req, res) => {
    let ruta;
    try {
      ruta = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const archivo = normalize(join(raiz, ruta));
    const dentro = archivo === raiz || archivo.startsWith(raiz + sep);
    let destino = dentro && existsSync(archivo) && statSync(archivo).isFile() ? archivo : null;
    if (!destino && extname(ruta)) {
      res.writeHead(404).end();
      return;
    }
    destino ??= cascaron;
    res.writeHead(200, {
      "Content-Type": TIPOS[extname(destino)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(destino).pipe(res);
  })
  .listen(puerto, "127.0.0.1", () => {
    console.log(`[e2e] build servido en http://127.0.0.1:${puerto}`);
  });
