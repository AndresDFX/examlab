import { describe, expect, it } from "vitest";

import {
  computeFinalGrade,
  type BreakdownItem,
  type ManualOverride,
  type QuestionPoints,
} from "./grade";

const qs: QuestionPoints[] = [
  { id: "q1", points: 4 },
  { id: "q2", points: 3 },
  { id: "q3", points: 3 },
];

describe("computeFinalGrade", () => {
  it("returns null when there are no questions", () => {
    expect(computeFinalGrade([], [], {})).toBeNull();
  });

  it("returns null when no score exists for any question", () => {
    expect(computeFinalGrade(qs, [], {})).toBeNull();
  });

  it("scales the earned total to a 0-10 grade", () => {
    const breakdown: BreakdownItem[] = [
      { qid: "q1", points: 4, earned: 4 },
      { qid: "q2", points: 3, earned: 3 },
      { qid: "q3", points: 3, earned: 3 },
    ];
    expect(computeFinalGrade(qs, breakdown, {})).toBe(10);
  });

  it("averages partial scores correctly", () => {
    const breakdown: BreakdownItem[] = [
      { qid: "q1", points: 4, earned: 2 },
      { qid: "q2", points: 3, earned: 3 },
      { qid: "q3", points: 3, earned: 0 },
    ];
    // 5 / 10 * 10 = 5
    expect(computeFinalGrade(qs, breakdown, {})).toBe(5);
  });

  it("treats missing per-question breakdown as zero", () => {
    const breakdown: BreakdownItem[] = [{ qid: "q1", points: 4, earned: 4 }];
    // 4 / 10 * 10 = 4
    expect(computeFinalGrade(qs, breakdown, {})).toBe(4);
  });

  it("lets manual overrides win over AI breakdown", () => {
    const breakdown: BreakdownItem[] = [
      { qid: "q1", points: 4, earned: 0 },
      { qid: "q2", points: 3, earned: 3 },
    ];
    const overrides: Record<string, ManualOverride> = {
      q1: { score: 4 },
    };
    // q1 (override 4) + q2 (AI 3) + q3 (none) = 7 / 10 * 10 = 7
    expect(computeFinalGrade(qs, breakdown, overrides)).toBe(7);
  });

  it("rounds to two decimals", () => {
    const breakdown: BreakdownItem[] = [
      { qid: "q1", points: 4, earned: 1 },
      { qid: "q2", points: 3, earned: 1 },
      { qid: "q3", points: 3, earned: 1 },
    ];
    // 3 / 10 * 10 = 3
    expect(computeFinalGrade(qs, breakdown, {})).toBe(3);
  });

  it("returns null when total points are zero", () => {
    const zeroQs: QuestionPoints[] = [{ id: "q1", points: 0 }];
    const breakdown: BreakdownItem[] = [{ qid: "q1", points: 0, earned: 0 }];
    expect(computeFinalGrade(zeroQs, breakdown, {})).toBeNull();
  });
});
