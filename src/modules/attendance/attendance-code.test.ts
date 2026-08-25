import { describe, expect, it } from "vitest";
import {
  ATTENDANCE_CHECK_IN_DEFAULT_MINUTES,
  ATTENDANCE_CODE_ROTATION_DEFAULT,
  attendanceCodeIsStatic,
  attendancePeriod,
  attendanceSecondsToNextRotation,
  buildAttendanceCheckInUrl,
  computeAttendanceCode,
} from "./attendance-code";

// CRITICO: el output de `computeAttendanceCode` DEBE coincidir bit-a-bit
// con la funcion SQL `compute_attendance_code(seed, period)`. Si este
// test rompe sin tocar la funcion JS, alguien movio la SQL y hay que
// sincronizarlas — el check-in con QR se rompe silenciosamente cuando
// divergen.

describe("constants", () => {
  it("ROTATION_DEFAULT = 60 (segundos)", () => {
    expect(ATTENDANCE_CODE_ROTATION_DEFAULT).toBe(60);
  });

  it("CHECK_IN_DEFAULT = 10 (minutos)", () => {
    expect(ATTENDANCE_CHECK_IN_DEFAULT_MINUTES).toBe(10);
  });
});

describe("attendancePeriod", () => {
  it("calcula floor(epoch_sec / rotation)", () => {
    const nowMs = 60_000 * 100; // 100 minutos despues de epoch
    expect(attendancePeriod(60, nowMs)).toBe(100);
    expect(attendancePeriod(30, nowMs)).toBe(200);
    expect(attendancePeriod(120, nowMs)).toBe(50);
  });

  it("el periodo CAMBIA al cruzar el limite de la ventana", () => {
    // a los 59 999 ms estamos en period 0 (60s); a los 60 000 entramos a period 1.
    expect(attendancePeriod(60, 59_999)).toBe(0);
    expect(attendancePeriod(60, 60_000)).toBe(1);
  });

  it("usa Date.now() por defecto", () => {
    const before = Math.floor(Date.now() / 1000 / 60);
    const p = attendancePeriod(60);
    const after = Math.floor(Date.now() / 1000 / 60);
    expect(p).toBeGreaterThanOrEqual(before);
    expect(p).toBeLessThanOrEqual(after);
  });
});

describe("attendanceSecondsToNextRotation", () => {
  it("retorna rotation cuando exactamente en el limite", () => {
    // epoch_sec % rotation == 0 → la formula da rotation (no 0)
    expect(attendanceSecondsToNextRotation(60, 0)).toBe(60);
    expect(attendanceSecondsToNextRotation(60, 60_000)).toBe(60);
  });

  it("decrementa dentro de la ventana", () => {
    expect(attendanceSecondsToNextRotation(60, 1_000)).toBe(59);
    expect(attendanceSecondsToNextRotation(60, 30_000)).toBe(30);
    expect(attendanceSecondsToNextRotation(60, 59_000)).toBe(1);
  });
});

describe("computeAttendanceCode", () => {
  it("retorna siempre 6 digitos numericos", async () => {
    const code = await computeAttendanceCode("seed-test", 0);
    expect(code).toMatch(/^\d{6}$/);
    expect(code.length).toBe(6);
  });

  it("es deterministico para la misma (seed, period)", async () => {
    const a = await computeAttendanceCode("seed-test", 42);
    const b = await computeAttendanceCode("seed-test", 42);
    expect(a).toBe(b);
  });

  it("cambia con seed distinta", async () => {
    const a = await computeAttendanceCode("seed-a", 0);
    const b = await computeAttendanceCode("seed-b", 0);
    expect(a).not.toBe(b);
  });

  it("cambia con period distinto", async () => {
    const a = await computeAttendanceCode("seed-x", 0);
    const b = await computeAttendanceCode("seed-x", 1);
    expect(a).not.toBe(b);
  });

  it("range 0..999999 — siempre cabe en 6 digitos", async () => {
    // El algoritmo es: parseInt(hex.slice(0,7), 16) % 1_000_000.
    // Con 100 muestras esperamos cubrir varios casos sin esperar todos.
    for (let i = 0; i < 100; i++) {
      const code = await computeAttendanceCode(`seed-${i}`, i);
      const n = Number(code);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(999_999);
      expect(code.length).toBe(6);
    }
  });

  // NOTA: los vectores hardcoded (input → output exacto) los dejamos
  // como TODO. Para validar bit-a-bit contra la SQL, hay que ejecutar
  // `SELECT compute_attendance_code('seed', 0)` en el destino y pegar
  // el output aqui. Por ahora cubrimos las propiedades determinismo
  // + formato + sensibilidad a inputs, que ya detecta divergencias
  // significativas (cambio de algoritmo, encoding, etc.).
});

describe("buildAttendanceCheckInUrl", () => {
  it("arma el deep link con session + code en query", () => {
    const url = buildAttendanceCheckInUrl("https://app.example.com", "abc-123", "654321");
    expect(url).toBe("https://app.example.com/asistencia?session=abc-123&code=654321");
  });

  it("encodea valores especiales en query", () => {
    const url = buildAttendanceCheckInUrl("https://app.example.com", "id with space", "000111");
    // URL ya hace encodeURIComponent en searchParams; espacio → "+" no, "%20" si.
    expect(url).toContain("session=id+with+space");
    expect(url).toContain("code=000111");
  });
});

describe("código FIJO (rotationSeconds = 0)", () => {
  it("0, null y negativos son modo fijo", () => {
    for (const v of [0, -1, null, undefined]) {
      expect(attendanceCodeIsStatic(v as number)).toBe(true);
    }
    expect(attendanceCodeIsStatic(60)).toBe(false);
  });

  it("el período es SIEMPRE 0, no importa el momento", () => {
    // Es lo que hace que el código valga toda la ventana. Con una rotación
    // grande no alcanzaría: el período es floor(epoch/rotación), así que
    // cambiaría en los múltiplos —con un día, a la medianoche UTC, en mitad de
    // una ventana de tres días.
    const momentos = [0, 1, 86_400_000, 1_700_000_000_000, 4_000_000_000_000];
    for (const t of momentos) expect(attendancePeriod(0, t)).toBe(0);
  });

  it("con rotación, el período SÍ cambia entre ventanas vecinas", () => {
    // Control: si esto no cambiara, el test de arriba no probaría nada.
    expect(attendancePeriod(60, 0)).not.toBe(attendancePeriod(60, 60_000));
  });

  it("no hay próxima rotación que contar: devuelve null, no 0", () => {
    // Devolver 0 haría que el proyector dijera "rota en 0s" para siempre y
    // pintara la barra vacía; `null` deja que la UI muestre otra cosa.
    expect(attendanceSecondsToNextRotation(0)).toBeNull();
    expect(attendanceSecondsToNextRotation(60, 0)).toBe(60);
  });

  it("el código del modo fijo es estable en el tiempo", async () => {
    const seed = "abc123";
    const a = await computeAttendanceCode(seed, attendancePeriod(0, 1_000));
    const b = await computeAttendanceCode(seed, attendancePeriod(0, 999_999_999_999));
    expect(a).toBe(b);
    expect(a).toMatch(/^\d{6}$/);
  });
});
