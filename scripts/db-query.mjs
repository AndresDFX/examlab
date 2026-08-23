#!/usr/bin/env node
/**
 * Consultas de lectura contra la base de producción, desde esta máquina.
 *
 *   node scripts/db-query.mjs "polls?select=id,title,poll_type&poll_type=eq.mixed"
 *   node scripts/db-query.mjs "rpc/poll_is_open" '{"_poll":"..."}'   (POST a una RPC)
 *
 * ── Por qué existe ────────────────────────────────────────────────────
 * Sin esto, cualquier dato que solo vive en la base (el UUID de una encuesta
 * para armar su enlace, el estado real de un curso, si una migración quedó
 * aplicada) obliga a pasar por el SQL Editor del dashboard a mano. Este script
 * cierra ese hueco con la credencial MÍNIMA que alcanza, y sin agregar
 * dependencias: usa el `fetch` nativo contra PostgREST.
 *
 * ── La credencial: qué usar y qué NO ──────────────────────────────────
 * Usa `SUPABASE_SERVICE_ROLE_KEY`, que se copia del dashboard de Supabase en
 * Project Settings → API. Se pone en `.env.local`, que NO se commitea (lo cubre
 * el patrón `.env.*` del .gitignore — verificalo con `git check-ignore .env.local`):
 *
 *     SUPABASE_SERVICE_ROLE_KEY=...
 *
 * Esa key es la correcta para esto porque:
 *   · Está acotada a ESTE proyecto de Supabase y a nada más.
 *   · Se rota desde el dashboard en un clic, sin tocar ninguna otra cuenta.
 *   · Es un secreto que el proyecto ya maneja (las edge functions lo usan).
 *
 * **NO usar la contraseña de GitHub ni de ninguna cuenta personal.** Una
 * contraseña de cuenta no está acotada: da acceso a todos los repos, y por SSO
 * a lo que esa identidad tenga federado. Además GitHub bloquea los inicios de
 * sesión automatizados (verificación por dispositivo, CAPTCHA), así que un
 * intento no solo falla: puede dejar la cuenta trabada.
 *
 * ── Solo lectura, a propósito ─────────────────────────────────────────
 * El service_role bypassa la RLS, así que este script se limita a GET (y POST a
 * `rpc/` para funciones de lectura). Para escribir hay dos caminos con red de
 * seguridad que ya existen: una migración versionada, o el SQL Editor con el
 * cambio a la vista. Un script que escriba a mano en prod con RLS desactivada es
 * exactamente cómo se pierde un dato sin que quede rastro.
 */
import { readFileSync } from "node:fs";

const AYUDA = `
Uso:  node scripts/db-query.mjs "<ruta PostgREST>" [cuerpo JSON para rpc/]

Ejemplos:
  node scripts/db-query.mjs "courses?select=id,name,status&limit=5"
  node scripts/db-query.mjs "polls?select=id,title&poll_type=eq.mixed&deleted_at=is.null"
  node scripts/db-query.mjs "rpc/mi_funcion_de_lectura" '{"_arg":"valor"}'
`;

/** Lee una variable de `.env.local` o del entorno, sin imprimir su valor. */
function leerSecreto(nombre) {
  if (process.env[nombre]) return process.env[nombre];
  for (const archivo of [".env.local", ".env"]) {
    try {
      const txt = readFileSync(archivo, "utf8");
      const m = txt.match(new RegExp(`^${nombre}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m"));
      if (m) return m[1];
    } catch {
      /* el archivo puede no existir */
    }
  }
  return null;
}

const ruta = process.argv[2];
if (!ruta) {
  console.log(AYUDA);
  process.exit(1);
}

const url = leerSecreto("VITE_SUPABASE_URL") ?? leerSecreto("SUPABASE_URL");
const key = leerSecreto("SUPABASE_SERVICE_ROLE_KEY");

if (!url) {
  console.error("Falta VITE_SUPABASE_URL (está en .env).");
  process.exit(2);
}
if (!key) {
  console.error(
    [
      "Falta SUPABASE_SERVICE_ROLE_KEY.",
      "",
      "Para habilitarlo, una sola vez:",
      "  1. Supabase → Project Settings → API → copiar la clave `service_role`.",
      "  2. Agregarla a .env.local (no se commitea):",
      "       SUPABASE_SERVICE_ROLE_KEY=...",
      "",
      "Es la credencial acotada a este proyecto y se rota desde el dashboard.",
      "No sirve —ni hace falta— una contraseña de cuenta personal.",
    ].join("\n"),
  );
  process.exit(3);
}

const esRpc = ruta.startsWith("rpc/");
const cuerpo = process.argv[3];

const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/${ruta}`, {
  method: esRpc ? "POST" : "GET",
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: esRpc ? (cuerpo ?? "{}") : undefined,
});

const texto = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  console.error(texto.slice(0, 1500));
  process.exit(4);
}
try {
  console.log(JSON.stringify(JSON.parse(texto), null, 2));
} catch {
  console.log(texto);
}
