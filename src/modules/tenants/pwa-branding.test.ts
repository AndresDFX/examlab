import { describe, expect, it } from "vitest";
import {
  FRACCION_SEGURA_ANY,
  FRACCION_SEGURA_MASKABLE,
  construirManifestDeInstitucion,
  esColorHex,
  iconosPorDefecto,
  medidasIcono,
  nombreCortoInstitucion,
} from "./pwa-branding";

const ORIGIN = "https://uniaj.examlab.workers.dev";

describe("nombreCortoInstitucion", () => {
  it("deja el nombre tal cual cuando ya entra en la etiqueta", () => {
    expect(nombreCortoInstitucion("FESNA")).toBe("FESNA");
    expect(nombreCortoInstitucion("Univalle")).toBe("Univalle");
  });

  it("arma siglas cuando el nombre no entra (así lo llama la gente igual)", () => {
    // El caso real: truncar daría "Universidad A…", que no identifica nada.
    expect(nombreCortoInstitucion("Universidad Antonio Jose Camacho")).toBe("UAJC");
  });

  it("descarta las palabras cortas al armar las siglas", () => {
    expect(nombreCortoInstitucion("Fundacion de Estudios Superiores")).toBe("FES");
  });

  it("con una sola palabra larga recorta en vez de inventar una sigla de una letra", () => {
    const corto = nombreCortoInstitucion("Superinstitucionalizacion");
    expect(corto).toBe("Superinstitu");
    expect((corto ?? "").length).toBeLessThanOrEqual(12);
  });

  it("no devuelve nada para un nombre vacío", () => {
    expect(nombreCortoInstitucion("")).toBeNull();
    expect(nombreCortoInstitucion("   ")).toBeNull();
    expect(nombreCortoInstitucion(null)).toBeNull();
    expect(nombreCortoInstitucion(undefined)).toBeNull();
  });

  it("nunca excede los 12 caracteres, que es donde trunca la pantalla de inicio", () => {
    const largos = [
      "Universidad Nacional Abierta y a Distancia de Colombia",
      "Institucion Universitaria Antonio Jose Camacho Sede Norte",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ];
    for (const n of largos) {
      expect((nombreCortoInstitucion(n) ?? "").length).toBeLessThanOrEqual(12);
    }
  });
});

describe("esColorHex", () => {
  it("acepta hex de 3 y 6 dígitos", () => {
    expect(esColorHex("#006CD0")).toBe(true);
    expect(esColorHex("#abc")).toBe(true);
  });

  it("rechaza cualquier otra cosa guardada en la base", () => {
    for (const v of ["rojo", "rgb(0,0,0)", "006CD0", "#12345", "", null, undefined]) {
      expect(esColorHex(v as string | null | undefined)).toBe(false);
    }
  });
});

describe("medidasIcono", () => {
  it("contiene el logo sin deformarlo y lo centra", () => {
    // Logo apaisado 200x100 en un lienzo de 512 al 60%: manda el ancho.
    const m = medidasIcono(200, 100, 512, 0.6);
    expect(m).not.toBeNull();
    expect(m!.w).toBeCloseTo(512 * 0.6, 5);
    expect(m!.h).toBeCloseTo((512 * 0.6) / 2, 5);
    // Centrado: los márgenes de cada lado son iguales.
    expect(m!.x).toBeCloseTo((512 - m!.w) / 2, 5);
    expect(m!.y).toBeCloseTo((512 - m!.h) / 2, 5);
    // Y conserva la proporción original.
    expect(m!.w / m!.h).toBeCloseTo(200 / 100, 5);
  });

  it("el logo nunca se sale del área segura", () => {
    for (const [w, h] of [
      [2000, 100],
      [100, 2000],
      [512, 512],
      [37, 41],
    ]) {
      const m = medidasIcono(w, h, 512, FRACCION_SEGURA_MASKABLE)!;
      expect(m.w).toBeLessThanOrEqual(512 * FRACCION_SEGURA_MASKABLE + 0.001);
      expect(m.h).toBeLessThanOrEqual(512 * FRACCION_SEGURA_MASKABLE + 0.001);
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("el ícono maskable deja MÁS margen que el `any` (el lanzador recorta)", () => {
    const any = medidasIcono(100, 100, 512, FRACCION_SEGURA_ANY)!;
    const maskable = medidasIcono(100, 100, 512, FRACCION_SEGURA_MASKABLE)!;
    expect(maskable.w).toBeLessThan(any.w);
  });

  it("devuelve null con medidas inservibles en vez de dibujar un ícono vacío", () => {
    expect(medidasIcono(0, 100, 512, 0.6)).toBeNull();
    expect(medidasIcono(100, 0, 512, 0.6)).toBeNull();
    expect(medidasIcono(100, 100, 0, 0.6)).toBeNull();
    expect(medidasIcono(Number.NaN, 100, 512, 0.6)).toBeNull();
  });
});

describe("construirManifestDeInstitucion", () => {
  const iconos = [
    { src: "data:image/png;base64,AAA", sizes: "192x192", type: "image/png", purpose: "any" },
  ];

  it("usa el nombre de la institución y sus siglas en la etiqueta", () => {
    const m = construirManifestDeInstitucion({
      nombreInstitucion: "Universidad Antonio Jose Camacho",
      iconos,
      colorTema: "#006CD0",
      origin: ORIGIN,
    });
    expect(m.name).toBe("Universidad Antonio Jose Camacho — ExamLab");
    expect(m.short_name).toBe("UAJC");
    expect(m.theme_color).toBe("#006CD0");
  });

  it("no repite la marca cuando la institución ya se llama así", () => {
    const m = construirManifestDeInstitucion({
      nombreInstitucion: "ExamLab Demo",
      iconos,
      colorTema: null,
      origin: ORIGIN,
    });
    expect(m.name).toBe("ExamLab Demo");
  });

  it("todas las URLs van ABSOLUTAS: el manifest se sirve desde un blob:", () => {
    // Con rutas relativas, el navegador las resolvería contra la URL del blob
    // —que no es del sitio— y descartaría el manifest entero.
    const m = construirManifestDeInstitucion({
      nombreInstitucion: "FESNA",
      iconos,
      colorTema: null,
      origin: ORIGIN,
    });
    for (const clave of ["id", "start_url", "scope"] as const) {
      expect(String(m[clave])).toMatch(/^https:\/\//);
      expect(String(m[clave]).startsWith(ORIGIN)).toBe(true);
    }
  });

  it("sin íconos propios cae en los de ExamLab, también absolutos", () => {
    const m = construirManifestDeInstitucion({
      nombreInstitucion: "Prueba cloudflare",
      iconos: [],
      colorTema: null,
      origin: ORIGIN,
    });
    const src = (m.icons as Array<{ src: string }>).map((i) => i.src);
    expect(src.length).toBeGreaterThan(0);
    for (const s of src) expect(s.startsWith(`${ORIGIN}/icons/`)).toBe(true);
  });

  it("sin institución queda el manifest de ExamLab de siempre", () => {
    const m = construirManifestDeInstitucion({ origin: ORIGIN });
    expect(m.name).toBe("ExamLab — Plataforma de Exámenes");
    expect(m.short_name).toBe("ExamLab");
    expect(m.theme_color).toBe("#6366f1");
    expect(m.icons).toEqual(iconosPorDefecto(ORIGIN));
  });

  it("un color inválido en la base no rompe el manifest: cae al de ExamLab", () => {
    const m = construirManifestDeInstitucion({
      nombreInstitucion: "FESNA",
      iconos,
      colorTema: "no-es-un-color",
      origin: ORIGIN,
    });
    expect(m.theme_color).toBe("#6366f1");
  });

  it("mantiene lo que la app ya dependía del manifest (standalone y vertical)", () => {
    // `display: standalone` es lo que la toma de examen acepta como equivalente
    // a pantalla completa en iPhone, y `orientation` se fijó por un bug propio.
    const m = construirManifestDeInstitucion({ nombreInstitucion: "FESNA", origin: ORIGIN });
    expect(m.display).toBe("standalone");
    expect(m.orientation).toBe("portrait");
  });
});
