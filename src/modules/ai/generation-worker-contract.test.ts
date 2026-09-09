import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * La respuesta del worker de generación es una invariante CROSS-FILE entre Deno
 * y el cliente que nadie sincroniza solo, y ya se rompió dos veces:
 *
 *  - El worker devolvía `skipped: "no_sync_tenant_jobs"` y el panel que lo leía
 *    comparaba `"async_mode_no_jobid"` — un centinela renombrado en un lado y no
 *    en el otro, así que la autoexclusión por modo NUNCA se le mostró a nadie.
 *  - El worker nunca emitió `remainingPending`, y el panel lo leía igual: sin
 *    trabajos de calificación pendientes el bucle cortaba en la primera pasada
 *    y anunciaba "No quedan tareas en espera" con la cola de generación llena.
 *
 * Este test lee las dos fuentes del disco, así que cambiar una sola rompe en
 * rojo. Precedente: `src/modules/whiteboard/page-types.test.ts`.
 */

const WORKER = resolve(
  __dirname,
  "../../../supabase/functions/ai-generation-worker/index.ts",
);
const PANEL = resolve(__dirname, "./UnifiedAiQueuePanel.tsx");

const leer = (p: string) => readFileSync(p, "utf8");

describe("contrato de respuesta del worker de generación", () => {
  const worker = leer(WORKER);

  it("devuelve remainingPending (lo que el panel usa para saber si quedan tareas)", () => {
    expect(worker).toContain("remainingPending");
  });

  it("cuenta los diferidos por modo en vez de callarlos", () => {
    expect(worker).toContain("deferred");
    expect(worker).toContain("deferredIncluded");
  });

  it("acepta includeDeferred para el drenaje a mano", () => {
    expect(worker).toContain("includeDeferred");
  });

  it("ya no usa el centinela de string que nadie leía", () => {
    expect(worker).not.toContain("no_sync_tenant_jobs");
  });
});

describe("el panel consume ese contrato", () => {
  const panel = leer(PANEL);

  it("acumula las DOS colas en vez de leer solo la de calificación", () => {
    expect(panel).toContain("acumularPasada");
    expect(panel).not.toContain("g?.remainingPending ?? 0");
  });

  it("pide explícitamente los diferidos al drenar a mano", () => {
    expect(panel).toContain("includeDeferred: true");
  });

  it("mira el error de invoke (que no lanza en 4xx/5xx)", () => {
    expect(panel).toContain("drainInvokeFailed");
  });
});
