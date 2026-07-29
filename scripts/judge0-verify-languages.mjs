#!/usr/bin/env node
/**
 * Verifica el mapeo de lenguajes contra la VM de Judge0 REAL.
 *
 * WHY existe: los `language_id` de Judge0 dependen de la VERSIÓN instalada.
 * Un id equivocado NO falla al arrancar — ejecuta OTRO lenguaje (mandar Kotlin
 * al compilador de Java compila y da un error de sintaxis incomprensible para
 * el alumno). Es un fallo mudo y caro de diagnosticar, así que se chequea con
 * una herramienta en vez de confiar en la memoria.
 *
 * Uso:
 *   JUDGE0_URL=http://mi-vm:2358 node scripts/judge0-verify-languages.mjs
 *   JUDGE0_URL=... JUDGE0_AUTH_TOKEN=... node scripts/judge0-verify-languages.mjs
 *
 * Qué reporta:
 *   - ids del mapeo que NO existen en la VM              → hay que corregirlos
 *   - ids cuyo NOMBRE en la VM no coincide con lo esperado → ejecutarían otro lenguaje
 *   - lenguajes del mapeo que la VM no tiene              → el ruteo debe mandarlos a otro proveedor
 *   - lenguajes que la VM ofrece y el mapeo ignora         → oportunidades
 *
 * Sale con código 1 si encuentra algo que corregir, para poder usarlo en CI.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const base = (process.env.JUDGE0_URL || "").replace(/\/+$/, "");
if (!base) {
  console.error("Falta JUDGE0_URL. Ej: JUDGE0_URL=http://mi-vm:2358 node scripts/judge0-verify-languages.mjs");
  process.exit(2);
}
const headers = {};
if (process.env.JUDGE0_AUTH_TOKEN) headers["X-Auth-Token"] = process.env.JUDGE0_AUTH_TOKEN;

/**
 * Se lee el mapeo del FUENTE (no se importa) para que el script funcione sin
 * build ni transpilación: es un .ts y esto es node crudo.
 */
function readMapping() {
  const src = readFileSync(resolve(ROOT, "src/modules/code/language-support.ts"), "utf8");
  const block = src.match(/JUDGE0_LANGUAGE_ID[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!block) throw new Error("No se pudo localizar JUDGE0_LANGUAGE_ID en language-support.ts");
  const out = {};
  for (const m of block[1].matchAll(/^\s*(\w+):\s*(\d+),?\s*(?:\/\/\s*(.*))?$/gm)) {
    out[m[1]] = { id: Number(m[2]), expected: (m[3] || "").trim() };
  }
  return out;
}

const mapping = readMapping();
console.log(`Mapeo local: ${Object.keys(mapping).length} lenguajes`);
console.log(`VM: ${base}\n`);

let res;
try {
  res = await fetch(`${base}/languages`, { headers });
} catch (e) {
  console.error(`No se pudo contactar la VM: ${e.message}`);
  console.error("Revisá que la URL sea alcanzable desde acá y que Judge0 esté corriendo.");
  process.exit(2);
}
if (!res.ok) {
  console.error(`GET /languages devolvió HTTP ${res.status}. ${res.status === 401 ? "¿Falta JUDGE0_AUTH_TOKEN?" : ""}`);
  process.exit(2);
}

const remote = await res.json();
const byId = new Map(remote.map((l) => [l.id, l.name]));
console.log(`La VM ofrece ${remote.length} lenguajes.\n`);

const problemas = [];

for (const [lang, { id, expected }] of Object.entries(mapping)) {
  const name = byId.get(id);
  if (!name) {
    problemas.push(`✗ ${lang}: el id ${id} NO existe en esta VM.`);
    // Sugerencia por nombre, para que el fix sea obvio.
    const cand = remote.filter((l) => new RegExp(lang.replace("cpp", "c\\+\\+"), "i").test(l.name));
    if (cand.length) {
      problemas.push(`    candidatos: ${cand.map((c) => `${c.id} = ${c.name}`).join(" | ")}`);
    }
    continue;
  }
  // El nombre de la VM debería mencionar el lenguaje. Si no, el id apunta a otra cosa.
  const needle = { cpp: "c++", csharp: "c#", fsharp: "f#", javascript: "javascript" }[lang] ?? lang;
  if (!name.toLowerCase().includes(needle.toLowerCase())) {
    problemas.push(`✗ ${lang}: el id ${id} en esta VM es "${name}" — NO parece ${lang}. Ejecutaría otro lenguaje.`);
  } else {
    const nota = expected && !name.startsWith(expected.split(" (")[0]) ? `  (local decía: ${expected})` : "";
    console.log(`✓ ${lang.padEnd(11)} ${String(id).padStart(3)} = ${name}${nota}`);
  }
}

// Kotlin es el objetivo de la integración: se destaca aparte.
const kotlinRemote = remote.filter((l) => /kotlin/i.test(l.name));
console.log("");
if (kotlinRemote.length === 0) {
  problemas.push(
    "✗ KOTLIN no está habilitado en esta VM. Hay que habilitarlo en Judge0 " +
      "(imagen con el compilador de Kotlin) o el ruteo lo mandará a JDoodle.",
  );
} else {
  console.log(`Kotlin disponible en la VM: ${kotlinRemote.map((k) => `${k.id} = ${k.name}`).join(" | ")}`);
}

const ignorados = remote.filter((l) => !Object.values(mapping).some((m) => m.id === l.id));
if (ignorados.length) {
  console.log(`\n${ignorados.length} lenguaje(s) que la VM ofrece y el mapeo no usa (informativo):`);
  console.log("  " + ignorados.map((l) => `${l.id}=${l.name}`).join(", "));
}

if (problemas.length) {
  console.log("\n─── A CORREGIR ───");
  problemas.forEach((p) => console.log(p));
  console.log(
    "\nCorregí los ids en src/modules/code/language-support.ts y REGENERÁ la réplica Deno\n" +
      "(supabase/functions/execute-code/language-support.ts) — el test language-support.test.ts\n" +
      "falla si divergen.",
  );
  process.exit(1);
}
console.log("\nTodo el mapeo coincide con la VM.");
