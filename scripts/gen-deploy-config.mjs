#!/usr/bin/env node
/**
 * Genera el `config.toml` mínimo que usa el deploy de edge functions,
 * DERIVÁNDOLO de `supabase/config.toml` en vez de mantener una copia a mano.
 *
 *   node scripts/gen-deploy-config.mjs <project_ref> > /tmp/.../config.toml
 *
 * ── Por qué existe ────────────────────────────────────────────────────
 * El paso del deploy armaba un config mínimo escrito A MANO porque el
 * `supabase/config.toml` del repo tiene claves de una versión vieja del CLI que
 * la actual rechaza. El problema: esa copia listaba 2 funciones y el repo
 * declara 14 con `verify_jwt = false`. Omitir una función NO deja su flag
 * como estaba — lo resetea a `true` en cada deploy.
 *
 * Comprobado contra producción el 2026-08-23 (un POST sin header de
 * autorización): las 2 declaradas pasaban al handler y **11 devolvían
 * `UNAUTHORIZED_NO_AUTH_HEADER`**, o sea que el gateway las cortaba antes de
 * llegar al código. Entre ellas, las que el worker invoca con la `service_role`
 * del formato nuevo (`sb_secret_*`, que NO es un JWT parseable) y
 * `retry-failed-ai-gradings`, que un cron llama por `net.http_post` mandando
 * solo `X-Trigger-Secret`. `net.http_post` es fire-and-forget: el 401 no
 * levanta excepción, no se audita y nadie se enteraba.
 *
 * Derivar del archivo del repo elimina la deriva POR CONSTRUCCIÓN: no hay dos
 * listas que puedan desincronizarse. Y como el `verify_jwt=false` de una edge
 * es lo único que la deja recibir llamadas sin JWT, la deriva silenciosa era el
 * peor modo de falla posible.
 *
 * ── Qué emite ─────────────────────────────────────────────────────────
 * Solo `project_id` y un bloque `[functions.X]` con su `verify_jwt` por cada
 * función DECLARADA en el repo que además EXISTA como carpeta. Nada de las
 * claves viejas que el CLI rechaza.
 *
 * Sale con código ≠ 0 si el repo declara una función que no tiene carpeta: eso
 * es un bloque huérfano, y desplegar con él pidiendo `--project-ref` falla o
 * (peor) pasa en silencio dejando el flag puesto sobre nada.
 */
import { readFileSync, existsSync } from "node:fs";

const ref = process.argv[2];
if (!ref) {
  console.error("uso: node scripts/gen-deploy-config.mjs <project_ref>");
  process.exit(1);
}

const toml = readFileSync("supabase/config.toml", "utf8");

/** `[functions.x]` y `[functions."x"]` — el CLI acepta las dos formas. */
const RE_BLOQUE = /^\[functions\.\"?([\w-]+)\"?\]\s*$/;

const funciones = [];
let actual = null;
for (const linea of toml.split(/\r?\n/)) {
  const m = RE_BLOQUE.exec(linea.trim());
  if (m) {
    actual = { nombre: m[1], verifyJwt: null };
    funciones.push(actual);
    continue;
  }
  if (linea.trim().startsWith("[")) {
    actual = null; // salimos del bloque de functions
    continue;
  }
  if (actual) {
    const v = /^\s*verify_jwt\s*=\s*(true|false)\s*$/.exec(linea);
    if (v) actual.verifyJwt = v[1] === "true";
  }
}

const huerfanas = funciones.filter((f) => !existsSync(`supabase/functions/${f.nombre}`));
if (huerfanas.length) {
  console.error(
    `config.toml declara ${huerfanas.length} función(es) sin carpeta en supabase/functions:\n` +
      huerfanas.map((f) => `  - ${f.nombre}`).join("\n") +
      "\nO se borró la función y quedó el bloque, o el nombre no coincide. Arreglá el config.",
  );
  process.exit(2);
}

const conFlag = funciones.filter((f) => f.verifyJwt !== null);
const salida = [`project_id = "${ref}"`, ""];
for (const f of conFlag) {
  salida.push(`[functions.${f.nombre}]`, `verify_jwt = ${f.verifyJwt}`, "");
}
process.stdout.write(salida.join("\n"));

// A stderr para que quede en el log del run sin contaminar el archivo.
const sinJwt = conFlag.filter((f) => f.verifyJwt === false).map((f) => f.nombre);
console.error(
  `config generado: ${conFlag.length} función(es) con verify_jwt declarado, ` +
    `${sinJwt.length} sin JWT: ${sinJwt.join(", ")}`,
);
