import { describe, expect, it } from "vitest";
import { corteEsParcial, corteNoTermino, itemDejaNotaParcial, type ItemParaParcial } from "./corte-parcial";

/** Ítem base «ya resuelto»: cerró, se entregó y tiene nota contada. No parcial. */
function item(parcial: Partial<ItemParaParcial> = {}): ItemParaParcial {
  return { cutId: "c1", weight: 10, seDio: true, entrego: true, cuenta: true, ...parcial };
}

describe("itemDejaNotaParcial", () => {
  it("una actividad abierta sin entregar deja la nota parcial (el caso del reporte)", () => {
    // Antes de cerrar, un taller propio sin entregar no cuenta: la nota del
    // corte se ve 'ganada' hasta que vence y entra el 0.
    expect(itemDejaNotaParcial(item({ seDio: false, entrego: false, cuenta: false }), false)).toBe(
      true,
    );
  });

  it("una actividad abierta que el estudiante ya entregó también deja la nota parcial", () => {
    expect(itemDejaNotaParcial(item({ seDio: false, entrego: true, cuenta: false }), false)).toBe(
      true,
    );
  });

  it("una entrega ya hecha pero sin calificar (ya se dio) deja la nota parcial", () => {
    // seDio=true, entregó, pero todavía no cuenta: espera la nota del docente.
    expect(itemDejaNotaParcial(item({ seDio: true, entrego: true, cuenta: false }), false)).toBe(
      true,
    );
  });

  it("una actividad cerrada que cuenta 0 por no entregarse NO deja la nota parcial", () => {
    // Ya cerró y el 0 entró: la nota de ese ítem es definitiva.
    expect(
      itemDejaNotaParcial(item({ seDio: true, entrego: false, cuenta: true }), false),
    ).toBe(false);
  });

  it("una actividad cerrada y calificada NO deja la nota parcial", () => {
    expect(itemDejaNotaParcial(item({ seDio: true, entrego: true, cuenta: true }), false)).toBe(
      false,
    );
  });

  it("sin corte no suma: nunca deja la nota parcial", () => {
    expect(itemDejaNotaParcial(item({ cutId: null, seDio: false, cuenta: false }), false)).toBe(
      false,
    );
  });

  it("con peso 0 no suma: nunca deja la nota parcial", () => {
    expect(itemDejaNotaParcial(item({ weight: 0, seDio: false, cuenta: false }), false)).toBe(
      false,
    );
  });

  it("peso negativo (dato sucio) tampoco deja la nota parcial", () => {
    expect(itemDejaNotaParcial(item({ weight: -5, seDio: false, cuenta: false }), false)).toBe(
      false,
    );
  });

  it("curso finalizado: una abierta deja de contar como pendiente (ya no va a cambiar)", () => {
    // Con el curso finalizado, lo abierto se da por cerrado (cuenta 0): no parcial.
    expect(itemDejaNotaParcial(item({ seDio: false, entrego: false, cuenta: true }), true)).toBe(
      false,
    );
  });

  it("curso finalizado: una entregada sin calificar SIGUE dejando parcial (falta la nota)", () => {
    // Finalizar el curso no califica solo: si entregó y no cuenta, sigue abierta la nota.
    expect(itemDejaNotaParcial(item({ seDio: true, entrego: true, cuenta: false }), true)).toBe(
      true,
    );
  });
});

describe("corteEsParcial", () => {
  it("es parcial si CUALQUIER ítem lo deja parcial", () => {
    const items = [
      item(),
      item({ seDio: false, entrego: false, cuenta: false }),
    ];
    expect(corteEsParcial(items, false)).toBe(true);
  });

  it("no es parcial si todos los ítems están resueltos", () => {
    expect(corteEsParcial([item(), item()], false)).toBe(false);
  });

  it("un corte sin ítems no es parcial", () => {
    expect(corteEsParcial([], false)).toBe(false);
  });

  it("ítems de asistencia u otros sin peso no vuelven parcial el corte", () => {
    // La asistencia sintética entra con los demás ítems del corte; sin peso o
    // sin corte no debe arrastrar la señal.
    const items = [item(), item({ weight: 0, seDio: false, cuenta: false })];
    expect(corteEsParcial(items, false)).toBe(false);
  });

  it("un peso que no es número no deja el corte parcial", () => {
    const i = item({ weight: Number.NaN, seDio: false, entrego: false, cuenta: false });
    expect(itemDejaNotaParcial(i, false)).toBe(false);
  });

  it("corteNoTermino: hoy o después sigue abierto; ayer ya terminó", () => {
    const ahora = Date.parse("2026-10-12T15:00:00-05:00");
    expect(corteNoTermino("2026-10-12", ahora)).toBe(true);
    expect(corteNoTermino("2026-11-22", ahora)).toBe(true);
    expect(corteNoTermino("2026-10-11", ahora)).toBe(false);
    expect(corteNoTermino(null, ahora)).toBe(false);
  });
});
