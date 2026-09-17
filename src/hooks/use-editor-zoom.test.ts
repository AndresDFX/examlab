import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { clampEditorZoom, EDITOR_ZOOM_MAX, EDITOR_ZOOM_MIN, useEditorZoom } from "./use-editor-zoom";

describe("clampEditorZoom", () => {
  it("acepta un valor válido guardado como string", () => {
    expect(clampEditorZoom("1.5")).toBe(1.5);
    expect(clampEditorZoom(1.75)).toBe(1.75);
  });

  it("sube al piso lo que quede por debajo (no hay zoom < 100%)", () => {
    expect(clampEditorZoom(0.4)).toBe(EDITOR_ZOOM_MIN);
    expect(clampEditorZoom(-3)).toBe(EDITOR_ZOOM_MIN);
  });

  it("baja al techo lo que quede por encima", () => {
    expect(clampEditorZoom(5)).toBe(EDITOR_ZOOM_MAX);
    expect(clampEditorZoom("999")).toBe(EDITOR_ZOOM_MAX);
  });

  it("cae al default con basura en localStorage", () => {
    expect(clampEditorZoom("basura")).toBe(EDITOR_ZOOM_MIN);
    expect(clampEditorZoom(null)).toBe(EDITOR_ZOOM_MIN);
    expect(clampEditorZoom(undefined)).toBe(EDITOR_ZOOM_MIN);
    expect(clampEditorZoom(NaN)).toBe(EDITOR_ZOOM_MIN);
    expect(clampEditorZoom(Infinity)).toBe(EDITOR_ZOOM_MIN);
  });

  it("hace snap al paso de 0,25 (un valor viejo fuera de la escala no queda intermedio)", () => {
    expect(clampEditorZoom(1.3)).toBe(1.25);
    expect(clampEditorZoom(1.4)).toBe(1.5);
    expect(clampEditorZoom(1.62)).toBe(1.5);
  });
});

describe("clave de almacenamiento (sin scopeKey — preferencia compartida legacy)", () => {
  it("el hook lee la clave nueva y, si no está, MIGRA la de SQL", async () => {
    // El zoom nació solo en la hoja de SQL con la clave `examlab_sql_zoom`.
    // Al extenderlo a los editores de código pasó a ser UNA preferencia por
    // persona bajo `examlab_editor_zoom`; sin leer la vieja, a quien lo tenía
    // en 150 % se le reseteaba a 100 % sin explicación. Un caller que NO pasa
    // `scopeKey` sigue en ese camino legacy.
    const fuente = await import("node:fs").then((fs) =>
      fs.readFileSync("src/hooks/use-editor-zoom.ts", "utf8"),
    );
    expect(fuente).toContain('"examlab_editor_zoom"');
    expect(fuente).toContain('"examlab_sql_zoom"');
    // El orden importa: la nueva gana, la vieja es el respaldo.
    expect(fuente.indexOf("STORAGE_KEY")).toBeLessThan(fuente.indexOf("LEGACY_KEY"));
    // Y la vieja NO se vuelve a escribir: se lee una vez y se deja morir. La
    // escritura va a `storageKey` (derivada, con o sin scope) — no a la
    // constante `STORAGE_KEY` directa, que es lo que este assert verificaba
    // antes de que existiera el scope.
    const escrituras = fuente.match(/setItem\(([a-zA-Z_]+)/g) ?? [];
    expect(escrituras).toEqual(["setItem(storageKey"]);
  });
});

describe("useEditorZoom — scopeKey (causa raíz del reporte 'el zoom queda en caché en todos los compiladores')", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("dos superficies con scopeKey distinto NO comparten su zoom", async () => {
    const a = renderHook(() => useEditorZoom("pregunta-A"));
    const b = renderHook(() => useEditorZoom("pregunta-B"));
    await waitFor(() => expect(a.result.current.pct).toBe(100));

    act(() => a.result.current.zoomIn());
    expect(a.result.current.pct).toBe(125);
    // B nunca vio el cambio de A: ni en memoria ni releyendo su propia clave.
    expect(b.result.current.pct).toBe(100);

    const c = renderHook(() => useEditorZoom("pregunta-B"));
    await waitFor(() => expect(c.result.current.pct).toBe(100));
  });

  it("la MISMA scopeKey sí persiste entre montajes (recargar la pantalla no resetea)", async () => {
    const primero = renderHook(() => useEditorZoom("hoja-pizarra-1"));
    await waitFor(() => expect(primero.result.current.pct).toBe(100));
    act(() => primero.result.current.zoomIn());
    act(() => primero.result.current.zoomIn());
    expect(primero.result.current.pct).toBe(150);

    const segundo = renderHook(() => useEditorZoom("hoja-pizarra-1"));
    await waitFor(() => expect(segundo.result.current.pct).toBe(150));
  });

  it("cambiar de scopeKey en el mismo componente relee SU propia clave (no arrastra la anterior)", async () => {
    // Caso real: el docente pasa de la pregunta 1 a la pregunta 2 del mismo
    // taller sin desmontar el editor (`key` no cambia, solo la prop).
    localStorage.setItem("examlab_editor_zoom:pregunta-2", "1.75");
    const { result, rerender } = renderHook(({ q }: { q: string }) => useEditorZoom(q), {
      initialProps: { q: "pregunta-1" },
    });
    await waitFor(() => expect(result.current.pct).toBe(100));
    act(() => result.current.zoomIn());
    expect(result.current.pct).toBe(125);

    rerender({ q: "pregunta-2" });
    await waitFor(() => expect(result.current.pct).toBe(175));
  });

  it("sin scopeKey sigue usando la preferencia compartida de siempre (compat)", async () => {
    localStorage.setItem("examlab_editor_zoom", "1.5");
    const { result } = renderHook(() => useEditorZoom());
    await waitFor(() => expect(result.current.pct).toBe(150));
  });

  it("con scopeKey NO migra el valor legado de SQL (esa migración es solo para la preferencia compartida)", async () => {
    localStorage.setItem("examlab_sql_zoom", "2");
    const { result } = renderHook(() => useEditorZoom("pregunta-nueva"));
    await waitFor(() => {
      // Nunca estuvo en `undefined`: el valor determinístico inicial es 100%.
      expect(result.current.pct).toBe(100);
    });
  });

  it("cada scopeKey escribe bajo su propia clave de localStorage", async () => {
    const { result } = renderHook(() => useEditorZoom("mi-pregunta"));
    await waitFor(() => expect(result.current.pct).toBe(100));
    act(() => result.current.zoomIn());
    expect(localStorage.getItem("examlab_editor_zoom:mi-pregunta")).toBe("1.25");
    expect(localStorage.getItem("examlab_editor_zoom")).toBeNull();
  });
});
