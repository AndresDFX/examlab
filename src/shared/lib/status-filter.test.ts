import { describe, expect, it } from "vitest";
import {
  matchesActivityStatus,
  DEFAULT_ACTIVITY_STATUS_FILTER,
} from "./status-filter";

describe("matchesActivityStatus", () => {
  it("el default es 'activos' (oculta cerrados, muestra borradores y publicados)", () => {
    expect(DEFAULT_ACTIVITY_STATUS_FILTER).toBe("activos");
    expect(matchesActivityStatus("draft", "activos")).toBe(true);
    expect(matchesActivityStatus("published", "activos")).toBe(true);
    expect(matchesActivityStatus("closed", "activos")).toBe(false);
  });

  it("'cerrados' muestra solo los cerrados", () => {
    expect(matchesActivityStatus("closed", "cerrados")).toBe(true);
    expect(matchesActivityStatus("draft", "cerrados")).toBe(false);
    expect(matchesActivityStatus("published", "cerrados")).toBe(false);
  });

  it("'todos' muestra todo", () => {
    expect(matchesActivityStatus("draft", "todos")).toBe(true);
    expect(matchesActivityStatus("published", "todos")).toBe(true);
    expect(matchesActivityStatus("closed", "todos")).toBe(true);
  });

  it("status nullish se asume 'published' (no cerrado) → visible en activos", () => {
    expect(matchesActivityStatus(null, "activos")).toBe(true);
    expect(matchesActivityStatus(undefined, "activos")).toBe(true);
    expect(matchesActivityStatus(null, "cerrados")).toBe(false);
  });
});
