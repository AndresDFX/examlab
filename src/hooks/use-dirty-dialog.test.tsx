import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock de useConfirm: por defecto resuelve true (el usuario "descarta").
// El test que verifica "no cerrar si cancela" lo cambia a false.
const confirmMock = vi.fn(() => Promise.resolve(true));

vi.mock("@/components/ConfirmDialog", () => ({
  useConfirm: () => confirmMock,
}));

import { useDirtyDialog } from "./use-dirty-dialog";

beforeEach(() => {
  confirmMock.mockClear();
  confirmMock.mockImplementation(() => Promise.resolve(true));
});

describe("useDirtyDialog — isDirty", () => {
  it("false cuando el diálogo está cerrado", () => {
    const { result } = renderHook(() => useDirtyDialog(false, { name: "a" }));
    expect(result.current.isDirty).toBe(false);
  });

  it("false al abrir sin cambios", () => {
    const { result } = renderHook(({ open, form }) => useDirtyDialog(open, form), {
      initialProps: { open: true, form: { name: "a" } },
    });
    expect(result.current.isDirty).toBe(false);
  });

  it("true cuando el form cambia mientras está abierto", () => {
    const { result, rerender } = renderHook(
      ({ open, form }) => useDirtyDialog(open, form),
      { initialProps: { open: true, form: { name: "a" } } },
    );
    expect(result.current.isDirty).toBe(false);
    rerender({ open: true, form: { name: "b" } });
    expect(result.current.isDirty).toBe(true);
  });

  it("false otra vez si el form vuelve al snapshot inicial", () => {
    const { result, rerender } = renderHook(
      ({ open, form }) => useDirtyDialog(open, form),
      { initialProps: { open: true, form: { name: "a" } } },
    );
    rerender({ open: true, form: { name: "b" } });
    expect(result.current.isDirty).toBe(true);
    rerender({ open: true, form: { name: "a" } });
    expect(result.current.isDirty).toBe(false);
  });

  it("re-snapshot al re-abrir: cambios anteriores ya no cuentan", () => {
    const { result, rerender } = renderHook(
      ({ open, form }) => useDirtyDialog(open, form),
      { initialProps: { open: true, form: { name: "a" } } },
    );
    rerender({ open: true, form: { name: "b" } });
    expect(result.current.isDirty).toBe(true);
    // Cerrar y volver a abrir con form "b" como nuevo punto de partida
    rerender({ open: false, form: { name: "b" } });
    rerender({ open: true, form: { name: "b" } });
    expect(result.current.isDirty).toBe(false);
  });

  it("usa JSON.stringify — detecta cambios en objetos anidados", () => {
    const { result, rerender } = renderHook(
      ({ open, form }) => useDirtyDialog(open, form),
      {
        initialProps: { open: true, form: { nested: { count: 0 } } },
      },
    );
    rerender({ open: true, form: { nested: { count: 1 } } });
    expect(result.current.isDirty).toBe(true);
  });
});

describe("useDirtyDialog — guardOpenChange", () => {
  it("permite abrir (next=true) sin preguntar nada", async () => {
    const setOpen = vi.fn();
    const { result } = renderHook(() => useDirtyDialog(false, { x: 1 }));
    await act(async () => {
      await result.current.guardOpenChange(setOpen)(true);
    });
    expect(setOpen).toHaveBeenCalledWith(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("permite cerrar (next=false) sin preguntar cuando NO está sucio", async () => {
    const setOpen = vi.fn();
    const { result } = renderHook(({ open, form }) => useDirtyDialog(open, form), {
      initialProps: { open: true, form: { x: 1 } },
    });
    await act(async () => {
      await result.current.guardOpenChange(setOpen)(false);
    });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it("pregunta antes de cerrar cuando ESTÁ sucio", async () => {
    const setOpen = vi.fn();
    const { result, rerender } = renderHook(
      ({ open, form }) => useDirtyDialog(open, form),
      { initialProps: { open: true, form: { x: 1 } } },
    );
    rerender({ open: true, form: { x: 2 } });
    expect(result.current.isDirty).toBe(true);
    await act(async () => {
      await result.current.guardOpenChange(setOpen)(false);
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it("NO cierra si el usuario rechaza la confirmación", async () => {
    confirmMock.mockImplementationOnce(() => Promise.resolve(false));
    const setOpen = vi.fn();
    const { result, rerender } = renderHook(
      ({ open, form }) => useDirtyDialog(open, form),
      { initialProps: { open: true, form: { x: 1 } } },
    );
    rerender({ open: true, form: { x: 2 } });
    await act(async () => {
      await result.current.guardOpenChange(setOpen)(false);
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(setOpen).not.toHaveBeenCalled();
  });

  it("usa tone='destructive' y los labels correctos en el confirm", async () => {
    const setOpen = vi.fn();
    const { result, rerender } = renderHook(
      ({ open, form }) => useDirtyDialog(open, form),
      { initialProps: { open: true, form: { x: 1 } } },
    );
    rerender({ open: true, form: { x: 2 } });
    await act(async () => {
      await result.current.guardOpenChange(setOpen)(false);
    });
    const args = (confirmMock.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(args.tone).toBe("destructive");
    expect(args.confirmLabel).toMatch(/Descartar/i);
    expect(args.cancelLabel).toMatch(/Seguir/i);
  });
});
