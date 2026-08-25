import { describe, expect, it } from "vitest";
import {
  CHECKIN_DEFAULT_WINDOW_HOURS,
  CHECKIN_MAX_WINDOW_HOURS,
  clampWindowHours,
  defaultCheckinWindow,
  recomputeClosesAt,
  toLocalDateTimeInput,
} from "./checkin-window";

describe("toLocalDateTimeInput", () => {
  it("usa la hora LOCAL, no UTC", () => {
    // El bug que evita: `toISOString().slice(0,16)` daría la hora UTC, así que
    // en Colombia (UTC-5) la apertura saldría cinco horas adelante de lo que el
    // docente ve en su reloj — y el picker no muestra la zona, así que nadie lo
    // notaría hasta que un alumno dijera que "todavía no empezó".
    const d = new Date(2026, 7, 25, 14, 30, 45); // 25 ago 2026, 14:30:45 local
    expect(toLocalDateTimeInput(d)).toBe("2026-08-25T14:30");
    // Y para probar que NO es UTC: el mismo instante en ISO tiene otra hora
    // salvo que el entorno esté en UTC.
    if (d.getTimezoneOffset() !== 0) {
      expect(toLocalDateTimeInput(d)).not.toBe(d.toISOString().slice(0, 16));
    }
  });

  it("rellena con cero los meses, días, horas y minutos de un dígito", () => {
    expect(toLocalDateTimeInput(new Date(2026, 0, 5, 9, 7))).toBe("2026-01-05T09:07");
  });

  it("medianoche no se rompe", () => {
    expect(toLocalDateTimeInput(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31T00:00");
  });
});

describe("defaultCheckinWindow", () => {
  it("abre AHORA y cierra seis horas después", () => {
    const w = defaultCheckinWindow(new Date(2026, 7, 25, 8, 0), CHECKIN_DEFAULT_WINDOW_HOURS);
    expect(w.opensAt).toBe("2026-08-25T08:00");
    expect(w.closesAt).toBe("2026-08-25T14:00");
  });

  it("descarta los segundos: la ventana es exactamente de N horas entre lo que se VE", () => {
    // Sin esto, abrir a las 8:00:45 daría un cierre a las 14:00:45 que el picker
    // mostraría como 14:00 — y la ventana real sería 45 segundos más larga que
    // la que el docente lee.
    const w = defaultCheckinWindow(new Date(2026, 7, 25, 8, 0, 45), 6);
    expect(w.opensAt).toBe("2026-08-25T08:00");
    expect(w.closesAt).toBe("2026-08-25T14:00");
  });

  it("cruza la medianoche sin perder el día", () => {
    const w = defaultCheckinWindow(new Date(2026, 7, 25, 22, 0), 6);
    expect(w.opensAt).toBe("2026-08-25T22:00");
    expect(w.closesAt).toBe("2026-08-26T04:00");
  });

  it("cruza el fin de mes y el fin de año", () => {
    expect(defaultCheckinWindow(new Date(2026, 7, 31, 22, 0), 6).closesAt).toBe("2026-09-01T04:00");
    expect(defaultCheckinWindow(new Date(2026, 11, 31, 23, 0), 6).closesAt).toBe(
      "2027-01-01T05:00",
    );
  });

  it("respeta las horas configuradas por la institución", () => {
    expect(defaultCheckinWindow(new Date(2026, 7, 25, 8, 0), 1).closesAt).toBe("2026-08-25T09:00");
    expect(defaultCheckinWindow(new Date(2026, 7, 25, 8, 0), 24).closesAt).toBe("2026-08-26T08:00");
  });

  it("horas con media hora", () => {
    expect(defaultCheckinWindow(new Date(2026, 7, 25, 8, 0), 1.5).closesAt).toBe(
      "2026-08-25T09:30",
    );
  });
});

describe("clampWindowHours", () => {
  it("basura, cero y negativos caen al default", () => {
    for (const v of [null, undefined, "", "abc", 0, -3, NaN]) {
      expect(clampWindowHours(v)).toBe(CHECKIN_DEFAULT_WINDOW_HOURS);
    }
  });

  it("un valor absurdo se ACOTA, no rechaza", () => {
    // Esto alimenta un formulario: dejarlo vacío por un valor mal configurado
    // sería peor que dejarlo con el tope.
    expect(clampWindowHours(100000)).toBe(CHECKIN_MAX_WINDOW_HOURS);
  });

  it("acepta un string numérico (viene de un input)", () => {
    expect(clampWindowHours("8")).toBe(8);
  });

  it("no admite ventanas de menos de una hora", () => {
    expect(clampWindowHours(0.25)).toBe(1);
  });
});

describe("recomputeClosesAt", () => {
  it("al mover la apertura, el cierre la sigue manteniendo la duración", () => {
    expect(recomputeClosesAt("2026-08-25T08:00", 6)).toBe("2026-08-25T14:00");
    expect(recomputeClosesAt("2026-08-25T20:00", 6)).toBe("2026-08-26T02:00");
  });

  it("una apertura vacía o inválida devuelve null, no una fecha inventada", () => {
    // El caller deja el cierre como estaba: borrarlo mientras el docente teclea
    // la fecha haría que el campo parpadeara en vacío.
    expect(recomputeClosesAt("", 6)).toBeNull();
    expect(recomputeClosesAt("no-es-fecha", 6)).toBeNull();
  });
});
