import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { esIntentoFinalizado } from "@/modules/exams/exam-attempts";
import {
  actividadConRecuperacionesSeDio,
  actividadCuenta,
  actividadSeDio,
  asistenciaDelCorte,
  corteYPesoEnCurso,
  notaDelEstudiante,
  pesoEfectivo,
  sesionesDadas,
  type AsistenciaDelCorte,
} from "./nota-relativa";

const ESCALA = { min: 0, max: 5 };
const HOY = Date.parse("2026-09-30T17:00:00Z");

describe("sesionesDadas / asistenciaDelCorte", () => {
  it("una sesión se dio si ALGUIEN tiene marca, sea cual sea", () => {
    const dadas = sesionesDadas([
      { session_id: "s1" },
      { session_id: "s1" },
      { session_id: "s2" },
    ]);
    expect([...dadas].sort()).toEqual(["s1", "s2"]);
  });

  it("el denominador son las sesiones DADAS: la futura y la que no se marcó no son faltas", () => {
    // s1 y s2 se dieron; s3 es futura; s4 pasó sin que nadie quedara marcado.
    const sesiones = [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }];
    const dadas = new Set(["s1", "s2"]);
    const r = asistenciaDelCorte(sesiones, dadas, (id) => (id === "s1" ? "presente" : undefined), ESCALA);
    expect(r).toEqual({ presentes: 1, dadas: 2, nota: 2.5 });
  });

  it("'tarde' cuenta como asistió, igual que antes", () => {
    const r = asistenciaDelCorte([{ id: "s1" }], new Set(["s1"]), () => "tarde", ESCALA);
    expect(r.nota).toBe(5);
  });

  it("sin sesiones dadas la asistencia no aplica todavía (null, no cero)", () => {
    const r = asistenciaDelCorte([{ id: "s1" }], new Set(), () => undefined, ESCALA);
    expect(r).toEqual({ presentes: 0, dadas: 0, nota: null });
  });

  it("respeta el mínimo de la escala", () => {
    const r = asistenciaDelCorte([{ id: "s1" }], new Set(["s1"]), () => undefined, { min: 1, max: 5 });
    expect(r.nota).toBe(1);
  });
});

describe("actividadSeDio", () => {
  const base = { externa: false, estado: "published", alguienConNota: false };

  it("en línea: se dio cuando pasó su plazo", () => {
    expect(actividadSeDio({ ...base, cierre: "2026-09-28T04:59:00Z" }, HOY)).toBe(true);
    expect(actividadSeDio({ ...base, cierre: "2026-10-05T04:59:00Z" }, HOY)).toBe(false);
  });

  it("en línea: el docente la cerró antes del plazo → se dio", () => {
    expect(actividadSeDio({ ...base, estado: "closed", cierre: "2026-10-05T04:59:00Z" }, HOY)).toBe(true);
  });

  it("externa: se dio cuando hay al menos una nota cargada, sin importar la fecha", () => {
    expect(actividadSeDio({ ...base, externa: true, cierre: "2026-01-01T00:00:00Z" }, HOY)).toBe(false);
    expect(actividadSeDio({ ...base, externa: true, alguienConNota: true, cierre: null }, HOY)).toBe(true);
  });

  it("en línea sin plazo: se dio cuando alguien tiene nota", () => {
    expect(actividadSeDio({ ...base, cierre: null }, HOY)).toBe(false);
    expect(actividadSeDio({ ...base, cierre: null, alguienConNota: true }, HOY)).toBe(true);
  });

  it("con una recuperación publicada abierta, el original todavía no se dio", () => {
    const original = { ...base, cierre: "2026-09-28T04:59:00Z" };
    const sup = { ...base, cierre: "2026-10-02T04:59:00Z" };
    expect(actividadConRecuperacionesSeDio(original, [sup], HOY)).toBe(false);
    expect(actividadConRecuperacionesSeDio(original, [{ ...sup, cierre: "2026-09-29T04:59:00Z" }], HOY)).toBe(true);
  });
});

describe("actividadCuenta", () => {
  it("con nota cuenta siempre, aunque la actividad siga abierta", () => {
    expect(actividadCuenta({ nota: 4, seDio: false, externa: false, entrego: true })).toBe(true);
  });
  it("abierta y sin nota: no cuenta", () => {
    expect(actividadCuenta({ nota: null, seDio: false, externa: false, entrego: false })).toBe(false);
  });
  it("cerrada, sin entregar: nota perdida (cuenta como 0)", () => {
    expect(actividadCuenta({ nota: null, seDio: true, externa: false, entrego: false })).toBe(true);
  });
  it("cerrada, entregada y sin calificar: la espera es del docente, no cuenta", () => {
    expect(actividadCuenta({ nota: null, seDio: true, externa: false, entrego: true })).toBe(false);
  });
  it("externa ya evaluada y sin nota para este estudiante: cuenta como 0", () => {
    expect(actividadCuenta({ nota: null, seDio: true, externa: true, entrego: false })).toBe(true);
  });
  it("cerrada, sin entregar y SIN asignar: no la pudo ver, no cuenta", () => {
    expect(
      actividadCuenta({ nota: null, seDio: true, externa: false, entrego: false, asignada: false }),
    ).toBe(false);
  });
  it("sin asignar pero con nota (la asignación se quitó después): cuenta", () => {
    expect(
      actividadCuenta({ nota: 3, seDio: true, externa: false, entrego: true, asignada: false }),
    ).toBe(true);
  });
  it("externa: la asignación no importa, la nota la carga el docente", () => {
    expect(
      actividadCuenta({ nota: null, seDio: true, externa: true, entrego: false, asignada: false }),
    ).toBe(true);
  });
});

describe("pesoEfectivo / corteYPesoEnCurso", () => {
  it("un peso vacío, inválido o negativo es 0", () => {
    expect(pesoEfectivo(null)).toBe(0);
    expect(pesoEfectivo(undefined)).toBe(0);
    expect(pesoEfectivo(-3)).toBe(0);
    expect(pesoEfectivo("10")).toBe(10);
  });

  it("manda la fila del curso cuando tiene corte", () => {
    expect(
      corteYPesoEnCurso({ cut_id: "c1", weight: 2.5 }, { course_id: "k", cut_id: "c1", weight: 10 }, "k"),
    ).toEqual({ cutId: "c1", weight: 2.5 });
  });

  it("fila del curso sin peso → el de la actividad (lo que documenta la columna)", () => {
    expect(
      corteYPesoEnCurso({ cut_id: "c1", weight: null }, { course_id: "k", cut_id: "c1", weight: 7 }, "k"),
    ).toEqual({ cutId: "c1", weight: 7 });
  });

  it("sin fila del curso, o con fila sin corte: la de la actividad de ESTE curso", () => {
    // El proyecto integrador: fila del curso con corte vacío y 1 %, fila propia Corte 3 · 20 %.
    expect(
      corteYPesoEnCurso({ cut_id: null, weight: 1 }, { course_id: "k", cut_id: "c3", weight: 20 }, "k"),
    ).toEqual({ cutId: "c3", weight: 20 });
    expect(corteYPesoEnCurso(undefined, { course_id: "k", cut_id: "c2", weight: 10 }, "k")).toEqual({
      cutId: "c2",
      weight: 10,
    });
  });

  it("en un curso secundario no toma el corte del primario", () => {
    expect(
      corteYPesoEnCurso({ cut_id: null, weight: 5 }, { course_id: "otro", cut_id: "c1", weight: 10 }, "k"),
    ).toEqual({ cutId: null, weight: 0 });
  });
});

describe("notaDelEstudiante", () => {
  const cortes = [
    { id: "c1", attendance_weight: 10 },
    { id: "c2", attendance_weight: 10 },
  ];
  const asis = (entries: Array<[string, AsistenciaDelCorte]>) => new Map(entries);

  it("solo pondera lo que cuenta", () => {
    const r = notaDelEstudiante(
      cortes,
      [
        { cutId: "c1", weight: 10, score: 4, cuenta: true },
        // taller abierto sin entregar: no entra
        { cutId: "c1", weight: 10, score: null, cuenta: false },
      ],
      asis([["c1", { presentes: 4, dadas: 4, nota: 5 }]]),
    );
    expect(r.cutGrades[0]).toEqual({ cutId: "c1", grade: 4.5 });
  });

  it("lo que se debe cuenta como 0", () => {
    const r = notaDelEstudiante(
      cortes,
      [
        { cutId: "c1", weight: 10, score: 4, cuenta: true },
        { cutId: "c1", weight: 10, score: null, cuenta: true },
      ],
      new Map(),
    );
    expect(r.cutGrades[0].grade).toBe(2);
  });

  it("la asistencia de un corte sin sesiones dadas no entra (ni al corte ni a la final)", () => {
    const r = notaDelEstudiante(
      cortes,
      [{ cutId: "c1", weight: 10, score: 4, cuenta: true }],
      asis([
        ["c1", { presentes: 0, dadas: 0, nota: null }],
        ["c2", { presentes: 0, dadas: 0, nota: null }],
      ]),
    );
    expect(r.cutGrades).toEqual([
      { cutId: "c1", grade: 4 },
      { cutId: "c2", grade: null },
    ]);
    expect(r.finalGrade).toBe(4);
    expect(r.attByCut).toEqual([
      { cutId: "c1", score: null },
      { cutId: "c2", score: null },
    ]);
  });

  it("un ítem sin corte, o con el corte de otro curso, no suma a la nota final", () => {
    const r = notaDelEstudiante(
      cortes,
      [
        { cutId: "c1", weight: 10, score: 5, cuenta: true },
        { cutId: null, weight: 1, score: 0, cuenta: true },
        { cutId: "de-otro-curso", weight: 5, score: 0, cuenta: true },
      ],
      new Map(),
    );
    expect(r.finalGrade).toBe(5);
  });

  it("la final pondera todos los ítems juntos, no las notas de los cortes", () => {
    const r = notaDelEstudiante(
      cortes,
      [
        { cutId: "c1", weight: 10, score: 5, cuenta: true },
        { cutId: "c2", weight: 30, score: 1, cuenta: true },
      ],
      new Map(),
    );
    expect(r.finalGrade).toBe(2);
  });

  it("sin nada evaluado todavía la nota es «—» (null), no 0", () => {
    const r = notaDelEstudiante(cortes, [{ cutId: "c1", weight: 10, score: null, cuenta: true }], new Map());
    expect(r.cutGrades[0].grade).toBeNull();
    expect(r.finalGrade).toBeNull();
  });

  it("un corte con peso de asistencia 0 no la suma aunque tenga sesiones", () => {
    const r = notaDelEstudiante(
      [{ id: "c1", attendance_weight: 0 }],
      [{ cutId: "c1", weight: 10, score: 4, cuenta: true }],
      asis([["c1", { presentes: 0, dadas: 3, nota: 0 }]]),
    );
    expect(r.cutGrades[0].grade).toBe(4);
  });
});

/**
 * El espejo SQL es el acta (mig 20262670000000). Lo que se puede fijar leyendo
 * el archivo se fija acá: si alguien cambia la regla de un lado, este test es el
 * que avisa que falta el otro. La paridad completa se verificó contra PGlite con
 * los datos reales (ver CHANGELOG).
 */
describe("espejo SQL de la nota relativa (mig 20262670000000)", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../../supabase/migrations/20262670000000_nota_relativa.sql"),
    "utf8",
  );

  it("un intento cuenta como terminado con los mismos estados en TS y en SQL", () => {
    expect(esIntentoFinalizado({ status: "completado" })).toBe(true);
    expect(esIntentoFinalizado({ status: "sospechoso" })).toBe(true);
    expect(esIntentoFinalizado({ status: "en_progreso" })).toBe(false);
    expect(sql).toContain("s.status IN ('completado', 'sospechoso')");
  });

  it("sin nota y ya dada: 0 solo si no la entregó y la tenía asignada (como actividadCuenta)", () => {
    const reglas = sql.match(/\(NOT x\.entrego AND x\.asignada\)/g) ?? [];
    expect(reglas).toHaveLength(3); // exámenes, talleres, proyectos
  });

  it("la asistencia cuenta solo sesiones con alguna marca y fuera de la papelera", () => {
    expect(sql).toMatch(/s\.deleted_at IS NULL\s+AND EXISTS \(SELECT 1 FROM public\.attendance_records r WHERE r\.session_id = s\.id\)/);
    expect(sql).toContain("ar.status IN ('presente', 'tarde')");
  });

  it("las recuperaciones solo hacen esperar al estudiante que las tiene asignadas", () => {
    expect(sql).toContain("WHERE ea.exam_id = r.id AND ea.user_id = p_user_id");
    expect(sql).toContain("WHERE wa.workshop_id = r.id AND wa.user_id = p_user_id");
  });
});
