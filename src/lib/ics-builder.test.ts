import { describe, expect, it } from "vitest";
import {
  buildIcs,
  escapeText,
  foldLine,
  formatDate,
  formatUtc,
  type IcsEvent,
} from "./ics-builder";

const NOW = new Date("2026-05-19T10:30:00Z");

describe("formatUtc", () => {
  it("formatea Date como yyyymmddThhmmssZ en UTC", () => {
    expect(formatUtc(new Date("2026-05-19T14:30:00Z"))).toBe("20260519T143000Z");
  });

  it("pad de meses/días/horas con cero", () => {
    expect(formatUtc(new Date("2026-01-05T03:04:05Z"))).toBe("20260105T030405Z");
  });
});

describe("formatDate", () => {
  it("formatea Date como yyyymmdd en UTC", () => {
    expect(formatDate(new Date("2026-05-19T14:30:00Z"))).toBe("20260519");
  });
});

describe("escapeText", () => {
  it("escapa backslash, comas, punto y coma, newlines", () => {
    expect(escapeText("Hola; mundo, prueba\\")).toBe("Hola\\; mundo\\, prueba\\\\");
  });

  it("convierte LF a literal \\n", () => {
    expect(escapeText("línea1\nlínea2")).toBe("línea1\\nlínea2");
  });

  it("convierte CRLF a literal \\n", () => {
    expect(escapeText("a\r\nb")).toBe("a\\nb");
  });

  it("no toca texto sin caracteres especiales", () => {
    expect(escapeText("Examen de Cálculo I")).toBe("Examen de Cálculo I");
  });
});

describe("foldLine", () => {
  it("no toca líneas <= 75 octetos", () => {
    const short = "DESCRIPTION:abc";
    expect(foldLine(short)).toBe(short);
  });

  it("dobla líneas > 75 octetos con CRLF + espacio", () => {
    const long = "DESCRIPTION:" + "a".repeat(100);
    const out = foldLine(long);
    const parts = out.split("\r\n ");
    expect(parts.length).toBeGreaterThan(1);
    // Recompone sin folding y debe ser idéntico al original
    expect(parts.join("")).toBe(long);
    // Cada parte <= 75 octetos
    for (const p of parts) {
      expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    }
  });

  it("respeta límites multi-byte UTF-8 (sin partir un char)", () => {
    // 30 emojis (cada uno 4 bytes UTF-8) = 120 bytes
    const emoji = "🎉";
    const line = "X:" + emoji.repeat(30);
    const out = foldLine(line);
    // Cada chunk debe ser decodificable sin errores
    for (const chunk of out.split("\r\n ")) {
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(chunk))).not.toThrow();
    }
  });
});

describe("buildIcs", () => {
  it("estructura mínima válida con 0 eventos", () => {
    const ics = buildIcs({ calendarName: "Test", events: [], now: NOW });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("X-WR-CALNAME:Test");
    // Sin eventos no debe tener VEVENT
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("evento con hora específica usa DTSTART/DTEND con tiempo UTC", () => {
    const ev: IcsEvent = {
      uid: "exam-1@examlab",
      summary: "Examen Cálculo",
      start: new Date("2026-05-20T14:00:00Z"),
      end: new Date("2026-05-20T16:00:00Z"),
    };
    const ics = buildIcs({ calendarName: "X", events: [ev], now: NOW });
    expect(ics).toContain("UID:exam-1@examlab");
    expect(ics).toContain("DTSTART:20260520T140000Z");
    expect(ics).toContain("DTEND:20260520T160000Z");
    expect(ics).toContain("SUMMARY:Examen Cálculo");
  });

  it("evento all-day usa VALUE=DATE sin componente de hora", () => {
    const ev: IcsEvent = {
      uid: "workshop-9@examlab",
      summary: "Taller Polimorfismo",
      start: new Date("2026-05-25T00:00:00Z"),
      allDay: true,
    };
    const ics = buildIcs({ calendarName: "X", events: [ev], now: NOW });
    expect(ics).toContain("DTSTART;VALUE=DATE:20260525");
    expect(ics).not.toContain("DTSTART:20260525T");
  });

  it("incluye DTSTAMP usando el `now` inyectado", () => {
    const ics = buildIcs({
      calendarName: "X",
      events: [
        {
          uid: "x@examlab",
          summary: "Evento",
          start: new Date("2026-05-20T10:00:00Z"),
        },
      ],
      now: new Date("2026-05-19T08:00:00Z"),
    });
    expect(ics).toContain("DTSTAMP:20260519T080000Z");
  });

  it("escapa caracteres reservados en summary/description/location", () => {
    const ev: IcsEvent = {
      uid: "x@examlab",
      summary: "Examen; con; punto",
      description: "Línea 1\nLínea 2, con coma",
      location: "Sala 3,B",
      start: new Date("2026-05-20T10:00:00Z"),
    };
    const ics = buildIcs({ calendarName: "X", events: [ev], now: NOW });
    expect(ics).toContain("SUMMARY:Examen\\; con\\; punto");
    expect(ics).toContain("DESCRIPTION:Línea 1\\nLínea 2\\, con coma");
    expect(ics).toContain("LOCATION:Sala 3\\,B");
  });

  it("incluye URL y CATEGORIES cuando se pasan", () => {
    const ev: IcsEvent = {
      uid: "x@examlab",
      summary: "Taller",
      start: new Date("2026-05-20T10:00:00Z"),
      url: "https://app.examlab.io/app/student/workshops",
      category: "WORKSHOP",
    };
    const ics = buildIcs({ calendarName: "X", events: [ev], now: NOW });
    expect(ics).toContain("URL:https://app.examlab.io/app/student/workshops");
    expect(ics).toContain("CATEGORIES:WORKSHOP");
  });

  it("termina con CRLF final (formato esperado por clientes)", () => {
    const ics = buildIcs({ calendarName: "X", events: [], now: NOW });
    expect(ics.endsWith("\r\n")).toBe(true);
  });

  it("separa líneas con CRLF (no solo LF)", () => {
    const ics = buildIcs({ calendarName: "X", events: [], now: NOW });
    expect(ics.split("\r\n").length).toBeGreaterThan(3);
  });

  it("usa prodId personalizado si se pasa", () => {
    const ics = buildIcs({
      calendarName: "X",
      events: [],
      now: NOW,
      prodId: "-//Mi Universidad//Calendario//ES",
    });
    expect(ics).toContain("PRODID:-//Mi Universidad//Calendario//ES");
  });

  it("usa timezone X-WR-TIMEZONE configurable", () => {
    const ics = buildIcs({
      calendarName: "X",
      events: [],
      now: NOW,
      timezone: "Europe/Madrid",
    });
    expect(ics).toContain("X-WR-TIMEZONE:Europe/Madrid");
  });

  it("emite múltiples eventos en orden con sus UIDs distintos", () => {
    const evs: IcsEvent[] = [
      { uid: "a@examlab", summary: "A", start: new Date("2026-05-20T10:00:00Z") },
      { uid: "b@examlab", summary: "B", start: new Date("2026-05-21T10:00:00Z") },
      { uid: "c@examlab", summary: "C", start: new Date("2026-05-22T10:00:00Z") },
    ];
    const ics = buildIcs({ calendarName: "X", events: evs, now: NOW });
    const veventCount = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
    expect(veventCount).toBe(3);
    // Orden preservado
    const aIdx = ics.indexOf("UID:a@examlab");
    const bIdx = ics.indexOf("UID:b@examlab");
    const cIdx = ics.indexOf("UID:c@examlab");
    expect(aIdx).toBeLessThan(bIdx);
    expect(bIdx).toBeLessThan(cIdx);
  });
});
