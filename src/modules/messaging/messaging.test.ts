import { describe, expect, it } from "vitest";
import {
  canEditOrDeleteMessage,
  filterByClearedAt,
  formatMessageTime,
  groupMessagesByDay,
  isMessageReadByOther,
  previewBody,
  relativeDayLabel,
  searchMessages,
  shouldStackWithPrevious,
  splitByMatch,
  unansweredConversationsCount,
  unreadCount,
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

describe("unreadCount", () => {
  const me = "user-me";
  const them = "user-them";
  const msgs: MessageLite[] = [
    { id: "m1", conversation_id: "c1", sender_id: them, body: "1", created_at: "2026-05-17T10:00:00Z" },
    { id: "m2", conversation_id: "c1", sender_id: me, body: "2", created_at: "2026-05-17T11:00:00Z" },
    { id: "m3", conversation_id: "c1", sender_id: them, body: "3", created_at: "2026-05-18T10:00:00Z" },
    { id: "m4", conversation_id: "c1", sender_id: them, body: "4", created_at: "2026-05-18T11:00:00Z" },
  ];

  it("retorna 0 cuando myUserId es null", () => {
    expect(unreadCount(msgs, "2026-01-01", null)).toBe(0);
  });

  it("cuenta solo mensajes ajenos", () => {
    // lastReadAt = null → todos los ajenos cuentan (3).
    expect(unreadCount(msgs, null, me)).toBe(3);
  });

  it("aplica lastReadAt strict greater", () => {
    // Después de 2026-05-17T15:00 → solo m3 y m4 cuentan (2).
    expect(unreadCount(msgs, "2026-05-17T15:00:00Z", me)).toBe(2);
  });

  it("nunca cuenta mis propios mensajes", () => {
    const onlyMine: MessageLite[] = [
      { id: "m1", conversation_id: "c1", sender_id: me, body: "a", created_at: "2026-05-18T11:00:00Z" },
    ];
    expect(unreadCount(onlyMine, null, me)).toBe(0);
  });

  it("0 si lastReadAt es posterior a todos los mensajes", () => {
    expect(unreadCount(msgs, "2030-01-01T00:00:00Z", me)).toBe(0);
  });
});

describe("searchMessages", () => {
  const msgs: MessageLite[] = [
    { id: "m1", conversation_id: "c", sender_id: "u", body: "Hola mundo", created_at: "2026-01-01T00:00:00Z" },
    { id: "m2", conversation_id: "c", sender_id: "u", body: "MUNDO feliz", created_at: "2026-01-01T00:01:00Z" },
    { id: "m3", conversation_id: "c", sender_id: "u", body: "otra cosa", created_at: "2026-01-01T00:02:00Z" },
  ];

  it("retorna todos cuando el query está vacío", () => {
    expect(searchMessages(msgs, "")).toHaveLength(3);
    expect(searchMessages(msgs, "  ")).toHaveLength(3);
  });

  it("es case-insensitive", () => {
    const result = searchMessages(msgs, "mundo");
    expect(result.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("retorna [] sin matches", () => {
    expect(searchMessages(msgs, "noexiste")).toHaveLength(0);
  });
});

describe("unansweredConversationsCount", () => {
  const me = "user-me";
  const them1 = "user-1";
  const them2 = "user-2";

  it("retorna 0 cuando myUserId es null", () => {
    const msgs: MessageLite[] = [
      { id: "m1", conversation_id: "c1", sender_id: them1, body: "x", created_at: "2026-01-01T00:00:00Z" },
    ];
    expect(unansweredConversationsCount(msgs, null)).toBe(0);
    expect(unansweredConversationsCount(msgs, undefined)).toBe(0);
  });

  it("0 cuando no hay mensajes", () => {
    expect(unansweredConversationsCount([], me)).toBe(0);
  });

  it("cuenta una conv cuyo último mensaje es del otro", () => {
    const msgs: MessageLite[] = [
      { id: "m1", conversation_id: "c1", sender_id: me, body: "a", created_at: "2026-01-01T10:00:00Z" },
      { id: "m2", conversation_id: "c1", sender_id: them1, body: "b", created_at: "2026-01-02T10:00:00Z" },
    ];
    expect(unansweredConversationsCount(msgs, me)).toBe(1);
  });

  it("NO cuenta una conv cuyo último mensaje es mío", () => {
    const msgs: MessageLite[] = [
      { id: "m1", conversation_id: "c1", sender_id: them1, body: "a", created_at: "2026-01-01T10:00:00Z" },
      { id: "m2", conversation_id: "c1", sender_id: me, body: "b", created_at: "2026-01-02T10:00:00Z" },
    ];
    expect(unansweredConversationsCount(msgs, me)).toBe(0);
  });

  it("cuenta cada conversación independiente", () => {
    const msgs: MessageLite[] = [
      { id: "m1", conversation_id: "c1", sender_id: them1, body: "a", created_at: "2026-01-02T00:00:00Z" },
      { id: "m2", conversation_id: "c2", sender_id: me, body: "b", created_at: "2026-01-02T00:00:00Z" },
      { id: "m3", conversation_id: "c3", sender_id: them2, body: "c", created_at: "2026-01-02T00:00:00Z" },
    ];
    expect(unansweredConversationsCount(msgs, me)).toBe(2); // c1 y c3
  });

  it("acepta mensajes desordenados — usa created_at, no orden de array", () => {
    const msgs: MessageLite[] = [
      { id: "m2", conversation_id: "c1", sender_id: me, body: "b", created_at: "2026-01-05T00:00:00Z" },
      { id: "m1", conversation_id: "c1", sender_id: them1, body: "a", created_at: "2026-01-01T00:00:00Z" },
    ];
    // Último por created_at es m2 (mío) → no cuenta.
    expect(unansweredConversationsCount(msgs, me)).toBe(0);
  });

  it("ignora conversación con solo mensaje mío", () => {
    const msgs: MessageLite[] = [
      { id: "m1", conversation_id: "c1", sender_id: me, body: "a", created_at: "2026-01-01T00:00:00Z" },
    ];
    expect(unansweredConversationsCount(msgs, me)).toBe(0);
  });
});

describe("splitByMatch", () => {
  it("retorna un solo segmento sin match si el query es vacío", () => {
    const result = splitByMatch("Hola mundo", "");
    expect(result).toEqual([{ text: "Hola mundo", isMatch: false }]);
  });

  it("parte 'Hola mundo' por 'mundo' en 2 segmentos", () => {
    const result = splitByMatch("Hola mundo", "mundo");
    expect(result).toEqual([
      { text: "Hola ", isMatch: false },
      { text: "mundo", isMatch: true },
    ]);
  });

  it("captura múltiples matches", () => {
    const result = splitByMatch("abc abc abc", "abc");
    expect(result.filter((s) => s.isMatch)).toHaveLength(3);
  });

  it("preserva el casing original", () => {
    const result = splitByMatch("Hola Mundo", "mundo");
    const match = result.find((s) => s.isMatch);
    expect(match?.text).toBe("Mundo");
  });

  it("sin matches: un solo segmento isMatch=false", () => {
    const result = splitByMatch("nada", "xyz");
    expect(result).toEqual([{ text: "nada", isMatch: false }]);
  });
});

describe("isMessageReadByOther", () => {
  it("false cuando otherLastReadAt es null (el otro nunca abrió)", () => {
    expect(isMessageReadByOther("2026-05-20T10:00:00Z", null)).toBe(false);
  });

  it("false cuando otherLastReadAt es undefined", () => {
    expect(isMessageReadByOther("2026-05-20T10:00:00Z", undefined)).toBe(false);
  });

  it("false cuando el otro leyó ANTES de que llegara el mensaje", () => {
    expect(isMessageReadByOther("2026-05-20T10:00:00Z", "2026-05-20T09:00:00Z")).toBe(false);
  });

  it("true cuando el otro leyó DESPUÉS de que llegara el mensaje", () => {
    expect(isMessageReadByOther("2026-05-20T10:00:00Z", "2026-05-20T11:00:00Z")).toBe(true);
  });

  it("true cuando el timestamp del read coincide exactamente con created_at", () => {
    // Edge case: race condition donde mark_conversation_read se dispara
    // exactamente en el mismo timestamp del INSERT. Lo tratamos como
    // "ya leído" — preferimos congelar antes que dejar editar.
    expect(isMessageReadByOther("2026-05-20T10:00:00Z", "2026-05-20T10:00:00Z")).toBe(true);
  });

  it("compara como strings ISO (lexicográficamente)", () => {
    // 9 < 10 lexicográfico falla con timestamps sin padding, pero los
    // ISO siempre tienen padding fijo (HH:MM:SS) → comparación segura.
    expect(isMessageReadByOther("2026-05-20T09:59:59Z", "2026-05-20T10:00:00Z")).toBe(true);
  });
});

describe("canEditOrDeleteMessage", () => {
  const baseParams = {
    senderId: "me",
    myUserId: "me",
    messageCreatedAt: "2026-05-20T10:00:00Z",
    otherSideLastReadAt: null as string | null,
  };

  it("false cuando myUserId es null (sin sesión)", () => {
    expect(canEditOrDeleteMessage({ ...baseParams, myUserId: null })).toBe(false);
  });

  it("false cuando myUserId es undefined", () => {
    expect(canEditOrDeleteMessage({ ...baseParams, myUserId: undefined })).toBe(false);
  });

  it("false cuando el mensaje NO es mío (sender distinto)", () => {
    expect(canEditOrDeleteMessage({ ...baseParams, senderId: "other" })).toBe(false);
  });

  it("true cuando es mío y el otro NO lo ha leído", () => {
    expect(canEditOrDeleteMessage({ ...baseParams, otherSideLastReadAt: null })).toBe(true);
  });

  it("true cuando es mío y el otro leyó ANTES del mensaje", () => {
    expect(
      canEditOrDeleteMessage({ ...baseParams, otherSideLastReadAt: "2026-05-20T09:00:00Z" }),
    ).toBe(true);
  });

  it("false cuando es mío pero el otro YA lo leyó (después de created_at)", () => {
    expect(
      canEditOrDeleteMessage({ ...baseParams, otherSideLastReadAt: "2026-05-20T11:00:00Z" }),
    ).toBe(false);
  });

  it("false cuando el read_at coincide exactamente con el created_at", () => {
    // Mismo razonamiento que isMessageReadByOther: preferimos congelar.
    expect(
      canEditOrDeleteMessage({ ...baseParams, otherSideLastReadAt: "2026-05-20T10:00:00Z" }),
    ).toBe(false);
  });
});
