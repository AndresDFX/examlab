import { describe, it, expect } from "vitest";
// Fuente única: el helper vive en el edge y se importa por ruta relativa
// (misma convención que vtt-transcript.test.ts y otras invariantes del repo).
import {
  ESTADOS_SIN_ENTREGAR_LOGISTICA,
  entregaRealizada,
  formatFechaHoraBogota,
  formatFechaSesionBogota,
  hoyBogotaISO,
  construirBloqueLogistica,
  type ActividadLog,
  type SesionLog,
} from "../../../supabase/functions/tutor-chat/logistica.ts";
import { ESTADOS_SIN_ENTREGAR } from "../submissions/entrega-hecha.ts";

describe("invariante cross-file: estados sin entregar", () => {
  it("la lista negra del edge coincide con la de src/submissions", () => {
    expect([...ESTADOS_SIN_ENTREGAR_LOGISTICA]).toEqual([...ESTADOS_SIN_ENTREGAR]);
  });
});

describe("entregaRealizada", () => {
  it("nulo o desconocido cuenta como entregado", () => {
    expect(entregaRealizada(null)).toBe(true);
    expect(entregaRealizada(undefined)).toBe(true);
    expect(entregaRealizada("calificado")).toBe(true);
    expect(entregaRealizada("entregado")).toBe(true);
    expect(entregaRealizada("ai_revisado")).toBe(true);
  });
  it("los estados de la lista negra NO cuentan", () => {
    expect(entregaRealizada("en_progreso")).toBe(false);
    expect(entregaRealizada("no_entregado")).toBe(false);
    expect(entregaRealizada(" borrador ")).toBe(false);
  });
});

describe("formato de fecha en Bogotá con día de la semana", () => {
  it("timestamptz → «jueves 5 de noviembre, …» en hora de Bogotá", () => {
    // 2026-11-06T01:00:00Z = 2026-11-05 20:00 en Bogotá (UTC-5).
    const s = formatFechaHoraBogota("2026-11-06T01:00:00+00:00");
    expect(s).toContain("jueves 5 de noviembre");
    expect(s).toMatch(/8:00\s*p/);
  });
  it("devuelve null para fecha ausente o inválida", () => {
    expect(formatFechaHoraBogota(null)).toBeNull();
    expect(formatFechaHoraBogota("no-es-fecha")).toBeNull();
  });
  it("sesión con DATE + TIME ancla a Bogotá (UTC-5 fijo)", () => {
    const s = formatFechaSesionBogota("2026-08-27", "18:00:00");
    expect(s).toContain("jueves 27 de agosto");
    expect(s).toMatch(/6:00\s*p/);
  });
  it("sesión sin hora: solo el día", () => {
    const s = formatFechaSesionBogota("2026-08-27", null);
    expect(s).toBe("jueves 27 de agosto");
  });
  it("hoyBogotaISO respeta la zona horaria", () => {
    // 2026-01-01T03:00:00Z = 2025-12-31 22:00 en Bogotá.
    expect(hoyBogotaISO(Date.parse("2026-01-01T03:00:00Z"))).toBe("2025-12-31");
  });
});

const AHORA = Date.parse("2026-10-25T17:00:00-05:00");

function act(partial: Partial<ActividadLog>): ActividadLog {
  return {
    tipo: "examen",
    titulo: "X",
    inicioIso: null,
    cierreIso: null,
    corteNombre: null,
    peso: 0,
    externa: false,
    entrego: false,
    esRecuperacion: false,
    makeupLabel: null,
    ...partial,
  };
}

describe("construirBloqueLogistica", () => {
  it("devuelve vacío cuando no hay nada que mostrar", () => {
    expect(construirBloqueLogistica({ ahora: AHORA, actividades: [], sesiones: [] })).toBe("");
  });

  it("incluye el encabezado y la advertencia de no inventar", () => {
    const out = construirBloqueLogistica({
      ahora: AHORA,
      actividades: [act({ titulo: "Parcial 2", cierreIso: "2026-11-06T01:00:00+00:00" })],
      sesiones: [],
    });
    expect(out).toContain("## Calendario del curso (datos de ExamLab");
    expect(out).toContain("NO lo inventes");
  });

  it("arma la línea de un examen pendiente con corte, peso y cierre", () => {
    const out = construirBloqueLogistica({
      ahora: AHORA,
      actividades: [
        act({
          titulo: "Parcial 2",
          corteNombre: "Corte 2",
          peso: 10,
          cierreIso: "2026-11-06T01:00:00+00:00",
        }),
      ],
      sesiones: [],
    });
    expect(out).toContain("Examen «Parcial 2» (Corte 2, 10% de la nota final).");
    expect(out).toContain("Cierra: jueves 5 de noviembre");
    expect(out).toContain("Pendiente de entregar.");
  });

  it("una que ya cerró sin entrega no dice «pendiente»", () => {
    const out = construirBloqueLogistica({
      ahora: AHORA,
      actividades: [act({ tipo: "taller", titulo: "Viejo", cierreIso: new Date(AHORA - 3 * 864e5).toISOString() })],
      sesiones: [],
    });
    expect(out).toContain("Ya cerró y no entregaste.");
    expect(out).not.toContain("Pendiente de entregar.");
  });

  it("marca entrega hecha y no pide entregar externas", () => {
    const out = construirBloqueLogistica({
      ahora: AHORA,
      actividades: [
        act({ tipo: "taller", titulo: "T1", cierreIso: "2026-10-20T04:59:00+00:00", entrego: true }),
        act({ tipo: "examen", titulo: "Presencial", externa: true, cierreIso: "2026-10-28T04:59:00+00:00" }),
      ],
      sesiones: [],
    });
    expect(out).toContain("Ya entregaste.");
    expect(out).toContain("Actividad EXTERNA");
    expect(out).not.toContain("Pendiente de entregar.");
  });

  it("deja fuera lo que cae fuera de la ventana (±)", () => {
    const out = construirBloqueLogistica({
      ahora: AHORA,
      actividades: [
        act({ titulo: "Muy viejo", cierreIso: "2026-01-01T00:00:00+00:00" }),
        act({ titulo: "Muy lejano", cierreIso: "2027-06-01T00:00:00+00:00" }),
        act({ titulo: "En ventana", cierreIso: "2026-11-06T01:00:00+00:00" }),
      ],
      sesiones: [],
    });
    expect(out).toContain("En ventana");
    expect(out).not.toContain("Muy viejo");
    expect(out).not.toContain("Muy lejano");
  });

  it("ordena las actividades por fecha y deja las sin fecha al final", () => {
    const out = construirBloqueLogistica({
      ahora: AHORA,
      actividades: [
        act({ titulo: "Sin fecha" }),
        act({ titulo: "Segunda", cierreIso: "2026-11-10T00:00:00+00:00" }),
        act({ titulo: "Primera", cierreIso: "2026-10-28T00:00:00+00:00" }),
      ],
      sesiones: [],
    });
    const iPrimera = out.indexOf("Primera");
    const iSegunda = out.indexOf("Segunda");
    const iSin = out.indexOf("Sin fecha");
    expect(iPrimera).toBeLessThan(iSegunda);
    expect(iSegunda).toBeLessThan(iSin);
    expect(out).toContain("Sin fecha definida todavía.");
  });

  it("separa próximas clases de recientes con grabación", () => {
    const sesiones: SesionLog[] = [
      { titulo: "Clase próxima", fecha: "2026-10-29", hora: "18:00:00", tipo: "virtual", tieneGrabacion: false },
      { titulo: "Clase pasada con grab", fecha: "2026-10-22", hora: "18:00:00", tipo: "presencial", tieneGrabacion: true },
      { titulo: "Clase pasada sin grab", fecha: "2026-10-15", hora: "18:00:00", tipo: "virtual", tieneGrabacion: false },
    ];
    const out = construirBloqueLogistica({ ahora: AHORA, actividades: [], sesiones });
    expect(out).toContain("### Próximas clases");
    expect(out).toContain("Clase próxima");
    expect(out).toContain("### Clases recientes con grabación");
    expect(out).toContain("Clase pasada con grab");
    expect(out).toContain("grabación disponible");
    expect(out).not.toContain("Clase pasada sin grab");
  });

  it("no expone enlaces de grabación, solo que existe", () => {
    const sesiones: SesionLog[] = [
      { titulo: "C", fecha: "2026-10-22", hora: null, tipo: "virtual", tieneGrabacion: true },
    ];
    const out = construirBloqueLogistica({ ahora: AHORA, actividades: [], sesiones });
    expect(out).toContain("Cursos o Asistencia");
    expect(out).not.toMatch(/https?:\/\//);
  });
});
