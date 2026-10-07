import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { msEntreSondeos, SEGUNDOS_RELOJ_FINO } from "@/hooks/use-realtime-timer";

// Lee la pantalla de toma del disco: lo que se vigila son decisiones de
// cableado (qué handler escribe en la base) que ningún tipo puede expresar.
const pantalla = readFileSync(resolve(process.cwd(), "src/modules/exams/TakeExamScreen.tsx"), "utf8");

describe("guardado del examen: qué escribe en la base", () => {
  it("salir del área de respuesta no escribe la fila entera: pasa por guardarDePaso", () => {
    expect(pantalla).not.toMatch(/onBlur=\{saveAnswersNow\}/);
    expect((pantalla.match(/onBlur=\{guardarDePaso\}/g) ?? []).length).toBe(8);
  });

  it("elegir una opción no escribe la fila entera", () => {
    expect(pantalla).not.toMatch(/updateAnswer\([^)]*\);\s*saveAnswersNow\(\)/);
  });

  it("la copia local se lee ANTES que la entrega del servidor (la sincronización la sube y la borra)", () => {
    const inicio = pantalla.indexOf("const runLoad = async () => {");
    const fin = pantalla.indexOf("void runLoad()", inicio);
    const cuerpo = pantalla.slice(inicio, fin);
    const lectura = cuerpo.indexOf("leerRespuestasLocales(examId)");
    const servidor = cuerpo.indexOf('.from("submissions")');
    expect(lectura).toBeGreaterThan(-1);
    expect(servidor).toBeGreaterThan(-1);
    expect(lectura).toBeLessThan(servidor);
    expect(cuerpo).toMatch(/simulacro \? null : await leerRespuestasLocales/);
  });

  it("al reanudar, el reclamo de la sesión se escribe en la base enseguida (las dos ramas)", () => {
    expect(pantalla).toMatch(/setStarted\(true\);\s*(\/\/[^\n]*\n\s*)*void saveAnswersNow\(\);\s*return;/);
    expect(pantalla).toMatch(/currentIdxRef\.current = idx;\s*(\/\/[^\n]*\n\s*)*void saveAnswersNow\(\);/);
  });
});

describe("sondeo del reloj", () => {
  it("10 s en general y 4 s en los dos últimos minutos", () => {
    expect(msEntreSondeos(3600)).toBe(10_000);
    expect(msEntreSondeos(SEGUNDOS_RELOJ_FINO)).toBe(4_000);
    expect(msEntreSondeos(30)).toBe(4_000);
    expect(msEntreSondeos(0)).toBe(10_000);
  });
});
