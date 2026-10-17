import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  armadoPorElDocente,
  avisarBajoElMinimo,
  cuposLibres,
  esModoGrupal,
  grupoEnLaTarjeta,
  gruposAlGuardar,
  MOTIVOS_GRUPO_CERRADO,
  problemaDeSeleccion,
  topesDeGrupo,
  topesInvalidos,
  type ResumenDeGrupo,
} from "./grupos-estudiante";

const resumen = (extra: Partial<ResumenDeGrupo> = {}): ResumenDeGrupo => ({
  motivo: null,
  modo: "teacher_assigned",
  arman_estudiantes: true,
  externa: false,
  minimo: 2,
  maximo: 4,
  grupo: null,
  individual: null,
  ...extra,
});

describe("qué muestra la tarjeta sobre el grupo", () => {
  it("sin resumen (actividad individual, o la base sin la migración), nada", () => {
    expect(grupoEnLaTarjeta(undefined)).toEqual({ tipo: "nada" });
  });

  it("sin grupo y con la puerta abierta, ofrece armarlo; estricto si el modo lo exige", () => {
    expect(grupoEnLaTarjeta(resumen())).toEqual({
      tipo: "armar",
      estricto: false,
      conBorrador: false,
    });
    expect(grupoEnLaTarjeta(resumen({ modo: "group_required" }))).toMatchObject({ estricto: true });
    expect(grupoEnLaTarjeta(resumen({ individual: { entregada: false } }))).toMatchObject({
      conBorrador: true,
    });
  });

  it("no ofrece armar lo que la base va a rechazar", () => {
    expect(grupoEnLaTarjeta(resumen({ individual: { entregada: true } }))).toEqual({
      tipo: "nada",
    });
    expect(grupoEnLaTarjeta(resumen({ motivo: "los_arma_el_docente" }))).toEqual({ tipo: "nada" });
    expect(grupoEnLaTarjeta(resumen({ motivo: "plazo_vencido" }))).toEqual({ tipo: "nada" });
  });

  it("con grupo lo muestra siempre, aunque ya no se pueda cambiar", () => {
    const g = { id: "g", nombre: "Los A", integrantes: 3, entregado: false };
    expect(grupoEnLaTarjeta(resumen({ grupo: g }))).toMatchObject({
      tipo: "con_grupo",
      puedeCambiar: true,
      bajoElMinimo: false,
    });
    // Grupo armado por el docente: se ve, pero no se cambia desde acá.
    expect(
      grupoEnLaTarjeta(
        resumen({ grupo: g, motivo: "los_arma_el_docente", arman_estudiantes: false }),
      ),
    ).toMatchObject({ tipo: "con_grupo", puedeCambiar: false });
  });

  it("avisa cuando el grupo quedó por debajo del mínimo, solo si todavía puede arreglarse", () => {
    const g = { id: "g", nombre: "Solo", integrantes: 1, entregado: false };
    expect(grupoEnLaTarjeta(resumen({ grupo: g }))).toMatchObject({
      bajoElMinimo: true,
      minimo: 2,
    });
    expect(grupoEnLaTarjeta(resumen({ grupo: g, motivo: "plazo_vencido" }))).toMatchObject({
      bajoElMinimo: false,
    });
  });

  it("no le dice que le falta gente a quien el DOCENTE dejó en un grupo de una persona", () => {
    const g = { id: "g", nombre: "Pedro", integrantes: 1, entregado: false, armado_por_docente: true };
    expect(grupoEnLaTarjeta(resumen({ modo: "group_required", grupo: g }))).toMatchObject({
      tipo: "con_grupo",
      bajoElMinimo: false,
      // Igual puede sumar compañeros desde «Gestionar», si los encuentra.
      puedeCambiar: true,
    });
  });
});

describe("quién armó el grupo", () => {
  it("la RPC del estudiante guarda quién lo creó; la ventana del docente no", () => {
    expect(armadoPorElDocente({ created_by: null })).toBe(true);
    expect(armadoPorElDocente({})).toBe(true);
    expect(armadoPorElDocente({ created_by: "estudiante" })).toBe(false);
  });

  it("el aviso de mínimo es solo para los grupos de los estudiantes, abiertos y cortos", () => {
    const base = { abierto: true, integrantes: 1, minimo: 2, armadoPorElDocente: false };
    expect(avisarBajoElMinimo(base)).toBe(true);
    expect(avisarBajoElMinimo({ ...base, armadoPorElDocente: true })).toBe(false);
    expect(avisarBajoElMinimo({ ...base, abierto: false })).toBe(false);
    expect(avisarBajoElMinimo({ ...base, integrantes: 2 })).toBe(false);
  });
});

describe("las ventanas «Grupos» del docente no llenan created_by", () => {
  // `armadoPorElDocente` se apoya en que SOLO la RPC del estudiante guarda quién
  // creó el grupo. Si una pantalla del docente empezara a mandarlo, sus grupos
  // de una persona volverían a mostrarle al estudiante que le falta gente.
  const archivos = [
    "src/modules/projects/ProjectGroupsEditor.tsx",
    "src/modules/workshops/WorkshopGroupsEditor.tsx",
    "src/modules/workshops/GruposDesdeImagenDialog.tsx",
  ];
  for (const archivo of archivos) {
    it(archivo, () => {
      const fuente = readFileSync(resolve(process.cwd(), archivo), "utf8");
      expect(fuente).not.toMatch(/created_by\s*:/);
    });
  }
});

describe("selección de compañeros", () => {
  it("crear: entre el mínimo y el máximo, contando a quien lo crea", () => {
    const base = { modo: "crear" as const, minimo: 3, maximo: 4, actuales: 1 };
    expect(problemaDeSeleccion({ ...base, elegidos: 0 })).toEqual({ tipo: "faltan", cuantos: 2 });
    expect(problemaDeSeleccion({ ...base, elegidos: 1 })).toEqual({ tipo: "faltan", cuantos: 1 });
    expect(problemaDeSeleccion({ ...base, elegidos: 2 })).toBeNull();
    expect(problemaDeSeleccion({ ...base, elegidos: 3 })).toBeNull();
    expect(problemaDeSeleccion({ ...base, elegidos: 4 })).toEqual({ tipo: "sobran", cuantos: 1 });
  });

  it("agregar: al menos uno y sin pasar el máximo; el mínimo no aplica", () => {
    const base = { modo: "agregar" as const, minimo: 3, maximo: 4, actuales: 1 };
    expect(problemaDeSeleccion({ ...base, elegidos: 0 })).toEqual({ tipo: "vacia" });
    expect(problemaDeSeleccion({ ...base, elegidos: 1 })).toBeNull();
    expect(problemaDeSeleccion({ ...base, actuales: 3, elegidos: 2 })).toEqual({
      tipo: "sobran",
      cuantos: 1,
    });
  });

  it("cupos libres nunca es negativo", () => {
    expect(cuposLibres(5, 2)).toBe(3);
    expect(cuposLibres(3, 5)).toBe(0);
  });
});

describe("formulario del docente", () => {
  it("modos con grupos", () => {
    expect(esModoGrupal("group_required")).toBe(true);
    expect(esModoGrupal("teacher_assigned")).toBe(true);
    expect(esModoGrupal("individual")).toBe(false);
    expect(esModoGrupal("self_signup")).toBe(false);
    expect(esModoGrupal(undefined)).toBe(false);
  });

  it("topes saneados: enteros, mínimo ≥ 1, máximo ≥ mínimo, con los defaults de la base", () => {
    expect(topesDeGrupo(undefined, undefined)).toEqual({ minimo: 2, maximo: 5 });
    expect(topesDeGrupo(0, 3)).toEqual({ minimo: 1, maximo: 3 });
    expect(topesDeGrupo(4, 2)).toEqual({ minimo: 4, maximo: 4 });
    expect(topesDeGrupo(2.7, 5.9)).toEqual({ minimo: 2, maximo: 5 });
    expect(topesDeGrupo(Number.NaN, 999)).toEqual({ minimo: 2, maximo: 50 });
  });

  it("máximo menor que el mínimo se avisa", () => {
    expect(topesInvalidos(4, 3)).toBe(true);
    expect(topesInvalidos(3, 3)).toBe(false);
    expect(topesInvalidos(null, 3)).toBe(false);
  });

  it("la columna nueva solo viaja cuando dice algo (sin chocar con una base sin la migración)", () => {
    // Individual o grupos del docente, en una actividad que nunca la usó: nada.
    expect(gruposAlGuardar({ group_mode: "individual" }, null)).toEqual({});
    expect(
      gruposAlGuardar({ group_mode: "teacher_assigned", students_form_groups: false }, null),
    ).toEqual({});
    // Los arman los estudiantes: la opción y los topes.
    expect(
      gruposAlGuardar(
        {
          group_mode: "group_required",
          students_form_groups: true,
          group_size_min: 3,
          group_size_max: 5,
        },
        null,
      ),
    ).toEqual({ students_form_groups: true, group_size_min: 3, group_size_max: 5 });
    // Apagarla, o pasar a individual, la apaga explícitamente.
    expect(
      gruposAlGuardar(
        { group_mode: "teacher_assigned", students_form_groups: false },
        { students_form_groups: true },
      ),
    ).toEqual({ students_form_groups: false });
    expect(
      gruposAlGuardar(
        { group_mode: "individual", students_form_groups: true },
        { students_form_groups: true },
      ),
    ).toEqual({ students_form_groups: false });
  });
});

describe("invariante con la base", () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      "../../../supabase/migrations/20262830000000_grupos_armados_por_estudiantes.sql",
    ),
    "utf8",
  );

  it("los códigos de motivo son los mismos en la base y en la pantalla", () => {
    const bloque = sql.slice(sql.indexOf("FUNCTION public._grupo_est_motivo_texto"));
    const fin = bloque.indexOf("$fn$;");
    const codigos = [...bloque.slice(0, fin).matchAll(/WHEN '([a-z_]+)' THEN/g)].map((m) => m[1]);
    expect(new Set(codigos)).toEqual(new Set(MOTIVOS_GRUPO_CERRADO));
  });

  it("la situación solo devuelve motivos que la pantalla conoce", () => {
    const bloque = sql.slice(sql.indexOf("FUNCTION public._grupo_est_situacion"));
    const fin = bloque.indexOf("$fn$;");
    const devueltos = new Set(
      [...bloque.slice(0, fin).matchAll(/'([a-z_]+)'/g)]
        .map((m) => m[1])
        .filter((c) => (MOTIVOS_GRUPO_CERRADO as readonly string[]).includes(c)),
    );
    // Todos los motivos salen de ahí, y ninguno de los que salen es desconocido.
    expect(devueltos).toEqual(new Set(MOTIVOS_GRUPO_CERRADO));
    const thens = [...bloque.slice(0, fin).matchAll(/THEN '([a-z_]+)'/g)].map((m) => m[1]);
    for (const c of thens) expect(MOTIVOS_GRUPO_CERRADO).toContain(c);
  });
});
