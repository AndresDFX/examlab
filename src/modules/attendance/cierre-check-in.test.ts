import { describe, expect, it } from "vitest";
import { horaDeCierre, mismoDiaLocal, relojDeCierre } from "./cierre-check-in";

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const DIA = 24 * H;

describe("reloj del cierre del check-in", () => {
  it("con horas: H:MM:SS", () => {
    expect(relojDeCierre(6 * H + 12 * S)).toEqual({ dias: 0, reloj: "6:00:12" });
  });

  it("sumar 5 minutos se ve en el reloj (con el cartel por horas no se veía)", () => {
    const antes = relojDeCierre(6 * H + 2 * MIN);
    const despues = relojDeCierre(6 * H + 7 * MIN);
    expect(antes.reloj).toBe("6:02:00");
    expect(despues.reloj).toBe("6:07:00");
  });

  it("bajo una hora: M:SS", () => {
    expect(relojDeCierre(59 * MIN + 7 * S)).toEqual({ dias: 0, reloj: "59:07" });
    expect(relojDeCierre(4 * MIN + 59 * S)).toEqual({ dias: 0, reloj: "4:59" });
  });

  it("con días: los días aparte y las horas con dos dígitos", () => {
    expect(relojDeCierre(2 * DIA + 3 * H + 59 * MIN + 12 * S)).toEqual({ dias: 2, reloj: "03:59:12" });
  });

  it("baja segundo a segundo y llega a 0:00 al cerrar, no antes", () => {
    expect(relojDeCierre(1999).reloj).toBe("0:01");
    expect(relojDeCierre(999).reloj).toBe("0:00");
    expect(relojDeCierre(0).reloj).toBe("0:00");
    expect(relojDeCierre(-5000)).toEqual({ dias: 0, reloj: "0:00" });
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
