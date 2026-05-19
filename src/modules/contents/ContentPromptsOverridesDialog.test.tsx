import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// El cliente de Supabase se mockea ANTES de importar el componente,
// porque el componente lo captura por referencia al evaluarse el módulo.
// Cada test reinyecta los valores devueltos por `from(...)` via la
// variable global `__mockTables` (controlable por el test).
type MockResult = { data: unknown; error: { message: string } | null };

interface MockState {
  /** Filas que devuelve `ai_prompts.select(...).in(...).is(null)` */
  aiPromptsRows: Array<{ use_case: string; system_prompt: string }>;
  /** Resultado de `generated_contents.select("prompt_overrides").eq(id).maybeSingle()` */
  contentRow: { prompt_overrides: Record<string, unknown> } | null;
  /** Espía la última llamada a update — el test inspecciona los argumentos */
  lastUpdate: { payload: Record<string, unknown>; eqArgs: [string, string] } | null;
  /** Error simulado al guardar — null = exitoso */
  updateError: { message: string } | null;
}

const mockState: MockState = {
  aiPromptsRows: [],
  contentRow: null,
  lastUpdate: null,
  updateError: null,
};

vi.mock("@/integrations/supabase/client", () => {
  function makeThenable(result: MockResult) {
    const target: Record<string, unknown> = {};
    const passthrough = ["select", "in", "eq", "is", "order"] as const;
    for (const m of passthrough) target[m] = vi.fn(() => target);
    target.maybeSingle = vi.fn(() => Promise.resolve(result));
    // Hacer la chain awaitable cuando NO se llama .maybeSingle() al final
    // (caso de ai_prompts: termina en `.is(null)`).
    (target as { then?: unknown }).then = (resolve: (r: MockResult) => unknown) =>
      Promise.resolve(result).then(resolve);
    return target;
  }
  return {
    supabase: {
      from: vi.fn((table: string) => {
        if (table === "ai_prompts") {
          return makeThenable({ data: mockState.aiPromptsRows, error: null });
        }
        if (table === "generated_contents") {
          // El componente usa la misma `.from("generated_contents")` para
          // SELECT y para UPDATE. Devolvemos un único objeto cuyos métodos
          // capturan la intención: `.select` → pasa a get; `.update` →
          // registra payload y deja un terminal `.eq` que resuelve sin error.
          const target: Record<string, unknown> = {};
          target.select = vi.fn(() => target);
          target.eq = vi.fn(() => target);
          target.maybeSingle = vi.fn(() =>
            Promise.resolve({ data: mockState.contentRow, error: null }),
          );
          target.update = vi.fn((payload: Record<string, unknown>) => {
            const eqFn = vi.fn((col: string, val: string) => {
              mockState.lastUpdate = { payload, eqArgs: [col, val] };
              return Promise.resolve({ error: mockState.updateError });
            });
            return { eq: eqFn };
          });
          return target;
        }
        return makeThenable({ data: null, error: null });
      }),
    },
  };
});

// Mock de sonner para que toast.error/.success no rompan en jsdom
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { ContentPromptsOverridesDialog } from "./ContentPromptsOverridesDialog";
import { toast } from "sonner";

beforeEach(() => {
  mockState.aiPromptsRows = [
    { use_case: "content_generation", system_prompt: "Global orchestrator prompt" },
    { use_case: "content.presentacion", system_prompt: "Global presentation prompt" },
    { use_case: "content.guia_docente", system_prompt: "Global guide prompt" },
    { use_case: "content.taller_practico", system_prompt: "Global workshop prompt" },
    { use_case: "content.ejercicio", system_prompt: "Global exercise prompt" },
    { use_case: "content.examen", system_prompt: "Global exam prompt" },
  ];
  mockState.contentRow = { prompt_overrides: {} };
  mockState.lastUpdate = null;
  mockState.updateError = null;
  (toast.success as Mock).mockClear();
  (toast.error as Mock).mockClear();
});

describe("ContentPromptsOverridesDialog — render & cierre", () => {
  it("no renderiza nada cuando contentId es null", () => {
    const { container } = render(
      <ContentPromptsOverridesDialog contentId={null} onClose={() => {}} />,
    );
    // Radix Dialog con open=false no monta el contenido — el DOM queda casi vacío
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("renderiza el dialog cuando contentId está poblado", async () => {
    render(<ContentPromptsOverridesDialog contentId="content-1" onClose={() => {}} />);
    expect(
      await screen.findByText("Personalizar prompts de este contenido"),
    ).toBeInTheDocument();
  });
});

describe("ContentPromptsOverridesDialog — estado inicial", () => {
  it("muestra 'Global' en todas las keys cuando no hay overrides", async () => {
    mockState.contentRow = { prompt_overrides: {} };
    render(<ContentPromptsOverridesDialog contentId="content-1" onClose={() => {}} />);
    // 6 use cases → 6 badges "Global"
    await waitFor(() => {
      const badges = screen.queryAllByTestId(/^badge-global-/);
      expect(badges.length).toBe(6);
    });
    expect(screen.queryAllByTestId(/^badge-customized-/).length).toBe(0);
  });

  it("muestra 'Personalizado' en las keys que vienen con override", async () => {
    mockState.contentRow = {
      prompt_overrides: {
        content_generation: "MY OVERRIDE",
        "content.examen": "EXAM OVERRIDE",
      },
    };
    render(<ContentPromptsOverridesDialog contentId="content-1" onClose={() => {}} />);
    await waitFor(() => {
      expect(
        screen.queryByTestId("badge-customized-content_generation"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("badge-customized-content.examen")).toBeInTheDocument();
    // El resto sigue como global
    expect(
      screen.queryByTestId("badge-global-content.presentacion"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("badge-global-content.guia_docente")).toBeInTheDocument();
  });

  it("rellena el textarea con el override existente (no con el global)", async () => {
    mockState.contentRow = {
      prompt_overrides: { content_generation: "MY OVERRIDE TEXT" },
    };
    render(<ContentPromptsOverridesDialog contentId="content-1" onClose={() => {}} />);
    const ta = await screen.findByLabelText("Prompt Prompt orquestador");
    expect((ta as HTMLTextAreaElement).value).toBe("MY OVERRIDE TEXT");
  });
});

describe("ContentPromptsOverridesDialog — toggles personalizar/volver", () => {
  it("clickear 'Personalizar' usa el global como punto de partida", async () => {
    mockState.contentRow = { prompt_overrides: {} };
    render(<ContentPromptsOverridesDialog contentId="content-1" onClose={() => {}} />);
    // Esperar que cargue
    await screen.findByTestId("badge-global-content_generation");

    // Clic en el botón "Personalizar" del primer use case (orquestador)
    const badge = screen.getByTestId("badge-global-content_generation");
    // El botón está en el mismo Card que el badge — buscamos el ancestor
    const card = badge.closest("[class*='card']") ?? badge.parentElement!.parentElement!;
    const personalizarBtn = within(card as HTMLElement).getByRole("button", {
      name: "Personalizar",
    });
    await userEvent.click(personalizarBtn);

    // Ahora debe aparecer el textarea con el global como contenido inicial
    const ta = await screen.findByLabelText("Prompt Prompt orquestador");
    expect((ta as HTMLTextAreaElement).value).toBe("Global orchestrator prompt");
    expect(screen.queryByTestId("badge-customized-content_generation")).toBeInTheDocument();
  });

  it("'Volver al global' quita el override del draft", async () => {
    mockState.contentRow = {
      prompt_overrides: { content_generation: "CUSTOM" },
    };
    render(<ContentPromptsOverridesDialog contentId="content-1" onClose={() => {}} />);
    await screen.findByTestId("badge-customized-content_generation");

    const volverBtn = (await screen.findAllByRole("button", { name: /Volver al global/ }))[0];
    await userEvent.click(volverBtn);

    // Después de clic, el badge cambia a Global y desaparece el textarea
    await waitFor(() => {
      expect(screen.queryByTestId("badge-global-content_generation")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("badge-customized-content_generation")).toBeNull();
  });
});

describe("ContentPromptsOverridesDialog — guardar", () => {
  it("guarda el JSONB sanitizado y llama onSaved + onClose", async () => {
    mockState.contentRow = { prompt_overrides: {} };
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(
      <ContentPromptsOverridesDialog
        contentId="content-xyz"
        onClose={onClose}
        onSaved={onSaved}
      />,
    );
    await screen.findByTestId("badge-global-content_generation");

    // Personalizar content_generation
    const badge = screen.getByTestId("badge-global-content_generation");
    const card = badge.closest("[class*='card']") ?? badge.parentElement!.parentElement!;
    await userEvent.click(
      within(card as HTMLElement).getByRole("button", { name: "Personalizar" }),
    );
    const ta = await screen.findByLabelText("Prompt Prompt orquestador");
    await userEvent.clear(ta);
    await userEvent.type(ta, "Custom for University A");

    // Clic en Guardar
    const guardar = screen.getByRole("button", { name: /Guardar overrides/ });
    await userEvent.click(guardar);

    await waitFor(() => {
      expect(mockState.lastUpdate).not.toBeNull();
    });
    expect(mockState.lastUpdate!.payload).toEqual({
      prompt_overrides: { content_generation: "Custom for University A" },
    });
    expect(mockState.lastUpdate!.eqArgs).toEqual(["id", "content-xyz"]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("guarda {} cuando el docente revierte todos los overrides", async () => {
    mockState.contentRow = {
      prompt_overrides: { content_generation: "ORIGINAL" },
    };
    const onClose = vi.fn();
    render(<ContentPromptsOverridesDialog contentId="c-1" onClose={onClose} />);
    await screen.findByTestId("badge-customized-content_generation");

    // Volver al global
    await userEvent.click(
      (await screen.findAllByRole("button", { name: /Volver al global/ }))[0],
    );

    // Guardar
    await userEvent.click(screen.getByRole("button", { name: /Guardar overrides/ }));

    await waitFor(() => {
      expect(mockState.lastUpdate).not.toBeNull();
    });
    expect(mockState.lastUpdate!.payload).toEqual({ prompt_overrides: {} });
  });

  it("guardar está deshabilitado cuando no hay cambios (dirty=false)", async () => {
    mockState.contentRow = { prompt_overrides: {} };
    render(<ContentPromptsOverridesDialog contentId="c-1" onClose={() => {}} />);
    await screen.findByTestId("badge-global-content_generation");
    const guardar = screen.getByRole("button", { name: /Guardar overrides/ });
    expect(guardar).toBeDisabled();
  });

  it("muestra toast.error y NO llama onClose si update falla", async () => {
    mockState.contentRow = { prompt_overrides: {} };
    mockState.updateError = { message: "DB error: permission denied" };
    const onClose = vi.fn();
    render(<ContentPromptsOverridesDialog contentId="c-1" onClose={onClose} />);
    await screen.findByTestId("badge-global-content_generation");

    // Personalizar
    const badge = screen.getByTestId("badge-global-content_generation");
    const card = badge.closest("[class*='card']") ?? badge.parentElement!.parentElement!;
    await userEvent.click(
      within(card as HTMLElement).getByRole("button", { name: "Personalizar" }),
    );
    const ta = await screen.findByLabelText("Prompt Prompt orquestador");
    await userEvent.clear(ta);
    await userEvent.type(ta, "custom");

    await userEvent.click(screen.getByRole("button", { name: /Guardar overrides/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("DB error: permission denied");
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ContentPromptsOverridesDialog — sanitización al guardar", () => {
  it("descarta strings vacíos / whitespace antes de persistir", async () => {
    mockState.contentRow = {
      prompt_overrides: { content_generation: "ORIGINAL", "content.examen": "OTHER" },
    };
    render(<ContentPromptsOverridesDialog contentId="c-1" onClose={() => {}} />);
    await screen.findByTestId("badge-customized-content_generation");

    // Vaciar el textarea del orquestador (queda string vacío)
    const ta = await screen.findByLabelText("Prompt Prompt orquestador");
    await userEvent.clear(ta);
    // El componente lo dejó como "" — al guardar debe sanitizarse a ausente.

    await userEvent.click(screen.getByRole("button", { name: /Guardar overrides/ }));

    await waitFor(() => {
      expect(mockState.lastUpdate).not.toBeNull();
    });
    // content_generation ya no aparece (string vacío descartado).
    // content.examen sigue porque no fue tocado.
    expect(mockState.lastUpdate!.payload).toEqual({
      prompt_overrides: { "content.examen": "OTHER" },
    });
  });
});
