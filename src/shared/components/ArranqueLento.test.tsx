/**
 * El arranque que no termina tiene que DECIRLO.
 *
 * El bug que ataja está medido en un navegador real: con la base colgada (un
 * 504 que tarda, no una conexión rechazada), un usuario con sesión se quedaba
 * en «Cargando…» a los 5, a los 11 y a los 21 segundos. Una promesa colgada
 * nunca rechaza, así que el `.catch` del arranque —puesto para otro caso— no
 * se dispara nunca.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { ArranqueLento, MS_PARA_ADMITIR_QUE_NO_CARGA } from "./ArranqueLento";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

afterEach(() => vi.useRealTimers());

describe("ArranqueLento", () => {
  it("al principio se ve como siempre: solo «Cargando…»", () => {
    vi.useFakeTimers();
    render(<ArranqueLento />);
    expect(screen.getByText("common.loading")).toBeTruthy();
    expect(screen.queryByText("arranque.noCargaTitulo")).toBeNull();
  });

  it("pasado el plazo dice qué pasa y ofrece recargar", () => {
    vi.useFakeTimers();
    render(<ArranqueLento />);
    act(() => void vi.advanceTimersByTime(MS_PARA_ADMITIR_QUE_NO_CARGA + 100));
    expect(screen.getByText("arranque.noCargaTitulo")).toBeTruthy();
    expect(screen.getByText("arranque.reintentar")).toBeTruthy();
    // Y deja de prometer que está cargando, que es lo que hacía dudar.
    expect(screen.queryByText("common.loading")).toBeNull();
  });

  it("el plazo es tolerante pero no eterno", () => {
    // Por encima de cualquier arranque normal (~600 ms por consulta medidos en
    // producción) y por debajo de lo que alguien aguanta mirando una pantalla
    // quieta. Si alguien lo sube, que sea una decisión consciente.
    expect(MS_PARA_ADMITIR_QUE_NO_CARGA).toBeGreaterThanOrEqual(5000);
    expect(MS_PARA_ADMITIR_QUE_NO_CARGA).toBeLessThanOrEqual(15000);
  });
});
