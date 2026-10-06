import { describe, expect, it } from "vitest";
import {
  AUSENTE_SIN_MARCA,
  asistenciaDelEstudiante,
  estadoVisibleDeSesion,
  sesionesDadasParaEstudiante,
} from "./asistencia-del-estudiante";
import { asistenciaDelCorte, sesionesDadas } from "@/modules/grading/nota-relativa";

const ses = (...ids: string[]) => ids.map((id) => ({ id }));
const marcas = (m: Record<string, string>) => (id: string) => m[id] ?? null;

describe("asistencia del estudiante (misma regla que la nota)", () => {
  it("un vacío en una sesión que se dio cuenta como falta", () => {
    const dadas = new Set(["s1", "s2"]);
    const r = asistenciaDelEstudiante(ses("s1", "s2"), dadas, marcas({ s1: "presente" }));
    expect(r).toEqual({ dadas: 2, asistio: 1, falto: 1, sinMarca: 1, pct: 50 });
  });

  it("una sesión que nadie marcó (no se dio, o es futura) no cuenta para nadie", () => {
    const dadas = new Set(["s1"]);
    const r = asistenciaDelEstudiante(ses("s1", "s2", "s3"), dadas, marcas({ s1: "presente" }));
    expect(r).toMatchObject({ dadas: 1, asistio: 1, pct: 100 });
  });

  it("tarde cuenta como asistió; ausente y justificado, como falta marcada", () => {
    const dadas = new Set(["a", "b", "c", "d"]);
    const r = asistenciaDelEstudiante(
      ses("a", "b", "c", "d"),
      dadas,
      marcas({ a: "presente", b: "tarde", c: "ausente", d: "justificado" }),
    );
    expect(r).toEqual({ dadas: 4, asistio: 2, falto: 2, sinMarca: 0, pct: 50 });
  });

  it("sin sesiones dadas el porcentaje es null, no 0", () => {
    expect(asistenciaDelEstudiante(ses("s1"), new Set(), marcas({})).pct).toBeNull();
  });

  it("coincide con la asistencia de la NOTA para los mismos datos", () => {
    const registros = [
      { session_id: "s1", user_id: "u1", status: "presente" },
      { session_id: "s1", user_id: "u2", status: "presente" },
      { session_id: "s2", user_id: "u2", status: "presente" },
      { session_id: "s3", user_id: "u1", status: "tarde" },
    ];
    const dadas = sesionesDadas(registros);
    const todas = ses("s1", "s2", "s3", "s4");
    for (const u of ["u1", "u2"]) {
      const estado = (sid: string) =>
        registros.find((r) => r.session_id === sid && r.user_id === u)?.status ?? null;
      const pantalla = asistenciaDelEstudiante(todas, dadas, estado);
      const nota = asistenciaDelCorte(todas, dadas, estado, { min: 0, max: 5 });
      expect(pantalla.dadas).toBe(nota.dadas);
      expect(pantalla.asistio).toBe(nota.presentes);
    }
  });
});

describe("estado visible de una sesión", () => {
  const dadas = new Set(["s1", "s2"]);
  const estado = marcas({ s1: "presente" });
  it("con marca, la marca", () =>
    expect(estadoVisibleDeSesion("s1", dadas, estado)).toBe("presente"));
  it("dada y sin marca: ausente sin marca", () =>
    expect(estadoVisibleDeSesion("s2", dadas, estado)).toBe(AUSENTE_SIN_MARCA));
  it("no dada y sin marca: null", () =>
    expect(estadoVisibleDeSesion("s3", dadas, estado)).toBeNull());
});

describe("sesiones dadas vistas por el estudiante", () => {
  const ses = [
    { id: "s1", session_date: "2026-10-01" },
    { id: "s2", session_date: "2026-10-05" },
    { id: "s3", session_date: "2026-10-20" },
  ];

  it("una marca propia suma la sesión aunque el servidor no la tuviera todavía", () => {
    // El check-in con la página abierta: el servidor dijo «s1» al cargar.
    const dadas = sesionesDadasParaEstudiante(new Set(["s1"]), ses, (id) => id === "s2", "2026-10-05");
    expect([...dadas].sort()).toEqual(["s1", "s2"]);
  });

  it("con la señal del servidor, una sesión pasada SIN marcas de nadie no cuenta", () => {
    const dadas = sesionesDadasParaEstudiante(new Set(["s1"]), ses, () => false, "2026-10-30");
    expect([...dadas]).toEqual(["s1"]);
  });

  it("sin la señal del servidor se aproxima: ya pasó (hoy incluido) o tiene marca", () => {
    const dadas = sesionesDadasParaEstudiante(null, ses, (id) => id === "s3", "2026-10-05");
    expect([...dadas].sort()).toEqual(["s1", "s2", "s3"]);
  });
});
