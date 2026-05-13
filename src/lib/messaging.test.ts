import { describe, expect, it } from "vitest";
import {
  filterByClearedAt,
  formatMessageTime,
  groupMessagesByDay,
  previewBody,
  relativeDayLabel,
  shouldStackWithPrevious,
  type MessageLite,
} from "./messaging";

// Anclamos `now` para que los tests sean deterministas independientemente
// del huso horario o la fecha en que corran.
const FIXED_NOW = new Date(2026, 4, 18, 14, 0, 0); // 18 mayo 2026 14:00 local

describe("relativeDayLabel", () => {
  it("'Hoy' cuando el ISO es del mismo día calendario", () => {
    const sameDay = new Date(2026, 4, 18, 9, 30, 0).toISOString();
    expect(relativeDayLabel(sameDay, FIXED_NOW)).toBe("Hoy");
  });

  it("'Ayer' cuando es el día anterior", () => {
    const yesterday = new Date(2026, 4, 17, 23, 59, 0).toISOString();
    expect(relativeDayLabel(yesterday, FIXED_NOW)).toBe("Ayer");
  });

  it("formato 'D mes YYYY' para días más antiguos", () => {
    const old = new Date(2026, 0, 15, 10, 0, 0).toISOString();
    const label = relativeDayLabel(old, FIXED_NOW);
    expect(label).toMatch(/15/);
    expect(label).toMatch(/2026/);
  });

  it("string vacío para ISO inválido", () => {
    expect(relativeDayLabel("no es fecha", FIXED_NOW)).toBe("");
  });
});

describe("groupMessagesByDay", () => {
  const msgs: MessageLite[] = [
    {
      id: "m1",
      conversation_id: "c1",
      sender_id: "u1",
      body: "hola",
      created_at: new Date(2026, 4, 17, 10, 0, 0).toISOString(),
    },
    {
      id: "m2",
      conversation_id: "c1",
      sender_id: "u2",
      body: "qué tal",
      created_at: new Date(2026, 4, 17, 10, 5, 0).toISOString(),
    },
    {
      id: "m3",
      conversation_id: "c1",
      sender_id: "u1",
      body: "todo bien",
      created_at: new Date(2026, 4, 18, 9, 0, 0).toISOString(),
    },
  ];

  it("agrupa por día calendario", () => {
    const groups = groupMessagesByDay(msgs, FIXED_NOW);
    expect(groups).toHaveLength(2);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(1);
  });

  it("etiqueta primer grupo como 'Ayer' (relativo a FIXED_NOW)", () => {
    const groups = groupMessagesByDay(msgs, FIXED_NOW);
    expect(groups[0].label).toBe("Ayer");
    expect(groups[1].label).toBe("Hoy");
  });

  it("ordena cronológicamente ascendente aunque la entrada esté desordenada", () => {
    const shuffled = [msgs[2], msgs[0], msgs[1]];
    const groups = groupMessagesByDay(shuffled, FIXED_NOW);
    expect(groups[0].items[0].id).toBe("m1");
    expect(groups[0].items[1].id).toBe("m2");
    expect(groups[1].items[0].id).toBe("m3");
  });

  it("descarta mensajes con created_at inválido", () => {
    const withBad: MessageLite[] = [
      ...msgs,
      { id: "bad", conversation_id: "c1", sender_id: "u1", body: "x", created_at: "no" },
    ];
    const groups = groupMessagesByDay(withBad, FIXED_NOW);
    const allIds = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(allIds).not.toContain("bad");
  });

  it("array vacío produce 0 grupos", () => {
    expect(groupMessagesByDay([], FIXED_NOW)).toHaveLength(0);
  });

  it("dayKey en formato YYYY-MM-DD", () => {
    const groups = groupMessagesByDay(msgs, FIXED_NOW);
    expect(groups[0].dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("formatMessageTime", () => {
  it("HH:MM 24h", () => {
    const iso = new Date(2026, 4, 18, 14, 5, 0).toISOString();
    expect(formatMessageTime(iso)).toMatch(/14:05/);
  });

  it("medianoche queda como 00:00 (hourCycle h23)", () => {
    const iso = new Date(2026, 4, 18, 0, 0, 0).toISOString();
    expect(formatMessageTime(iso)).toMatch(/00:00/);
  });
});

describe("previewBody", () => {
  it("trim y corta saltos de línea", () => {
    expect(previewBody("  hola\nmundo  ")).toBe("hola");
  });

  it("retorna '' para null/undefined/empty", () => {
    expect(previewBody(null)).toBe("");
    expect(previewBody(undefined)).toBe("");
    expect(previewBody("")).toBe("");
  });

  it("trunca con ellipsis cuando supera el max", () => {
    const longBody = "a".repeat(200);
    const result = previewBody(longBody, 80);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith("…")).toBe(true);
  });

  it("no trunca cuando está dentro del max", () => {
    expect(previewBody("corto", 80)).toBe("corto");
  });
});

describe("shouldStackWithPrevious", () => {
  const base: MessageLite = {
    id: "m1",
    conversation_id: "c1",
    sender_id: "u1",
    body: "x",
    created_at: new Date(2026, 4, 18, 10, 0, 0).toISOString(),
  };

  it("false cuando no hay previo", () => {
    expect(shouldStackWithPrevious(base, undefined)).toBe(false);
  });

  it("false cuando sender distinto", () => {
    const prev = { ...base, id: "m0", sender_id: "u2" };
    expect(shouldStackWithPrevious(base, prev)).toBe(false);
  });

  it("true cuando mismo sender y <60s de diferencia", () => {
    const prev: MessageLite = {
      ...base,
      id: "m0",
      created_at: new Date(2026, 4, 18, 10, 0, 30).toISOString(), // 30s antes
    };
    const curr: MessageLite = {
      ...base,
      created_at: new Date(2026, 4, 18, 10, 0, 50).toISOString(),
    };
    expect(shouldStackWithPrevious(curr, prev)).toBe(true);
  });

  it("false cuando >=60s de diferencia", () => {
    const prev: MessageLite = {
      ...base,
      id: "m0",
      created_at: new Date(2026, 4, 18, 10, 0, 0).toISOString(),
    };
    const curr: MessageLite = {
      ...base,
      created_at: new Date(2026, 4, 18, 10, 1, 0).toISOString(), // exactamente 60s
    };
    expect(shouldStackWithPrevious(curr, prev)).toBe(false);
  });
});

describe("filterByClearedAt", () => {
  const msgs: MessageLite[] = [
    {
      id: "m1",
      conversation_id: "c1",
      sender_id: "u1",
      body: "pre",
      created_at: "2026-05-17T10:00:00Z",
    },
    {
      id: "m2",
      conversation_id: "c1",
      sender_id: "u1",
      body: "post",
      created_at: "2026-05-18T10:00:00Z",
    },
  ];

  it("retorna todos cuando cleared_at es null", () => {
    expect(filterByClearedAt(msgs, null)).toHaveLength(2);
  });

  it("retorna todos cuando cleared_at es undefined", () => {
    expect(filterByClearedAt(msgs, undefined)).toHaveLength(2);
  });

  it("descarta los anteriores a cleared_at (strict greater)", () => {
    const out = filterByClearedAt(msgs, "2026-05-17T15:00:00Z");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("m2");
  });

  it("descarta también los iguales a cleared_at (no >=)", () => {
    const out = filterByClearedAt(msgs, "2026-05-18T10:00:00Z");
    expect(out).toHaveLength(0);
  });

  it("no muta el array original", () => {
    const copy = [...msgs];
    filterByClearedAt(msgs, "2026-05-17T15:00:00Z");
    expect(msgs).toEqual(copy);
  });
});
