import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TIPOS_CON_EDITOR, necesitaEditorDeCodigo } from "./tipos-con-editor";
import { decidirModoTexto } from "./use-monaco-listo";

describe("necesitaEditorDeCodigo", () => {
  it("un examen de puras cerradas NO precalienta nada", () => {
    // Es el punto de la lista: bajar 1 MB para un parcial de selección múltiple
    // sería gastar los datos del alumno en algo que nunca se va a mostrar.
    expect(necesitaEditorDeCodigo(["cerrada", "cerrada_multi", "abierta"])).toBe(false);
    expect(necesitaEditorDeCodigo([])).toBe(false);
  });

  it("basta UNA pregunta con editor", () => {
    expect(necesitaEditorDeCodigo(["cerrada", "bd_sql", "abierta"])).toBe(true);
    expect(necesitaEditorDeCodigo(["codigo"])).toBe(true);
    expect(necesitaEditorDeCodigo(["java_gui"])).toBe(true);
    expect(necesitaEditorDeCodigo(["python_gui"])).toBe(true);
  });

  it("tolera nulos y tipos desconocidos sin romperse", () => {
    expect(necesitaEditorDeCodigo([null, undefined, ""])).toBe(false);
    expect(necesitaEditorDeCodigo([null, "bd_sql"])).toBe(true);
    expect(necesitaEditorDeCodigo(["tipo_que_no_existe"])).toBe(false);
  });

  it("so_consola NO cuenta: usa otro motor (xterm + v86), no Monaco", () => {
    expect(necesitaEditorDeCodigo(["so_consola"])).toBe(false);
  });
});

describe("la lista sigue cubriendo a todos los editores de Monaco", () => {
  it("no apareció un quinto componente que use Monaco sin decidir su tipo", () => {
    // Guardrail de una invariante que falla EN SILENCIO: si alguien agrega un
    // editor nuevo sobre Monaco y su tipo de pregunta no entra en
    // TIPOS_CON_EDITOR, lo único que pasa es que no se precalienta. No hay
    // error, no hay pantalla rota — simplemente vuelve la espera que este
    // cambio vino a sacar, y nadie se entera.
    const raiz = "src";
    const archivos: string[] = [];
    const recorrer = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const q = path.join(dir, e.name);
        if (e.isDirectory()) recorrer(q);
        else if (/\.tsx$/.test(e.name)) archivos.push(q);
      }
    };
    recorrer(raiz);
    const conMonaco = archivos
      .filter((f) => fs.readFileSync(f, "utf8").includes('from "@monaco-editor/react"'))
      .map((f) => path.basename(f))
      .sort();

    expect(
      conMonaco,
      "Apareció (o desapareció) un editor de Monaco. Decidí si su tipo de " +
        "pregunta va en TIPOS_CON_EDITOR de tipos-con-editor.ts y actualizá " +
        "esta lista.",
    ).toEqual([
      "CodeEditor.tsx", // codigo
      "JavaGuiRunner.tsx", // java_gui
      "PythonGuiRunner.tsx", // python_gui
      "SqlRunner.tsx", // bd_sql
    ]);
    expect(TIPOS_CON_EDITOR.size).toBe(conMonaco.length);
  });
});

describe("decidirModoTexto", () => {
  it("mientras el editor viene en camino no cambia nada", () => {
    expect(decidirModoTexto(null, "cargando", false)).toBeNull();
  });

  it("si se cumple el plazo, la caja de texto toma su lugar", () => {
    // El caso que de verdad ocurre en un salón: el loader NO rechaza cuando la
    // red está lenta, se queda cargando. Esperar un error sería esperar para
    // siempre, con la pregunta sin ningún lugar donde responder.
    expect(decidirModoTexto(null, "cargando", true)).toBe("lento");
  });

  it("si el editor falla, la caja de texto toma su lugar aunque no haya plazo", () => {
    expect(decidirModoTexto(null, "error", false)).toBe("error");
  });

  it("lo ya elegido NO se pisa, ni siquiera por un motivo distinto", () => {
    // Quien pidió escribir a mano no puede perder su caja porque el editor
    // llegó tarde; y quien está escribiendo no puede perder el foco.
    expect(decidirModoTexto("manual", "cargando", true)).toBe("manual");
    expect(decidirModoTexto("manual", "error", true)).toBe("manual");
    expect(decidirModoTexto("lento", "listo", true)).toBe("lento");
  });

  it("con el editor disponible NO se vuelve solo a la caja, aunque el plazo se haya cumplido", () => {
    // Sin esta condición, pulsar «Usar el editor» tras una espera larga devolvía
    // null y el efecto reponía «lento» en el acto: el botón parecía no hacer
    // nada. Es la trampa por la que esta función es pura y tiene test.
    expect(decidirModoTexto(null, "listo", true)).toBeNull();
    expect(decidirModoTexto(null, "listo", false)).toBeNull();
  });
});
