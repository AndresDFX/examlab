import { describe, expect, it } from "vitest";
import {
  COURSE_STATUS_VALUES,
  deriveCourseDisplayState,
  summarizeCourses,
  partitionCoursesByLifecycle,
  sortCoursesByPriority,
} from "./course-status";

// Fecha de referencia fija para todos los casos: 2026-06-14T12:00:00Z.
const NOW = new Date("2026-06-14T12:00:00Z").getTime();
const PAST = "2026-01-01"; // fecha en el pasado relativo a NOW
const FUTURE = "2026-12-31"; // fecha en el futuro relativo a NOW

describe("COURSE_STATUS_VALUES", () => {
  it("es el set canónico de 3 estados persistidos", () => {
    expect(COURSE_STATUS_VALUES).toEqual(["borrador", "en_curso", "finalizado"]);
  });
});

describe("deriveCourseDisplayState", () => {
  it("finalizado gana sobre las fechas (start futuro)", () => {
    expect(
      deriveCourseDisplayState({ status: "finalizado", start_date: FUTURE }, NOW),
    ).toBe("finalizado");
  });

  it("finalizado gana aunque end_date no haya pasado", () => {
    expect(
      deriveCourseDisplayState({ status: "finalizado", end_date: FUTURE }, NOW),
    ).toBe("finalizado");
  });

  it("borrador se mantiene borrador (con o sin fechas)", () => {
    expect(deriveCourseDisplayState({ status: "borrador" }, NOW)).toBe("borrador");
    expect(
      deriveCourseDisplayState({ status: "borrador", start_date: PAST, end_date: FUTURE }, NOW),
    ).toBe("borrador");
  });

  it("en_curso + start futuro = proximo", () => {
    expect(
      deriveCourseDisplayState({ status: "en_curso", start_date: FUTURE }, NOW),
    ).toBe("proximo");
  });

  it("en_curso + start pasado = en_curso", () => {
    expect(
      deriveCourseDisplayState({ status: "en_curso", start_date: PAST }, NOW),
    ).toBe("en_curso");
  });

  it("en_curso + start null = en_curso", () => {
    expect(deriveCourseDisplayState({ status: "en_curso", start_date: null }, NOW)).toBe(
      "en_curso",
    );
  });

  it("en_curso + end pasado (cron aún no corrió) = sigue en_curso", () => {
    expect(
      deriveCourseDisplayState({ status: "en_curso", start_date: PAST, end_date: PAST }, NOW),
    ).toBe("en_curso");
  });

  it("status null/desconocido (legacy) = en_curso", () => {
    expect(deriveCourseDisplayState({ status: null }, NOW)).toBe("en_curso");
    expect(deriveCourseDisplayState({ status: undefined }, NOW)).toBe("en_curso");
    expect(deriveCourseDisplayState({ status: "activo_legacy" }, NOW)).toBe("en_curso");
  });

  it("start_date inválido no rompe → en_curso", () => {
    expect(
      deriveCourseDisplayState({ status: "en_curso", start_date: "no-es-fecha" }, NOW),
    ).toBe("en_curso");
  });

  // Regresión #28/#30: DATE-only ('YYYY-MM-DD') se ancla a MEDIODÍA local, no
  // a medianoche UTC. Sin el ancla, un curso que empieza "hoy" se clasificaba
  // off-by-one en zonas UTC-negativas (es-CO) durante las primeras horas del
  // día. Estos casos son TZ-independientes (construimos `now` con el
  // constructor local, igual que el ancla del helper).
  it("DATE-only se ancla a mediodía local (regresión TZ off-by-one)", () => {
    const startStr = "2026-06-15";
    const localNoon = new Date(2026, 5, 15, 12, 0, 0).getTime();
    // Justo antes del mediodía local del día de inicio → aún no empieza.
    expect(
      deriveCourseDisplayState({ status: "en_curso", start_date: startStr }, localNoon - 1),
    ).toBe("proximo");
    // Justo después del mediodía local → ya empezó.
    expect(
      deriveCourseDisplayState({ status: "en_curso", start_date: startStr }, localNoon + 1),
    ).toBe("en_curso");
  });
});

describe("summarizeCourses", () => {
  it("tabula un set mixto por estado de display", () => {
    const courses = [
      { status: "borrador" },
      { status: "borrador", start_date: FUTURE },
      { status: "en_curso", start_date: PAST }, // active
      { status: "en_curso", start_date: null }, // active
      { status: "en_curso", start_date: FUTURE }, // upcoming
      { status: "finalizado" },
      { status: "finalizado", end_date: PAST },
      { status: null }, // legacy → active
    ];
    const summary = summarizeCourses(courses, NOW);
    expect(summary).toEqual({
      total: 8,
      draft: 2,
      active: 3,
      upcoming: 1,
      finalized: 2,
    });
  });

  it("set vacío → todo en 0", () => {
    expect(summarizeCourses([], NOW)).toEqual({
      total: 0,
      draft: 0,
      active: 0,
      upcoming: 0,
      finalized: 0,
    });
  });
});

describe("partitionCoursesByLifecycle", () => {
  const mk = (id: string, name: string, status: string) => ({ id, name, status });

  it("open = no-finalizado, closed = finalizado; alfabético es-CO dentro de cada grupo", () => {
    const courses = [
      mk("1", "Zoología", "en_curso"),
      mk("2", "álgebra", "finalizado"),
      mk("3", "Botánica", "borrador"),
      mk("4", "Cálculo", "en_curso"),
      mk("5", "Redes", "finalizado"),
    ];
    const { open, closed } = partitionCoursesByLifecycle(courses);
    // open: Botánica (borrador), Cálculo (en_curso), Zoología (en_curso) — alfabético
    expect(open.map((c) => c.name)).toEqual(["Botánica", "Cálculo", "Zoología"]);
    // closed: álgebra, Redes — alfabético insensible a acentos/mayúsculas
    expect(closed.map((c) => c.name)).toEqual(["álgebra", "Redes"]);
  });

  it("keepIds fuerza a open un curso finalizado (el que se está editando/filtrando)", () => {
    const courses = [
      mk("1", "Activo", "en_curso"),
      mk("2", "Viejo", "finalizado"),
    ];
    const { open, closed } = partitionCoursesByLifecycle(courses, ["2"]);
    expect(open.map((c) => c.id).sort()).toEqual(["1", "2"]);
    expect(closed).toEqual([]);
  });

  it("status ausente/null → tratado como open (no se esconde)", () => {
    const courses = [
      { id: "1", name: "Sin status", status: null },
      { id: "2", name: "Undef", status: undefined },
    ];
    const { open, closed } = partitionCoursesByLifecycle(courses);
    expect(open).toHaveLength(2);
    expect(closed).toHaveLength(0);
  });

  it("acepta Set como keepIds", () => {
    const { open } = partitionCoursesByLifecycle(
      [{ id: "x", name: "X", status: "finalizado" }],
      new Set(["x"]),
    );
    expect(open.map((c) => c.id)).toEqual(["x"]);
  });
});

describe("sortCoursesByPriority", () => {
  it("lista plana: abiertos primero (alfabético), luego cerrados (alfabético)", () => {
    const courses = [
      { id: "1", name: "Cerrado B", status: "finalizado" },
      { id: "2", name: "Abierto B", status: "en_curso" },
      { id: "3", name: "Cerrado A", status: "finalizado" },
      { id: "4", name: "Abierto A", status: "en_curso" },
    ];
    expect(sortCoursesByPriority(courses).map((c) => c.name)).toEqual([
      "Abierto A",
      "Abierto B",
      "Cerrado A",
      "Cerrado B",
    ]);
  });
});
