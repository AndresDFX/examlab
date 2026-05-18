#!/usr/bin/env node
// Corre vitest solo sobre los archivos .test.{ts,tsx,js,jsx} que git
// considera modificados o nuevos (incluyendo uncommitted + last commit).
//
// Si no hay tests modificados, sale 0 — no falla el flow.
//
// El pipeline en CI usa `bun run test:run` que corre TODO. Este script
// es para uso local rápido: tras editar un test, lanzas `bun test` y
// solo corre lo que tocaste.

import { execSync, spawnSync } from "node:child_process";
import process from "node:process";

function listChangedTestFiles() {
  // Combinamos varias fuentes:
  //  - working tree no commiteado (M, A, ??)
  //  - último commit (HEAD~1..HEAD)
  // Así un test recién commiteado pero no pusheado también se corre.
  const sources = [
    "git diff --name-only HEAD",
    "git diff --name-only --cached",
    "git ls-files --others --exclude-standard",
    "git diff --name-only HEAD~1..HEAD",
  ];
  const files = new Set();
  for (const cmd of sources) {
    try {
      const out = execSync(cmd, { encoding: "utf8" }).trim();
      if (!out) continue;
      for (const line of out.split(/\r?\n/)) {
        const f = line.trim();
        if (!f) continue;
        if (/\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$/.test(f)) {
          files.add(f);
        }
      }
    } catch {
      // git puede fallar (no repo, no HEAD~1, etc.) — ignoramos esa fuente
    }
  }
  return [...files];
}

const tests = listChangedTestFiles();
if (tests.length === 0) {
  console.log("✓ No hay archivos de test modificados. (Para correr todo: bun run test:run)");
  process.exit(0);
}

console.log(`▶ Corriendo ${tests.length} test file(s) modificado(s):`);
for (const t of tests) console.log(`  · ${t}`);
console.log();

const result = spawnSync("npx", ["vitest", "run", ...tests], {
  stdio: "inherit",
  shell: true,
});
process.exit(result.status ?? 0);
