import { describe, expect, it } from "vitest";
import { accionDeEntrega, accionDeExamen } from "./accion-de-tarjeta";

const entrega = (extra: Partial<Parameters<typeof accionDeEntrega>[0]> = {}) =>
  accionDeEntrega({
    armarGrupo: false,
    externa: false,
    abierta: true,
    sinGrupoObligatorio: false,
    intentosAgotados: false,
    conNota: false,
    entregada: false,
    proxima: false,
    vencida: false,
    ...extra,
  });

describe("acción de la tarjeta de un taller o proyecto", () => {
  it("abierta y sin entregar: entregar", () => {
    expect(entrega()).toBe("entregar");
  });

  it("con nota y plazo abierto se puede actualizar; con los intentos agotados, ver el detalle", () => {
    expect(entrega({ entregada: true, conNota: true })).toBe("entregar");
    expect(entrega({ entregada: true, conNota: true, intentosAgotados: true })).toBe("detalle");
  });

  it("grupal estricto sin grupo: armarlo si lo arman los estudiantes, si no avisar que falta", () => {
    expect(entrega({ armarGrupo: true, sinGrupoObligatorio: true })).toBe("armar");
    expect(entrega({ sinGrupoObligatorio: true })).toBe("sinGrupo");
    // Armar el grupo no depende de que ya haya abierto: se prepara antes.
    expect(entrega({ armarGrupo: true, abierta: false, proxima: true })).toBe("armar");
    // Cerrada, el aviso de grupo ya no ayuda: manda lo que pasó con el plazo.
    expect(entrega({ sinGrupoObligatorio: true, abierta: false, vencida: true })).toBe("vencido");
  });

  it("un externo no se entrega por acá: nota o nada, nunca «Vencido»", () => {
    expect(entrega({ externa: true })).toBe("externo");
    expect(entrega({ externa: true, abierta: false, vencida: true })).toBe("externo");
    expect(entrega({ externa: true, conNota: true })).toBe("detalle");
  });

  it("cerrada: la nota, la espera de la nota, o por qué no hay nada", () => {
    const cerrada = { abierta: false };
    expect(entrega({ ...cerrada, entregada: true, conNota: true })).toBe("detalle");
    expect(entrega({ ...cerrada, entregada: true })).toBe("porCalificar");
    expect(entrega({ ...cerrada, proxima: true })).toBe("proximo");
    expect(entrega({ ...cerrada, vencida: true })).toBe("vencido");
    expect(entrega(cerrada)).toBe("cerrado");
  });
});

const examen = (extra: Partial<Parameters<typeof accionDeExamen>[0]> = {}) =>
  accionDeExamen({
    completado: false,
    abierto: true,
    sinIntentos: false,
    conNota: false,
    enCurso: false,
    ventanaTerminada: false,
    antesDeAbrir: false,
    advertenciasAlTope: false,
    ...extra,
  });

describe("acción de la tarjeta de un examen", () => {
  it("abierto: presentar (o reanudar)", () => {
    expect(examen()).toBe("presentar");
    expect(examen({ enCurso: true })).toBe("presentar");
  });

  it("terminado con intentos y la ventana abierta: reintentar", () => {
    expect(examen({ completado: true })).toBe("reintentar");
    expect(examen({ completado: true, conNota: true })).toBe("reintentar");
  });

  it("terminado sin reintento: la nota o la espera de la nota", () => {
    expect(examen({ completado: true, sinIntentos: true, conNota: true })).toBe("detalle");
    expect(examen({ completado: true, sinIntentos: true })).toBe("porCalificar");
    expect(examen({ completado: true, abierto: false, ventanaTerminada: true })).toBe(
      "porCalificar",
    );
  });

  it("un intento a medias cuando cerró la ventana dice eso, antes que los intentos", () => {
    expect(
      examen({ enCurso: true, abierto: false, ventanaTerminada: true, sinIntentos: true }),
    ).toBe("ventanaCerrada");
  });

  it("sin intentos, suspendido por advertencias, próximo y cerrado", () => {
    expect(examen({ sinIntentos: true })).toBe("sinIntentos");
    expect(examen({ enCurso: true, advertenciasAlTope: true })).toBe("suspendido");
    expect(examen({ abierto: false, antesDeAbrir: true })).toBe("proximo");
    expect(examen({ abierto: false, ventanaTerminada: true })).toBe("cerrado");
  });
});
