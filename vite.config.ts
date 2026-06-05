// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Workarounds para OOM del build cuando Rollup procesa libs pesadas
// (Excalidraw ~1MB+ minificado, Monaco editor). Dos patas:
//
//   1. `optimizeDeps.exclude`: en dev evita el prebundle pesado.
//      Excalidraw es ESM puro, no necesita la transformación de Vite.
//   2. `chunkSizeWarningLimit`: silenciamos el warning rote — los
//      chunks lazy de Excalidraw/Monaco SON grandes intencionalmente
//      y solo se descargan cuando el usuario abre la feature.
//
// NOTA HISTÓRICA: tuvimos un `manualChunks` que asignaba excalidraw y
// monaco a chunks aparte. Lo REMOVIMOS porque Vite/tanstack-start
// aplican la misma config tanto al bundle del cliente como al del SSR
// worker (Cloudflare). El manualChunks rompía el bundle del worker
// (Cloudflare devolvía 502 al primer request — caso reportado el
// 2026-06-05). El cliente sigue beneficiándose del code splitting
// natural de `await import(...)` que ya hace WhiteboardEditor.
//
// Memoria del build:
//   - `package.json` -> "build": "NODE_OPTIONS=--max-old-space-size=8192 vite build"
//     da headroom suficiente para el OOM original sin manualChunks.
//   - Si vuelve a aparecer "::OOMDetails const&" en CI, considerar
//     cargar Excalidraw desde CDN (sacrifica reproducibilidad pero
//     elimina el costo de build).
export default defineConfig({
  vite: {
    optimizeDeps: {
      exclude: ["@excalidraw/excalidraw"],
    },
    build: {
      chunkSizeWarningLimit: 2000,
    },
  },
});
