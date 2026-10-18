#!/usr/bin/env node
/**
 * Regenera `e2e/linea-base.json` (el trinquete): corre las pruebas en modo registro —lo
 * nuevo no las hace fallar— y guarda como conocido todo lo que bloquea hoy.
 *
 * Solo se reemplaza lo que corrió en ESTA corrida —cada pantalla en cada perfil—; lo demás
 * conserva sus entradas, así que registrar un solo perfil no borra lo de los otros. Si alguna
 * prueba falló por otra causa (no cargó, se venció el tiempo) no se escribe nada: quedaría
 * registrada una pantalla a medias.
 *
 * Uso: bun run e2e:linea-base [-- argumentos de Playwright, p. ej. --project=anchos]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ARCHIVO = resolve("e2e", "linea-base.json");
const RESULTADOS = resolve("test-results", "e2e");
const CLI = resolve("node_modules", "@playwright", "test", "cli.js");

const NOTA =
  "Problemas de UI que ya existían al instalar el trinquete o que se aceptaron después. " +
  "No frenan el despliegue; lo que no esté acá, sí. Se regenera con `bun run e2e:linea-base` " +
  "(ver e2e/README.md). Al arreglar uno, su entrada se puede borrar.";

const corrida = spawnSync(process.execPath, [CLI, "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, E2E_LINEA_BASE: "registrar" },
});
if (corrida.status !== 0) {
  console.error(
    "\n[e2e] Hubo pruebas que fallaron por otra causa: la línea base queda como estaba.",
  );
  process.exit(corrida.status ?? 1);
}

function* archivosDeHallazgos(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* archivosDeHallazgos(p);
    else if (e.name === "hallazgos.json") yield p;
  }
}

const previa = existsSync(ARCHIVO) ? JSON.parse(readFileSync(ARCHIVO, "utf8")) : { entradas: {} };
const corrieron = new Set();
const entradas = {};

for (const archivo of archivosDeHallazgos(RESULTADOS)) {
  const { capa, pantalla, perfil, hallazgos } = JSON.parse(readFileSync(archivo, "utf8"));
  corrieron.add(`${capa}|${pantalla}|${perfil}`);
  for (const h of hallazgos) {
    if (h.severidad !== "bloquea") continue;
    const e = (entradas[h.clave] ??= {
      capa,
      pantalla,
      regla: h.regla,
      elemento: h.elemento,
      ...(h.otro ? { otro: h.otro } : {}),
      detalle: h.detalle,
      perfiles: [],
    });
    if (!e.perfiles.includes(perfil)) e.perfiles.push(perfil);
  }
}

for (const [clave, e] of Object.entries(previa.entradas ?? {})) {
  const conservar = e.perfiles.filter((p) => !corrieron.has(`${e.capa}|${e.pantalla}|${p}`));
  if (!conservar.length) continue;
  const actual = (entradas[clave] ??= { ...e, perfiles: [] });
  for (const p of conservar) if (!actual.perfiles.includes(p)) actual.perfiles.push(p);
}

const ordenadas = Object.fromEntries(
  Object.keys(entradas)
    .sort()
    .map((k) => [k, { ...entradas[k], perfiles: [...entradas[k].perfiles].sort() }]),
);
writeFileSync(ARCHIVO, JSON.stringify({ nota: NOTA, entradas: ordenadas }, null, 2) + "\n");

const porRegla = {};
for (const e of Object.values(ordenadas)) porRegla[e.regla] = (porRegla[e.regla] ?? 0) + 1;
console.log(`\n[e2e] Línea base: ${Object.keys(ordenadas).length} problema(s) conocidos.`);
for (const [regla, n] of Object.entries(porRegla).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${regla}`);
}
