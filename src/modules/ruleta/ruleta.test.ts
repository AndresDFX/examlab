import { describe, expect, it } from "vitest";

import {
  PALETA,
  claveDeRonda,
  colorDeGajo,
  elegirIndice,
  enLaRueda,
  etiquetaCorta,
  gajosConNombre,
  indiceBajoElPuntero,
  leerRondaGuardada,
  pareceIdentificador,
  rotacionParaCaerEn,
  sigueCursando,
  tamanoDeLetra,
  textoDeElegidos,
} from "./ruleta";

describe("rotacionParaCaerEn ↔ indiceBajoElPuntero", () => {
  it("la rueda se detiene EXACTAMENTE en el gajo sorteado (cualquier n, punto de partida y fracción)", () => {
    const fallas: string[] = [];
    for (const n of [1, 2, 3, 7, 10, 11, 21, 35, 93, 100]) {
      for (const actual of [0, 17.3, 359.9, 360, 725.5, -40, 12345.678]) {
        for (const fraccion of [0, 0.01, 0.5, 0.99, 1]) {
          for (let indice = 0; indice < n; indice += Math.max(1, Math.floor(n / 7))) {
            const fin = rotacionParaCaerEn(actual, indice, n, 6, fraccion);
            const cae = indiceBajoElPuntero(fin, n);
            if (cae !== indice) fallas.push(`n=${n} actual=${actual} f=${fraccion}: ${indice}→${cae}`);
          }
        }
      }
    }
    expect(fallas).toEqual([]);
  });

  it("siempre gira hacia adelante, al menos las vueltas pedidas", () => {
    const fin = rotacionParaCaerEn(100, 3, 10, 6, 0.5);
    expect(fin).toBeGreaterThanOrEqual(100 + 6 * 360);
    expect(fin).toBeLessThan(100 + 7 * 360);
  });

  it("el puntero nunca cae sobre la línea entre dos gajos", () => {
    const n = 8;
    const s = 360 / n;
    for (const f of [0, 1]) {
      const fin = rotacionParaCaerEn(0, 2, n, 0, f);
      const dentro = (((-fin % 360) + 360) % 360) - 2 * s;
      expect(dentro).toBeGreaterThan(s * 0.1);
      expect(dentro).toBeLessThan(s * 0.9);
    }
  });
});

describe("elegirIndice", () => {
  it("queda dentro del rango, también con el azar en su extremo", () => {
    expect(elegirIndice(5, () => 0)).toBe(0);
    expect(elegirIndice(5, () => 0.999999)).toBe(4);
    expect(elegirIndice(5, () => 1)).toBe(4);
    expect(elegirIndice(0, () => 0.3)).toBe(-1);
  });

  it("es parejo: con el azar del navegador todos salen parecido", () => {
    const n = 6;
    const veces = new Array(n).fill(0);
    const tiros = 60000;
    for (let i = 0; i < tiros; i++) veces[elegirIndice(n)]++;
    const esperado = tiros / n;
    for (const v of veces) expect(Math.abs(v - esperado)).toBeLessThan(esperado * 0.06);
  });
});

describe("colorDeGajo", () => {
  it("dos gajos vecinos nunca tienen el mismo color, tampoco el último con el primero", () => {
    for (let n = 2; n <= 101; n++) {
      for (let i = 0; i < n; i++) {
        const vecino = (i + 1) % n;
        expect(colorDeGajo(i, n).fondo, `n=${n} i=${i}`).not.toBe(colorDeGajo(vecino, n).fondo);
      }
    }
  });

  it("usa la paleta", () => {
    expect(colorDeGajo(0, 3)).toBe(PALETA[0]);
  });
});

describe("etiquetaCorta / tamanoDeLetra", () => {
  it("recorta según cuántos gajos hay, con puntos suspensivos", () => {
    expect(etiquetaCorta("Ana", 40)).toBe("Ana");
    expect(etiquetaCorta("Arroyave Ortiz Mariana Mariana", 35)).toBe("Arroyave O…");
    expect(etiquetaCorta("Arroyave Ortiz Mariana Mariana", 4)).toBe("Arroyave Ortiz Marian…");
  });

  it("la letra achica con muchos gajos, sin bajar de 8", () => {
    expect(tamanoDeLetra(1)).toBe(18);
    expect(tamanoDeLetra(8)).toBe(16);
    expect(tamanoDeLetra(35)).toBeLessThan(16);
    expect(tamanoDeLetra(100)).toBe(8);
  });
});

describe("enLaRueda", () => {
  const p = (id: string) => ({ id, etiqueta: id });
  const todos = [p("a"), p("b"), p("c"), p("d")];

  it("saca a los desmarcados", () => {
    expect(enLaRueda(todos, new Set(["b"]), [], { noRepetir: true, mostrandoA: null }).map((x) => x.id)).toEqual([
      "a",
      "c",
      "d",
    ]);
  });

  it("sin repetir saca a los que ya salieron, pero el último se queda mientras se muestra", () => {
    const opciones = { noRepetir: true, mostrandoA: "c" };
    expect(enLaRueda(todos, new Set(), ["a", "c"], opciones).map((x) => x.id)).toEqual(["b", "c", "d"]);
    expect(enLaRueda(todos, new Set(), ["a", "c"], { ...opciones, mostrandoA: null }).map((x) => x.id)).toEqual([
      "b",
      "d",
    ]);
  });

  it("repitiendo, quien ya salió sigue en la rueda", () => {
    expect(enLaRueda(todos, new Set(), ["a"], { noRepetir: false, mostrandoA: null })).toHaveLength(4);
  });
});

describe("textoDeElegidos", () => {
  it("numera en el orden en que salieron", () => {
    expect(textoDeElegidos([{ id: "1", etiqueta: "Ana" }, { id: "2", etiqueta: "Luis" }])).toBe("1. Ana\n2. Luis");
  });
});

describe("PALETA", () => {
  const luminancia = (hex: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contraste = (a: string, b: string) => {
    const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };

  it("el nombre se lee sobre cada color (≥ 4,5:1)", () => {
    for (const c of PALETA) expect(contraste(c.fondo, c.texto), c.fondo).toBeGreaterThanOrEqual(4.5);
  });
});

describe("quién entra a la ruleta", () => {
  it("retirados, aplazados y graduados no; lo desconocido o vacío sí", () => {
    expect(sigueCursando("retirado")).toBe(false);
    expect(sigueCursando(" Graduado ")).toBe(false);
    expect(sigueCursando("aplazado")).toBe(false);
    expect(sigueCursando("activo")).toBe(true);
    expect(sigueCursando(null)).toBe(true);
    expect(sigueCursando("otro")).toBe(true);
  });

  it("un código o la parte local del correo no se proyecta como nombre", () => {
    expect(pareceIdentificador("2024101234", "2024101234@uniaj.edu.co")).toBe(true);
    expect(pareceIdentificador("jperez", "JPerez@uniaj.edu.co")).toBe(true);
    expect(pareceIdentificador("1.144.567.890", null)).toBe(true);
    expect(pareceIdentificador("  ", null)).toBe(true);
    expect(pareceIdentificador("Juan Pérez", "jperez@uniaj.edu.co")).toBe(false);
  });

  it("con más de 40 gajos la rueda va sin nombres", () => {
    expect(gajosConNombre(40)).toBe(true);
    expect(gajosConNombre(41)).toBe(false);
    expect(gajosConNombre(0)).toBe(false);
  });
});

describe("leerRondaGuardada", () => {
  it("devuelve la ronda tal cual si está bien formada", () => {
    const r = {
      fuente: "sesion",
      sesionId: "s1",
      actividadKey: "",
      desmarcados: ["a"],
      elegidos: [{ id: "b", etiqueta: "Beto" }],
      noRepetir: false,
      giros: 3,
    };
    expect(leerRondaGuardada(JSON.stringify(r))).toEqual(r);
  });

  it("descarta lo que no encaja, campo por campo, y un JSON roto es «no hay ronda»", () => {
    expect(leerRondaGuardada("{roto")).toBeNull();
    expect(leerRondaGuardada(null)).toBeNull();
    expect(leerRondaGuardada(JSON.stringify({ fuente: "otra" }))).toBeNull();
    expect(
      leerRondaGuardada(
        JSON.stringify({ fuente: "curso", desmarcados: [1, "a"], elegidos: [{ id: 2 }, { id: "x", etiqueta: "X" }], giros: -4 }),
      ),
    ).toEqual({
      fuente: "curso",
      sesionId: "",
      actividadKey: "",
      desmarcados: ["a"],
      elegidos: [{ id: "x", etiqueta: "X" }],
      noRepetir: true,
      giros: 0,
    });
  });

  it("la clave es por curso", () => {
    expect(claveDeRonda("c1")).toBe("examlab_ruleta:c1");
  });
});
