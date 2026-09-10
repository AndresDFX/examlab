import { describe, expect, it } from "vitest";
import { clampEditorZoom, EDITOR_ZOOM_MAX, EDITOR_ZOOM_MIN } from "./use-editor-zoom";

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

describe("clave de almacenamiento", () => {
  it("el hook lee la clave nueva y, si no está, MIGRA la de SQL", async () => {
    // El zoom nació solo en la hoja de SQL con la clave `examlab_sql_zoom`.
    // Al extenderlo a los editores de código pasó a ser UNA preferencia por
    // persona bajo `examlab_editor_zoom`; sin leer la vieja, a quien lo tenía
    // en 150 % se le reseteaba a 100 % sin explicación.
    const fuente = await import("node:fs").then((fs) =>
      fs.readFileSync("src/hooks/use-editor-zoom.ts", "utf8"),
    );
    expect(fuente).toContain('"examlab_editor_zoom"');
    expect(fuente).toContain('"examlab_sql_zoom"');
    // El orden importa: la nueva gana, la vieja es el respaldo.
    expect(fuente.indexOf("STORAGE_KEY")).toBeLessThan(fuente.indexOf("LEGACY_KEY"));
    // Y la vieja NO se vuelve a escribir: se lee una vez y se deja morir.
    const escrituras = fuente.match(/setItem\(([A-Z_]+)/g) ?? [];
    expect(escrituras).toEqual(["setItem(STORAGE_KEY"]);
  });
});
