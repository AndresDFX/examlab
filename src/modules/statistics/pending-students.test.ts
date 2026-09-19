import { describe, expect, it } from "vitest";
import {
  aggregateAllStudents,
  aggregatePending,
  asistenciasFaltantes,
  filterItemsByKind,
  pollIsOpen,
  type PendingItem,
} from "./pending-students";

const names = new Map([
  ["u1", "Ana Pérez"],
  ["u2", "Beto Gómez"],
]);
const courseNames = new Map([
  ["c1", "Algoritmos"],
  ["c2", "Bases de datos"],
]);

describe("aggregatePending", () => {
  it("cuenta por tipo y agrupa por estudiante", () => {
    const items: PendingItem[] = [
      { userId: "u1", courseId: "c1", kind: "examen" },
      { userId: "u1", courseId: "c1", kind: "taller" },
      { userId: "u1", courseId: "c2", kind: "firma" },
      { userId: "u2", courseId: "c1", kind: "encuesta" },
    ];
    const rows = aggregatePending(items, names, courseNames);
    expect(rows).toHaveLength(2);
    const ana = rows.find((r) => r.userId === "u1")!;
    expect(ana.name).toBe("Ana Pérez");
    expect(ana.examen).toBe(1);
    expect(ana.taller).toBe(1);
    expect(ana.firma).toBe(1);
    expect(ana.total).toBe(3);
    // Dedup + orden alfabético de cursos.
    expect(ana.courses).toEqual(["Algoritmos", "Bases de datos"]);
    // Desglose por curso: 2 pendientes en Algoritmos, 1 en Bases de datos.
    expect(ana.byCourse).toEqual([
      { courseId: "c1", courseName: "Algoritmos", firma: 0, encuesta: 0, examen: 1, taller: 1, proyecto: 0, asistencia: 0, total: 2 },
      { courseId: "c2", courseName: "Bases de datos", firma: 1, encuesta: 0, examen: 0, taller: 0, proyecto: 0, asistencia: 0, total: 1 },
    ]);
  });

  it("ordena por total descendente y desempata por nombre", () => {
    const items: PendingItem[] = [
      { userId: "u2", courseId: "c1", kind: "examen" },
      { userId: "u1", courseId: "c1", kind: "examen" },
      { userId: "u1", courseId: "c1", kind: "taller" },
    ];
    const rows = aggregatePending(items, names, courseNames);
    expect(rows[0].userId).toBe("u1"); // 2 pendientes
    expect(rows[1].userId).toBe("u2"); // 1 pendiente
  });

  it("no incluye estudiantes sin pendientes (lista vacía)", () => {
    expect(aggregatePending([], names, courseNames)).toEqual([]);
  });

  it("nombre y curso desconocidos degradan sin romper", () => {
    const rows = aggregatePending(
      [{ userId: "zzz", courseId: "cX", kind: "firma" }],
      names,
      courseNames,
    );
    expect(rows[0].name).toBe("—");
    expect(rows[0].courses).toEqual([]);
  });
});

describe("aggregateAllStudents", () => {
  it("incluye estudiantes SIN pendientes con total 0", () => {
    const enrolledByUser = new Map([
      ["u1", new Set(["c1"])],
      ["u2", new Set(["c1", "c2"])],
    ]);
    const items: PendingItem[] = [{ userId: "u1", courseId: "c1", kind: "examen" }];
    const rows = aggregateAllStudents(items, names, courseNames, enrolledByUser);
    expect(rows).toHaveLength(2);
    const beto = rows.find((r) => r.userId === "u2")!;
    expect(beto.total).toBe(0);
    // Matrícula COMPLETA aunque no tenga pendiente en ninguno de los dos.
    expect(beto.courses).toEqual(["Algoritmos", "Bases de datos"]);
  });

  it("byCourse cubre TODA la matrícula, con 0 en el curso donde está al día", () => {
    const enrolledByUser = new Map([["u2", new Set(["c1", "c2"])]]);
    const items: PendingItem[] = [{ userId: "u2", courseId: "c1", kind: "examen" }];
    const rows = aggregateAllStudents(items, names, courseNames, enrolledByUser);
    const beto = rows.find((r) => r.userId === "u2")!;
    expect(beto.byCourse).toEqual([
      { courseId: "c1", courseName: "Algoritmos", firma: 0, encuesta: 0, examen: 1, taller: 0, proyecto: 0, asistencia: 0, total: 1 },
      { courseId: "c2", courseName: "Bases de datos", firma: 0, encuesta: 0, examen: 0, taller: 0, proyecto: 0, asistencia: 0, total: 0 },
    ]);
  });

  it("ordena alfabéticamente por nombre (roster, no ranking)", () => {
    const enrolledByUser = new Map([
      ["u2", new Set(["c1"])],
      ["u1", new Set(["c1"])],
    ]);
    const rows = aggregateAllStudents([], names, courseNames, enrolledByUser);
    expect(rows.map((r) => r.userId)).toEqual(["u1", "u2"]); // Ana antes que Beto
  });
});

describe("filterItemsByKind", () => {
  const items: PendingItem[] = [
    { userId: "u1", courseId: "c1", kind: "examen" },
    { userId: "u1", courseId: "c1", kind: "taller" },
    { userId: "u2", courseId: "c1", kind: "taller" },
  ];

  it("sin excludeKinds (undefined) devuelve todo tal cual", () => {
    expect(filterItemsByKind(items, undefined)).toEqual(items);
  });

  it("con Set vacío devuelve todo tal cual", () => {
    expect(filterItemsByKind(items, new Set())).toEqual(items);
  });

  it("descarta los items del tipo excluido", () => {
    const filtered = filterItemsByKind(items, new Set(["taller"]));
    expect(filtered).toEqual([{ userId: "u1", courseId: "c1", kind: "examen" }]);
  });

  it("un estudiante cuyo ÚNICO pendiente es del tipo excluido deja de aparecer en aggregatePending", () => {
    const filtered = filterItemsByKind(items, new Set(["taller"]));
    const rows = aggregatePending(filtered, names, courseNames);
    // u2 solo tenía "taller" (excluido) → ya no tiene ningún pendiente.
    expect(rows.map((r) => r.userId)).toEqual(["u1"]);
    expect(rows[0].taller).toBe(0);
    expect(rows[0].examen).toBe(1);
    expect(rows[0].total).toBe(1);
  });

  it("en aggregateAllStudents el estudiante SIGUE apareciendo, pero con total 0 para el tipo excluido", () => {
    const enrolledByUser = new Map([
      ["u1", new Set(["c1"])],
      ["u2", new Set(["c1"])],
    ]);
    const filtered = filterItemsByKind(items, new Set(["taller"]));
    const rows = aggregateAllStudents(filtered, names, courseNames, enrolledByUser);
    const u2 = rows.find((r) => r.userId === "u2")!;
    expect(u2.taller).toBe(0);
    expect(u2.total).toBe(0);
  });

  it("excluir varios tipos a la vez", () => {
    const filtered = filterItemsByKind(items, new Set(["taller", "examen"]));
    expect(filtered).toEqual([]);
  });
});

describe("pollIsOpen", () => {
  const now = new Date("2026-06-01T12:00:00Z").getTime();
  it("abierta dentro de la ventana", () => {
    expect(
      pollIsOpen(
        { is_published: true, opens_at: "2026-05-01T00:00:00Z", closes_at: "2026-07-01T00:00:00Z", closed_manually: false },
        now,
      ),
    ).toBe(true);
  });
  it("borrador (sin publicar) no cuenta aunque las fechas den abierta", () => {
    expect(
      pollIsOpen(
        { is_published: false, opens_at: "2026-05-01T00:00:00Z", closes_at: "2026-07-01T00:00:00Z", closed_manually: false },
        now,
      ),
    ).toBe(false);
  });
  it("cerrada a mano no cuenta", () => {
    expect(
      pollIsOpen({ is_published: true, opens_at: "2026-05-01T00:00:00Z", closes_at: null, closed_manually: true }, now),
    ).toBe(false);
  });
  it("aún no abrió", () => {
    expect(
      pollIsOpen({ is_published: true, opens_at: "2026-07-01T00:00:00Z", closes_at: null, closed_manually: false }, now),
    ).toBe(false);
  });
  it("ya cerró por fecha", () => {
    expect(
      pollIsOpen({ is_published: true, opens_at: null, closes_at: "2026-05-01T00:00:00Z", closed_manually: false }, now),
    ).toBe(false);
  });
});

describe("asistenciasFaltantes", () => {
  const curso = new Map([["c1", new Set(["ana", "beto", "caro"])]]);

  it("una sesión SIN ningún registro no genera pendientes", () => {
    // El caso que hace o rompe esta funcionalidad. Si el docente no pasó lista,
    // NADIE tiene registro — y contar eso como falta marcaría al curso entero
    // por un hueco que no es de los estudiantes. El informe dejaría de creerse.
    expect(asistenciasFaltantes([{ id: "s1", course_id: "c1" }], [], curso)).toEqual([]);
  });

  it("con al menos un compañero marcado, los demás SÍ quedan pendientes", () => {
    // Que Ana figure prueba que la lista se tomó ese día, así que la ausencia
    // de Beto y Caro es un dato sobre ellos, no sobre el docente.
    const r = asistenciasFaltantes(
      [{ id: "s1", course_id: "c1" }],
      [{ session_id: "s1", user_id: "ana" }],
      curso,
    );
    expect(r.map((x) => x.userId).sort()).toEqual(["beto", "caro"]);
    expect(r.every((x) => x.kind === "asistencia" && x.courseId === "c1")).toBe(true);
  });

  it("quien tiene registro nunca queda pendiente", () => {
    const r = asistenciasFaltantes(
      [{ id: "s1", course_id: "c1" }],
      [
        { session_id: "s1", user_id: "ana" },
        { session_id: "s1", user_id: "beto" },
        { session_id: "s1", user_id: "caro" },
      ],
      curso,
    );
    expect(r).toEqual([]);
  });

  it("cada sesión se evalúa por separado", () => {
    // s1 tiene lista tomada y s2 no: solo s1 debe producir pendientes. Sin esto,
    // un curso con una sola clase registrada arrastraría a todas las demás.
    const r = asistenciasFaltantes(
      [
        { id: "s1", course_id: "c1" },
        { id: "s2", course_id: "c1" },
      ],
      [{ session_id: "s1", user_id: "ana" }],
      curso,
    );
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.userId).sort()).toEqual(["beto", "caro"]);
  });

  it("no toca a estudiantes de otro curso", () => {
    const dos = new Map([
      ["c1", new Set(["ana"])],
      ["c2", new Set(["zoe"])],
    ]);
    const r = asistenciasFaltantes(
      [{ id: "s1", course_id: "c1" }],
      [{ session_id: "s1", user_id: "otro" }],
      dos,
    );
    expect(r.map((x) => x.userId)).toEqual(["ana"]);
  });

  it("una sesión de un curso sin matrícula cargada no rompe", () => {
    const r = asistenciasFaltantes(
      [{ id: "s1", course_id: "desconocido" }],
      [{ session_id: "s1", user_id: "ana" }],
      curso,
    );
    expect(r).toEqual([]);
  });
});
