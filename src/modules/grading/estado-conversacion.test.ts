import { describe, it, expect } from "vitest";
import { contarPorEstado, estadoDeConversacion, resumirHilos } from "./estado-conversacion";

describe("estadoDeConversacion", () => {
  it("sin hilos abiertos no hay nada pendiente", () => {
    expect(estadoDeConversacion(undefined)).toBeNull();
    expect(estadoDeConversacion({ count: 0, pending: false })).toBeNull();
  });
  it("si el último mensaje es del estudiante, falta responder", () => {
    expect(estadoDeConversacion({ count: 1, pending: true, awaitingClose: false })).toBe(
      "responder",
    );
  });
  it("respondido y abierto: falta cerrar (el caso que se perdía)", () => {
    expect(estadoDeConversacion({ count: 1, pending: false, awaitingClose: true })).toBe("cerrar");
  });
  it("sin el dato nuevo, un hilo abierto que no espera respuesta es «falta cerrar»", () => {
    expect(estadoDeConversacion({ count: 2, pending: false })).toBe("cerrar");
  });
  it("con dos hilos, manda el más urgente", () => {
    expect(estadoDeConversacion({ count: 2, pending: true, awaitingClose: true })).toBe(
      "responder",
    );
  });
});

describe("resumirHilos", () => {
  const owner = new Map([["sub1", "ana"]]);
  it("separa lo que espera respuesta de lo que espera cierre", () => {
    const r = resumirHilos(
      [
        { id: "h1", submission_id: "sub1", question_id: "q1" },
        { id: "h2", submission_id: "sub1", question_id: "q2" },
        { id: "h3", submission_id: "sub1", question_id: "q3" },
      ],
      new Map([
        ["h1", "ana"], // último: la estudiante → responder
        ["h2", "docente"], // último: el docente → cerrar
        // h3 sin comentarios → abierto, no espera respuesta → cerrar
      ]),
      owner,
    );
    expect(estadoDeConversacion(r["sub1:q1"])).toBe("responder");
    expect(estadoDeConversacion(r["sub1:q2"])).toBe("cerrar");
    expect(estadoDeConversacion(r["sub1:q3"])).toBe("cerrar");
    expect(contarPorEstado(Object.values(r))).toEqual({ responder: 1, cerrar: 2 });
  });
  it("un hilo de una entrega desconocida se ignora", () => {
    expect(
      resumirHilos([{ id: "h", submission_id: "otra", question_id: "q" }], new Map(), owner),
    ).toEqual({});
  });
});
