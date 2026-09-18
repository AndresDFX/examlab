import { beforeEach, describe, expect, it } from "vitest";
import {
  borrarBorrador,
  claveBorrador,
  combinarConBorrador,
  esVacia,
  guardarBorrador,
  leerBorrador,
  tieneContenido,
} from "./borrador-local";

beforeEach(() => {
  localStorage.clear();
});

describe("claveBorrador", () => {
  it("separa por tipo, entregable y usuario", () => {
    expect(claveBorrador("taller", "w1", "u1")).toBe("examlab_borrador:taller:w1:u1");
    expect(claveBorrador("proyecto", "w1", "u1")).toBe("examlab_borrador:proyecto:w1:u1");
    // Dos personas en el mismo navegador (sala de cómputo) no comparten borrador.
    expect(claveBorrador("taller", "w1", "u2")).not.toBe(claveBorrador("taller", "w1", "u1"));
  });

  it("sin usuario no colisiona con una sesión iniciada", () => {
    expect(claveBorrador("taller", "w1", null)).toBe("examlab_borrador:taller:w1:anon");
  });
});

describe("esVacia", () => {
  it("reconoce las formas de respuesta vacía", () => {
    expect(esVacia(null)).toBe(true);
    expect(esVacia(undefined)).toBe(true);
    expect(esVacia("")).toBe(true);
    expect(esVacia("   ")).toBe(true);
    expect(esVacia([])).toBe(true);
    expect(esVacia({})).toBe(true);
  });

  it("el índice 0 es una RESPUESTA, no un vacío", () => {
    // Es la primera opción de una cerrada. Tratarlo como vacío haría que el
    // borrador la pisara y que el estudiante perdiera justo esa.
    expect(esVacia(0)).toBe(false);
  });

  it("reconoce respuestas con contenido", () => {
    expect(esVacia("hola")).toBe(false);
    expect(esVacia([1, 2])).toBe(false);
    expect(esVacia({ topology: {} })).toBe(false);
  });
});

describe("guardar y leer", () => {
  it("un borrador con contenido va y vuelve", () => {
    const k = claveBorrador("taller", "w1", "u1");
    guardarBorrador(k, { q1: "mi respuesta", q2: 2 });
    const leido = leerBorrador(k);
    expect(leido?.respuestas).toEqual({ q1: "mi respuesta", q2: 2 });
    expect(leido?.guardadoEn).toBeTruthy();
  });

  it("guardar vacío BORRA el borrador en vez de dejar uno inútil", () => {
    const k = claveBorrador("taller", "w1", "u1");
    guardarBorrador(k, { q1: "algo" });
    guardarBorrador(k, { q1: "" });
    expect(leerBorrador(k)).toBeNull();
  });

  it("no devuelve nada si no hay borrador", () => {
    expect(leerBorrador(claveBorrador("taller", "nope", "u1"))).toBeNull();
  });

  it("descarta basura y formatos viejos sin romper", () => {
    const k = claveBorrador("taller", "w1", "u1");
    localStorage.setItem(k, "no es json");
    expect(leerBorrador(k)).toBeNull();
    localStorage.setItem(k, JSON.stringify({ v: 99, guardadoEn: new Date().toISOString(), respuestas: { q: "x" } }));
    expect(leerBorrador(k)).toBeNull();
    localStorage.setItem(k, JSON.stringify({ v: 1, guardadoEn: "ayer", respuestas: { q: "x" } }));
    expect(leerBorrador(k)).toBeNull();
  });

  it("un borrador vencido se descarta y se limpia", () => {
    const k = claveBorrador("taller", "w1", "u1");
    const viejo = new Date("2026-01-01T00:00:00Z").toISOString();
    localStorage.setItem(k, JSON.stringify({ v: 1, guardadoEn: viejo, respuestas: { q: "x" } }));
    expect(leerBorrador(k, new Date("2026-09-18T00:00:00Z"))).toBeNull();
    expect(localStorage.getItem(k)).toBeNull();
  });

  it("borrarBorrador lo quita", () => {
    const k = claveBorrador("proyecto", "p1", "u1");
    guardarBorrador(k, { q1: "x" });
    borrarBorrador(k);
    expect(leerBorrador(k)).toBeNull();
  });
});

describe("tieneContenido", () => {
  it("distingue un formulario en blanco de uno empezado", () => {
    expect(tieneContenido({})).toBe(false);
    expect(tieneContenido({ q1: "", q2: [] })).toBe(false);
    expect(tieneContenido({ q1: "", q2: "algo" })).toBe(true);
    expect(tieneContenido({ q1: 0 })).toBe(true);
  });
});

describe("combinarConBorrador", () => {
  it("el servidor MANDA: lo que ya tiene respuesta no se pisa", () => {
    // El caso real: un taller en grupo donde un compañero ya respondió desde
    // otro dispositivo. Pisarlo con un borrador viejo de este sería peor que
    // no restaurar nada.
    const r = combinarConBorrador({ q1: "la del servidor" }, { q1: "la del borrador" });
    expect(r.respuestas.q1).toBe("la del servidor");
    expect(r.recuperadas).toEqual([]);
  });

  it("rellena SOLO lo que quedó vacío", () => {
    const r = combinarConBorrador(
      { q1: "del servidor", q2: "", q3: [] },
      { q1: "ignorada", q2: "recuperada", q3: [1] },
    );
    expect(r.respuestas).toEqual({ q1: "del servidor", q2: "recuperada", q3: [1] });
    expect(r.recuperadas.sort()).toEqual(["q2", "q3"]);
  });

  it("agrega preguntas que el servidor ni siquiera tenía", () => {
    const r = combinarConBorrador({}, { q1: "escrita y nunca enviada" });
    expect(r.respuestas).toEqual({ q1: "escrita y nunca enviada" });
    expect(r.recuperadas).toEqual(["q1"]);
  });

  it("sin borrador devuelve el objeto del servidor tal cual", () => {
    const servidor = { q1: "x" };
    expect(combinarConBorrador(servidor, null).respuestas).toBe(servidor);
    expect(combinarConBorrador(servidor, undefined).recuperadas).toEqual([]);
  });

  it("un borrador que no aporta nada no cambia la identidad del objeto", () => {
    // Para no disparar un render ni un effect por una restauración que no
    // restauró nada.
    const servidor = { q1: "x" };
    const r = combinarConBorrador(servidor, { q1: "otra", q2: "" });
    expect(r.respuestas).toBe(servidor);
    expect(r.recuperadas).toEqual([]);
  });

  it("un 0 del borrador se recupera sobre una vacía del servidor", () => {
    const r = combinarConBorrador({ q1: "" }, { q1: 0 });
    expect(r.respuestas.q1).toBe(0);
    expect(r.recuperadas).toEqual(["q1"]);
  });
});
