import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
    // Vitest 4 + setupFiles con `afterEach` crashea ("failed to find
    // current suite") cuando varios workers se inicializan en paralelo.
    // Forzar ejecucion secuencial ENTRE archivos resuelve sin perder
    // paralelismo dentro de cada archivo. Overhead aceptable (~10-15s
    // extra en CI vs ejecucion paralela).
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
});
