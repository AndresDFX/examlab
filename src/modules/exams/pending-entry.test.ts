import { describe, expect, it } from "vitest";
import { quienesNoIngresaron, type AsignadoParaEntrada } from "./pending-entry";

const a = (userId: string, fullName: string, email: string | null = null): AsignadoParaEntrada => ({
  userId,
  fullName,
  email,
});

describe("quienesNoIngresaron", () => {
  it("el caso que lo originó: 23 asignados, 18 con entrega → faltan 5", () => {
    const asignados = Array.from({ length: 23 }, (_, i) => a(`u${i}`, `Alumno ${i}`));
    const conEntrega = new Set(Array.from({ length: 18 }, (_, i) => `u${i}`));
    const faltan = quienesNoIngresaron(asignados, conEntrega);
    expect(faltan.map((x) => x.userId)).toEqual(["u18", "u19", "u20", "u21", "u22"]);
  });

  it("una entrega de CUALQUIER estado cuenta como que ya entró", () => {
    // La fila se crea al ABRIR el examen: quien tiene fila ya está adentro,
    // aunque no haya contestado nada.
    const faltan = quienesNoIngresaron([a("u1", "Ana"), a("u2", "Beto")], new Set(["u1"]));
    expect(faltan.map((x) => x.fullName)).toEqual(["Beto"]);
  });

  it("nadie entró todavía: devuelve a todos", () => {
    const faltan = quienesNoIngresaron([a("u1", "Ana"), a("u2", "Beto")], new Set());
    expect(faltan).toHaveLength(2);
  });

  it("entraron todos: lista vacía", () => {
    expect(quienesNoIngresaron([a("u1", "Ana")], new Set(["u1"]))).toEqual([]);
  });

  it("orden alfabético es-CO, porque la lista se lee en voz alta", () => {
    const faltan = quienesNoIngresaron(
      [a("u3", "Ñáñez Peña Daniel"), a("u1", "Zúñiga Arce Pablo"), a("u2", "Álvarez Gómez Ana")],
      new Set(),
    );
    expect(faltan.map((x) => x.fullName)).toEqual([
      "Álvarez Gómez Ana",
      "Ñáñez Peña Daniel",
      "Zúñiga Arce Pablo",
    ]);
  });

  it("una asignación duplicada no muestra el nombre dos veces", () => {
    // Un nombre repetido haría dudar del conteo entero.
    const faltan = quienesNoIngresaron([a("u1", "Ana"), a("u1", "Ana")], new Set());
    expect(faltan).toHaveLength(1);
  });

  it("descarta filas sin userId en vez de romper", () => {
    const faltan = quienesNoIngresaron(
      [a("", "Vacío"), a("u1", "Ana")] as AsignadoParaEntrada[],
      new Set(),
    );
    expect(faltan.map((x) => x.fullName)).toEqual(["Ana"]);
  });

  it("un user con entrega que NO está asignado no aparece ni suma", () => {
    // Caso real: el docente quita una asignación después de que la persona
    // entregó. No es "alguien que falta".
    const faltan = quienesNoIngresaron([a("u1", "Ana")], new Set(["u1", "u9"]));
    expect(faltan).toEqual([]);
  });

  it("no muta la entrada", () => {
    const asignados = [a("u2", "Beto"), a("u1", "Ana")];
    const copia = JSON.stringify(asignados);
    quienesNoIngresaron(asignados, new Set());
    expect(JSON.stringify(asignados)).toBe(copia);
  });

  it("listas vacías no rompen", () => {
    expect(quienesNoIngresaron([], new Set())).toEqual([]);
  });
});
