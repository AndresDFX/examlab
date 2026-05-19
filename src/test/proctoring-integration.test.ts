/**
 * Integration-style test for the proctoring warning loop.
 *
 * The real take-flow wires `window.addEventListener("blur", ...)` and
 * `document.addEventListener("visibilitychange", ...)` to increment a counter
 * and autosave. We reproduce that logic headlessly against jsdom to verify
 * the counter, autosave trigger, and suspicious-state transition.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_WARNINGS, shouldMarkSuspicious, type WarningEvent } from "@/modules/exams/proctoring";

interface ProctorState {
  warnings: number;
  suspicious: boolean;
  events: WarningEvent[];
  autosaves: number;
}

function attachProctoring(state: ProctorState, onAutosave: () => void) {
  const handleBlur = () => {
    state.warnings += 1;
    state.events.push({ type: "pestaña", at: new Date().toISOString() });
    onAutosave();
    state.autosaves += 1;
    if (shouldMarkSuspicious(state.warnings)) state.suspicious = true;
  };

  const handleVisibility = () => {
    if (document.visibilityState === "hidden") {
      state.warnings += 1;
      state.events.push({ type: "visibility_hidden", at: new Date().toISOString() });
      onAutosave();
      state.autosaves += 1;
      if (shouldMarkSuspicious(state.warnings)) state.suspicious = true;
    }
  };

  window.addEventListener("blur", handleBlur);
  document.addEventListener("visibilitychange", handleVisibility);
  return () => {
    window.removeEventListener("blur", handleBlur);
    document.removeEventListener("visibilitychange", handleVisibility);
  };
}

describe("proctoring integration (blur + visibility)", () => {
  let state: ProctorState;
  let autosave: ReturnType<typeof vi.fn<() => void>>;
  let detach: () => void;

  beforeEach(() => {
    state = { warnings: 0, suspicious: false, events: [], autosaves: 0 };
    autosave = vi.fn<() => void>();
    detach = attachProctoring(state, autosave);
  });

  afterEach(() => {
    detach();
  });

  it("increments the warning counter on window blur and triggers autosave", () => {
    window.dispatchEvent(new Event("blur"));
    expect(state.warnings).toBe(1);
    expect(state.events[0]?.type).toBe("pestaña");
    expect(autosave).toHaveBeenCalledTimes(1);
    expect(state.suspicious).toBe(false);
  });

  it("flips to suspicious once warnings reach MAX_WARNINGS", () => {
    for (let i = 0; i < MAX_WARNINGS; i++) {
      window.dispatchEvent(new Event("blur"));
    }
    expect(state.warnings).toBe(MAX_WARNINGS);
    expect(state.suspicious).toBe(true);
    expect(autosave).toHaveBeenCalledTimes(MAX_WARNINGS);
  });

  it("increments on document visibility change to hidden", () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(state.warnings).toBe(1);
    expect(state.events[0]?.type).toBe("visibility_hidden");
  });

  it("does not increment when visibility returns to visible", () => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(state.warnings).toBe(0);
    expect(autosave).not.toHaveBeenCalled();
  });
});
