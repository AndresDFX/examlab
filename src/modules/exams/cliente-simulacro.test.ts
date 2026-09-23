import { describe, expect, it, vi } from "vitest";

import { clienteDeSimulacro, METODOS_QUE_ESCRIBEN, resultadoVacio } from "./cliente-simulacro";

/** Doble del cliente real: registra TODO lo que se le pide, para poder afirmar
 *  que una escritura no llegó. */
function clienteFalso() {
  const llamadas: string[] = [];
  const builder: any = {};
  for (const m of [
    "select", "insert", "update", "upsert", "delete", "eq", "in", "is", "or",
    "order", "limit", "single", "maybeSingle",
  ]) {
    builder[m] = vi.fn((...args: unknown[]) => {
      llamadas.push(`${m}(${args.length})`);
      return builder;
    });
  }
  builder.then = (r: (v: unknown) => unknown) =>
    Promise.resolve({ data: [{ id: "real" }], error: null }).then(r);

  const cliente = {
    from: vi.fn((tabla: string) => {
      llamadas.push(`from(${tabla})`);
      return builder;
    }),
    rpc: vi.fn((nombre: string) => {
      llamadas.push(`rpc(${nombre})`);
      return Promise.resolve({ data: 1, error: null });
    }),
    functions: { invoke: vi.fn(() => Promise.resolve({ data: "salida", error: null })) },
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: { id: "u1" } } })) },
  };
  return { cliente, llamadas, builder };
}

describe("clienteDeSimulacro", () => {
  it("las LECTURAS llegan a la base de verdad", async () => {
    const { cliente, llamadas } = clienteFalso();
    const sim = clienteDeSimulacro(cliente);
    const r = await (sim as any).from("exams").select("*").eq("id", "x");
    expect(llamadas).toContain("from(exams)");
    expect(llamadas).toContain("select(1)");
    // Un simulacro que leyera de otro lado no probaría nada.
    expect(r.data).toEqual([{ id: "real" }]);
  });

  it.each(METODOS_QUE_ESCRIBEN)("%s NO sale a la red", async (metodo) => {
    const { cliente, llamadas } = clienteFalso();
    const sim = clienteDeSimulacro(cliente);
    const r = await (sim as any).from("submissions")[metodo]({ answers: {} }).eq("id", "s1");
    expect(llamadas).not.toContain(`${metodo}(1)`);
    expect(r).toEqual(resultadoVacio());
  });

  it("una escritura devuelve ÉXITO vacío, no un error", async () => {
    // Con un error, la pantalla mostraría «no se pudo guardar» durante todo el
    // simulacro — la impresión exactamente equivocada.
    const { cliente } = clienteFalso();
    const r = await (clienteDeSimulacro(cliente) as any).from("submissions").insert({});
    expect(r.error).toBeNull();
    expect(r.data).toBeNull();
  });

  it("la cadena tras una escritura se puede seguir encadenando", async () => {
    // El caller real hace `.update(...).eq(...).select().maybeSingle()`. Si un
    // eslabón devolviera undefined, el simulacro reventaría con «cannot read
    // properties of undefined» en vez de no hacer nada.
    const { cliente } = clienteFalso();
    const sim = clienteDeSimulacro(cliente) as any;
    const r = await sim
      .from("submissions")
      .update({ a: 1 })
      .eq("id", "s1")
      .select("id")
      .maybeSingle();
    expect(r).toEqual(resultadoVacio());
  });

  it("los RPC no corren: por ahí van el aviso al docente y la cancelación de IA", async () => {
    const { cliente, llamadas } = clienteFalso();
    const sim = clienteDeSimulacro(cliente) as any;
    const r = await sim.rpc("notify_exam_teachers", { _exam_id: "e1" });
    expect(llamadas).not.toContain("rpc(notify_exam_teachers)");
    expect(r).toEqual(resultadoVacio());
  });

  it("ejecutar código SÍ funciona: es lo que el docente viene a probar", async () => {
    const { cliente } = clienteFalso();
    const sim = clienteDeSimulacro(cliente) as any;
    const r = await sim.functions.invoke("execute-code", { body: { sourceCode: "x" } });
    expect(cliente.functions.invoke).toHaveBeenCalledOnce();
    expect(r.data).toBe("salida");
  });

  it("auth queda intacto: la sesión la necesita la pantalla", async () => {
    const { cliente } = clienteFalso();
    const sim = clienteDeSimulacro(cliente) as any;
    const r = await sim.auth.getUser();
    expect(r.data.user.id).toBe("u1");
  });

  it("no rompe una lectura que se encadena largo", async () => {
    const { cliente } = clienteFalso();
    const sim = clienteDeSimulacro(cliente) as any;
    const r = await sim.from("questions").select("*").eq("exam_id", "e").order("position").limit(50);
    expect(r.data).toEqual([{ id: "real" }]);
  });
});
