import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  LARGO_CODIGO_MANUAL,
  normalizarCodigoManual,
  codigoManualCompleto,
  codigoManualParaEnviar,
} from "./codigo-manual";

describe("normalizarCodigoManual", () => {
  it("deja solo digitos", () => {
    expect(normalizarCodigoManual("24-68-10")).toBe("246810");
    expect(normalizarCodigoManual(" 24 68 10 ")).toBe("246810");
    expect(normalizarCodigoManual("ABC123")).toBe("123");
  });

  it("recorta al largo", () => {
    expect(normalizarCodigoManual("123456789")).toBe("123456");
  });

  it("conserva el cero de adelante", () => {
    // `024681` es un codigo valido. Tratarlo como numero lo vuelve `24681` y el
    // docente dicta seis digitos mientras la pantalla muestra cinco.
    expect(normalizarCodigoManual("024681")).toBe("024681");
  });
});

describe("codigoManualCompleto", () => {
  it("vacio es valido: significa que lo genera la plataforma", () => {
    // No es un error que haya que señalarle al docente — es el comportamiento
    // de siempre.
    expect(codigoManualCompleto("")).toBe(true);
    expect(codigoManualCompleto("   ")).toBe(true);
  });

  it("seis digitos es valido", () => {
    expect(codigoManualCompleto("246810")).toBe(true);
    expect(codigoManualCompleto("000000")).toBe(true);
  });

  it("a medio escribir NO es valido", () => {
    expect(codigoManualCompleto("2468")).toBe(false);
  });

  it("de mas no es valido", () => {
    expect(codigoManualCompleto("2468101")).toBe(false);
  });
});

describe("codigoManualParaEnviar", () => {
  it("vacio viaja como null, no como cadena vacia", () => {
    // El servidor distingue «sin codigo elegido» de «codigo vacio»: mandar ""
    // haria que rechazara la apertura entera.
    expect(codigoManualParaEnviar("")).toBeNull();
    expect(codigoManualParaEnviar("  ")).toBeNull();
  });

  it("un codigo viaja tal cual", () => {
    expect(codigoManualParaEnviar(" 246810 ")).toBe("246810");
  });
});

describe("el largo coincide con el de la BASE", () => {
  // La regla vive en TRES lugares: la CHECK de la columna, el guard de las dos
  // RPC de check-in y este campo. Si se separan, el docente elige un codigo que
  // la pantalla acepta y la base rechaza — y lo descubre con el curso entero
  // tecleandolo. Por eso el test lee la migracion del disco en vez de repetir
  // el numero.
  const MIG = path.join(
    process.cwd(),
    "supabase/migrations/20262570000000_codigo_asistencia_manual.sql",
  );

  it("la migracion existe", () => {
    expect(fs.existsSync(MIG)).toBe(true);
  });

  it("la CHECK de la columna exige el MISMO largo que el cliente", () => {
    const sql = fs.readFileSync(MIG, "utf8");
    const m = sql.match(/manual_code\s*~\s*'\^\[0-9\]\{(\d+)\}\$'/);
    expect(m, "no se encontro la CHECK de manual_code en la migracion").not.toBeNull();
    expect(Number(m![1])).toBe(LARGO_CODIGO_MANUAL);
  });

  it("el guard de la RPC exige el MISMO largo", () => {
    const sql = fs.readFileSync(MIG, "utf8");
    const m = sql.match(/p_code\s*!~\s*'\^\[0-9\]\{(\d+)\}\$'/);
    expect(m, "no se encontro el guard de p_code en la migracion").not.toBeNull();
    expect(Number(m![1])).toBe(LARGO_CODIGO_MANUAL);
  });

  it("un codigo elegido APAGA la rotacion en el servidor", () => {
    // Si esto se cae, el proyector muestra un contador que no cambia nada y el
    // alumno que lo ve llegar a cero cree que su codigo vencio.
    const sql = fs.readFileSync(MIG, "utf8");
    expect(sql).toMatch(/IF v_manual IS NOT NULL THEN[\s\S]{0,40}?v_rot := 0;/);
  });

  it("las hermanas del grupo COPIAN el codigo elegido", () => {
    // Copiar solo la semilla dejaria al ancla validando contra el elegido y a
    // las hermanas contra el derivado: el mismo codigo marca una sesion y no
    // las otras, sin ningun error a la vista.
    const sql = fs.readFileSync(MIG, "utf8");
    expect(sql).toMatch(/SET seed = v_semilla, manual_code = v_manual/);
  });

  it("la comparacion del codigo esta en UN solo lugar", () => {
    // Estaba copiada byte a byte en los dos caminos de check-in. Un codigo
    // manual honrado en uno y no en el otro funciona desde el QR y falla desde
    // el enlace por correo.
    const sql = fs.readFileSync(MIG, "utf8");
    const usos = sql.match(/public\.attendance_codigo_valido\(v_state, v_normalized\)/g) ?? [];
    expect(usos.length).toBe(2);
    expect(sql).not.toMatch(/v_ok := v_normalized = public\.compute_attendance_code/);
  });
});
