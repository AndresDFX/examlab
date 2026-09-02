import { describe, expect, it } from "vitest";

import {
  alternarVisibles,
  calcularDiff,
  filtrarFirmantes,
  seleccionables,
  todosVisiblesMarcados,
} from "./send-to-sign-selection";

const alumnos = [
  { id: "a", nombre: "Ana Gómez", email: "ana@uniajc.edu.co" },
  { id: "b", nombre: "Bruno Pérez", email: "bruno@uniajc.edu.co" },
  { id: "c", nombre: "Camilo Ríos", email: null },
];
const nadieFirmo = () => false;

describe("filtrarFirmantes", () => {
  it("con búsqueda vacía devuelve el MISMO arreglo, sin clonar", () => {
    // La lista se re-renderiza en cada tecleo; clonar 96 filas por nada es
    // trabajo tirado.
    expect(filtrarFirmantes(alumnos, "")).toBe(alumnos);
    expect(filtrarFirmantes(alumnos, "   ")).toBe(alumnos);
  });

  it("encuentra por nombre sin distinguir tildes ni mayúsculas", () => {
    expect(filtrarFirmantes(alumnos, "GOMEZ").map((a) => a.id)).toEqual(["a"]);
    expect(filtrarFirmantes(alumnos, "rios").map((a) => a.id)).toEqual(["c"]);
  });

  it("encuentra por correo", () => {
    expect(filtrarFirmantes(alumnos, "bruno@").map((a) => a.id)).toEqual(["b"]);
  });

  it("un alumno sin correo no rompe la búsqueda por correo", () => {
    expect(filtrarFirmantes(alumnos, "uniajc").map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("sin coincidencias devuelve vacío", () => {
    expect(filtrarFirmantes(alumnos, "zzz")).toEqual([]);
  });
});

describe("alternarVisibles — lo que está FUERA del filtro no se toca", () => {
  it("marcar lo visible PRESERVA la selección escondida por el buscador", () => {
    // El accidente que esto evita: con 96 matriculados, escribir tres letras y
    // pulsar "marcar" con un toggleAll normal reemplazaría la selección por lo
    // visible y retiraría las 90 solicitudes restantes.
    const r = alternarVisibles(new Set(["b", "c"]), [alumnos[0]], nadieFirmo, true);
    expect([...r].sort()).toEqual(["a", "b", "c"]);
  });

  it("desmarcar lo visible saca SOLO lo visible", () => {
    const r = alternarVisibles(new Set(["a", "b", "c"]), [alumnos[0]], nadieFirmo, false);
    expect([...r].sort()).toEqual(["b", "c"]);
  });

  it("a quien ya firmó no lo toca en ninguna dirección", () => {
    const firmoA = (id: string) => id === "a";
    expect([...alternarVisibles(new Set(), alumnos, firmoA, true)].sort()).toEqual(["b", "c"]);
    expect([...alternarVisibles(new Set(["a", "b"]), alumnos, firmoA, false)]).toEqual(["a"]);
  });

  it("no muta el set de entrada", () => {
    const original = new Set(["b"]);
    alternarVisibles(original, alumnos, nadieFirmo, true);
    expect([...original]).toEqual(["b"]);
  });
});

describe("seleccionables / todosVisiblesMarcados", () => {
  it("los que ya firmaron no cuentan como seleccionables", () => {
    expect(seleccionables(alumnos, (id) => id === "b").map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("todos marcados ignora a los que firmaron", () => {
    // 'b' firmó y no está en el set: igual cuenta como "todo marcado", porque el
    // botón no puede hacer nada más por él.
    expect(todosVisiblesMarcados(new Set(["a", "c"]), alumnos, (id) => id === "b")).toBe(true);
  });

  it("con un visible sin marcar, no está todo marcado", () => {
    expect(todosVisiblesMarcados(new Set(["a"]), alumnos, nadieFirmo)).toBe(false);
  });

  it("sin nada seleccionable, no está 'todo marcado' (el botón no aplica)", () => {
    expect(todosVisiblesMarcados(new Set(), [], nadieFirmo)).toBe(false);
    expect(todosVisiblesMarcados(new Set(["a"]), alumnos, () => true)).toBe(false);
  });
});

describe("calcularDiff", () => {
  const sinSolicitud = () => undefined;

  it("los marcados sin solicitud son los nuevos", () => {
    const { nuevos, retirados } = calcularDiff(alumnos, new Set(["a", "b"]), sinSolicitud);
    expect(nuevos.sort()).toEqual(["a", "b"]);
    expect(retirados).toEqual([]);
  });

  it("un pendiente desmarcado se retira; uno firmado NO", () => {
    const estado = (id: string) =>
      id === "a" ? { firmada: false } : id === "b" ? { firmada: true } : undefined;
    const { nuevos, retirados } = calcularDiff(alumnos, new Set(), estado);
    expect(retirados).toEqual(["a"]);
    expect(nuevos).toEqual([]);
  });

  it("pedirle de nuevo a quien ya tiene solicitud no genera un nuevo", () => {
    const estado = (id: string) => (id === "a" ? { firmada: false } : undefined);
    const { nuevos } = calcularDiff(alumnos, new Set(["a"]), estado);
    expect(nuevos).toEqual([]);
  });
});

describe("composición: buscar → marcar lo visible → guardar", () => {
  it("NO retira las solicitudes que el buscador dejó fuera", () => {
    // Este es el test que importa, y es de composición a propósito: cada función
    // por separado puede estar bien y el bug aparecer al encadenarlas. Escenario
    // real: 'b' y 'c' tienen solicitud pendiente, el docente busca "ana" y marca
    // lo que ve. Si el diff se calculara sobre la lista filtrada, 'b' y 'c'
    // caerían en `retirados` y perderían su enlace personal.
    const pendientes = new Map([
      ["b", { firmada: false }],
      ["c", { firmada: false }],
    ]);
    const estado = (id: string) => pendientes.get(id);

    const visibles = filtrarFirmantes(alumnos, "ana");
    expect(visibles.map((v) => v.id)).toEqual(["a"]);

    const elegidos = alternarVisibles(new Set(pendientes.keys()), visibles, nadieFirmo, true);
    const { nuevos, retirados } = calcularDiff(alumnos, elegidos, estado);

    expect(nuevos).toEqual(["a"]);
    expect(retirados).toEqual([]);
  });

  it("y desmarcar lo visible retira SOLO a ese, no a los escondidos", () => {
    const pendientes = new Map([
      ["a", { firmada: false }],
      ["b", { firmada: false }],
      ["c", { firmada: false }],
    ]);
    const visibles = filtrarFirmantes(alumnos, "bruno");
    const elegidos = alternarVisibles(new Set(pendientes.keys()), visibles, nadieFirmo, false);
    const { retirados } = calcularDiff(alumnos, elegidos, (id) => pendientes.get(id));
    expect(retirados).toEqual(["b"]);
  });
});
