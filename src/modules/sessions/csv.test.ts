/**
 * Tests del CSV de sesiones. Cubre los 4 helpers PUROS extraídos de
 * `app.teacher.attendance.tsx`:
 *
 *   - parseHHMMToMinutes / addMinutesToHHMM (utilities de tiempo).
 *   - buildSessionsRows                       (export).
 *   - parseSessionsCsv                        (import).
 *
 * El objetivo es validar:
 *   1. El header del template coincide con las columnas del builder
 *      (invariante de round-trip).
 *   2. Los formatos HH:MM / HH:MM:SS se aceptan; basura → null.
 *   3. Backward-compat: filas legacy con `duration_minutes` (sin
 *      `end_time`) siguen importándose.
 *   4. Errores claros con número de fila Excel-style cuando faltan
 *      campos obligatorios o el dato es inconsistente.
 *   5. Round-trip: build → parse devuelve los mismos datos.
 */
import { describe, expect, it } from "vitest";
import {
  SESSIONS_TEMPLATE,
  SESSIONS_CSV_COLUMNS,
  parseHHMMToMinutes,
  addMinutesToHHMM,
  buildSessionsRows,
  parseSessionsCsv,
  type SessionForCsv,
} from "./csv";

describe("SESSIONS_TEMPLATE", () => {
  it("header coincide con SESSIONS_CSV_COLUMNS (round-trip invariant)", () => {
    const header = SESSIONS_TEMPLATE.split("\n")[0];
    expect(header).toBe(SESSIONS_CSV_COLUMNS.join(","));
  });

  it("incluye las columnas nuevas start_time + end_time", () => {
    expect(SESSIONS_CSV_COLUMNS).toContain("start_time");
    expect(SESSIONS_CSV_COLUMNS).toContain("end_time");
  });

  it("incluye al menos una fila demo con start + end válidos", () => {
    const lines = SESSIONS_TEMPLATE.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    // Segunda línea: "2026-06-14,...,18:00,20:00,..."
    expect(lines[1]).toContain("18:00,20:00");
  });
});

describe("parseHHMMToMinutes", () => {
  it("HH:MM válido → minutos del día", () => {
    expect(parseHHMMToMinutes("00:00")).toBe(0);
    expect(parseHHMMToMinutes("09:30")).toBe(9 * 60 + 30);
    expect(parseHHMMToMinutes("23:59")).toBe(23 * 60 + 59);
  });

  it("HH:MM:SS también es aceptado (Postgres TIME)", () => {
    expect(parseHHMMToMinutes("18:00:00")).toBe(18 * 60);
    expect(parseHHMMToMinutes("07:45:30")).toBe(7 * 60 + 45);
  });

  it("hora de 1 dígito (H:MM) aceptada", () => {
    expect(parseHHMMToMinutes("9:30")).toBe(9 * 60 + 30);
  });

  it("trim de whitespace", () => {
    expect(parseHHMMToMinutes("  09:30  ")).toBe(9 * 60 + 30);
  });

  it("formato inválido → null (NO NaN)", () => {
    expect(parseHHMMToMinutes("")).toBeNull();
    expect(parseHHMMToMinutes("9")).toBeNull();
    expect(parseHHMMToMinutes("9-30")).toBeNull();
    expect(parseHHMMToMinutes("foo")).toBeNull();
    expect(parseHHMMToMinutes("25:00")).toBeNull(); // hora > 23
    expect(parseHHMMToMinutes("12:60")).toBeNull(); // min > 59
    expect(parseHHMMToMinutes("12:5")).toBeNull(); // min 1-dígito no aceptado
  });
});

describe("addMinutesToHHMM", () => {
  it("suma básica con padding", () => {
    expect(addMinutesToHHMM("09:30", 60)).toBe("10:30");
    expect(addMinutesToHHMM("18:00", 120)).toBe("20:00");
    expect(addMinutesToHHMM("09:00", 5)).toBe("09:05");
  });

  it("wraparound a 24h", () => {
    // 23:30 + 60 → 00:30 del día siguiente.
    expect(addMinutesToHHMM("23:30", 60)).toBe("00:30");
  });

  it("HH:MM inválido → string vacío (NO crashea)", () => {
    expect(addMinutesToHHMM("", 60)).toBe("");
    expect(addMinutesToHHMM("foo", 60)).toBe("");
  });
});

describe("buildSessionsRows — export", () => {
  it("emite end_time = start + duration", () => {
    const sessions: SessionForCsv[] = [
      {
        session_date: "2026-06-14",
        title: "Clase 1",
        start_time: "18:00:00",
        duration_minutes: 120,
        meeting_url: "https://meet.google.com/abc",
        cut_id: "cut-1",
        recording_url: null,
      },
    ];
    const cutNameById = new Map([["cut-1", "Corte 1"]]);
    const rows = buildSessionsRows(sessions, cutNameById);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      session_date: "2026-06-14",
      title: "Clase 1",
      start_time: "18:00", // HH:MM:SS → HH:MM en CSV
      end_time: "20:00",
      meeting_url: "https://meet.google.com/abc",
      cut_name: "Corte 1",
      recording_url: "",
      session_type: "virtual", // sin session_type en la entrada → default
    });
  });

  it("start_time vacío → end_time vacío (no inventa)", () => {
    const rows = buildSessionsRows(
      [
        {
          session_date: "2026-06-14",
          title: null,
          start_time: null,
          duration_minutes: 90,
        },
      ],
      new Map(),
    );
    expect(rows[0].start_time).toBe("");
    expect(rows[0].end_time).toBe("");
  });

  it("duration_minutes null → end_time vacío (no asume 0)", () => {
    const rows = buildSessionsRows(
      [
        {
          session_date: "2026-06-14",
          title: "X",
          start_time: "18:00",
          duration_minutes: null,
        },
      ],
      new Map(),
    );
    expect(rows[0].start_time).toBe("18:00");
    expect(rows[0].end_time).toBe("");
  });

  it("cut_id sin match en map → cut_name vacío (no crash)", () => {
    const rows = buildSessionsRows(
      [
        {
          session_date: "2026-06-14",
          title: "X",
          cut_id: "missing",
        },
      ],
      new Map(),
    );
    expect(rows[0].cut_name).toBe("");
  });

  it("title null y meeting/recording null → strings vacíos", () => {
    const rows = buildSessionsRows(
      [{ session_date: "2026-06-14", title: null }],
      new Map(),
    );
    expect(rows[0].title).toBe("");
    expect(rows[0].meeting_url).toBe("");
    expect(rows[0].recording_url).toBe("");
  });

  it("SIEMPRE emite todas las columnas (incl. start_time/end_time) aun con start/duration null", () => {
    // Bug FESNA: sesiones sin start_time/duration omitían las columnas de
    // hora en el export. buildSessionsRows debe emitir TODAS las claves de
    // SESSIONS_CSV_COLUMNS en cada fila — vacías cuando no hay dato.
    const rows = buildSessionsRows(
      [
        { session_date: "2026-06-14", title: null, start_time: null, duration_minutes: null },
        { session_date: "2026-06-16", title: "Solo inicio", start_time: "18:00", duration_minutes: null },
        { session_date: "2026-06-18", title: "Completa", start_time: "18:00", duration_minutes: 120 },
      ],
      new Map(),
    );
    for (const row of rows) {
      // Cada fila debe tener EXACTAMENTE las columnas del CSV.
      expect(Object.keys(row).sort()).toEqual([...SESSIONS_CSV_COLUMNS].sort());
      // start_time / end_time presentes como claves siempre (string, nunca undefined).
      expect(typeof row.start_time).toBe("string");
      expect(typeof row.end_time).toBe("string");
    }
    // Fila sin datos de hora → ambas vacías (no inventa).
    expect(rows[0].start_time).toBe("");
    expect(rows[0].end_time).toBe("");
    // Inicio sin duración → start presente, end vacío.
    expect(rows[1].start_time).toBe("18:00");
    expect(rows[1].end_time).toBe("");
    // Inicio + duración → end derivado de start + duration.
    expect(rows[2].start_time).toBe("18:00");
    expect(rows[2].end_time).toBe("20:00");
  });
});

describe("parseSessionsCsv — import", () => {
  const emptyCuts = new Map<string, string>();

  it("header nuevo: parsea filas con start + end", () => {
    const { rows } = parseSessionsCsv(
      [
        {
          session_date: "2026-06-14",
          title: "Clase 1",
          start_time: "18:00",
          end_time: "20:00",
          meeting_url: "https://meet.google.com/abc",
          cut_name: "",
          recording_url: "",
        },
      ],
      emptyCuts,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_date: "2026-06-14",
      title: "Clase 1",
      start_time: "18:00",
      duration_minutes: 120, // 20:00 - 18:00
      meeting_url: "https://meet.google.com/abc",
      recording_url: null,
      cut_id: null,
    });
  });

  it("start sin end + sin duration legacy → start guardado, duration null (NO default 90)", () => {
    // El backend (DB) acepta start_time sin duration. El default 90 que
    // pide el spec se aplica en el FORM manual, no en el importer —
    // acá la regla es "respeta lo que viene, no inventes".
    const { rows } = parseSessionsCsv(
      [
        {
          session_date: "2026-06-14",
          title: "X",
          start_time: "18:00",
          end_time: "",
          cut_name: "",
        },
      ],
      emptyCuts,
    );
    expect(rows[0].start_time).toBe("18:00");
    expect(rows[0].duration_minutes).toBeNull();
  });

  it("end sin start → error con número de fila Excel-style", () => {
    expect(() =>
      parseSessionsCsv(
        [
          {
            session_date: "2026-06-14",
            title: "X",
            start_time: "",
            end_time: "20:00",
            cut_name: "",
          },
        ],
        emptyCuts,
      ),
    ).toThrow(/Fila 2.*end_time sin start_time/);
  });

  it("session_date vacío → error con número de fila", () => {
    expect(() =>
      parseSessionsCsv(
        [{ session_date: "", title: "X", start_time: "", end_time: "", cut_name: "" }],
        emptyCuts,
      ),
    ).toThrow(/Fila 2.*session_date es obligatorio/);
  });

  it("session_date mal formado → error mencionando el valor", () => {
    expect(() =>
      parseSessionsCsv(
        [{ session_date: "06/14/2026", title: "X", start_time: "", end_time: "", cut_name: "" }],
        emptyCuts,
      ),
    ).toThrow(/Fila 2.*06\/14\/2026.*YYYY-MM-DD/);
  });

  it("número de fila respeta el ÍNDICE en el array (línea Excel = idx + 2)", () => {
    // Header = línea 1, primera fila = línea 2 → la 3ª fila del array es línea 4.
    const rows = [
      { session_date: "2026-06-14", title: "ok 1", start_time: "", end_time: "", cut_name: "" },
      { session_date: "2026-06-15", title: "ok 2", start_time: "", end_time: "", cut_name: "" },
      { session_date: "", title: "boom", start_time: "", end_time: "", cut_name: "" },
    ];
    expect(() => parseSessionsCsv(rows, emptyCuts)).toThrow(/Fila 4/);
  });

  it("backward-compat: CSV legacy con duration_minutes se importa", () => {
    const { rows } = parseSessionsCsv(
      [
        {
          session_date: "2026-06-14",
          title: "Clase legacy",
          start_time: "18:00",
          end_time: "",
          duration_minutes: "90",
          meeting_url: "",
          cut_name: "",
          recording_url: "",
        },
      ],
      emptyCuts,
    );
    expect(rows[0].duration_minutes).toBe(90);
  });

  it("end <= start → duration cae al legacy duration_minutes (no negativo)", () => {
    const { rows } = parseSessionsCsv(
      [
        {
          session_date: "2026-06-14",
          title: "X",
          start_time: "20:00",
          end_time: "18:00", // inválido — end <= start
          duration_minutes: "45",
          cut_name: "",
        },
      ],
      emptyCuts,
    );
    // end-start no se aplica; cae al legacy 45.
    expect(rows[0].duration_minutes).toBe(45);
  });

  it("end > start validado y derivado", () => {
    const { rows } = parseSessionsCsv(
      [
        {
          session_date: "2026-06-14",
          title: "X",
          start_time: "09:00",
          end_time: "10:30",
          cut_name: "",
        },
      ],
      emptyCuts,
    );
    expect(rows[0].duration_minutes).toBe(90);
  });

  it("cut_name match case-insensitive contra el map de cortes", () => {
    const cuts = new Map([["corte 1", "cut-id-1"]]);
    const { rows, unmatchedCuts } = parseSessionsCsv(
      [
        {
          session_date: "2026-06-14",
          title: "X",
          start_time: "",
          end_time: "",
          cut_name: "Corte 1", // mayúsculas
        },
      ],
      cuts,
    );
    expect(rows[0].cut_id).toBe("cut-id-1");
    expect(unmatchedCuts).toBe(0);
  });

  it("cut_name sin match cuenta como unmatched (no aborta)", () => {
    const cuts = new Map([["corte 1", "cut-id-1"]]);
    const { rows, unmatchedCuts } = parseSessionsCsv(
      [
        {
          session_date: "2026-06-14",
          title: "X",
          start_time: "",
          end_time: "",
          cut_name: "Corte 99",
        },
      ],
      cuts,
    );
    expect(rows[0].cut_id).toBeNull();
    expect(unmatchedCuts).toBe(1);
  });

  it("HH:MM:SS válido en start_time se conserva", () => {
    const { rows } = parseSessionsCsv(
      [
        {
          session_date: "2026-06-14",
          title: "X",
          start_time: "18:00:00",
          end_time: "20:00:00",
          cut_name: "",
        },
      ],
      emptyCuts,
    );
    expect(rows[0].start_time).toBe("18:00:00");
    expect(rows[0].duration_minutes).toBe(120);
  });

  it("start_time mal formado → null sin abortar la fila", () => {
    // Decisión de diseño: typo de hora no debe rechazar la fila — el
    // session_date sí (obligatorio), la hora no.
    const { rows } = parseSessionsCsv(
      [
        {
          session_date: "2026-06-14",
          title: "X",
          start_time: "9-30",
          end_time: "",
          cut_name: "",
        },
      ],
      emptyCuts,
    );
    expect(rows[0].start_time).toBeNull();
  });

  it("title vacío → null", () => {
    const { rows } = parseSessionsCsv(
      [{ session_date: "2026-06-14", title: "", start_time: "", end_time: "", cut_name: "" }],
      emptyCuts,
    );
    expect(rows[0].title).toBeNull();
  });
});

describe("round-trip: buildSessionsRows → parseSessionsCsv", () => {
  it("preserva los campos no-null de una sesión típica", () => {
    const original: SessionForCsv = {
      session_date: "2026-06-14",
      title: "Clase 1 — Introducción",
      start_time: "18:00:00",
      duration_minutes: 120,
      meeting_url: "https://meet.google.com/abc-defg-hij",
      cut_id: "cut-1",
      recording_url: null,
    };
    const cutNameById = new Map([["cut-1", "Corte 1"]]);
    const csvRows = buildSessionsRows([original], cutNameById);
    // Para el parser, necesitamos el map name → id (inverso).
    const cutByName = new Map([["corte 1", "cut-1"]]);
    const { rows: reimported } = parseSessionsCsv(csvRows, cutByName);
    expect(reimported[0]).toMatchObject({
      session_date: "2026-06-14",
      title: "Clase 1 — Introducción",
      start_time: "18:00", // HH:MM en CSV (no HH:MM:SS)
      duration_minutes: 120,
      meeting_url: "https://meet.google.com/abc-defg-hij",
      cut_id: "cut-1",
      recording_url: null,
    });
  });

  it("preserva múltiples filas en orden", () => {
    const sessions: SessionForCsv[] = [
      { session_date: "2026-06-14", title: "A", start_time: "18:00", duration_minutes: 90 },
      { session_date: "2026-06-16", title: "B", start_time: "09:00", duration_minutes: 60 },
      { session_date: "2026-06-18", title: "C" }, // sin start
    ];
    const csvRows = buildSessionsRows(sessions, new Map());
    const { rows } = parseSessionsCsv(csvRows, new Map());
    expect(rows.map((r) => r.session_date)).toEqual([
      "2026-06-14",
      "2026-06-16",
      "2026-06-18",
    ]);
    expect(rows.map((r) => r.duration_minutes)).toEqual([90, 60, null]);
  });
});

describe("parseSessionsCsv — session_type", () => {
  const base = { session_date: "2026-06-14" };
  it("acepta los tres tipos válidos (case-insensitive)", () => {
    const { rows } = parseSessionsCsv(
      [
        { ...base, session_type: "presencial" },
        { ...base, session_type: "AUTONOMA" },
        { ...base, session_type: "Virtual" },
      ],
      new Map(),
    );
    expect(rows.map((r) => r.session_type)).toEqual(["presencial", "autonoma", "virtual"]);
  });
  it("vacío o inválido → default 'virtual'", () => {
    const { rows } = parseSessionsCsv(
      [
        { ...base },
        { ...base, session_type: "" },
        { ...base, session_type: "hibrida" },
      ],
      new Map(),
    );
    expect(rows.map((r) => r.session_type)).toEqual(["virtual", "virtual", "virtual"]);
  });
});
