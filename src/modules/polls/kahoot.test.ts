import { describe, it, expect } from "vitest";
import { kahootPoints, secondsLeft, KAHOOT_SHAPES } from "./kahoot";

describe("kahootPoints", () => {
  it("incorrect answer is always 0", () => {
    expect(kahootPoints({ correct: false, elapsedMs: 0, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(0);
    expect(kahootPoints({ correct: false, elapsedMs: 10000, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(0);
  });

  it("instant correct answer gets full points", () => {
    expect(kahootPoints({ correct: true, elapsedMs: 0, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(1000);
  });

  it("answering at the time limit gets half points", () => {
    expect(kahootPoints({ correct: true, elapsedMs: 20000, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(500);
  });

  it("answering at half the time gets 75% of points", () => {
    // 1 - (0.5)/2 = 0.75
    expect(kahootPoints({ correct: true, elapsedMs: 10000, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(750);
  });

  it("clamps elapsed beyond the limit to half points (never below)", () => {
    expect(kahootPoints({ correct: true, elapsedMs: 999999, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(500);
  });

  it("clamps negative elapsed to full points", () => {
    expect(kahootPoints({ correct: true, elapsedMs: -500, timeLimitSeconds: 20, maxPoints: 1000 })).toBe(1000);
  });

  it("respects maxPoints scaling", () => {
    expect(kahootPoints({ correct: true, elapsedMs: 0, timeLimitSeconds: 20, maxPoints: 2000 })).toBe(2000);
    expect(kahootPoints({ correct: true, elapsedMs: 20000, timeLimitSeconds: 20, maxPoints: 2000 })).toBe(1000);
  });

  it("zero time limit degrades to full points (no division by zero)", () => {
    expect(kahootPoints({ correct: true, elapsedMs: 0, timeLimitSeconds: 0, maxPoints: 1000 })).toBe(1000);
  });
});

describe("secondsLeft", () => {
  const start = "2026-06-09T10:00:00.000Z";
  const startMs = new Date(start).getTime();

  it("returns null when no start time", () => {
    expect(secondsLeft(null, 20, startMs)).toBeNull();
  });

  it("returns full limit at the start", () => {
    expect(secondsLeft(start, 20, startMs)).toBe(20);
  });

  it("counts down as time passes", () => {
    expect(secondsLeft(start, 20, startMs + 5000)).toBe(15);
    expect(secondsLeft(start, 20, startMs + 19000)).toBe(1);
  });

  it("never goes below 0", () => {
    expect(secondsLeft(start, 20, startMs + 25000)).toBe(0);
  });

  it("returns null for an invalid date", () => {
    expect(secondsLeft("not-a-date", 20, startMs)).toBeNull();
  });
});

describe("KAHOOT_SHAPES", () => {
  it("has exactly 4 shapes with unique keys", () => {
    expect(KAHOOT_SHAPES).toHaveLength(4);
    expect(new Set(KAHOOT_SHAPES.map((s) => s.key)).size).toBe(4);
  });

  it("each shape has bg + icon", () => {
    for (const s of KAHOOT_SHAPES) {
      expect(s.bg).toMatch(/^bg-\[#/);
      expect(["triangle", "diamond", "circle", "square"]).toContain(s.icon);
    }
  });
});
