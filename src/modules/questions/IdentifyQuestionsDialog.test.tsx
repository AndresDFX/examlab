import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Lo que este test protege es la parte del flujo que NO se puede verificar con
 * los módulos puros: que la revisión existe de verdad (la lista se pinta y el
 * docente puede cambiar el tipo), que una fila a la que le falta lo que su tipo
 * necesita queda BLOQUEADA con el motivo a la vista, y que lo que se inserta es
 * exactamente lo que revisó — con el `position` que la superficie pasó.
 *
 * El modelo NO se llama: `functions.invoke` está mockeado con una respuesta
 * canónica. Gastar cuota del proveedor para probar la UI está prohibido.
 */

interface EstadoMock {
  respuesta: unknown;
  errorInvoke: unknown;
  insertados: unknown[] | null;
  errorInsert: { message: string } | null;
  tabla: string | null;
}

const mock: EstadoMock = {
  respuesta: null,
  errorInvoke: null,
  insertados: null,
  errorInsert: null,
  tabla: null,
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: vi.fn(async () => ({ data: mock.respuesta, error: mock.errorInvoke })),
    },
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u-1" } } })) },
    from: vi.fn((tabla: string) => ({
      insert: vi.fn(async (filas: unknown[]) => {
        mock.tabla = tabla;
        mock.insertados = filas;
        return { error: mock.errorInsert };
      }),
    })),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  },
}));

// Patrón de CLAUDE.md: se mockea el módulo, no `window.confirm`.
const confirmResult = { value: true };
vi.mock("@/shared/components/ConfirmDialog", () => ({
  useConfirm: () => async () => confirmResult.value,
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// El gate real consulta el estado del override por RPC; acá interesa el flujo
// posterior, así que siempre autoriza en modo inmediato.
const gateDecision = { value: "proceed-sync" as string };
vi.mock("@/modules/ai/AiAuthorizationGate", () => ({
  useAiAuthorizationGate: () => ({
    ensureAuthorized: async () => gateDecision.value,
    GateDialog: () => null,
  }),
}));

vi.mock("@/shared/lib/audit", () => ({ logEvent: vi.fn(async () => {}) }));

// jsdom no trae ResizeObserver y `ScrollArea` de Radix lo instancia al montar.
// Es una carencia del entorno de test, no del componente.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

import { TooltipProvider } from "@/components/ui/tooltip";
import { IdentifyQuestionsDialog } from "./IdentifyQuestionsDialog";

/** Las tres preguntas del caso de uso original, tal como las devuelve el edge. */
const TRES = {
  ok: true,
  truncated: false,
  discarded: [],
  questions: [
    {
      type: "cerrada",
      statement:
        "Si solo despliega código y el proveedor gestiona el entorno de ejecución, ¿qué modelo es?",
      rubric: null,
      options: { choices: ["IaaS", "PaaS", "SaaS", "FaaS"], correct_index: 1 },
      language: null,
      points: 1,
      confidence: "alta",
      reason: "respuesta única entre alternativas conocidas del dominio",
      source_excerpt: "Pregunta 1",
    },
    {
      type: "abierta",
      statement: "¿SaaS puede ser el modelo dominante de CloudLite App? ¿Cuándo sí y cuándo no?",
      rubric: "Debe dar condiciones a favor y en contra.",
      options: null,
      language: null,
      points: 1,
      confidence: "alta",
      reason: "pide argumentar dos escenarios",
      source_excerpt: "Pregunta 2",
    },
    {
      type: "abierta",
      statement: "¿Qué es un registro de decisiones de arquitectura?",
      rubric: "Decisión, contexto, consecuencias e inmutabilidad.",
      options: null,
      language: null,
      points: 1,
      confidence: "media",
      reason: "definición corta",
      source_excerpt: "Pregunta 3",
    },
  ],
};

const TEXTO = [
  "Pregunta 1",
  "Si solo despliega codigo y el proveedor gestiona el runtime, que modelo es?",
  "Pregunta 2",
  "SaaS puede ser el modelo dominante de CloudLite App? Cuando si/no?",
  "Pregunta 3",
  "Que es un ADR?",
].join("\n");

function montar(over: Partial<React.ComponentProps<typeof IdentifyQuestionsDialog>> = {}) {
  // `RowAction` usa Tooltip de Radix, que exige el provider. La app lo monta en
  // `__root.tsx`; acá se replica para no rendererizar media aplicación.
  return render(
    <TooltipProvider>
      <IdentifyQuestionsDialog
        open
        onOpenChange={() => {}}
        destino="exam"
        targetId="ex-1"
        courseId="curso-1"
        nextPosition={7}
        {...over}
      />
    </TooltipProvider>,
  );
}

/** Pega el texto y corre la clasificación hasta llegar a la revisión. */
async function clasificar(user: ReturnType<typeof userEvent.setup>, texto = TEXTO) {
  const area = screen.getByRole("textbox", { name: /Texto con las preguntas/i });
  await user.click(area);
  await user.paste(texto);
  await user.click(screen.getByRole("button", { name: /Identificar con IA/i }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Agregar \d/ })).toBeInTheDocument(),
  );
}

beforeEach(() => {
  mock.respuesta = TRES;
  mock.errorInvoke = null;
  mock.insertados = null;
  mock.errorInsert = null;
  mock.tabla = null;
  confirmResult.value = true;
  gateDecision.value = "proceed-sync";
  try {
    window.localStorage.clear();
  } catch {
    /* sin almacenamiento */
  }
});

describe("IdentifyQuestionsDialog", () => {
  it("cuenta las preguntas del texto ANTES de llamar a la IA", async () => {
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByRole("textbox", { name: /Texto con las preguntas/i }));
    await user.paste(TEXTO);
    expect(screen.getByText(/Preguntas detectadas: 3/)).toBeInTheDocument();
    expect(mock.insertados).toBeNull();
  });

  it("no deja identificar con el textarea vacío", () => {
    montar();
    expect(screen.getByRole("button", { name: /Identificar con IA/i })).toBeDisabled();
  });

  it("muestra la revisión con el tipo y el motivo de cada pregunta, sin insertar nada", async () => {
    const user = userEvent.setup();
    montar();
    await clasificar(user);

    expect(screen.getByText(/respuesta única entre alternativas/i)).toBeInTheDocument();
    expect(screen.getByText(/pide argumentar dos escenarios/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("IaaS")).toBeInTheDocument();
    expect(screen.getByDisplayValue("PaaS")).toBeInTheDocument();
    // La revisión es obligatoria: hasta acá la base no se tocó.
    expect(mock.insertados).toBeNull();
  });

  it("inserta lo revisado con el position que pasó la superficie", async () => {
    const user = userEvent.setup();
    montar();
    await clasificar(user);
    await user.click(screen.getByRole("button", { name: /^Agregar \d/ }));

    await waitFor(() => expect(mock.insertados).not.toBeNull());
    expect(mock.tabla).toBe("questions");
    const filas = mock.insertados as Record<string, unknown>[];
    expect(filas).toHaveLength(3);
    expect(filas.map((f) => f.position)).toEqual([7, 8, 9]);
    expect(filas.map((f) => f.type)).toEqual(["cerrada", "abierta", "abierta"]);
    expect(filas[0].exam_id).toBe("ex-1");
    expect(filas[0].options).toEqual({
      choices: ["IaaS", "PaaS", "SaaS", "FaaS"],
      correct_index: 1,
    });
    expect(filas[1].options).toBeNull();
  });

  it("una cerrada sin opciones queda bloqueada, con el motivo a la vista y fuera del insert", async () => {
    mock.respuesta = {
      ...TRES,
      questions: [{ ...TRES.questions[0], options: null, confidence: "baja" }, TRES.questions[1]],
    };
    const user = userEvent.setup();
    montar();
    await clasificar(user);

    expect(screen.getByText(/Faltan las opciones y cuál es la correcta/i)).toBeInTheDocument();
    // El rótulo dice cuántas de cuántas entran: insertar no es todo-o-nada.
    expect(screen.getByRole("button", { name: /Agregar 1 de 2 preguntas/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Agregar 1 de 2 preguntas/i }));
    await waitFor(() => expect(mock.insertados).not.toBeNull());
    const filas = mock.insertados as Record<string, unknown>[];
    expect(filas).toHaveLength(1);
    expect(filas[0].type).toBe("abierta");
  });

  it("«Dejarlas como abierta» desbloquea la fila inválida", async () => {
    mock.respuesta = {
      ...TRES,
      questions: [{ ...TRES.questions[0], options: null }],
    };
    const user = userEvent.setup();
    montar();
    await clasificar(user);

    await user.click(screen.getByRole("button", { name: /Dejarlas como abierta/i }));
    await waitFor(() => expect(screen.queryByText(/Faltan las opciones/i)).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /^Agregar \d/ }));
    await waitFor(() => expect(mock.insertados).not.toBeNull());
    expect((mock.insertados as Record<string, unknown>[])[0].type).toBe("abierta");
  });

  it("un tipo que el destino NO acepta se degrada a abierta en vez de perder la pregunta", async () => {
    // `bd_sql` es válido en examen pero NO en proyecto (su taker no lo pinta).
    mock.respuesta = {
      ...TRES,
      questions: [
        {
          ...TRES.questions[1],
          type: "bd_sql",
          options: { db: { setupSql: "CREATE TABLE a (i int);" } },
        },
      ],
    };
    const user = userEvent.setup();
    montar({ destino: "project", targetId: "pr-1" });
    await clasificar(user);
    await user.click(screen.getByRole("button", { name: /^Agregar \d/ }));

    await waitFor(() => expect(mock.insertados).not.toBeNull());
    expect(mock.tabla).toBe("project_files");
    const fila = (mock.insertados as Record<string, unknown>[])[0];
    expect(fila.type).toBe("abierta");
    // En proyectos el enunciado va a `title`, no a `content`.
    expect(typeof fila.title).toBe("string");
    expect("content" in fila).toBe(false);
  });

  it("descarta una fila y deja de insertarla", async () => {
    const user = userEvent.setup();
    montar();
    await clasificar(user);

    const descartar = screen.getAllByRole("button", { name: /^Descartar$/i });
    await user.click(descartar[0]);
    await user.click(screen.getByRole("button", { name: /^Agregar \d/ }));

    await waitFor(() => expect(mock.insertados).not.toBeNull());
    const filas = mock.insertados as Record<string, unknown>[];
    expect(filas).toHaveLength(2);
    expect(filas.every((f) => f.type === "abierta")).toBe(true);
  });

  it("si el edge devuelve un error, no inserta nada y muestra el motivo real", async () => {
    mock.respuesta = { ok: false, error: "Sin créditos de IA.", no_credits: true };
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByRole("textbox", { name: /Texto con las preguntas/i }));
    await user.paste(TEXTO);
    await user.click(screen.getByRole("button", { name: /Identificar con IA/i }));

    await waitFor(() => expect(screen.getByText("Sin créditos de IA.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Reintentar esta tanda/i })).toBeInTheDocument();
    expect(mock.insertados).toBeNull();
  });

  it("si el modelo no devuelve preguntas, lo dice en vez de mostrar una lista vacía", async () => {
    mock.respuesta = { ok: true, questions: [], discarded: [], truncated: false };
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByRole("textbox", { name: /Texto con las preguntas/i }));
    await user.paste(TEXTO);
    await user.click(screen.getByRole("button", { name: /Identificar con IA/i }));

    await waitFor(() =>
      expect(screen.getByText(/no devolvió preguntas para este texto/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /^Agregar \d/ })).not.toBeInTheDocument();
  });

  it("avisa cuando la IA clasificó menos preguntas de las que detectamos", async () => {
    mock.respuesta = { ...TRES, questions: [TRES.questions[0], TRES.questions[1]] };
    const user = userEvent.setup();
    montar();
    await clasificar(user);

    expect(
      screen.getByText(/Detectamos 3 preguntas y la IA clasificó 2/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Texto sin clasificar/i)).toBeInTheDocument();
  });

  it("si el insert falla, el diálogo NO se cierra y la lista queda intacta", async () => {
    mock.errorInsert = { message: "network error" };
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    montar({ onOpenChange });
    await clasificar(user);
    await user.click(screen.getByRole("button", { name: /^Agregar \d/ }));

    await waitFor(() => expect(mock.insertados).not.toBeNull());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: /^Agregar \d/ })).toBeInTheDocument();
  });

  it("en cola no procede: la cola devuelve preguntas ya creadas y acá hay que revisarlas", async () => {
    gateDecision.value = "proceed-async";
    const user = userEvent.setup();
    montar();
    await user.click(screen.getByRole("textbox", { name: /Texto con las preguntas/i }));
    await user.paste(TEXTO);
    await user.click(screen.getByRole("button", { name: /Identificar con IA/i }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Agregar \d/ })).not.toBeInTheDocument(),
    );
    expect(mock.insertados).toBeNull();
  });

  it("en el banco inserta en question_bank con suggested_points y created_by", async () => {
    const user = userEvent.setup();
    montar({ destino: "bank", targetId: "curso-1", nextPosition: 0 });
    await clasificar(user);
    await user.click(screen.getByRole("button", { name: /^Agregar \d/ }));

    await waitFor(() => expect(mock.insertados).not.toBeNull());
    expect(mock.tabla).toBe("question_bank");
    const fila = (mock.insertados as Record<string, unknown>[])[0];
    expect(fila.course_id).toBe("curso-1");
    expect(fila.suggested_points).toBe(1);
    expect(fila.created_by).toBe("u-1");
    expect("position" in fila).toBe(false);
  });
});
