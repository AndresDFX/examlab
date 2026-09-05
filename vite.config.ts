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
  // ── Modo SPA: sin SSR ────────────────────────────────────────────────────
  //
  // Por qué, con números medidos (2026-08-21): el Worker SSR pesa 5,34 MB
  // gzip y el plan Free de Cloudflare Workers corta en 3 MB — el deploy
  // rebota con el error 10027. Y aun bajándolo, quedaría el segundo techo del
  // plan Free: 10 ms de CPU por request, que renderizar este árbol de React en
  // el servidor casi seguro se pasa (error 1102). Los dos límites son del SSR;
  // en SPA el servidor deja de ejecutar React y ninguno aplica.
  //
  // Por qué es seguro acá (verificado, no supuesto): la app NO tiene lógica de
  // servidor. Cero `createServerFn`, cero rutas de servidor, cero `loader:` en
  // las 84 rutas y un solo `beforeLoad`. Todos los datos ya van del navegador a
  // Supabase con la RLS haciendo el aislamiento. El SSR solo pintaba HTML que
  // después se hidrataba.
  //
  // Lo que se pierde: HTML pre-renderizado. Un bot que no ejecuta JS ve el
  // cascarón con los meta del root. Casi no duele — `/verify/$shortCode` y
  // `/reto/$pin` ya están marcadas `noindex, nofollow` a propósito, y todo
  // `/app/*` vive tras el login.
  //
  // Lo que NO se pierde: `__root.tsx` ya define `shellComponent: RootShell`, así
  // que el cascarón prerenderizado conserva los <script> pre-paint del tema y
  // del branding del tenant — el anti-flash sigue igual.
  //
  // OJO: esto diverge de Lovable, que publica con SSR. Vive en la rama
  // `deploy/cloudflare`; no mezclar a `main` sin decidir qué hace Lovable.
  tanstackStart: {
    spa: {
      enabled: true,
    },
  },

  // ── Sin el plugin de Cloudflare, a propósito ─────────────────────────────
  //
  // El destino de esta rama NO es un Worker: es el sitio ESTÁTICO que el modo
  // SPA prerenderiza en `dist/client/index.html`, servido por Cloudflare como
  // assets. Sin código de servidor no hay bundle que pese, así que los límites
  // de 3 MB y 10 ms del plan Free dejan de aplicar. Medido: activar SPA a secas
  // NO achicaba el Worker (el bundle del servidor salía idéntico, 5,34 MB gzip)
  // — lo que resuelve el problema es no desplegar Worker en absoluto.
  //
  // Además arregla un choque entre los dos plugins: el prerender de SPA importa
  // `dist/server/server.js`, pero el plugin de Cloudflare nombra esa entrada
  // `index.js`, y el build moría con ERR_MODULE_NOT_FOUND. Sin el plugin, la
  // salida vuelve al nombre que el prerender espera. El servidor que genera se
  // usa solo durante el build, para producir el HTML, y después se descarta.
  // `cloudflare: false` — y NO `nitro: false`.
  //
  // El 2026-09-05 lo cambié a `nitro` porque el chequeo de tipos rechazaba
  // `cloudflare`, y me equivoqué: lo que estaba mal era mi `node_modules`, que
  // tenía el plugin en 1.8.0 (donde la opción sí se llama `nitro`) mientras
  // `bun.lock` —lo que instala CI— fija la **1.4.0**, que declara
  // `cloudflare?: Record<string, unknown> | false`. Con el nombre "corregido" la
  // opción pasaba a ser la propiedad de más que el plugin ignora, y se perdía la
  // única línea que dice "no generes Worker".
  //
  // Si alguna vez este chequeo vuelve a marcar `cloudflare`, lo primero que hay
  // que mirar NO es el nombre de la opción: es si el `node_modules` local viene
  // del lockfile (`rm -rf node_modules && bun install --frozen-lockfile`).
  cloudflare: false,
  vite: {
    optimizeDeps: {
      exclude: ["@excalidraw/excalidraw"],
    },
    build: {
      chunkSizeWarningLimit: 2000,
    },
  },
});
