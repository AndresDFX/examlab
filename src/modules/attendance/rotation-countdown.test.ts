import { describe, expect, it } from "vitest";
import { partesCuentaAtras } from "./rotation-countdown";

describe("partesCuentaAtras", () => {
  it("el caso que lo originó: 84797s no se muestra en segundos", () => {
    // Es lo que la proyección decía en producción: "Rota en 84797s".
    expect(partesCuentaAtras(84797)).toEqual({ unidad: "hours", valor: 24 });
  });

  it("bajo un minuto usa segundos: es lo que importa mientras alguien teclea", () => {
    expect(partesCuentaAtras(45)).toEqual({ unidad: "seconds", valor: 45 });
    expect(partesCuentaAtras(1)).toEqual({ unidad: "seconds", valor: 1 });
    expect(partesCuentaAtras(59)).toEqual({ unidad: "seconds", valor: 59 });
  });

  it("de un minuto a una hora, minutos", () => {
    expect(partesCuentaAtras(60)).toEqual({ unidad: "minutes", valor: 1 });
    expect(partesCuentaAtras(600)).toEqual({ unidad: "minutes", valor: 10 });
    expect(partesCuentaAtras(3599)).toEqual({ unidad: "minutes", valor: 60 });
  });

  it("desde una hora, horas", () => {
    expect(partesCuentaAtras(3600)).toEqual({ unidad: "hours", valor: 1 });
    expect(partesCuentaAtras(7200)).toEqual({ unidad: "hours", valor: 2 });
    expect(partesCuentaAtras(86400)).toEqual({ unidad: "hours", valor: 24 });
  });

  it("redondea HACIA ARRIBA: el cartel nunca promete menos tiempo del que hay", () => {
    // Con `floor`, 119s diría "1 minuto" y el código rotaría mientras el cartel
    // sigue diciendo que falta un minuto.
    expect(partesCuentaAtras(119)).toEqual({ unidad: "minutes", valor: 2 });
    expect(partesCuentaAtras(61)).toEqual({ unidad: "minutes", valor: 2 });
    expect(partesCuentaAtras(3601)).toEqual({ unidad: "hours", valor: 2 });
  });

  it("cero, negativos y basura no rompen la proyección", () => {
    // Esto se renderiza en una pantalla que está al frente de un salón: un NaN
    // ahí es peor que un cero.
    for (const v of [0, -5, null, undefined, NaN]) {
      expect(partesCuentaAtras(v as number)).toEqual({ unidad: "seconds", valor: 0 });
    }
  });

  it("nunca devuelve decimales", () => {
    for (const v of [0.4, 59.9, 90.5, 3600.7]) {
      const r = partesCuentaAtras(v);
      expect(Number.isInteger(r.valor), `${v} -> ${r.valor}`).toBe(true);
    }
  });
});
