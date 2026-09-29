import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ordenarSesiones,
  sesionSiguiente,
  sesionDondeToca,
  pendientesPorSesionDestino,
  pendientesAnotadosEn,
  siguientePosicion,
  normalizarTextoPendiente,
  lineasDePendientes,
  pendientesQueNoEntran,
  gruposDePendientes,
  MAX_CARACTERES_PENDIENTE,
  MAX_PENDIENTES_POR_LOTE,
  type PendienteSesion,
} from "./pendientes-sesion";

const s = (id: string, session_date: string, start_time: string | null = null) => ({
  id,
  session_date,
  start_time,
});
// Tres martes de un curso real: 22-sep, 29-sep y 6-oct.
const S3 = s("s3", "2026-09-22", "14:30:00");
const S4 = s("s4", "2026-09-29", "14:30:00");
const S5 = s("s5", "2026-10-06", "14:30:00");
const CURSO = [S5, S3, S4]; // desordenadas a propósito, como pueden llegar

const p = (
  id: string,
  session_id: string,
  extra: Partial<PendienteSesion> = {},
): PendienteSesion => ({
  id,
  session_id,
  body: `pendiente ${id}`,
  done_at: null,
  position: 0,
  created_at: "2026-09-22T20:00:00Z",
  ...extra,
});

describe("ordenarSesiones", () => {
  it("ordena por fecha", () => {
    expect(ordenarSesiones(CURSO).map((x) => x.id)).toEqual(["s3", "s4", "s5"]);
  });

  it("en el mismo día, por hora", () => {
    const a = s("a", "2026-09-29", "16:00:00");
    const b = s("b", "2026-09-29", "14:30:00");
    expect(ordenarSesiones([a, b]).map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("sin hora va al final del día y el id desempata siempre igual", () => {
    const conHora = s("z", "2026-09-29", "18:30:00");
    const sinHora1 = s("b", "2026-09-29");
    const sinHora2 = s("a", "2026-09-29");
    expect(ordenarSesiones([sinHora1, conHora, sinHora2]).map((x) => x.id)).toEqual(["z", "a", "b"]);
  });

  it("no muta la lista recibida", () => {
    const lista = [S5, S3];
    ordenarSesiones(lista);
    expect(lista.map((x) => x.id)).toEqual(["s5", "s3"]);
  });
});

describe("sesionSiguiente", () => {
  it("devuelve la del siguiente día de clase", () => {
    expect(sesionSiguiente(CURSO, "s3")?.id).toBe("s4");
    expect(sesionSiguiente(CURSO, "s4")?.id).toBe("s5");
  });

  it("la última todavía no tiene siguiente", () => {
    expect(sesionSiguiente(CURSO, "s5")).toBeNull();
  });

  it("una sesión que no está en la lista no tiene siguiente", () => {
    expect(sesionSiguiente(CURSO, "otra")).toBeNull();
  });

  it("un bloque partido es la misma clase: la próxima es la del día siguiente", () => {
    // Dos sesiones el 29 (las abre un solo código) y la clase del 6 de octubre.
    const a = s("a", "2026-09-29", "14:30:00");
    const b = s("b", "2026-09-29", "16:00:00");
    const lista = [b, a, S5];
    expect(sesionSiguiente(lista, "a")?.id).toBe("s5");
    expect(sesionSiguiente(lista, "b")?.id).toBe("s5");
  });

  it("si la próxima clase es un bloque partido, toca en su primera parte", () => {
    const a = s("a", "2026-10-06", "16:00:00");
    const b = s("b", "2026-10-06", "14:30:00");
    expect(sesionSiguiente([S4, a, b], "s4")?.id).toBe("b");
  });
});

describe("sesionDondeToca", () => {
  it("un pendiente del martes pasado toca hoy, si hoy hay clase", () => {
    expect(sesionDondeToca(CURSO, "s3", "2026-09-29")?.id).toBe("s4");
  });

  it("anotado el mismo día de una clase, toca en la siguiente", () => {
    expect(sesionDondeToca(CURSO, "s4", "2026-09-29")?.id).toBe("s5");
  });

  it("antes del día de su clase sigue vigente", () => {
    expect(sesionDondeToca(CURSO, "s3", "2026-09-25")?.id).toBe("s4");
  });

  it("pasado el día de su clase, caduca — no se arrastra a la siguiente", () => {
    // Lo ven los estudiantes: un pendiente de hace dos semanas es ruido.
    expect(sesionDondeToca(CURSO, "s3", "2026-09-30")).toBeNull();
  });

  it("anotado en la última sesión creada: todavía no le toca a ninguna", () => {
    expect(sesionDondeToca(CURSO, "s5", "2026-10-06")).toBeNull();
  });
});

describe("pendientesPorSesionDestino", () => {
  it("agrupa los abiertos en la sesión donde tocan", () => {
    const mapa = pendientesPorSesionDestino(
      CURSO,
      [p("1", "s3"), p("2", "s3"), p("3", "s4")],
      "2026-09-29",
    );
    expect(mapa.get("s4")?.map((x) => x.id)).toEqual(["1", "2"]);
    expect(mapa.get("s5")?.map((x) => x.id)).toEqual(["3"]);
  });

  it("los tachados no cuentan", () => {
    const mapa = pendientesPorSesionDestino(
      CURSO,
      [p("1", "s3", { done_at: "2026-09-29T20:00:00Z" }), p("2", "s3")],
      "2026-09-29",
    );
    expect(mapa.get("s4")?.map((x) => x.id)).toEqual(["2"]);
  });

  it("los caducados no cuentan", () => {
    const mapa = pendientesPorSesionDestino(CURSO, [p("viejo", "s3"), p("nuevo", "s4")], "2026-09-30");
    expect(mapa.has("s4")).toBe(false);
    expect(mapa.get("s5")?.map((x) => x.id)).toEqual(["nuevo"]);
  });

  it("los anotados en la última sesión no aparecen en ninguna columna", () => {
    const mapa = pendientesPorSesionDestino(CURSO, [p("1", "s5")], "2026-10-06");
    expect(mapa.size).toBe(0);
  });

  it("respeta el orden que fijó el docente", () => {
    const mapa = pendientesPorSesionDestino(
      CURSO,
      [p("b", "s3", { position: 1 }), p("a", "s3", { position: 0 })],
      "2026-09-29",
    );
    expect(mapa.get("s4")?.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("gruposDePendientes (la tarjeta del tablero)", () => {
  it("el día de la clase muestra lo de hoy y lo recién anotado para la siguiente", () => {
    const grupos = gruposDePendientes(CURSO, [p("hoy", "s3"), p("prox", "s4")], "2026-09-29");
    expect(grupos.map((g) => g.sesion.id)).toEqual(["s4", "s5"]);
    expect(grupos[0].items.map((x) => x.id)).toEqual(["hoy"]);
    expect(grupos[1].items.map((x) => x.id)).toEqual(["prox"]);
  });

  it("al día siguiente solo queda lo de la próxima", () => {
    const grupos = gruposDePendientes(CURSO, [p("hoy", "s3"), p("prox", "s4")], "2026-09-30");
    expect(grupos.map((g) => g.sesion.id)).toEqual(["s5"]);
  });

  it("sin pendientes vigentes no hay grupos (la tarjeta no se dibuja)", () => {
    expect(gruposDePendientes(CURSO, [p("x", "s3", { done_at: "x" })], "2026-09-29")).toEqual([]);
  });
});

describe("pendientesAnotadosEn / siguientePosicion", () => {
  const items = [p("1", "s3", { position: 0 }), p("2", "s3", { position: 3, done_at: "x" }), p("3", "s4")];
  it("lista los de esa sesión, abiertos y tachados", () => {
    expect(pendientesAnotadosEn(items, "s3").map((x) => x.id)).toEqual(["1", "2"]);
  });
  it("el nuevo va al final de su lista", () => {
    expect(siguientePosicion(items, "s3")).toBe(4);
    expect(siguientePosicion(items, "vacia")).toBe(0);
  });
});

describe("normalizarTextoPendiente", () => {
  it("recorta y colapsa espacios", () => {
    expect(normalizarTextoPendiente("  Retomar   JOINs \n ")).toBe("Retomar JOINs");
  });
  it("vacío no se guarda", () => {
    expect(normalizarTextoPendiente("   ")).toBeNull();
  });
  it("respeta el tope de la tabla", () => {
    expect(normalizarTextoPendiente("a".repeat(900))?.length).toBe(MAX_CARACTERES_PENDIENTE);
  });
  it("el tope es el mismo número que el CHECK de la migración", () => {
    const sql = readFileSync(
      resolve(__dirname, "../../../supabase/migrations/20262640000000_pendientes_proxima_sesion.sql"),
      "utf8",
    );
    const m = /char_length\(btrim\(body\)\)\s+BETWEEN\s+1\s+AND\s+(\d+)/.exec(sql);
    expect(Number(m?.[1])).toBe(MAX_CARACTERES_PENDIENTE);
  });
});

describe("lineasDePendientes (el campo del check-in)", () => {
  it("uno por línea, sin vacías", () => {
    expect(lineasDePendientes("Traer el taller impreso\n\n  Leer el capítulo 3  \r\n")).toEqual([
      "Traer el taller impreso",
      "Leer el capítulo 3",
    ]);
  });
  it("quita la viñeta de una lista pegada", () => {
    expect(lineasDePendientes("- uno\n• dos\n1. tres\n2) cuatro")).toEqual(["uno", "dos", "tres", "cuatro"]);
  });
  it("no toma el guion de un texto que empieza con número sin viñeta", () => {
    expect(lineasDePendientes("3 ejercicios de JOIN")).toEqual(["3 ejercicios de JOIN"]);
  });
  it("sin repetidos, aunque cambien las mayúsculas", () => {
    expect(lineasDePendientes("Leer el cap 3\nleer el cap 3")).toEqual(["Leer el cap 3"]);
  });
  it("con tope de líneas", () => {
    const texto = Array.from({ length: 40 }, (_, i) => `item ${i}`).join("\n");
    expect(lineasDePendientes(texto)).toHaveLength(MAX_PENDIENTES_POR_LOTE);
    // Lo que queda afuera se cuenta, para poder decirlo.
    expect(pendientesQueNoEntran(texto)).toBe(40 - MAX_PENDIENTES_POR_LOTE);
    expect(pendientesQueNoEntran(["uno", "dos"].join("\n"))).toBe(0);
  });
  it("vacío no da nada", () => {
    expect(lineasDePendientes("   \n  ")).toEqual([]);
  });
});
