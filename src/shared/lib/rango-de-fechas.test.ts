import { describe, it, expect } from "vitest";
import {
  diaDe,
  enRangoDeFechas,
  algunaEnRango,
  normalizarRango,
  rangoVacio,
  claveDeRango,
  RANGO_VACIO,
} from "./rango-de-fechas";

const r = (desde: string | null, hasta: string | null) => ({ desde, hasta });

describe("diaDe", () => {
  it("un yyyy-MM-dd se devuelve tal cual", () => {
    // Pasarlo por `Date` lo leeria como medianoche UTC y en UTC-5 retrocederia
    // al dia anterior — el bug que ya justifica `formatDateOnly`.
    expect(diaDe("2026-10-01")).toBe("2026-10-01");
    expect(diaDe(" 2026-10-01 ")).toBe("2026-10-01");
  });

  it("un instante baja al dia LOCAL", () => {
    // Construido por componentes para que el test no dependa de la zona del CI.
    const d = new Date(2026, 9, 1, 23, 59);
    expect(diaDe(d)).toBe("2026-10-01");
  });

  it("sin valor no hay dia", () => {
    expect(diaDe(null)).toBeNull();
    expect(diaDe(undefined)).toBeNull();
    expect(diaDe("")).toBeNull();
  });

  it("una fecha ilegible no inventa un dia", () => {
    expect(diaDe("no es una fecha")).toBeNull();
  });
});

describe("rangoVacio", () => {
  it("sin extremos no filtra", () => {
    expect(rangoVacio(RANGO_VACIO)).toBe(true);
    expect(rangoVacio(null)).toBe(true);
    expect(rangoVacio(r(null, null))).toBe(true);
  });
  it("con un extremo ya filtra", () => {
    expect(rangoVacio(r("2026-10-01", null))).toBe(false);
    expect(rangoVacio(r(null, "2026-10-01"))).toBe(false);
  });
});

describe("enRangoDeFechas", () => {
  it("sin filtro deja pasar todo, incluso lo que no tiene fecha", () => {
    expect(enRangoDeFechas("2026-10-01", RANGO_VACIO)).toBe(true);
    expect(enRangoDeFechas(null, RANGO_VACIO)).toBe(true);
  });

  it("los DOS extremos son inclusivos", () => {
    // «Del 1 al 5» incluye el 5. Excluirlo no se lee como un error de borde:
    // se lee como que el filtro no sirve.
    const rango = r("2026-10-01", "2026-10-05");
    expect(enRangoDeFechas("2026-10-01", rango)).toBe(true);
    expect(enRangoDeFechas("2026-10-05", rango)).toBe(true);
    expect(enRangoDeFechas("2026-10-03", rango)).toBe(true);
    expect(enRangoDeFechas("2026-09-30", rango)).toBe(false);
    expect(enRangoDeFechas("2026-10-06", rango)).toBe(false);
  });

  it("una fecha EXACTA es el rango con los dos extremos iguales", () => {
    // No hay un modo aparte: poner la misma fecha en los dos campos ES pedir
    // ese dia.
    const exacta = r("2026-10-03", "2026-10-03");
    expect(enRangoDeFechas("2026-10-03", exacta)).toBe(true);
    expect(enRangoDeFechas("2026-10-02", exacta)).toBe(false);
    expect(enRangoDeFechas("2026-10-04", exacta)).toBe(false);
  });

  it("un solo extremo deja el rango abierto del otro lado", () => {
    expect(enRangoDeFechas("2030-01-01", r("2026-10-01", null))).toBe(true);
    expect(enRangoDeFechas("2020-01-01", r("2026-10-01", null))).toBe(false);
    expect(enRangoDeFechas("2020-01-01", r(null, "2026-10-01"))).toBe(true);
    expect(enRangoDeFechas("2030-01-01", r(null, "2026-10-01"))).toBe(false);
  });

  it("una fila SIN fecha queda afuera mientras el filtro este puesto", () => {
    // Misma regla que el filtro de periodo con un item sin curso: no se le
    // puede atribuir una fecha, asi que no se puede afirmar que cae dentro.
    expect(enRangoDeFechas(null, r("2026-10-01", "2026-10-05"))).toBe(false);
    expect(enRangoDeFechas(undefined, r(null, "2026-10-05"))).toBe(false);
  });

  it("compara por DIA, no por instante", () => {
    // Un `timestamptz` de las 23:59 del 1 de octubre cae DENTRO de «hasta el 1
    // de octubre», aunque como instante sea posterior a su medianoche.
    const casiMedianoche = new Date(2026, 9, 1, 23, 59, 59);
    expect(enRangoDeFechas(casiMedianoche, r(null, "2026-10-01"))).toBe(true);
    const primerMinuto = new Date(2026, 9, 1, 0, 0, 1);
    expect(enRangoDeFechas(primerMinuto, r("2026-10-01", null))).toBe(true);
  });
});

describe("normalizarRango", () => {
  it("da vuelta los extremos invertidos", () => {
    // Quien elige «desde el 5 hasta el 1» quiso decir del 1 al 5. Devolver
    // vacio seria literal y completamente inutil: la tabla queda en blanco sin
    // nada que lo explique.
    expect(normalizarRango(r("2026-10-05", "2026-10-01"))).toEqual(r("2026-10-01", "2026-10-05"));
  });
  it("no toca un rango bien puesto", () => {
    const bien = r("2026-10-01", "2026-10-05");
    expect(normalizarRango(bien)).toBe(bien);
  });
  it("y filtrar con el rango invertido devuelve lo mismo que con el correcto", () => {
    expect(enRangoDeFechas("2026-10-03", r("2026-10-05", "2026-10-01"))).toBe(true);
  });
});

describe("algunaEnRango", () => {
  it("basta con que UNA fecha de la fila caiga dentro", () => {
    // El docente que filtra «esta semana» espera ver el taller que empezo antes
    // y vence dentro, no solo los que empiezan dentro.
    const semana = r("2026-10-01", "2026-10-07");
    expect(algunaEnRango(["2026-09-20", "2026-10-03"], semana)).toBe(true);
    expect(algunaEnRango(["2026-09-20", "2026-09-25"], semana)).toBe(false);
  });

  it("tolera fechas nulas mezcladas", () => {
    const semana = r("2026-10-01", "2026-10-07");
    expect(algunaEnRango([null, "2026-10-03"], semana)).toBe(true);
    expect(algunaEnRango([null, undefined], semana)).toBe(false);
  });

  it("sin filtro deja pasar todo", () => {
    expect(algunaEnRango([null, null], RANGO_VACIO)).toBe(true);
  });
});

describe("claveDeRango", () => {
  it("cambia cuando cambia el rango, para que la paginacion vuelva a la 1", () => {
    expect(claveDeRango(r("2026-10-01", null))).not.toBe(claveDeRango(r("2026-10-02", null)));
    expect(claveDeRango(RANGO_VACIO)).toBe(claveDeRango(null));
  });
  it("distingue los dos extremos", () => {
    expect(claveDeRango(r("2026-10-01", null))).not.toBe(claveDeRango(r(null, "2026-10-01")));
  });
});
