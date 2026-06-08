import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateLong,
  formatDateOnly,
  formatDateShort,
  formatDateTime,
  formatDuration,
  formatPercent,
  formatSessionLabel,
  formatTime,
  formatWeekday,
  formatWeekdayName,
} from "./format";

// Locale es-CO hardcodeado en el modulo — las assertions chequean
// componentes (dia, mes, año) en lugar de strings exactos para que sean
// robustas frente a diferencias menores entre versiones de ICU (ej:
// "sep" vs "sept" vs "sep.").

describe("formatDate", () => {
  it("formatea un Date a 'd MMM YYYY' en es-CO", () => {
    const out = formatDate(new Date(2026, 8, 30, 12, 0, 0));
    expect(out).toMatch(/30/);
    expect(out).toMatch(/sep/i);
    expect(out).toMatch(/2026/);
  });

  it("acepta ISO string", () => {
    const out = formatDate("2026-09-30T12:00:00");
    expect(out).toMatch(/30/);
    expect(out).toMatch(/2026/);
  });

  it("acepta timestamp numerico", () => {
    const out = formatDate(new Date(2026, 8, 30, 12).getTime());
    expect(out).toMatch(/30/);
  });

  it("retorna fallback en null/undefined/empty/invalido", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("")).toBe("—");
    expect(formatDate("no-es-fecha")).toBe("—");
  });

  it("respeta fallback custom", () => {
    expect(formatDate(null, "N/A")).toBe("N/A");
  });
});

describe("formatDateShort", () => {
  it("solo dia + mes (sin año)", () => {
    const out = formatDateShort(new Date(2026, 8, 30, 12));
    expect(out).toMatch(/30/);
    expect(out).toMatch(/sep/i);
    expect(out).not.toMatch(/2026/);
  });
});

describe("formatDateLong", () => {
  it("formatea con mes completo", () => {
    const out = formatDateLong(new Date(2026, 8, 30, 12));
    expect(out).toMatch(/30/);
    expect(out).toMatch(/septiembre/i);
    expect(out).toMatch(/2026/);
  });
});

describe("formatDateTime", () => {
  it("incluye hora en 24h", () => {
    const out = formatDateTime(new Date(2026, 8, 30, 14, 30, 0));
    expect(out).toMatch(/30/);
    expect(out).toMatch(/14:30/);
    expect(out).toMatch(/2026/);
  });

  it("hora cero queda 00:00", () => {
    const out = formatDateTime(new Date(2026, 8, 30, 0, 0));
    expect(out).toMatch(/00:00/);
  });
});

describe("formatTime", () => {
  it("HH:MM 24h", () => {
    expect(formatTime(new Date(2026, 8, 30, 14, 30))).toMatch(/14:30/);
    expect(formatTime(new Date(2026, 8, 30, 9, 5))).toMatch(/09:05/);
  });
});

describe("formatWeekday", () => {
  it("incluye nombre del dia + dia + mes", () => {
    // 30 sep 2026 = miercoles
    const out = formatWeekday(new Date(2026, 8, 30, 12));
    expect(out).toMatch(/miércoles/i);
    expect(out).toMatch(/30/);
    expect(out).toMatch(/septiembre/i);
  });

  it("ancla strings YYYY-MM-DD a mediodia para evitar UTC -1", () => {
    // Sin el ancla, "2026-09-30" se parsea como UTC midnight y en zonas
    // oeste de UTC puede caer en "martes 29". El modulo añade T12:00:00
    // antes de pasar al formateador para clavarlo en mediodia LOCAL.
    const out = formatWeekday("2026-09-30");
    expect(out).toMatch(/miércoles/i);
    expect(out).toMatch(/30/);
  });
});

describe("formatWeekdayName", () => {
  it("solo el nombre del dia", () => {
    const out = formatWeekdayName(new Date(2026, 8, 30, 12));
    expect(out).toMatch(/miércoles/i);
    expect(out).not.toMatch(/30/);
  });

  it("ancla YYYY-MM-DD a mediodia", () => {
    expect(formatWeekdayName("2026-09-30")).toMatch(/miércoles/i);
  });
});

describe("formatDateOnly", () => {
  it("preserva fechas YYYY-MM-DD sin descontar dia por UTC", () => {
    // El bug clasico: new Date("2026-09-30") → UTC 00:00 → en local oeste
    // de UTC cae en "29 sep". formatDateOnly añade T12:00:00 antes de
    // formatear.
    const out = formatDateOnly("2026-09-30");
    expect(out).toMatch(/30/);
    expect(out).toMatch(/sep/i);
  });

  it("acepta tambien ISO completo sin tocarlo", () => {
    const out = formatDateOnly("2026-09-30T18:00:00.000Z");
    expect(out).toMatch(/2026/);
  });

  it("retorna fallback en null/empty", () => {
    expect(formatDateOnly(null)).toBe("—");
    expect(formatDateOnly("")).toBe("—");
    expect(formatDateOnly(undefined as unknown as string)).toBe("—");
  });
});

describe("formatSessionLabel", () => {
  it("devuelve 'fecha - título' con guion", () => {
    const out = formatSessionLabel("2026-09-30", "Clase 1 — Intro");
    expect(out).toMatch(/30/);
    expect(out).toMatch(/sep/i);
    expect(out).toMatch(/2026/);
    // El separador es un guion con espacios, no un punto medio.
    expect(out).toContain(" - Clase 1 — Intro");
  });

  it("ancla YYYY-MM-DD a mediodía local (sin descontar día por UTC)", () => {
    // Mismo bug que formatDateOnly: "2026-09-30" como UTC midnight cae en
    // "29 sep" en zonas oeste de UTC. formatSessionLabel usa formatDateOnly.
    const out = formatSessionLabel("2026-09-30", "X");
    expect(out).toMatch(/30/);
  });

  it("sin título → solo la fecha", () => {
    const out = formatSessionLabel("2026-09-30");
    expect(out).toMatch(/30/);
    expect(out).not.toContain(" - ");
  });

  it("título null/undefined/vacío/espacios → solo la fecha", () => {
    expect(formatSessionLabel("2026-09-30", null)).not.toContain(" - ");
    expect(formatSessionLabel("2026-09-30", undefined)).not.toContain(" - ");
    expect(formatSessionLabel("2026-09-30", "")).not.toContain(" - ");
    expect(formatSessionLabel("2026-09-30", "   ")).not.toContain(" - ");
  });

  it("recorta espacios del título", () => {
    expect(formatSessionLabel("2026-09-30", "  Clase  ")).toContain(" - Clase");
  });

  it("session_date nulo/vacío → fallback '—' (sin guion si no hay título)", () => {
    expect(formatSessionLabel(null)).toBe("—");
    expect(formatSessionLabel("")).toBe("—");
    expect(formatSessionLabel(undefined)).toBe("—");
  });

  it("session_date nulo pero con título → '— - Título'", () => {
    expect(formatSessionLabel(null, "Clase")).toBe("— - Clase");
  });
});

describe("formatDuration", () => {
  it("solo minutos cuando < 60", () => {
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(15)).toBe("15m");
    expect(formatDuration(59)).toBe("59m");
  });

  it("horas exactas", () => {
    expect(formatDuration(60)).toBe("1h");
    expect(formatDuration(120)).toBe("2h");
  });

  it("horas + minutos", () => {
    expect(formatDuration(90)).toBe("1h 30m");
    expect(formatDuration(125)).toBe("2h 5m");
  });

  it("redondea hacia abajo (floor)", () => {
    expect(formatDuration(90.7)).toBe("1h 30m");
  });

  it("retorna em-dash en null/NaN/negativo/0", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
    expect(formatDuration(0)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("usa coma como separador decimal en es-CO", () => {
    expect(formatPercent(33.33)).toBe("33,33");
  });

  it("max 2 decimales", () => {
    expect(formatPercent(33.336)).toBe("33,34");
  });

  it("entero sin decimales", () => {
    expect(formatPercent(30)).toBe("30");
  });

  it("cero", () => {
    expect(formatPercent(0)).toBe("0");
  });

  it("null/NaN/undefined → 0", () => {
    expect(formatPercent(null)).toBe("0");
    expect(formatPercent(undefined)).toBe("0");
    expect(formatPercent(Number.NaN)).toBe("0");
  });
});
