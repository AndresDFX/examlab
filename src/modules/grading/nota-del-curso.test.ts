import { describe, expect, it } from "vitest";
import {
  actividadesConNota,
  notaDelEstudianteEnCurso,
  type DatosDelEstudiante,
  type DatosParaNota,
} from "./nota-del-curso";

const HOY = Date.parse("2026-09-30T17:00:00Z");
const PASADO = "2026-09-27T04:59:00Z";
const FUTURO = "2026-10-05T04:59:00Z";

function curso(parcial: Partial<DatosParaNota> = {}): DatosParaNota {
  return {
    courseId: "k",
    escala: { min: 0, max: 5 },
    cortes: [{ id: "c1", attendance_weight: 10 }],
    examenes: [],
    talleres: [],
    unionTalleres: new Map(),
    proyectos: [],
    unionProyectos: new Map(),
    sesiones: [],
    sesionesDadas: new Set(),
    conNota: { examenes: new Set(), talleres: new Set(), proyectos: new Set() },
    ...parcial,
  };
}

function estudiante(parcial: Partial<DatosDelEstudiante> = {}): DatosDelEstudiante {
  return {
    intentos: [],
    entregaTaller: () => undefined,
    entregaProyecto: () => undefined,
    estadoAsistencia: () => undefined,
    ...parcial,
  };
}

const intento = (exam_id: string, nota: number | null, status = "completado") => ({
  exam_id,
  status,
  ai_grade: nota,
  final_override_grade: null,
  created_at: "2026-09-20T00:00:00Z",
});

describe("notaDelEstudianteEnCurso — la nota relativa", () => {
  it("el corte 1 de hoy: parcial cerrado, taller abierto sin entregar y asistencia de las sesiones dadas", () => {
    const d = curso({
      examenes: [{ id: "p1", cut_id: "c1", weight: 10, end_time: PASADO, status: "published" }],
      talleres: [
        { id: "t1", course_id: "k", cut_id: "c1", weight: 10, due_date: FUTURO, status: "published", max_score: 5 },
      ],
      unionTalleres: new Map([["t1", { cut_id: "c1", weight: 10 }]]),
      sesiones: [
        { id: "s1", cut_id: "c1" },
        { id: "s2", cut_id: "c1" },
        { id: "s3", cut_id: "c1" }, // futura: nadie marcado
      ],
      sesionesDadas: new Set(["s1", "s2"]),
    });
    const r = notaDelEstudianteEnCurso(
      d,
      estudiante({
        intentos: [intento("p1", 4)],
        estadoAsistencia: (id) => (id === "s1" || id === "s2" ? "presente" : undefined),
      }),
      HOY,
    );
    // Parcial 4 (10 %) + asistencia 2/2 = 5 (10 %); el taller abierto no entra.
    expect(r.cutGrades[0].grade).toBe(4.5);
    expect(r.items.find((i) => i.id === "t1")?.cuenta).toBe(false);
    expect(r.asistencia.get("c1")).toEqual({ presentes: 2, dadas: 2, nota: 5 });
  });

  it("un taller ya calificado cuenta aunque siga abierto", () => {
    const d = curso({
      talleres: [
        { id: "t1", course_id: "k", cut_id: "c1", weight: 10, due_date: FUTURO, status: "published", max_score: 5 },
      ],
      unionTalleres: new Map([["t1", { cut_id: "c1", weight: 10 }]]),
    });
    const r = notaDelEstudianteEnCurso(
      d,
      estudiante({ entregaTaller: () => ({ status: "calificado", ai_grade: 4, final_grade: 4.5 }) }),
      HOY,
    );
    expect(r.cutGrades[0].grade).toBe(4.5);
  });

  it("taller cerrado: sin entregar es 0; entregado y sin calificar no cuenta todavía", () => {
    const d = curso({
      examenes: [{ id: "p1", cut_id: "c1", weight: 10, end_time: PASADO, status: "published" }],
      talleres: [
        { id: "t1", course_id: "k", cut_id: "c1", weight: 10, due_date: PASADO, status: "published", max_score: 5 },
      ],
      unionTalleres: new Map([["t1", { cut_id: "c1", weight: 10 }]]),
    });
    const sinEntregar = notaDelEstudianteEnCurso(d, estudiante({ intentos: [intento("p1", 4)] }), HOY);
    expect(sinEntregar.cutGrades[0].grade).toBe(2);
    const pendiente = notaDelEstudianteEnCurso(
      d,
      estudiante({
        intentos: [intento("p1", 4)],
        entregaTaller: () => ({ status: "entregado", ai_grade: null, final_grade: null }),
      }),
      HOY,
    );
    expect(pendiente.cutGrades[0].grade).toBe(4);
  });

  it("parcial cerrado sin presentar es 0; con un supletorio publicado abierto, espera", () => {
    const original = { id: "p1", cut_id: "c1", weight: 10, end_time: PASADO, status: "published" };
    const sinSup = notaDelEstudianteEnCurso(
      curso({
        examenes: [original],
        sesiones: [{ id: "s1", cut_id: "c1" }],
        sesionesDadas: new Set(["s1"]),
      }),
      estudiante({ estadoAsistencia: () => "presente" }),
      HOY,
    );
    expect(sinSup.cutGrades[0].grade).toBe(2.5);

    const conSup = notaDelEstudianteEnCurso(
      curso({
        examenes: [
          original,
          {
            id: "s",
            parent_exam_id: "p1",
            makeup_kind: "supletorio",
            end_time: FUTURO,
            status: "published",
            created_at: "2026-09-29T00:00:00Z",
          },
        ],
        sesiones: [{ id: "s1", cut_id: "c1" }],
        sesionesDadas: new Set(["s1"]),
      }),
      estudiante({ estadoAsistencia: () => "presente" }),
      HOY,
    );
    expect(conSup.cutGrades[0].grade).toBe(5);
  });

  it("la nota del supletorio llena la ausencia del original", () => {
    const r = notaDelEstudianteEnCurso(
      curso({
        examenes: [
          { id: "p1", cut_id: "c1", weight: 10, end_time: PASADO, status: "published" },
          {
            id: "s",
            parent_exam_id: "p1",
            makeup_kind: "supletorio",
            end_time: PASADO,
            status: "published",
            created_at: "2026-09-29T00:00:00Z",
          },
        ],
      }),
      estudiante({ intentos: [intento("s", 3.39)] }),
      HOY,
    );
    expect(r.cutGrades[0].grade).toBe(3.39);
    expect(r.items[0].fuente).toBe("supletorio");
  });

  it("externa: antes de la primera nota no cuenta; después, sin nota es 0", () => {
    const base = {
      talleres: [
        {
          id: "x",
          course_id: "k",
          cut_id: "c1",
          weight: 10,
          due_date: PASADO,
          status: "published",
          is_external: true,
        },
      ],
      unionTalleres: new Map([["x", { cut_id: "c1", weight: 10 }]]),
      examenes: [{ id: "p1", cut_id: "c1", weight: 10, end_time: PASADO, status: "published" }],
    };
    const antes = notaDelEstudianteEnCurso(curso(base), estudiante({ intentos: [intento("p1", 4)] }), HOY);
    expect(antes.cutGrades[0].grade).toBe(4);
    const despues = notaDelEstudianteEnCurso(
      curso({ ...base, conNota: { examenes: new Set(["p1"]), talleres: new Set(["x"]), proyectos: new Set() } }),
      estudiante({ intentos: [intento("p1", 4)] }),
      HOY,
    );
    expect(despues.cutGrades[0].grade).toBe(2);
  });

  it("proyecto con fila de curso sin corte: toma el corte y el peso de su propia fila", () => {
    const r = notaDelEstudianteEnCurso(
      curso({
        cortes: [
          { id: "c1", attendance_weight: 0 },
          { id: "c3", attendance_weight: 0 },
        ],
        proyectos: [
          { id: "pi", course_id: "k", cut_id: "c3", weight: 20, due_date: PASADO, status: "published", max_score: 100 },
        ],
        unionProyectos: new Map([["pi", { cut_id: null, weight: 1 }]]),
      }),
      estudiante({ entregaProyecto: () => ({ status: "calificado", ai_grade: 80, final_grade: null }) }),
      HOY,
    );
    const item = r.items.find((i) => i.id === "pi");
    expect(item).toMatchObject({ cutId: "c3", weight: 20, score: 4 });
    expect(r.cutGrades.find((c) => c.cutId === "c3")?.grade).toBe(4);
  });

  it("un taller sin fila de curso (duplicado, importado) igual cuenta en su corte", () => {
    const r = notaDelEstudianteEnCurso(
      curso({
        cortes: [{ id: "c2", attendance_weight: 0 }],
        talleres: [
          { id: "t2", course_id: "k", cut_id: "c2", weight: 10, due_date: PASADO, status: "published", max_score: 5 },
        ],
      }),
      estudiante({ entregaTaller: () => ({ status: "calificado", ai_grade: 3, final_grade: null }) }),
      HOY,
    );
    expect(r.cutGrades[0].grade).toBe(3);
  });

  it("un taller de práctica sin corte no suma a la final aunque tenga 1 %", () => {
    const r = notaDelEstudianteEnCurso(
      curso({
        examenes: [{ id: "p1", cut_id: "c1", weight: 10, end_time: PASADO, status: "published" }],
        talleres: [
          { id: "pr", course_id: "k", cut_id: null, weight: 1, due_date: PASADO, status: "published", max_score: 5 },
        ],
        unionTalleres: new Map([["pr", { cut_id: null, weight: 1 }]]),
      }),
      estudiante({ intentos: [intento("p1", 5)] }),
      HOY,
    );
    expect(r.finalGrade).toBe(5);
  });
});

describe("asignaciones — lo que no se le asignó no lo pudo ver", () => {
  const asignaciones = (talleres: string[], examenes: string[] = []) => ({
    examenes: new Set(examenes),
    talleres: new Set(talleres),
    proyectos: new Set<string>(),
  });
  const cerrado = {
    id: "t1",
    course_id: "k",
    cut_id: "c1",
    weight: 10,
    due_date: PASADO,
    status: "published",
    max_score: 5,
  };

  it("taller cerrado sin asignar y sin entrega: no cuenta, y no deja la nota parcial", () => {
    const d = curso({
      examenes: [{ id: "p1", cut_id: "c1", weight: 10, end_time: PASADO, status: "published" }],
      talleres: [cerrado],
      unionTalleres: new Map([["t1", { cut_id: "c1", weight: 10 }]]),
    });
    const r = notaDelEstudianteEnCurso(
      d,
      estudiante({ intentos: [intento("p1", 4)], asignaciones: asignaciones([], ["p1"]) }),
      HOY,
    );
    expect(r.cutGrades[0].grade).toBe(4);
    expect(r.items.find((i) => i.id === "t1")).toMatchObject({ asignada: false, cuenta: false });
    expect(r.parcial).toBe(false);
  });

  it("el mismo taller ASIGNADO y sin entregar: cuenta 0", () => {
    const d = curso({
      examenes: [{ id: "p1", cut_id: "c1", weight: 10, end_time: PASADO, status: "published" }],
      talleres: [cerrado],
      unionTalleres: new Map([["t1", { cut_id: "c1", weight: 10 }]]),
    });
    const r = notaDelEstudianteEnCurso(
      d,
      estudiante({ intentos: [intento("p1", 4)], asignaciones: asignaciones(["t1"], ["p1"]) }),
      HOY,
    );
    expect(r.cutGrades[0].grade).toBe(2);
  });

  it("asignado solo a la recuperación: cuenta (la podía presentar)", () => {
    const d = curso({
      talleres: [
        cerrado,
        {
          id: "sup",
          course_id: "k",
          parent_workshop_id: "t1",
          makeup_kind: "supletorio",
          due_date: PASADO,
          status: "published",
          max_score: 5,
          created_at: "2026-09-28T00:00:00Z",
        },
      ],
      unionTalleres: new Map([["t1", { cut_id: "c1", weight: 10 }]]),
      sesiones: [{ id: "s1", cut_id: "c1" }],
      sesionesDadas: new Set(["s1"]),
    });
    const r = notaDelEstudianteEnCurso(
      d,
      estudiante({ asignaciones: asignaciones(["sup"]), estadoAsistencia: () => "presente" }),
      HOY,
    );
    expect(r.items.find((i) => i.id === "t1")).toMatchObject({ asignada: true, cuenta: true });
    expect(r.cutGrades[0].grade).toBe(2.5);
  });

  it("un supletorio abierto de OTROS no hace esperar: el parcial ya cuenta 0", () => {
    const d = curso({
      examenes: [
        { id: "p1", cut_id: "c1", weight: 10, end_time: PASADO, status: "published" },
        {
          id: "sup",
          parent_exam_id: "p1",
          makeup_kind: "supletorio",
          end_time: FUTURO,
          status: "published",
          created_at: "2026-09-29T00:00:00Z",
        },
      ],
      sesiones: [{ id: "s1", cut_id: "c1" }],
      sesionesDadas: new Set(["s1"]),
    });
    const ajeno = notaDelEstudianteEnCurso(
      d,
      estudiante({ asignaciones: asignaciones([], ["p1"]), estadoAsistencia: () => "presente" }),
      HOY,
    );
    expect(ajeno.items[0]).toMatchObject({ seDio: true, cuenta: true });
    expect(ajeno.cutGrades[0].grade).toBe(2.5);
    const suyo = notaDelEstudianteEnCurso(
      d,
      estudiante({ asignaciones: asignaciones([], ["p1", "sup"]), estadoAsistencia: () => "presente" }),
      HOY,
    );
    expect(suyo.items[0]).toMatchObject({ seDio: false, cuenta: false });
    expect(suyo.cutGrades[0].grade).toBe(5);
  });

  it("sin datos de asignación todo se toma como asignado (como antes)", () => {
    const d = curso({
      talleres: [cerrado],
      unionTalleres: new Map([["t1", { cut_id: "c1", weight: 10 }]]),
      sesiones: [{ id: "s1", cut_id: "c1" }],
      sesionesDadas: new Set(["s1"]),
    });
    const r = notaDelEstudianteEnCurso(d, estudiante({ estadoAsistencia: () => "presente" }), HOY);
    expect(r.cutGrades[0].grade).toBe(2.5);
  });
});

describe("parcial — con qué nota se puede emitir un certificado", () => {
  const cerrado = { id: "p1", cut_id: "c1", weight: 10, end_time: PASADO, status: "published" };

  it("con todo cerrado y calificado la nota es definitiva", () => {
    const r = notaDelEstudianteEnCurso(
      curso({ examenes: [cerrado] }),
      estudiante({ intentos: [intento("p1", 4)] }),
      HOY,
    );
    expect(r.parcial).toBe(false);
  });

  it("una actividad abierta la deja parcial, aunque el estudiante ya tenga nota en ella", () => {
    const d = curso({
      examenes: [cerrado],
      talleres: [
        { id: "t1", course_id: "k", cut_id: "c1", weight: 10, due_date: FUTURO, status: "published", max_score: 5 },
      ],
      unionTalleres: new Map([["t1", { cut_id: "c1", weight: 10 }]]),
    });
    const conNota = notaDelEstudianteEnCurso(
      d,
      estudiante({
        intentos: [intento("p1", 5)],
        entregaTaller: () => ({ status: "calificado", ai_grade: 5, final_grade: null }),
      }),
      HOY,
    );
    expect(conNota.finalGrade).toBe(5);
    expect(conNota.parcial).toBe(true);
  });

  it("una entrega sin calificar la deja parcial", () => {
    const r = notaDelEstudianteEnCurso(
      curso({
        examenes: [cerrado],
        talleres: [
          { id: "t1", course_id: "k", cut_id: "c1", weight: 10, due_date: PASADO, status: "published", max_score: 5 },
        ],
        unionTalleres: new Map([["t1", { cut_id: "c1", weight: 10 }]]),
      }),
      estudiante({
        intentos: [intento("p1", 4)],
        entregaTaller: () => ({ status: "entregado", ai_grade: null, final_grade: null }),
      }),
      HOY,
    );
    expect(r.parcial).toBe(true);
  });

  it("una sesión por darse la deja parcial; una que pasó sin marcas, no", () => {
    const base = { examenes: [cerrado], sesionesDadas: new Set(["s1"]) };
    const alumno = estudiante({ intentos: [intento("p1", 4)], estadoAsistencia: () => "presente" });
    const futura = notaDelEstudianteEnCurso(
      curso({
        ...base,
        sesiones: [
          { id: "s1", cut_id: "c1", session_date: "2026-09-20" },
          { id: "s2", cut_id: "c1", session_date: "2026-10-07" },
        ],
      }),
      alumno,
      HOY,
    );
    expect(futura.parcial).toBe(true);
    const sinMarcas = notaDelEstudianteEnCurso(
      curso({
        ...base,
        sesiones: [
          { id: "s1", cut_id: "c1", session_date: "2026-09-20" },
          { id: "s2", cut_id: "c1", session_date: "2026-09-23" },
        ],
      }),
      alumno,
      HOY,
    );
    expect(sinMarcas.parcial).toBe(false);
  });

  it("lo que no suma no la deja parcial: sin corte, sin peso, o asistencia que pesa 0", () => {
    const r = notaDelEstudianteEnCurso(
      curso({
        cortes: [{ id: "c1", attendance_weight: 0 }],
        examenes: [cerrado],
        talleres: [
          { id: "pr", course_id: "k", cut_id: null, weight: 1, due_date: FUTURO, status: "published", max_score: 5 },
          { id: "t0", course_id: "k", cut_id: "c1", weight: 0, due_date: FUTURO, status: "published", max_score: 5 },
        ],
        sesiones: [{ id: "s9", cut_id: "c1", session_date: "2026-10-07" }],
      }),
      estudiante({ intentos: [intento("p1", 4)] }),
      HOY,
    );
    expect(r.parcial).toBe(false);
  });

  it("curso finalizado: la en línea con plazo futuro cuenta (0 si no entregó) y la nota es definitiva", () => {
    const d = curso({
      cursoFinalizado: true,
      examenes: [cerrado],
      talleres: [
        { id: "t1", course_id: "k", cut_id: "c1", weight: 10, due_date: FUTURO, status: "published", max_score: 5 },
      ],
      unionTalleres: new Map([["t1", { cut_id: "c1", weight: 10 }]]),
      sesiones: [{ id: "s2", cut_id: "c1", session_date: "2026-10-07" }],
    });
    const r = notaDelEstudianteEnCurso(d, estudiante({ intentos: [intento("p1", 4)] }), HOY);
    expect(r.cutGrades[0].grade).toBe(2);
    expect(r.parcial).toBe(false);
  });

  it("un corte que todavía no termina deja la nota parcial aunque no tenga nada pendiente", () => {
    const r = notaDelEstudianteEnCurso(
      curso({
        cortes: [
          { id: "c1", attendance_weight: 0, end_date: "2026-09-27" },
          { id: "c2", attendance_weight: 0, end_date: "2026-10-25" },
        ],
        examenes: [cerrado],
      }),
      estudiante({ intentos: [intento("p1", 4)] }),
      HOY,
    );
    expect(r.parcial).toBe(true);
    const terminado = notaDelEstudianteEnCurso(
      curso({ cortes: [{ id: "c1", attendance_weight: 0, end_date: "2026-09-27" }], examenes: [cerrado] }),
      estudiante({ intentos: [intento("p1", 4)] }),
      HOY,
    );
    expect(terminado.parcial).toBe(false);
  });

  it("curso finalizado: una externa que nunca tuvo notas no deja la nota parcial para siempre", () => {
    const r = notaDelEstudianteEnCurso(
      curso({
        cursoFinalizado: true,
        examenes: [cerrado],
        talleres: [
          { id: "x", course_id: "k", cut_id: "c1", weight: 10, due_date: PASADO, status: "published", is_external: true },
        ],
        unionTalleres: new Map([["x", { cut_id: "c1", weight: 10 }]]),
      }),
      estudiante({ intentos: [intento("p1", 4)] }),
      HOY,
    );
    expect(r.parcial).toBe(false);
  });

  it("curso finalizado: la externa sin ninguna nota cargada sigue sin contar", () => {
    const r = notaDelEstudianteEnCurso(
      curso({
        cursoFinalizado: true,
        examenes: [cerrado],
        talleres: [
          { id: "x", course_id: "k", cut_id: "c1", weight: 10, due_date: PASADO, status: "published", is_external: true },
        ],
        unionTalleres: new Map([["x", { cut_id: "c1", weight: 10 }]]),
      }),
      estudiante({ intentos: [intento("p1", 4)] }),
      HOY,
    );
    expect(r.cutGrades[0].grade).toBe(4);
  });
});

describe("actividadesConNota", () => {
  it("un intento sin terminar o sin nota no marca el examen como evaluado", () => {
    const r = actividadesConNota({
      intentos: [intento("a", 4), intento("b", null), intento("c", 4, "en_progreso")],
      entregasTaller: [],
      talleres: [],
      entregasProyecto: [],
    });
    expect([...r.examenes]).toEqual(["a"]);
  });

  it("un taller con sustentación pendiente todavía no está evaluado", () => {
    const r = actividadesConNota({
      intentos: [],
      entregasTaller: [
        { workshop_id: "t1", status: "calificado", ai_grade: 4, final_grade: null },
        { workshop_id: "t2", status: "calificado", ai_grade: 4, final_grade: null },
      ],
      talleres: [
        { id: "t1", requires_defense: true },
        { id: "t2", requires_defense: false },
      ],
      entregasProyecto: [{ project_id: "p", status: "entregado", ai_grade: null, final_grade: 3 }],
    });
    expect([...r.talleres]).toEqual(["t2"]);
    expect([...r.proyectos]).toEqual(["p"]);
  });
});
