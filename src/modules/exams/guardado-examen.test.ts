import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { msEntreSondeos, SEGUNDOS_RELOJ_FINO } from "@/hooks/use-realtime-timer";
import { MS_DISPERSION_ENTREGA_AUTOMATICA } from "@/modules/exams/exam-session";

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

// Cuerpo de una función de la pantalla, desde su declaración hasta un marcador.
const cuerpoDe = (inicio: string, fin: string) => {
  const i = pantalla.indexOf(inicio);
  const f = pantalla.indexOf(fin, i);
  expect(i, `no se encontró «${inicio}»`).toBeGreaterThan(-1);
  expect(f, `no se encontró «${fin}» después de «${inicio}»`).toBeGreaterThan(i);
  return pantalla.slice(i, f);
};

describe("navegar sin responder no reescribe la fila", () => {
  it("el guardado compara la firma de CONTENIDO (sin el índice de pregunta)", () => {
    const cuerpo = cuerpoDe("const saveAnswersNow = useCallback", "const guardarCopiaLocal");
    expect(cuerpo).toMatch(/firmaContenido === firmaEnServidorRef\.current/);
  });

  it("en un examen secuencial el índice SÍ se escribe: ahí es una regla de navegación", () => {
    // Sin esto, pasar a otro dispositivo devolvía al alumno a una pregunta que ya
    // había dejado atrás.
    const cuerpo = cuerpoDe("const saveAnswersNow = useCallback", "const guardarCopiaLocal");
    expect(cuerpo).toMatch(/navigation_type !== "secuencial"\s*&&\s*!!firmaEnServidorRef\.current/);
  });

  it("todo lo que marca «esto ya está en la base» usa esa misma firma", () => {
    // Si una asignación usara `firmaDeRespuestas` (con el índice), las firmas no
    // coincidirían nunca y el latido subiría la fila entera cada minuto.
    const asignaciones = [...pantalla.matchAll(/firmaEnServidorRef\.current = ([^;]+);/g)].map((m) => m[1]);
    expect(asignaciones.length).toBeGreaterThan(0);
    for (const a of asignaciones) expect(a).toMatch(/^(firmaContenido|firmaDeContenido\(.*\))$/);
    expect(pantalla).toMatch(/debeSubirRespuestas\(\s*firmaDeContenido\(actuales\)/);
  });
});

describe("tiempo agotado: la entrega automática se dispersa sin cobrarle nada al alumno", () => {
  it("no reescribe la fila antes de entregar y espera un turno aleatorio", () => {
    const cuerpo = cuerpoDe("const handleTimeUp = useCallback", "const initialSeconds");
    // La llamada, no la mención: el comentario explica por qué se quitó.
    expect(cuerpo).not.toMatch(/saveAnswersNow\(\)/);
    expect(cuerpo).toMatch(/tiempoAgotadoRef\.current = true;/);
    expect(cuerpo).toMatch(/retrasoDeEntregaAutomatica\(Math\.random\(\)\)/);
  });

  it("sin entrega no congela nada: el reloj corre también antes de comenzar", () => {
    // Congelar sin entrega dejaba al alumno detrás de «Entregando…» sin salida.
    const cuerpo = cuerpoDe("const handleTimeUp = useCallback", "const initialSeconds");
    const guarda = cuerpo.indexOf("if (!simulacro && !submissionIdRef.current) return;");
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(cuerpo.indexOf("tiempoAgotadoRef.current = true;"));
  });

  it("con el tiempo agotado no se puede seguir respondiendo", () => {
    const cuerpo = cuerpoDe("const updateAnswer = useCallback", "const next =");
    expect(cuerpo).toMatch(/if \(tiempoAgotadoRef\.current\) return;/);
  });

  it("ningún registrador de proctoring cobra mientras la entrega espera su turno", () => {
    for (const nombre of ["recordWarning", "recordCopyAlert", "recordScreenshotAttempt", "registrarSenalBlanda"]) {
      const guarda = new RegExp(
        `const ${nombre} = \\([^)]*\\) => \\{[\\s\\S]{0,300}?if \\(submittedRef\\.current \\|\\| tiempoAgotadoRef\\.current\\) return;`,
      );
      expect(pantalla, nombre).toMatch(guarda);
    }
    expect(pantalla).toMatch(/started && !submittedRef\.current && !tiempoAgotadoRef\.current && requireFullscreen/);
  });

  it("cerrar la página con el tiempo agotado solo deja las respuestas: ni retiene, ni anota, ni suma", () => {
    const cuerpo = cuerpoDe("const onBeforeUnload", "const onPageHide");
    const rama = cuerpo.indexOf("if (tiempoAgotadoRef.current)");
    expect(rama).toBeGreaterThan(-1);
    expect(rama).toBeLessThan(cuerpo.indexOf("e.preventDefault()"));
    expect(cuerpo).toMatch(/dejarRespuestasConTiempoAgotado\(\)/);
    const respaldo = cuerpoDe("const dejarRespuestasConTiempoAgotado", "const onBeforeUnload");
    expect(respaldo).toMatch(/cuentaComoAdvertencia: false/);
  });

  it("el respaldo también corre donde no hay beforeunload: pagehide y mandar la app al fondo", () => {
    expect(cuerpoDe("const onPageHide", "const onFocus")).toMatch(/dejarRespuestasConTiempoAgotado\(\)/);
    expect(cuerpoDe("const onVisibility", "window.addEventListener(\"beforeunload\"")).toMatch(
      /visibilityState === "hidden" && tiempoAgotadoRef\.current\)\s*\{\s*(\/\/[^\n]*\n\s*)*dejarRespuestasConTiempoAgotado\(\);/,
    );
  });

  it("la dispersión cabe en el minuto de gracia del cron que cierra los intentos vencidos", () => {
    // Si el cron cerrara antes de que el cliente entregue, la entrega llegaría
    // sobre un intento cerrado. Se lee la ÚLTIMA migración que define el cron.
    const dir = resolve(process.cwd(), "supabase/migrations");
    const ultima = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) => readFileSync(resolve(dir, f), "utf8").includes("FUNCTION public.close_expired_exam_attempts"))
      .pop();
    expect(ultima).toBeTruthy();
    const gracia = /now\(\) - interval '(\d+) minute'/.exec(readFileSync(resolve(dir, ultima!), "utf8"));
    expect(gracia).toBeTruthy();
    expect(MS_DISPERSION_ENTREGA_AUTOMATICA).toBeLessThan(Number(gracia![1]) * 60_000);
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
