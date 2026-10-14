import { describe, expect, it } from "vitest";
import { horaDeCierre, mismoDiaLocal, relojDeCierre } from "./cierre-check-in";

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const DIA = 24 * H;

describe("tiempo que le queda al check-in", () => {
  it("con unidades: «5:58:36» no decía si eran horas o minutos", () => {
    expect(relojDeCierre(5 * H + 58 * MIN + 36 * S)).toEqual({ dias: 0, reloj: "5 h 58 min" });
    expect(relojDeCierre(6 * H + 12 * S)).toEqual({ dias: 0, reloj: "6 h" });
  });

  it("sumar 5 minutos se ve (con el cartel por horas enteras no se veía)", () => {
    expect(relojDeCierre(5 * H + 58 * MIN).reloj).toBe("5 h 58 min");
    expect(relojDeCierre(6 * H + 3 * MIN).reloj).toBe("6 h 3 min");
  });

  it("bajo una hora, solo minutos", () => {
    expect(relojDeCierre(59 * MIN + 7 * S)).toEqual({ dias: 0, reloj: "59 min" });
    expect(relojDeCierre(1 * MIN)).toEqual({ dias: 0, reloj: "1 min" });
  });

  it("nunca promete más tiempo del que queda", () => {
    expect(relojDeCierre(4 * MIN + 59 * S).reloj).toBe("4 min");
    expect(relojDeCierre(1 * H + 59 * S).reloj).toBe("1 h");
  });

  it("los segundos, solo en el último minuto, y llega a 0 s al cerrar, no antes", () => {
    expect(relojDeCierre(59 * S).reloj).toBe("59 s");
    expect(relojDeCierre(1999).reloj).toBe("1 s");
    expect(relojDeCierre(999).reloj).toBe("0 s");
    expect(relojDeCierre(0).reloj).toBe("0 s");
    expect(relojDeCierre(-5000)).toEqual({ dias: 0, reloj: "0 s" });
  });

  it("con días: los días aparte (los traduce quien llama) y el resto con unidades", () => {
    expect(relojDeCierre(2 * DIA + 3 * H + 59 * MIN + 12 * S)).toEqual({ dias: 2, reloj: "3 h 59 min" });
    expect(relojDeCierre(1 * DIA + 15 * MIN)).toEqual({ dias: 1, reloj: "15 min" });
    expect(relojDeCierre(2 * DIA + 30 * S)).toEqual({ dias: 2, reloj: "" });
  });
});

describe("hora de cierre", () => {
  const fmt = {
    hora: (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
    dia: (d: Date) => `${d.getDate()}/${d.getMonth() + 1}`,
  };

  it("si cierra hoy, solo la hora", () => {
    const ahora = new Date(2026, 9, 5, 19, 58);
    expect(horaDeCierre(new Date(2026, 9, 5, 23, 30), ahora, fmt)).toBe("23:30");
  });

  it("si cierra pasada la medianoche, con la fecha (si no, 01:59 se lee como pasado)", () => {
    const ahora = new Date(2026, 9, 5, 19, 58);
    expect(horaDeCierre(new Date(2026, 9, 6, 1, 59), ahora, fmt)).toBe("6/10, 01:59");
  });

  it("mismo día del calendario local", () => {
    expect(mismoDiaLocal(new Date(2026, 9, 5, 0, 0), new Date(2026, 9, 5, 23, 59))).toBe(true);
    expect(mismoDiaLocal(new Date(2026, 9, 5, 23, 59), new Date(2026, 9, 6, 0, 0))).toBe(false);
  });
});
