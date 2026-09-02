import { describe, expect, it } from "vitest";

import {
  fueraDeRango,
  mezclar,
  nombreDeGrupo,
  nombresLibres,
  repartirAlAzar,
  resumenDeTamanos,
  tamanosEquilibrados,
} from "./reparto-grupos";

/** Azar determinista: siempre devuelve el mismo valor, así el reparto es fijo. */
const azarFijo = (v: number) => () => v;
/** Secuencia controlada, para verificar que Fisher-Yates se usa de verdad. */
const azarSecuencia = (vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i + 1}`);

describe("tamanosEquilibrados", () => {
  it("reparte parejo cuando divide exacto", () => {
    expect(tamanosEquilibrados(12, 3)).toEqual([4, 4, 4]);
  });

  it("el resto se reparte de a UNO, no se apila al final", () => {
    // El caso que importa: 31 en 8 grupos. Apilando el resto darían tamaños
    // desparejos; repartido, ninguno queda a más de uno de otro.
    expect(tamanosEquilibrados(31, 8)).toEqual([4, 4, 4, 4, 4, 4, 4, 3]);
  });

  it("NUNCA deja un grupo de una persona si se puede evitar", () => {
    // 25 en grupos de 4: el reparto ingenuo haría 6 de 4 y uno de 1. Un grupo de
    // una persona no es un grupo.
    const t = tamanosEquilibrados(25, Math.ceil(25 / 4));
    expect(t).toEqual([4, 4, 4, 4, 3, 3, 3]);
    expect(t.reduce((a, b) => a + b, 0)).toBe(25);
    expect(Math.min(...t)).toBeGreaterThan(1);
  });

  it("no crea más grupos que personas", () => {
    expect(tamanosEquilibrados(3, 10)).toEqual([1, 1, 1]);
  });

  it("sin personas no hay grupos", () => {
    expect(tamanosEquilibrados(0, 5)).toEqual([]);
  });

  it("siempre suma el total", () => {
    for (const n of [1, 7, 13, 31, 93]) {
      for (const g of [1, 2, 3, 5, 8]) {
        const t = tamanosEquilibrados(n, g);
        expect(t.reduce((a, b) => a + b, 0)).toBe(n);
      }
    }
  });
});

describe("mezclar", () => {
  it("no toca el arreglo original", () => {
    const original = ids(5);
    const copia = [...original];
    mezclar(original, azarFijo(0));
    expect(original).toEqual(copia);
  });

  it("conserva exactamente los mismos elementos", () => {
    const r = mezclar(ids(20), azarSecuencia([0.1, 0.9, 0.5, 0.3, 0.7]));
    expect([...r].sort()).toEqual([...ids(20)].sort());
  });

  it("con azar controlado el resultado es reproducible", () => {
    const a = mezclar(ids(10), azarSecuencia([0.2, 0.8, 0.4]));
    const b = mezclar(ids(10), azarSecuencia([0.2, 0.8, 0.4]));
    expect(a).toEqual(b);
  });
});

describe("repartirAlAzar", () => {
  it("por TAMAÑO: 31 personas de a 4 dan 8 grupos", () => {
    const g = repartirAlAzar(ids(31), { tamano: 4, aleatorio: azarFijo(0) });
    expect(g).toHaveLength(8);
    expect(g.map((x) => x.integrantes.length)).toEqual([4, 4, 4, 4, 4, 4, 4, 3]);
  });

  it("por CANTIDAD: 31 en 5 grupos", () => {
    const g = repartirAlAzar(ids(31), { cantidad: 5, aleatorio: azarFijo(0) });
    expect(g).toHaveLength(5);
    expect(g.map((x) => x.integrantes.length)).toEqual([7, 6, 6, 6, 6]);
  });

  it("nadie queda afuera y nadie está dos veces", () => {
    const g = repartirAlAzar(ids(93), { tamano: 5, aleatorio: azarSecuencia([0.3, 0.7, 0.1]) });
    const todos = g.flatMap((x) => x.integrantes);
    expect(todos).toHaveLength(93);
    expect(new Set(todos).size).toBe(93);
    expect([...todos].sort()).toEqual([...ids(93)].sort());
  });

  it("los ids repetidos se cuentan una sola vez", () => {
    const g = repartirAlAzar(["a", "b", "a", "c"], { tamano: 2, aleatorio: azarFijo(0) });
    expect(g.flatMap((x) => x.integrantes)).toHaveLength(3);
  });

  it("los vacíos se descartan", () => {
    const g = repartirAlAzar(["a", "", "b"], { tamano: 2, aleatorio: azarFijo(0) });
    expect(g.flatMap((x) => x.integrantes).sort()).toEqual(["a", "b"]);
  });

  it("sin nadie no devuelve grupos", () => {
    expect(repartirAlAzar([], { tamano: 4 })).toEqual([]);
  });

  it("sin tamaño ni cantidad NO inventa un reparto", () => {
    // Quien llama decide qué decirle al usuario; esta función no adivina.
    expect(repartirAlAzar(ids(10), {})).toEqual([]);
  });

  it("los nombres se numeran desde 1 y se pueden correr con `desde`", () => {
    const g = repartirAlAzar(ids(4), { tamano: 2, aleatorio: azarFijo(0) });
    expect(g.map((x) => x.nombre)).toEqual(["Grupo 1", "Grupo 2"]);
    const h = repartirAlAzar(ids(4), { tamano: 2, desde: 3, aleatorio: azarFijo(0) });
    expect(h.map((x) => x.nombre)).toEqual(["Grupo 3", "Grupo 4"]);
  });

  it("una sola persona no rompe: un grupo de uno", () => {
    const g = repartirAlAzar(["a"], { tamano: 4, aleatorio: azarFijo(0) });
    expect(g).toEqual([{ nombre: "Grupo 1", integrantes: ["a"] }]);
  });

  it("con el mismo azar, el reparto es idéntico", () => {
    const opts = { tamano: 3, aleatorio: azarSecuencia([0.4, 0.9, 0.2, 0.6]) };
    const a = repartirAlAzar(ids(10), { ...opts, aleatorio: azarSecuencia([0.4, 0.9, 0.2, 0.6]) });
    const b = repartirAlAzar(ids(10), { ...opts, aleatorio: azarSecuencia([0.4, 0.9, 0.2, 0.6]) });
    expect(a).toEqual(b);
  });
});

describe("fueraDeRango", () => {
  const g = (...tam: number[]) =>
    tam.map((n, i) => ({ nombre: nombreDeGrupo(i + 1), integrantes: ids(n) }));

  it("marca el grupo que queda por debajo del mínimo", () => {
    // Es el aviso que faltaba: los talleres reales declaran 2..5 y la interfaz
    // no los leía.
    expect(fueraDeRango(g(4, 1), 2, 5)).toEqual([
      { nombre: "Grupo 2", integrantes: 1, motivo: "min" },
    ]);
  });

  it("marca el que pasa el máximo", () => {
    expect(fueraDeRango(g(7), 2, 5)).toEqual([
      { nombre: "Grupo 1", integrantes: 7, motivo: "max" },
    ]);
  });

  it("un reparto dentro del rango no reporta nada", () => {
    expect(fueraDeRango(g(4, 3, 2), 2, 5)).toEqual([]);
  });

  it("sin límites declarados no reporta nada", () => {
    expect(fueraDeRango(g(1, 99), null, null)).toEqual([]);
    expect(fueraDeRango(g(1, 99), 0, 0)).toEqual([]);
  });
});

describe("resumenDeTamanos", () => {
  it("agrupa y ordena de mayor a menor", () => {
    const grupos = [4, 4, 4, 3].map((n, i) => ({
      nombre: nombreDeGrupo(i + 1),
      integrantes: ids(n),
    }));
    expect(resumenDeTamanos(grupos)).toEqual([
      { cuantos: 3, integrantes: 4 },
      { cuantos: 1, integrantes: 3 },
    ]);
  });

  it("sin grupos, sin resumen", () => {
    expect(resumenDeTamanos([])).toEqual([]);
  });
});

describe("nombresLibres — el UNIQUE (workshop_id, name) no perdona", () => {
  it("sin nada tomado, numera desde 1", () => {
    expect(nombresLibres(3)).toEqual(["Grupo 1", "Grupo 2", "Grupo 3"]);
  });

  it("SALTA los nombres ya usados, incluso con huecos", () => {
    // El bug que esto ataja: numerar desde "cantidad + 1" con ["Grupo 1",
    // "Grupo 2", "Grupo 4"] arrancaría en 4 y choca. Un nombre repetido hace
    // fallar el INSERT ENTERO con 23505: no se crea NINGÚN grupo.
    expect(nombresLibres(3, ["Grupo 1", "Grupo 2", "Grupo 4"])).toEqual([
      "Grupo 3",
      "Grupo 5",
      "Grupo 6",
    ]);
  });

  it("compara sin distinguir mayúsculas ni espacios de borde", () => {
    expect(nombresLibres(1, ["  grupo 1 "])).toEqual(["Grupo 2"]);
  });

  it("los nombres que no siguen el patrón no estorban", () => {
    expect(nombresLibres(2, ["Equipo A", "Los Cracks"])).toEqual(["Grupo 1", "Grupo 2"]);
  });

  it("pedir cero nombres devuelve nada", () => {
    expect(nombresLibres(0, ["Grupo 1"])).toEqual([]);
  });
});

describe("repartirAlAzar con nombres ya tomados", () => {
  it("los grupos nuevos no chocan con los existentes", () => {
    const g = repartirAlAzar(ids(6), {
      tamano: 3,
      nombresTomados: ["Grupo 1", "Grupo 3"],
      aleatorio: azarFijo(0),
    });
    expect(g.map((x) => x.nombre)).toEqual(["Grupo 2", "Grupo 4"]);
  });

  it("y siguen repartiendo a todos", () => {
    const g = repartirAlAzar(ids(7), {
      tamano: 3,
      nombresTomados: ["Grupo 1"],
      aleatorio: azarFijo(0),
    });
    expect(g.flatMap((x) => x.integrantes)).toHaveLength(7);
    expect(new Set(g.map((x) => x.nombre)).size).toBe(g.length);
    expect(g.map((x) => x.nombre)).not.toContain("Grupo 1");
  });
});
