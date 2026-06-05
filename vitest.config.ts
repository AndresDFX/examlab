import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      // Tests de helpers compartidos entre el frontend y los edge
      // functions de Deno. Los helpers TS puros viven en
      // supabase/functions/_shared/ y se importan vía path relativo
      // desde los edges; los tests vitest les pegan vía path absoluto.
      "supabase/functions/_shared/**/*.{test,spec}.ts",
    ],
    css: false,
    // Vitest 4 + setupFiles con `afterEach` crashea ("failed to find
    // current suite") cuando varios workers se inicializan en paralelo.
    // Forzar ejecucion secuencial ENTRE archivos resuelve sin perder
    // paralelismo dentro de cada archivo. Overhead aceptable (~10-15s
    // extra en CI vs ejecucion paralela).
    fileParallelism: false,
    // ── Coverage ──────────────────────────────────────────────────────
    // Provider v8 (nativo en Node 20+); más rápido que istanbul y no
    // requiere paquete extra que babelifique todo. Reporta text (stdout)
    // + html (browseable) + lcov (consumido por Codecov / Coveralls).
    //
    // Threshold conservador: solo lógica pura ya tiene tests. UI tsx
    // queda exluida de `include` para no bajar el porcentaje a 5%.
    // Si más adelante agregamos tests de componentes, sumamos sus
    // patrones al include.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      // Scope explícito: SOLO módulos que ya tienen cobertura ≥80%.
      // El criterio es "lo que está testeado se queda testeado" —
      // gate de NO regresión. Cuando agreguemos tests a un módulo
      // nuevo y suba a ≥80%, lo movemos al include. Esto evita que
      // un mal commit baje el % global rompiendo CI desde el día 1.
      //
      // Estado actual (run 2026-05-26, post-tests nuevos):
      //   modules/grading       84%
      //   modules/exams         87%
      //   modules/tutor        100%
      //   modules/messaging/message-tags.ts        100%  ← agregado en esta iter
      //   modules/tenants/active-role-signal.ts    100%  ← agregado en esta iter
      //   shared/lib/csv.ts      83%
      //   shared/lib/ics-builder.ts  98%
      //   shared/lib/rbac.ts     95%
      //   shared/lib/google-error.ts 100%
      //
      // Para sumar otro módulo al gate, agregalo al `include` y corre
      // `bun run test:coverage` localmente: si el global cae <80%,
      // hay que escribir más tests antes de mergear.
      include: [
        // ── Módulos con cobertura sólida ──
        "src/modules/grading/grade.ts",
        "src/modules/grading/grade-attachments.ts",
        "src/modules/exams/exam-session.ts",
        "src/modules/exams/exam-time.ts",
        "src/modules/exams/exam-attempts.ts",
        "src/modules/exams/proctoring.ts",
        "src/modules/exams/question-scoring.ts",
        "src/modules/tutor/tutor-prompt.ts",
        // ── Helpers compartidos con tests ──
        "src/shared/lib/csv.ts",
        "src/shared/lib/ics-builder.ts",
        "src/shared/lib/rbac.ts",
        "src/shared/lib/google-error.ts",
        // ── Lógica pura agregada en iteración 2026-05-26 ──
        "src/modules/messaging/message-tags.ts",
        "src/modules/tenants/active-role-signal.ts",
        // ── Otros con coverage parcial >80% ──
        "src/modules/contents/contents-display-name.ts",
        "src/modules/contents/contents-extract.ts",
        "src/modules/contents/session-dates.ts",
        "src/modules/attendance/attendance-code.ts",
        "src/modules/notifications/notification-email.ts",
        "src/modules/reports/template-engine.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.spec.ts",
        "**/*.spec.tsx",
        "src/integrations/**",
        "src/routeTree.gen.ts",
        "**/*.d.ts",
        "**/types.ts",
        "**/index.ts",
        "src/test/**",
      ],
      // Gate ESTRICTO de 80% — si una metric cae, CI falla.
      // No queremos que se merge código que reduzca coverage del
      // núcleo testeado. Para subir el threshold (ej. a 90%), basta
      // con cambiar estos números.
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
});
