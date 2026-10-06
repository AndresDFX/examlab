import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import userEvent from "@testing-library/user-event";
import type { EstadoMonaco } from "@/modules/code/use-monaco-listo";
import { isSqlAnswerBlank, parseSqlAnswer } from "@/modules/database/sql-answer";

/**
 * Lo que se fija acá: **una pregunta de SQL siempre tiene dónde responder.**
 *
 * Monaco se baja de un CDN cuando la pregunta aparece (1,05 MB comprimidos) y
 * `@monaco-editor/react` no avisa si falla: deja su nodo «Loading...» puesto
 * para siempre. En una `bd_sql` eso vacía la única caja donde se contesta.
 *
 * El editor se sustituye por un doble: acá no se prueba Monaco, se prueba qué
 * pasa CUANDO NO ESTÁ.
 */
const estadoMonaco = { estado: "cargando" as EstadoMonaco, lento: false };

// Un editor falso con lo justo para que el runner lea una selección: así se
// puede probar dónde aparece el aviso de «se ejecuta solo lo seleccionado».
const editorFalso = vi.hoisted(() => {
  const estado = { vacia: true, alCambiar: null as null | (() => void) };
  return {
    seleccionar(hay: boolean) {
      estado.vacia = !hay;
      estado.alCambiar?.();
    },
    crear() {
      return {
        onDidChangeCursorSelection: (cb: () => void) => {
          estado.alCambiar = cb;
          return { dispose() {} };
        },
        addCommand: () => null,
        getModel: () => ({ getValueInRange: () => "SELECT 1", getOffsetAt: () => 0 }),
        getSelections: () =>
          estado.vacia ? [] : [{ isEmpty: () => false, startLineNumber: 1, startColumn: 1 }],
      };
    },
  };
});

vi.mock("@monaco-editor/react", async () => {
  const { useEffect } = await import("react");
  return {
    default: (props: { onMount?: (editor: unknown, monaco: unknown) => void }) => {
      useEffect(() => {
        props.onMount?.(editorFalso.crear(), { KeyMod: { CtrlCmd: 0 }, KeyCode: { Enter: 0 } });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <div data-testid="monaco" />;
    },
  };
});

vi.mock("@/modules/code/use-monaco-listo", async () => {
  const real = await vi.importActual<typeof import("@/modules/code/use-monaco-listo")>(
    "@/modules/code/use-monaco-listo",
  );
  return {
    ...real,
    // `decidirModoTexto` se deja REAL: es la regla que se quiere ejercitar.
    useMonacoListo: () => estadoMonaco,
  };
});

// La base: un doble que permite emitir avisos como lo hace PGlite (por el
// callback `onNotice` de `exec`, y solo por ahí).
const { fakeExec } = vi.hoisted(() => ({ fakeExec: vi.fn() }));
vi.mock("@/modules/database/pglite-loader", () => ({
  createEphemeralDb: async () => ({ exec: fakeExec, query: vi.fn(), close: async () => {} }),
}));

const { SqlRunner } = await import("@/modules/database/SqlRunner");

type Props = Parameters<typeof SqlRunner>[0];

/** El proveedor de tooltips lo monta `__root.tsx` para toda la app; acá hay que
 *  reponerlo porque se renderiza el componente suelto. */
const montar = (props: Props) =>
  render(
    <TooltipProvider>
      <SqlRunner {...props} />
    </TooltipProvider>,
  );

beforeEach(() => {
  estadoMonaco.estado = "cargando";
  estadoMonaco.lento = false;
});

describe("SqlRunner sin el editor", () => {
  it("mientras el editor baja se explica la espera y se ofrece salida", () => {
    montar({ value: null, onChange: () => {} });
    expect(screen.getByText("Cargando el editor de SQL…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Escribir sin el editor" })).toBeInTheDocument();
    // Y NO el literal en inglés de la librería, que era lo que se veía.
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("si el editor falla, la caja de texto aparece SOLA", () => {
    // El alumno no tiene que entender qué falló ni buscar un botón: la pregunta
    // se vuelve contestable sin que haga nada.
    estadoMonaco.estado = "error";
    montar({ value: null, onChange: () => {} });
    expect(screen.getByPlaceholderText("Escribe acá tu consulta SQL")).toBeInTheDocument();
    expect(screen.getByText(/No se pudo cargar el editor/)).toBeInTheDocument();
  });

  it("si tarda demasiado, la caja de texto aparece SOLA", () => {
    // El caso real de un salón: el loader no rechaza con red lenta, se queda
    // cargando. Sin el plazo, la espera no termina nunca.
    estadoMonaco.lento = true;
    montar({ value: null, onChange: () => {} });
    expect(screen.getByPlaceholderText("Escribe acá tu consulta SQL")).toBeInTheDocument();
    expect(screen.getByText(/está tardando en cargar/)).toBeInTheDocument();
  });

  it("lo escrito en la caja de texto CUENTA como respuesta", async () => {
    // Lo más importante del respaldo: que no sea un cuaderno aparte. Se guarda
    // con el mismo formato que el editor, así que el aviso de «entregás con N
    // en blanco», el monitor del docente y la IA lo ven igual.
    const user = userEvent.setup();
    const cambios: string[] = [];
    estadoMonaco.estado = "error";
    montar({ value: null, onChange: (v) => cambios.push(v) });

    await user.type(screen.getByPlaceholderText("Escribe acá tu consulta SQL"), "select 1");

    const ultimo = cambios[cambios.length - 1];
    expect(parseSqlAnswer(ultimo)?.sql).toBe("select 1");
    expect(isSqlAnswerBlank(ultimo)).toBe(false);
  });

  it("el alumno puede saltarse la espera sin esperar el plazo", async () => {
    const user = userEvent.setup();
    montar({ value: null, onChange: () => {} });
    await user.click(screen.getByRole("button", { name: "Escribir sin el editor" }));
    expect(screen.getByPlaceholderText("Escribe acá tu consulta SQL")).toBeInTheDocument();
  });

  it("en solo lectura no se ofrece escribir: no hay nada que escribir", () => {
    montar({ value: null, onChange: () => {}, readOnly: true });
    expect(
      screen.queryByRole("button", { name: "Escribir sin el editor" }),
    ).not.toBeInTheDocument();
  });

  it("fuera de una entrega NO se promete una calificacion que no existe", () => {
    // La hoja SQL de la pizarra monta el MISMO runner y ahí no hay entrega ni
    // nota: es una demostración en vivo. Sin este corte, al alumno que mira la
    // pizarra se le prometía que su consulta «se califica leyendo», sobre algo
    // que nadie va a calificar. Por eso `graded` falla cerrado: hay que pedirlo.
    estadoMonaco.estado = "error";
    montar({ value: null, onChange: () => {} });
    expect(screen.getByText(/se guarda igual/)).toBeInTheDocument();
    expect(screen.queryByText(/se califica leyendo la consulta/)).not.toBeInTheDocument();
  });

  it("en un examen o taller SI se dice que se califica leyendo la consulta", () => {
    estadoMonaco.estado = "error";
    montar({ value: null, onChange: () => {}, graded: true });
    expect(screen.getByText(/se califica leyendo la consulta/)).toBeInTheDocument();
  });

  it("en solo lectura no se invita a escribir ni se habla de guardar", () => {
    // La caja es de solo lectura, así que un marcador de posición que diga
    // «escribí acá» es una instrucción imposible de seguir; y como `onSqlChange`
    // ni siquiera corre, no hay nada que guardar de lo que tranquilizar.
    estadoMonaco.estado = "error";
    montar({ value: null, onChange: () => {}, readOnly: true });
    expect(screen.queryByPlaceholderText("Escribe acá tu consulta SQL")).not.toBeInTheDocument();
    expect(screen.getByText("No se pudo cargar el editor.")).toBeInTheDocument();
    expect(screen.queryByText(/se guarda igual/)).not.toBeInTheDocument();
  });

  it("con el editor disponible se usa el editor", () => {
    estadoMonaco.estado = "listo";
    montar({ value: null, onChange: () => {} });
    expect(screen.getByTestId("monaco")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Escribe acá tu consulta SQL")).not.toBeInTheDocument();
  });
});

describe("SqlRunner — lo que imprime la base", () => {
  it("RAISE NOTICE se muestra con su sentencia y se guarda con la respuesta", async () => {
    // PGlite entrega los avisos SOLO por `onNotice`: sin pasarlo, un
    // procedimiento que avisa «Insumo 3 dado de baja» no mostraba nada.
    fakeExec.mockImplementation(
      async (sql: string, opts?: { onNotice?: (n: { severity: string; message: string }) => void }) => {
        if (sql.includes("RAISE NOTICE")) {
          opts?.onNotice?.({ severity: "NOTICE", message: "Insumo 3 dado de baja" });
        }
        return [];
      },
    );
    const user = userEvent.setup();
    const cambios: string[] = [];
    estadoMonaco.estado = "error";
    montar({ value: null, onChange: (v) => cambios.push(v) });

    await user.type(
      screen.getByPlaceholderText("Escribe acá tu consulta SQL"),
      "DO $$ BEGIN RAISE NOTICE 'x'; END $$;",
    );
    await user.click(screen.getByRole("button", { name: /Ejecutar/ }));

    expect(await screen.findByText(/Insumo 3 dado de baja/)).toBeInTheDocument();
    const guardado = parseSqlAnswer(cambios[cambios.length - 1]);
    expect(guardado?.results[0].notices).toEqual(["NOTICE:  Insumo 3 dado de baja"]);
  });

  it("el aviso de la SELECCIÓN aparece debajo del editor, no arriba", async () => {
    // Arriba cambiaba el alto del bloque fijo en cuanto se marcaba texto y
    // corría el editor ~25 px bajo el mouse: un arrastre de punta a punta
    // quedaba en «CR». Es el «copiar y pegar es raro» que se reportó.
    estadoMonaco.estado = "listo";
    montar({ value: JSON.stringify({ bdSql: 1, sql: "SELECT 1;", results: [] }), onChange: () => {} });
    act(() => editorFalso.seleccionar(true));
    const editor = screen.getByTestId("monaco");
    const aviso = await screen.findByText(/Se ejecuta solo lo seleccionado/);
    expect(editor.compareDocumentPosition(aviso) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // El botón dice lo que va a correr.
    expect(screen.getByRole("button", { name: /Ejecutar selecci/ })).toBeInTheDocument();
    act(() => editorFalso.seleccionar(false));
  });

  it("el aviso del costo de la primera corrida también va debajo", () => {
    estadoMonaco.estado = "error";
    montar({ value: null, onChange: () => {} });
    const caja = screen.getByPlaceholderText("Escribe acá tu consulta SQL");
    const aviso = screen.getByText(/La primera ejecución descarga el motor/);
    expect(caja.compareDocumentPosition(aviso) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
