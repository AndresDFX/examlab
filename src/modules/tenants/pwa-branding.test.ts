import { describe, expect, it } from "vitest";
import {
  FRACCION_DISTINTIVO,
  RADIO_SEGURO_MASKABLE,
  construirManifestDeInstitucion,
  esColorHex,
  etiquetaInstitucion,
  iconosPorDefecto,
  medidasDistintivo,
  medidasIcono,
} from "./pwa-branding";

const ORIGIN = "https://uniaj.examlab.workers.dev";

describe("etiquetaInstitucion", () => {
  it("usa el identificador de la institución, no un acrónimo inventado", () => {
    // El caso que originó el cambio: la institución se llama "Universidad
    // Antonio Jose Camacho" pero para todo el mundo —y en la plataforma— es
    // UNIAJ. La primera versión armaba siglas y la bautizaba "UAJC".
    expect(etiquetaInstitucion("uniaj", "Universidad Antonio Jose Camacho")).toBe("UNIAJ");
    expect(etiquetaInstitucion("fesna", "Fundacion de Estudios Superiores")).toBe("FESNA");
  });

  it("cae al nombre solo si no hay slug", () => {
    expect(etiquetaInstitucion(null, "FESNA")).toBe("FESNA");
    expect(etiquetaInstitucion("", "Universidad Antonio Jose Camacho")).toBe("Universidad");
  });

  it("no devuelve nada cuando no hay ni slug ni nombre", () => {
    expect(etiquetaInstitucion(null, null)).toBeNull();
    expect(etiquetaInstitucion("", "   ")).toBeNull();
    expect(etiquetaInstitucion(undefined, undefined)).toBeNull();
  });

  it("nunca excede los 12 caracteres, que es donde trunca la pantalla de inicio", () => {
    const casos: Array<[string | null, string | null]> = [
      ["una-institucion-con-slug-larguisimo", "Nombre Largo De Verdad"],
      [null, "Universidad Nacional Abierta y a Distancia de Colombia"],
      ["uniaj", "Universidad Antonio Jose Camacho"],
    ];
    for (const [slug, nombre] of casos) {
      expect((etiquetaInstitucion(slug, nombre) ?? "").length).toBeLessThanOrEqual(12);
    }
  });
});

describe("medidasDistintivo", () => {
  it("en un ícono normal se apoya contra la esquina inferior derecha", () => {
    const d = medidasDistintivo(512, false)!;
    expect(d).not.toBeNull();
    // Abajo y a la derecha del centro.
    expect(d.cx).toBeGreaterThan(256);
    expect(d.cy).toBeGreaterThan(256);
    // Y entero dentro del lienzo.
    expect(d.cx + d.r).toBeLessThanOrEqual(512);
    expect(d.cy + d.r).toBeLessThanOrEqual(512);
  });

  it("el distintivo queda ENTERO dentro del círculo que Android garantiza", () => {
    // Es la razón de ser del caso maskable: una esquina es justo lo que el
    // lanzador recorta, así que ahí el distintivo se pierde.
    for (const lado of [192, 512, 180]) {
      const d = medidasDistintivo(lado, true)!;
      const centro = lado / 2;
      const distancia = Math.hypot(d.cx - centro, d.cy - centro);
      expect(distancia + d.r).toBeLessThanOrEqual(lado * RADIO_SEGURO_MASKABLE + 0.001);
    }
  });

  it("el maskable mete el distintivo hacia adentro respecto del normal", () => {
    const normal = medidasDistintivo(512, false)!;
    const maskable = medidasDistintivo(512, true)!;
    expect(maskable.cx).toBeLessThan(normal.cx);
    expect(maskable.cy).toBeLessThan(normal.cy);
  });

  it("sigue leyéndose abajo a la derecha, también en maskable", () => {
    const d = medidasDistintivo(512, true)!;
    expect(d.cx).toBeGreaterThan(256);
    expect(d.cy).toBeGreaterThan(256);
  });

  it("el distintivo no le tapa la mitad al ícono de abajo", () => {
    const d = medidasDistintivo(512, false)!;
    expect(d.r * 2).toBeCloseTo(512 * FRACCION_DISTINTIVO, 5);
    expect(d.r * 2).toBeLessThan(512 * 0.4);
  });

  it("devuelve null con un lado inservible", () => {
    expect(medidasDistintivo(0, false)).toBeNull();
    expect(medidasDistintivo(Number.NaN, true)).toBeNull();
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
    // Logo apaisado 200x100 en una caja de 512 al 60%: manda el ancho.
    const m = medidasIcono(200, 100, 512, 0.6);
    expect(m).not.toBeNull();
    expect(m!.w).toBeCloseTo(512 * 0.6, 5);
    expect(m!.h).toBeCloseTo((512 * 0.6) / 2, 5);
    expect(m!.x).toBeCloseTo((512 - m!.w) / 2, 5);
    expect(m!.y).toBeCloseTo((512 - m!.h) / 2, 5);
    expect(m!.w / m!.h).toBeCloseTo(200 / 100, 5);
  });

  it("nunca se sale de la caja, sea cual sea la forma del logo", () => {
    for (const [w, h] of [
      [2000, 100],
      [100, 2000],
      [512, 512],
      [37, 41],
    ]) {
      const m = medidasIcono(w, h, 512, 1)!;
      expect(m.w).toBeLessThanOrEqual(512.001);
      expect(m.h).toBeLessThanOrEqual(512.001);
      expect(m.x).toBeGreaterThanOrEqual(0);
      expect(m.y).toBeGreaterThanOrEqual(0);
    }
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

  it("la etiqueta corta es el identificador de la institución", () => {
    const m = construirManifestDeInstitucion({
      nombreInstitucion: "Universidad Antonio Jose Camacho",
      slugInstitucion: "uniaj",
      iconos,
      colorTema: "#006CD0",
      origin: ORIGIN,
    });
    // La plataforma primero y la institución después, con el mismo
    // identificador corto que va bajo el ícono.
    expect(m.name).toBe("ExamLab - UNIAJ");
    expect(m.short_name).toBe("UNIAJ");
    expect(m.theme_color).toBe("#006CD0");
  });

  it("no repite la marca cuando la institución ya se llama así", () => {
    const m = construirManifestDeInstitucion({
      nombreInstitucion: "ExamLab Demo",
      slugInstitucion: "examlab-demo",
      iconos,
      colorTema: null,
      origin: ORIGIN,
    });
    // Anteponer la marca daría «ExamLab - EXAMLAB-DEMO».
    expect(m.name).toBe("EXAMLAB-DEMO");
  });

  it("sin institución en el host no antepone nada", () => {
    expect(construirManifestDeInstitucion({ origin: ORIGIN }).name).toBe(
      "ExamLab — Plataforma de Exámenes",
    );
  });

  it("todas las URLs van ABSOLUTAS: el manifest se sirve desde un blob:", () => {
    // Con rutas relativas, el navegador las resolvería contra la URL del blob
    // —que no es del sitio— y descartaría el manifest entero.
    const m = construirManifestDeInstitucion({
      nombreInstitucion: "FESNA",
      slugInstitucion: "fesna",
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
      slugInstitucion: "prueba",
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
      slugInstitucion: "fesna",
      iconos,
      colorTema: "no-es-un-color",
      origin: ORIGIN,
    });
    expect(m.theme_color).toBe("#6366f1");
  });

  it("mantiene lo que la app ya dependía del manifest (standalone y vertical)", () => {
    // `display: standalone` es lo que la toma de examen acepta como equivalente
    // a pantalla completa en iPhone, y `orientation` se fijó por un bug propio.
    const m = construirManifestDeInstitucion({
      nombreInstitucion: "FESNA",
      slugInstitucion: "fesna",
      origin: ORIGIN,
    });
    expect(m.display).toBe("standalone");
    expect(m.orientation).toBe("portrait");
  });
});
