/**
 * Blinda el mapeo oficial lenguaje × compilador.
 *
 * Dos invariantes se cuidan acá, y las dos evitan fallos MUDOS (los caros):
 *
 *  1. La copia Deno del mapeo (`supabase/functions/execute-code/`) no puede
 *     divergir de la del cliente. Si divergen, el front cree que un lenguaje
 *     corre y el edge lo rechaza — o peor, lo manda a otro compilador.
 *  2. Ningún lenguaje ofrecido en la UI puede quedar sin un compilador capaz de
 *     ejecutarlo. Ese fue exactamente el riesgo al agregar Kotlin: aparecía en
 *     el selector y el runner lo desconocía, sin error visible.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AWS_LAMBDA_LANGUAGES,
  CHEERP_LANGUAGES,
  JDOODLE_ID,
  JUDGE0_LANGUAGE_ID,
  LANGUAGE_LABEL,
  MONACO_LANGUAGE,
  ONLINECOMPILER_ID,
  UI_EXECUTABLE_LANGUAGES,
  providerSupports,
  providersForLanguage,
  resolveProviderFor,
  type CodeLanguage,
  type CodeProvider,
} from "./language-support";

const ALL_PROVIDERS: CodeProvider[] = ["onlinecompiler", "jdoodle", "aws_lambda", "cheerp"];

describe("réplica Deno del mapeo", () => {
  it("el cuerpo del mapeo es idéntico en las dos copias", () => {
    const root = resolve(__dirname, "../../..");
    const clientSrc = readFileSync(resolve(root, "src/modules/code/language-support.ts"), "utf8");
    const denoSrc = readFileSync(
      resolve(root, "supabase/functions/execute-code/language-support.ts"),
      "utf8",
    );
    // Se compara TODO menos el bloque de comentario del encabezado, que a
    // propósito dice algo distinto en cada lado (cuál es la copia de cuál).
    const body = (s: string) => s.slice(s.indexOf("/** Lenguajes que el sistema"));
    expect(body(clientSrc)).not.toBe(""); // el ancla existe
    expect(body(denoSrc)).toBe(body(clientSrc));
  });
});

describe("mapeo lenguaje × compilador", () => {
  it("todo lenguaje que la UI ofrece tiene AL MENOS un compilador que lo ejecuta", () => {
    const huerfanos = UI_EXECUTABLE_LANGUAGES.filter(
      (l) => !ALL_PROVIDERS.some((p) => p !== "cheerp" && providerSupports(p, l)),
    );
    expect(huerfanos, "lenguajes ofrecidos en la UI que ningún compilador server-side soporta").toEqual(
      [],
    );
  });

  it("Kotlin lo ejecuta JDoodle; el runner propio NO lo declara (compilar cuesta 13-18s a 1 vCPU)", () => {
    expect(providerSupports("jdoodle", "kotlin")).toBe(true);
    // El runner TIENE kotlinc instalado, pero a 1 vCPU compilar se pasa del
    // timeout. El mapeo declara lo que se puede EJECUTAR, no lo que está
    // instalado — si declarara Kotlin, el ruteo lo mandaría ahí a morir.
    expect(providerSupports("aws_lambda", "kotlin")).toBe(false);
    // OnlineCompiler.io no tiene Kotlin confirmado: no se le inventa un id.
    expect(providerSupports("onlinecompiler", "kotlin")).toBe(false);
    // No existe kotlinc en el navegador → CheerpJ no puede compilarlo.
    expect(providerSupports("cheerp", "kotlin")).toBe(false);
  });

  it("si el compilador configurado no soporta el lenguaje, se rutea a uno que sí", () => {
    // El caso que motivó el ruteo: un tenant con OnlineCompiler por default
    // pidiendo Kotlin. Antes el fallback era `onlinecompiler` hardcodeado y
    // habría mandado Kotlin a un compilador que no lo conoce.
    expect(resolveProviderFor("kotlin", "onlinecompiler")).toBe("jdoodle");
    expect(resolveProviderFor("kotlin", "cheerp")).toBe("jdoodle");
    // Incluso si el default es el runner propio: no declara Kotlin, así que se
    // rutea igual. Es el caso que produjo el 500 en producción.
    expect(resolveProviderFor("kotlin", "aws_lambda")).toBe("jdoodle");
  });

  it("respeta el compilador configurado cuando SÍ soporta el lenguaje", () => {
    expect(resolveProviderFor("java", "jdoodle")).toBe("jdoodle");
    expect(resolveProviderFor("python", "aws_lambda")).toBe("aws_lambda");
    expect(resolveProviderFor("haskell", "onlinecompiler")).toBe("onlinecompiler");
  });

  it("cheerp nunca se resuelve server-side (corre en el navegador)", () => {
    expect(resolveProviderFor("java", "cheerp")).not.toBe("cheerp");
  });

  it("devuelve null cuando ningún compilador soporta el lenguaje", () => {
    // Lenguaje inexistente: el caller debe mostrar un error explícito en vez
    // de intentar a ciegas.
    expect(resolveProviderFor("brainfuck" as CodeLanguage, "aws_lambda")).toBeNull();
  });

  it("providersForLanguage ofrece cheerp SOLO para Java", () => {
    expect(providersForLanguage("java")).toContain("cheerp");
    for (const l of UI_EXECUTABLE_LANGUAGES.filter((x) => x !== "java")) {
      expect(providersForLanguage(l), `cheerp no debe ofrecerse para ${l}`).not.toContain("cheerp");
    }
  });

  it("cada lenguaje tiene etiqueta y gramática de Monaco", () => {
    for (const l of Object.keys(LANGUAGE_LABEL) as CodeLanguage[]) {
      expect(LANGUAGE_LABEL[l], `falta label de ${l}`).toBeTruthy();
      expect(MONACO_LANGUAGE[l], `falta monacoLang de ${l}`).toBeTruthy();
    }
  });

  it("los ids de Judge0 son numéricos y únicos (un id repetido ejecuta otro lenguaje)", () => {
    const ids = Object.values(JUDGE0_LANGUAGE_ID).filter((v): v is number => v !== undefined);
    expect(ids.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
    expect(new Set(ids).size, "hay language_id de Judge0 duplicados").toBe(ids.length);
  });

  it("no hay ids vacíos en los mapas de proveedores externos", () => {
    for (const [l, id] of Object.entries(ONLINECOMPILER_ID)) {
      expect(id, `id vacío de OnlineCompiler para ${l}`).toBeTruthy();
    }
    for (const [l, v] of Object.entries(JDOODLE_ID)) {
      expect(v?.language, `language vacío de JDoodle para ${l}`).toBeTruthy();
      expect(v?.versionIndex, `versionIndex vacío de JDoodle para ${l}`).toBeTruthy();
    }
  });

  it("los sets del Lambda y CheerpJ no prometen lenguajes sin runtime", () => {
    // Solo lo que la imagen ejecuta en tiempo usable a 1 vCPU.
    expect([...AWS_LAMBDA_LANGUAGES].sort()).toEqual(["java", "python"]);
    expect([...CHEERP_LANGUAGES]).toEqual(["java"]);
  });
});
