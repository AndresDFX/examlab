import { describe, it, expect } from "vitest";
import {
  resolverNotaConRecuperacion,
  notaDeExamenParaEstudiante,
  entregasQueDecidenLaNota,
  presento,
  tipoDeRecuperacion,
  reglaDeRecuperatorio,
  type Recuperacion,
} from "./nota-con-recuperacion";
import type { AttemptForGrade } from "@/modules/exams/exam-attempts";

const intento = (
  nota: number | null,
  status = "completado",
  created_at = "2026-09-28T23:50:00Z",
): AttemptForGrade => ({ status, ai_grade: nota, final_override_grade: null, created_at });

const original = (intentos: AttemptForGrade[]) => ({
  id: "parcial",
  retryMode: "last" as const,
  intentos,
});

const rec = (
  id: string,
  tipo: Recuperacion["tipo"],
  intentos: AttemptForGrade[],
  extra: Partial<Recuperacion> = {},
): Recuperacion => ({
  id,
  tipo,
  regla: "mayor",
  retryMode: "last",
  intentos,
  creadoEn: "2026-09-30T00:00:00Z",
  ...extra,
});

describe("sin recuperaciones", () => {
  it("cuenta la nota del original", () => {
    expect(resolverNotaConRecuperacion(original([intento(3.5)]), [])).toEqual({
      nota: 3.5,
      fuente: "original",
      examIdFuente: "parcial",
    });
  });

  it("sin haber presentado nada, no hay nota", () => {
    expect(resolverNotaConRecuperacion(original([]), [])).toEqual({
      nota: null,
      fuente: null,
      examIdFuente: null,
    });
  });
});

describe("supletorio — el comportamiento de siempre, sin cambios", () => {
  it("llena la ausencia de quien no presentó el original", () => {
    const r = resolverNotaConRecuperacion(original([]), [rec("sup", "supletorio", [intento(4)])]);
    expect(r).toEqual({ nota: 4, fuente: "supletorio", examIdFuente: "sup" });
  });

  it("NO cuenta si el estudiante presentó el original, aunque también presente el supletorio", () => {
    const r = resolverNotaConRecuperacion(original([intento(2)]), [
      rec("sup", "supletorio", [intento(5)]),
    ]);
    expect(r).toEqual({ nota: 2, fuente: "original", examIdFuente: "parcial" });
  });

  it("un intento EN CURSO del original no es haber presentado: cuenta el supletorio", () => {
    const r = resolverNotaConRecuperacion(original([intento(null, "en_progreso")]), [
      rec("sup", "supletorio", [intento(3.8)]),
    ]);
    expect(r.fuente).toBe("supletorio");
    expect(r.nota).toBe(3.8);
  });
});

describe("recuperatorio", () => {
  it("regla «mayor»: si sube, cuenta el recuperatorio", () => {
    const r = resolverNotaConRecuperacion(original([intento(2.5)]), [
      rec("rec", "recuperatorio", [intento(3.6)]),
    ]);
    expect(r).toEqual({ nota: 3.6, fuente: "recuperatorio", examIdFuente: "rec" });
  });

  it("regla «mayor»: si baja, se queda la nota del original", () => {
    const r = resolverNotaConRecuperacion(original([intento(2.5)]), [
      rec("rec", "recuperatorio", [intento(1.9)]),
    ]);
    expect(r).toEqual({ nota: 2.5, fuente: "original", examIdFuente: "parcial" });
  });

  it("regla «mayor»: un empate se queda con el original", () => {
    const r = resolverNotaConRecuperacion(original([intento(3)]), [
      rec("rec", "recuperatorio", [intento(3)]),
    ]);
    expect(r.fuente).toBe("original");
  });

  it("regla «reemplaza»: sustituye aunque baje", () => {
    const r = resolverNotaConRecuperacion(original([intento(2.5)]), [
      rec("rec", "recuperatorio", [intento(1.9)], { regla: "reemplaza" }),
    ]);
    expect(r).toEqual({ nota: 1.9, fuente: "recuperatorio", examIdFuente: "rec" });
  });

  it("presentado pero todavía sin nota (la IA va en cola): no cambia nada", () => {
    const r = resolverNotaConRecuperacion(original([intento(2.5)]), [
      rec("rec", "recuperatorio", [intento(null)], { regla: "reemplaza" }),
    ]);
    expect(r).toEqual({ nota: 2.5, fuente: "original", examIdFuente: "parcial" });
  });

  it("si el original aún no tiene nota y el recuperatorio sí, cuenta el recuperatorio", () => {
    const r = resolverNotaConRecuperacion(original([intento(null)]), [
      rec("rec", "recuperatorio", [intento(3.2)]),
    ]);
    expect(r.nota).toBe(3.2);
    expect(r.fuente).toBe("recuperatorio");
  });

  it("quien no presentó el original y sí el recuperatorio recibe esa nota", () => {
    const r = resolverNotaConRecuperacion(original([]), [
      rec("rec", "recuperatorio", [intento(3.1)]),
    ]);
    expect(r).toEqual({ nota: 3.1, fuente: "recuperatorio", examIdFuente: "rec" });
  });

  it("respeta el modo de reintentos PROPIO del recuperatorio", () => {
    const r = resolverNotaConRecuperacion(original([intento(2)]), [
      rec(
        "rec",
        "recuperatorio",
        [intento(3.9, "completado", "2026-10-05T23:10:00Z"), intento(3, "completado", "2026-10-05T23:40:00Z")],
        { retryMode: "highest" },
      ),
    ]);
    expect(r.nota).toBe(3.9);
  });

  it("un recuperatorio sin presentar no cuenta", () => {
    const r = resolverNotaConRecuperacion(original([intento(2)]), [rec("rec", "recuperatorio", [])]);
    expect(r.fuente).toBe("original");
  });
});

describe("varias recuperaciones: se aplican en orden de creación", () => {
  it("el supletorio llena la ausencia y un recuperatorio posterior sube la nota", () => {
    const r = resolverNotaConRecuperacion(original([]), [
      rec("rec", "recuperatorio", [intento(4.2)], { creadoEn: "2026-10-10T00:00:00Z" }),
      rec("sup", "supletorio", [intento(2.8)], { creadoEn: "2026-10-01T00:00:00Z" }),
    ]);
    expect(r).toEqual({ nota: 4.2, fuente: "recuperatorio", examIdFuente: "rec" });
  });

  it("un «reemplaza» posterior manda sobre un «mayor» anterior", () => {
    const r = resolverNotaConRecuperacion(original([intento(2)]), [
      rec("rec1", "recuperatorio", [intento(3.5)], { creadoEn: "2026-10-01T00:00:00Z" }),
      rec("rec2", "recuperatorio", [intento(3)], {
        creadoEn: "2026-10-08T00:00:00Z",
        regla: "reemplaza",
      }),
    ]);
    expect(r).toEqual({ nota: 3, fuente: "recuperatorio", examIdFuente: "rec2" });
  });
});

describe("notaDeExamenParaEstudiante (desde las filas que cargan las pantallas)", () => {
  const examenes = [
    { id: "parcial", parent_exam_id: null, retry_mode: "last", created_at: "2026-09-01T00:00:00Z" },
    {
      id: "rec",
      parent_exam_id: "parcial",
      retry_mode: "last",
      makeup_kind: "recuperatorio",
      recovery_rule: "mayor",
      created_at: "2026-09-30T00:00:00Z",
    },
    { id: "otro", parent_exam_id: null, retry_mode: "last", created_at: "2026-09-02T00:00:00Z" },
  ];

  it("toma solo las recuperaciones de ESE examen", () => {
    const intentos = [
      { ...intento(2.5), exam_id: "parcial" },
      { ...intento(4), exam_id: "rec" },
      { ...intento(5), exam_id: "otro" },
    ];
    expect(notaDeExamenParaEstudiante(examenes[0], examenes, intentos).nota).toBe(4);
    expect(notaDeExamenParaEstudiante(examenes[2], examenes, intentos).nota).toBe(5);
  });

  it("una recuperación en borrador o en la papelera no cuenta (como en el acta)", () => {
    const conBorrador = [
      examenes[0],
      { ...examenes[1], status: "draft" },
      { ...examenes[1], id: "rec-papelera", deleted_at: "2026-10-01T00:00:00Z" },
    ];
    const intentos = [
      { ...intento(2.5), exam_id: "parcial" },
      { ...intento(4), exam_id: "rec" },
      { ...intento(4.5), exam_id: "rec-papelera" },
    ];
    expect(notaDeExamenParaEstudiante(conBorrador[0], conBorrador, intentos).nota).toBe(2.5);
  });

  it("una fila vieja SIN la columna nueva se comporta como supletorio (como antes)", () => {
    const viejos = [
      { id: "parcial", parent_exam_id: null, retry_mode: "last" },
      { id: "sup", parent_exam_id: "parcial", retry_mode: "last" },
    ];
    const intentos = [
      { ...intento(2), exam_id: "parcial" },
      { ...intento(5), exam_id: "sup" },
    ];
    // Presentó el original: el supletorio no cuenta, exactamente como hasta hoy.
    expect(notaDeExamenParaEstudiante(viejos[0], viejos, intentos).nota).toBe(2);
  });
});

describe("normalizadores", () => {
  it("un valor desconocido cae al default", () => {
    expect(tipoDeRecuperacion(undefined)).toBe("supletorio");
    expect(tipoDeRecuperacion("otra cosa")).toBe("supletorio");
    expect(tipoDeRecuperacion("recuperatorio")).toBe("recuperatorio");
    expect(reglaDeRecuperatorio(null)).toBe("mayor");
    expect(reglaDeRecuperatorio("reemplaza")).toBe("reemplaza");
  });

  it("presentó = al menos un intento finalizado", () => {
    expect(presento([intento(null, "en_progreso")])).toBe(false);
    expect(presento([intento(null, "sospechoso")])).toBe(true);
    expect(presento([])).toBe(false);
  });
});

describe("entregasQueDecidenLaNota (lo que cuentan Estadísticas y la Alerta temprana)", () => {
  const examenes = [
    { id: "parcial", parent_exam_id: null, retry_mode: "last", created_at: "2026-09-01T00:00:00Z" },
    {
      id: "rec",
      parent_exam_id: "parcial",
      retry_mode: "last",
      makeup_kind: "recuperatorio",
      recovery_rule: "mayor",
      created_at: "2026-09-30T00:00:00Z",
    },
  ];
  const e = (user_id: string, exam_id: string, nota: number | null, status = "completado") => ({
    ...intento(nota, status),
    user_id,
    exam_id,
  });
  const resumen = (xs: ReturnType<typeof entregasQueDecidenLaNota>) =>
    xs.map((x) => `${x.examenOriginal}:${x.entrega.user_id}:${x.entrega.exam_id}`).sort();

  it("sin recuperaciones se queda todo, atribuido a su examen", () => {
    expect(resumen(entregasQueDecidenLaNota(examenes, [e("ana", "parcial", 4)]))).toEqual([
      "parcial:ana:parcial",
    ]);
  });

  it("si el recuperatorio mejora la nota, cuenta SU entrega y se atribuye al original", () => {
    const r = entregasQueDecidenLaNota(examenes, [e("ana", "parcial", 2), e("ana", "rec", 3.5)]);
    expect(resumen(r)).toEqual(["parcial:ana:rec"]);
  });

  it("si no la mejora, cuenta la del original y el recuperatorio no suma una reprobada más", () => {
    const r = entregasQueDecidenLaNota(examenes, [e("ana", "parcial", 2), e("ana", "rec", 1.5)]);
    expect(resumen(r)).toEqual(["parcial:ana:parcial"]);
  });

  it("quien no presentó nada y tiene un intento en curso sigue «en curso»", () => {
    const r = entregasQueDecidenLaNota(examenes, [e("caro", "rec", null, "en_progreso")]);
    expect(resumen(r)).toEqual(["parcial:caro:rec"]);
  });

  it("una recuperación cuyo original no está (borrador o papelera) no cuenta", () => {
    const r = entregasQueDecidenLaNota([examenes[1]], [e("ana", "rec", 4)]);
    expect(r).toEqual([]);
  });
});
