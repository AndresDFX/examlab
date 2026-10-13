// @vitest-environment node
// Node y no jsdom: `zipSync` bajo jsdom arma carpetas basura (otro realm de Uint8Array) y deja verdes
// pruebas que no validan nada.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
// El módulo vive con el servidor (lo usa `ai-grade-submission`) y el navegador lo importa tal cual:
// estas pruebas fijan lo que las dos puntas aceptan.
import {
  extensionesPermitidas,
  leerPoliticaZip,
  normalizarExtensiones,
  opcionesConPoliticaZip,
  revisarArchivosDelZip,
} from "../../../supabase/functions/_shared/contenido-zip.ts";
import {
  acceptDeEntrega,
  archivoPermitidoEnEntrega,
  LANG_TO_EXT,
  permitidosDeEntregaZip,
  prevalidarZipDeEntrega,
  queAceptaLaEntrega,
} from "./code-upload";

const t = (k: string, o?: Record<string, unknown>) => `${k}${o ? JSON.stringify(o) : ""}`;

describe("leerPoliticaZip", () => {
  it("sin configuración es «codigo»: las entregas de siempre no cambian", () => {
    expect(leerPoliticaZip(null)).toEqual({ contenido: "codigo", extensiones: [] });
    expect(leerPoliticaZip({ choices: ["a"] })).toEqual({ contenido: "codigo", extensiones: [] });
    expect(leerPoliticaZip({ zip: { contenido: "inventado" } }).contenido).toBe("codigo");
  });

  it("lee las demás políticas", () => {
    expect(leerPoliticaZip({ zip: { contenido: "documentos" } }).contenido).toBe("documentos");
    expect(leerPoliticaZip({ zip: { contenido: "cualquiera" } }).contenido).toBe("cualquiera");
    expect(leerPoliticaZip({ zip: { contenido: "lista", extensiones: ["PDF", ".docx"] } })).toEqual({
      contenido: "lista",
      extensiones: ["pdf", "docx"],
    });
  });

  it("una lista vacía vuelve a «codigo»: no puede dejar una entrega imposible", () => {
    expect(leerPoliticaZip({ zip: { contenido: "lista", extensiones: [] } }).contenido).toBe("codigo");
  });
});

describe("normalizarExtensiones", () => {
  it("acepta texto separado por comas o espacios y descarta lo que no es una extensión", () => {
    expect(normalizarExtensiones("pdf, .DOCX  *.java;pdf, ../x, java script")).toEqual([
      "pdf",
      "docx",
      "java",
      "script",
    ]);
    expect(normalizarExtensiones(42)).toEqual([]);
  });
});

describe("opcionesConPoliticaZip", () => {
  it("guarda la política sin tocar lo demás de `options`", () => {
    expect(opcionesConPoliticaZip({ otra: 1 }, { contenido: "cualquiera", extensiones: [] })).toEqual({
      otra: 1,
      zip: { contenido: "cualquiera" },
    });
  });

  it("«codigo» no deja rastro: sin nada más, `options` queda en null como antes", () => {
    expect(opcionesConPoliticaZip(null, { contenido: "codigo", extensiones: [] })).toBeNull();
    expect(
      opcionesConPoliticaZip({ zip: { contenido: "documentos" } }, { contenido: "codigo", extensiones: [] }),
    ).toBeNull();
  });
});

describe("extensionesPermitidas", () => {
  it("«documentos» suma documentos y configuración al código; «cualquiera» no restringe", () => {
    const docs = extensionesPermitidas({ contenido: "documentos", extensiones: [] }, ["java"]);
    expect(docs).toEqual(expect.arrayContaining(["java", "pdf", "mf", "properties"]));
    expect(extensionesPermitidas({ contenido: "cualquiera", extensiones: [] }, ["java"])).toBeNull();
    expect(extensionesPermitidas({ contenido: "lista", extensiones: ["pdf"] }, ["java"])).toEqual(["pdf"]);
  });
});

// Un proyecto de NetBeans real, comprimido entero: el caso que motivó la regla abierta.
const PROYECTO = [
  "VetCare/",
  "VetCare/src/vetcare/Main.java",
  "VetCare/build.xml",
  "VetCare/manifest.mf",
  "VetCare/nbproject/project.properties",
  "VetCare/scripts/esquema.sql",
  "VetCare/datos.csv",
  "VetCare/Manual de usuario.pdf",
  "VetCare/capturas/inicio.png",
  "VetCare/Dockerfile",
  "VetCare/.gitignore",
  "VetCare/.git/HEAD",
  "__MACOSX/VetCare/._Main.java",
  "VetCare/demo.exe",
];

describe("permitidosDeEntregaZip + revisarArchivosDelZip", () => {
  it("«codigo» conserva la regla de siempre: el lenguaje o `null` (= la lista general de código)", () => {
    expect(permitidosDeEntregaZip("java", null).extensiones).toEqual(LANG_TO_EXT.java);
    expect(permitidosDeEntregaZip(null, null).extensiones).toBeNull();
    expect(archivoPermitidoEnEntrega("Main.java", permitidosDeEntregaZip("java", null))).toBe(true);
    expect(archivoPermitidoEnEntrega("informe.pdf", permitidosDeEntregaZip("java", null))).toBe(false);
  });

  it("«documentos» acepta un proyecto de NetBeans entero, aunque la entrega diga Java", () => {
    const p = permitidosDeEntregaZip("java", { zip: { contenido: "documentos" } });
    const r = revisarArchivosDelZip(PROYECTO, p.extensiones, { sinExtension: true });
    expect(r.rechazados).toEqual(["VetCare/demo.exe"]);
    expect(r.aceptados).toEqual(
      expect.arrayContaining([
        "VetCare/build.xml",
        "VetCare/manifest.mf",
        "VetCare/nbproject/project.properties",
        "VetCare/scripts/esquema.sql",
        "VetCare/Manual de usuario.pdf",
        "VetCare/Dockerfile",
      ]),
    );
    expect(acceptDeEntrega(p)).toContain(".pdf");
  });

  it("los ocultos y el ruido no se rechazan ni se leen (vienen solos al comprimir una carpeta)", () => {
    const r = revisarArchivosDelZip(PROYECTO, ["java"]);
    const todos = [...r.aceptados, ...r.rechazados];
    expect(todos).not.toContain("VetCare/.gitignore");
    expect(todos.some((x) => x.includes(".git/") || x.includes("__MACOSX"))).toBe(false);
  });

  it("«lista» acepta solo lo escrito: ni siquiera el Dockerfile", () => {
    const p = permitidosDeEntregaZip(null, { zip: { contenido: "lista", extensiones: ["pdf", "java"] } });
    expect(archivoPermitidoEnEntrega("Dockerfile", p)).toBe(false);
    expect(archivoPermitidoEnEntrega("informe.pdf", p)).toBe(true);
    expect(archivoPermitidoEnEntrega("datos.csv", p)).toBe(false);
  });

  it("«cualquiera» no filtra el selector ni rechaza archivos", () => {
    const p = permitidosDeEntregaZip("java", { zip: { contenido: "cualquiera" } });
    expect(p.extensiones).toBeNull();
    expect(acceptDeEntrega(p)).toBeUndefined();
    expect(revisarArchivosDelZip(PROYECTO, p.extensiones).rechazados).toEqual([]);
  });

  it("dice lo que acepta en palabras, no con cien extensiones", () => {
    expect(queAceptaLaEntrega(permitidosDeEntregaZip("java", { zip: { contenido: "documentos" } }), t)).toBe(
      "projectFiles.zipQue.documentos",
    );
    expect(queAceptaLaEntrega(permitidosDeEntregaZip("java", null), t)).toBe(".java");
  });
});

describe("prevalidarZipDeEntrega (con un ZIP de verdad)", () => {
  const zip = (archivos: Record<string, string>) =>
    new File([zipSync(Object.fromEntries(Object.entries(archivos).map(([k, v]) => [k, strToU8(v)])))], "e.zip");

  it("«documentos» deja pasar el informe y rechaza un ejecutable, nombrándolo", async () => {
    const p = permitidosDeEntregaZip("java", { zip: { contenido: "documentos" } });
    expect(await prevalidarZipDeEntrega(zip({ "a/Main.java": "x", "a/informe.pdf": "x" }), p, t)).toEqual({
      ok: true,
    });
    const r = await prevalidarZipDeEntrega(zip({ "a/Main.java": "x", "a/demo.exe": "x" }), p, t);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("a/demo.exe");
  });

  it("«cualquiera» no abre el ZIP: ni siquiera uno dañado lo frena (lo valida el servidor)", async () => {
    const p = permitidosDeEntregaZip("java", { zip: { contenido: "cualquiera" } });
    expect(await prevalidarZipDeEntrega(new File([strToU8("no es un zip")], "e.zip"), p, t)).toEqual({ ok: true });
  });

  it("un ZIP dañado con regla de lista se rechaza con el mensaje de ilegible", async () => {
    const p = permitidosDeEntregaZip(null, { zip: { contenido: "lista", extensiones: ["pdf"] } });
    const r = await prevalidarZipDeEntrega(new File([strToU8("no es un zip")], "e.zip"), p, t);
    expect(r).toEqual({ ok: false, error: "projectFiles.zipIlegible" });
  });
});

describe("todo camino que califica un ZIP de proyecto manda `questionId`", () => {
  // Sin el id, el servidor no sabe qué acepta la entrega y cae a «solo código»: rechazaría en la cola o en
  // la recalificación lo que el estudiante pudo subir. Son cuatro lugares; uno nuevo tiene que mandarlo.
  const ARCHIVOS = [
    "src/modules/projects/ProjectFiles.tsx",
    "src/modules/ai/grade-submission.ts",
    "src/routes/app.teacher.projects.tsx",
  ];
  it.each(ARCHIVOS)("%s", (ruta) => {
    const src = readFileSync(ruta, "utf8");
    // La línea del objeto, no una mención en un comentario.
    const cuerpos = src.split(/\n\s*projectCodeZipGrading: true,/).slice(1);
    expect(cuerpos.length).toBeGreaterThan(0);
    for (const despues of cuerpos) {
      expect(despues.slice(0, 500)).toMatch(/\bquestionId\b/);
    }
  });
});
