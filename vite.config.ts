// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // Workarounds para OOM del build cuando Rollup procesa libs pesadas
  // (Excalidraw ~1MB+ minificado, Monaco editor). Tres patas:
  //
  //   1. `optimizeDeps.exclude`: en dev evita el prebundle pesado.
  //      Excalidraw es ESM puro, no necesita la transformación de Vite.
  //   2. `manualChunks`: en build Rollup les da un chunk aparte a las
  //      libs pesadas, lo que reduce el peak de memoria durante el
  //      mangle/minify (se procesan en pasadas separadas en lugar de
  //      todo el grafo a la vez).
  //   3. `chunkSizeWarningLimit`: silenciamos el warning rote — los
  //      chunks lazy de Excalidraw/Monaco SON grandes intencionalmente
  //      y solo se descargan cuando el usuario abre la feature.
  //
  // Si vuelve a aparecer "::OOMDetails const&" en CI, considerar:
  //   - Subir `NODE_OPTIONS=--max-old-space-size=...` en package.json (8GB ahora).
  //   - Cargar Excalidraw desde CDN (sacrifica reproducibilidad pero
  //     elimina el costo de build).
  vite: {
    optimizeDeps: {
      exclude: ["@excalidraw/excalidraw"],
    },
    build: {
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          // Aisla las libs pesadas para que Rollup procese cada chunk
          // de forma independiente — sin esto, todo el grafo entra a un
          // solo mangle pass y satura V8.
          manualChunks: (id) => {
            if (id.includes("@excalidraw/excalidraw")) return "excalidraw";
            if (id.includes("monaco-editor")) return "monaco";
            return undefined;
          },
        },
      },
    },
  },
});
