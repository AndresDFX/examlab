import { describe, expect, it } from "vitest";
import { todasLasFilas } from "./todas-las-filas";

/** Una tabla falsa que corta cada respuesta en `tope` filas, como PostgREST. */
function tablaConTope(total: number, tope: number) {
  const pedidos: Array<[number, number]> = [];
  const consulta = async (desde: number, hasta: number) => {
    pedidos.push([desde, hasta]);
    const fin = Math.min(hasta + 1, desde + tope, total);
    return { data: Array.from({ length: Math.max(0, fin - desde) }, (_, i) => desde + i), error: null };
  };
  return { consulta, pedidos };
}

describe("todasLasFilas", () => {
  it("junta las páginas hasta la última incompleta", async () => {
    const { consulta, pedidos } = tablaConTope(2500, 1000);
    const r = await todasLasFilas(consulta);
    expect(r.error).toBeNull();
    expect(r.data).toHaveLength(2500);
    expect(r.data[2499]).toBe(2499);
    expect(pedidos).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("con un múltiplo exacto pide una página vacía y termina", async () => {
    const { consulta, pedidos } = tablaConTope(2000, 1000);
    const r = await todasLasFilas(consulta);
    expect(r.data).toHaveLength(2000);
    expect(pedidos).toHaveLength(3);
  });

  it("devuelve el error sin seguir pidiendo", async () => {
    let n = 0;
    const r = await todasLasFilas(async () => {
      n++;
      return n === 1
        ? { data: Array.from({ length: 1000 }, (_, i) => i), error: null }
        : { data: null, error: { message: "boom" } };
    });
    expect(r.error).toEqual({ message: "boom" });
    expect(r.data).toHaveLength(1000);
    expect(n).toBe(2);
  });
});
