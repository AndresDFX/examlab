import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  avisoDeCambioDeEstado,
  partesDeMaterial,
  TIPOS_DE_MATERIAL,
  totalDeMaterial,
  type ImpactoCambioEstado,
} from "./cambio-estado-curso";

const claves = (a: ReturnType<typeof avisoDeCambioDeEstado>) => a?.parrafos.map((p) => p.clave) ?? [];

describe("partesDeMaterial / totalDeMaterial", () => {
  it("enumera solo lo que tiene cantidad, en orden fijo", () => {
    expect(partesDeMaterial({ contenidos: 2, examenes: 1, talleres: 0, encuestas: 3 })).toEqual([
      { tipo: "examenes", n: 1 },
      { tipo: "encuestas", n: 3 },
      { tipo: "contenidos", n: 2 },
    ]);
    expect(totalDeMaterial({ contenidos: 2, examenes: 1, talleres: 0, encuestas: 3 })).toBe(6);
  });

  it("sin conteo no hay partes", () => {
    expect(partesDeMaterial(null)).toEqual([]);
    expect(totalDeMaterial(undefined)).toBe(0);
  });
});

describe("avisoDeCambioDeEstado", () => {
  it("sin cambio no hay aviso; un curso heredado sin estado cuenta como en curso", () => {
    expect(avisoDeCambioDeEstado("borrador", "borrador", null)).toBeNull();
    expect(avisoDeCambioDeEstado(null, "en_curso", null)).toBeNull();
  });

  describe("a borrador", () => {
    const impacto: ImpactoCambioEstado = {
      a_borrador: { examenes: 2, talleres: 3 },
      con_entregas: 4,
      retos_en_vivo: 1,
      compartidos_siguen: 2,
    };

    it("dice cuánto se oculta, qué pasa con las notas, los retos y lo compartido", () => {
      const a = avisoDeCambioDeEstado("en_curso", "borrador", impacto);
      expect(a?.clave).toBe("aBorrador");
      expect(a?.tono).toBe("warning");
      expect(claves(a)).toEqual([
        "cursoEstado.aBorrador.material",
        "cursoEstado.aBorrador.conEntregas",
        "cursoEstado.aBorrador.retos",
        "cursoEstado.aBorrador.compartidos",
        "cursoEstado.aBorrador.regla",
      ]);
      expect(a?.parrafos[0].material).toEqual({ examenes: 2, talleres: 3 });
      expect(a?.parrafos[1].params).toEqual({ count: 4 });
    });

    it("sin material publicado lo dice, y la regla va siempre", () => {
      const a = avisoDeCambioDeEstado("en_curso", "borrador", { a_borrador: {} });
      expect(claves(a)).toEqual(["cursoEstado.aBorrador.nada", "cursoEstado.aBorrador.regla"]);
    });

    it("sin datos del impacto, el aviso se arma igual sin números", () => {
      const a = avisoDeCambioDeEstado("finalizado", "borrador", null);
      expect(claves(a)).toEqual(["cursoEstado.aBorrador.sinDatos", "cursoEstado.aBorrador.regla"]);
    });
  });

  describe("activar", () => {
    it("desde borrador: bienvenida a los matriculados y lo que sigue en borrador", () => {
      const a = avisoDeCambioDeEstado("borrador", "en_curso", {
        matriculados: 19,
        bienvenida: true,
        en_borrador: { talleres: 5 },
      });
      expect(a?.clave).toBe("activar");
      expect(a?.tono).toBe("default");
      expect(claves(a)).toEqual([
        "cursoEstado.activar.visible",
        "cursoEstado.activar.bienvenida",
        "cursoEstado.activar.siguenEnBorrador",
      ]);
      expect(a?.parrafos[1].params).toEqual({ count: 19 });
    });

    it("con la bienvenida apagada dice que no sale", () => {
      const a = avisoDeCambioDeEstado("borrador", "en_curso", { matriculados: 3, bienvenida: false });
      expect(claves(a)).toEqual(["cursoEstado.activar.visible", "cursoEstado.activar.sinBienvenida"]);
    });

    it("sin matriculados no habla de bienvenida", () => {
      const a = avisoDeCambioDeEstado("borrador", "en_curso", { matriculados: 0, bienvenida: true });
      expect(claves(a)).toEqual(["cursoEstado.activar.visible"]);
    });
  });

  describe("reabrir", () => {
    it("recuerda la finalización automática y que lo cerrado sigue cerrado", () => {
      const a = avisoDeCambioDeEstado("finalizado", "en_curso", { cerrados: { examenes: 2 } });
      expect(a?.clave).toBe("reabrir");
      expect(claves(a)).toEqual(["course.actionReopenConfirmBody", "cursoEstado.reabrir.cerrados"]);
    });
  });

  describe("finalizar", () => {
    it("dice qué se cierra y que reabrir no lo reabre", () => {
      const a = avisoDeCambioDeEstado("en_curso", "finalizado", {
        pendientes_calificar: 0,
        a_cerrar: { examenes: 1, pizarras: 2 },
      });
      expect(a?.tono).toBe("warning");
      expect(a?.bloqueo).toBeUndefined();
      expect(claves(a)).toEqual(["course.actionFinalizeConfirmBody", "cursoEstado.finalizar.cierra"]);
    });

    it("con entregas sin calificar queda bloqueado, con el conteo", () => {
      const a = avisoDeCambioDeEstado("en_curso", "finalizado", { pendientes_calificar: 3 });
      expect(a?.bloqueo).toEqual({ clave: "cursoEstado.finalizar.pendientes", params: { count: 3 } });
    });

    it("desde borrador también es finalizar", () => {
      expect(avisoDeCambioDeEstado("borrador", "finalizado", null)?.clave).toBe("finalizar");
    });
  });
});

// ── Las claves que el aviso arma en tiempo de ejecución existen ──────────
// `claves-usadas.test.ts` no ve las claves dinámicas (`cursoEstado.${clave}.titulo`,
// `cursoEstado.material.${tipo}`, las de cada párrafo), así que una clave mal
// escrita acá saldría como texto crudo en el diálogo sin que nada falle.
describe("claves de traducción del aviso", () => {
  const locales = {
    es: JSON.parse(fs.readFileSync("src/i18n/locales/es.json", "utf8")) as Record<string, unknown>,
    en: JSON.parse(fs.readFileSync("src/i18n/locales/en.json", "utf8")) as Record<string, unknown>,
  };
  const leer = (obj: Record<string, unknown>, ruta: string): unknown =>
    ruta.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
  // Con `count`, i18next busca `_one` / `_other`.
  const existe = (obj: Record<string, unknown>, ruta: string, plural: boolean) =>
    plural
      ? typeof leer(obj, `${ruta}_one`) === "string" && typeof leer(obj, `${ruta}_other`) === "string"
      : typeof leer(obj, ruta) === "string";

  const lleno: ImpactoCambioEstado = {
    estado_actual: "en_curso",
    matriculados: 3,
    a_borrador: { examenes: 1, talleres: 1, proyectos: 1, encuestas: 1, pizarras: 1, contenidos: 1 },
    con_entregas: 2,
    retos_en_vivo: 1,
    compartidos_siguen: 1,
    pendientes_calificar: 1,
    a_cerrar: { examenes: 1 },
    bienvenida: true,
    en_borrador: { talleres: 1 },
    cerrados: { examenes: 1 },
  };
  const transiciones: [string | null, "borrador" | "en_curso" | "finalizado", ImpactoCambioEstado | null][] = [
    ["en_curso", "borrador", lleno],
    ["en_curso", "borrador", { a_borrador: {} }],
    ["en_curso", "borrador", null],
    ["borrador", "en_curso", lleno],
    ["borrador", "en_curso", { ...lleno, bienvenida: false }],
    ["finalizado", "en_curso", lleno],
    ["en_curso", "finalizado", lleno],
  ];

  it.each(Object.keys(locales))("todas existen en %s", (idioma) => {
    const obj = locales[idioma as keyof typeof locales];
    const faltan: string[] = [];
    for (const [desde, hasta, impacto] of transiciones) {
      const aviso = avisoDeCambioDeEstado(desde, hasta, impacto)!;
      for (const ruta of [`cursoEstado.${aviso.clave}.titulo`, `cursoEstado.${aviso.clave}.confirmar`]) {
        if (!existe(obj, ruta, false)) faltan.push(ruta);
      }
      for (const p of [...aviso.parrafos, ...(aviso.bloqueo ? [aviso.bloqueo] : [])]) {
        if (!existe(obj, p.clave, p.params?.count !== undefined)) faltan.push(p.clave);
      }
    }
    for (const tipo of TIPOS_DE_MATERIAL) {
      if (!existe(obj, `cursoEstado.material.${tipo}`, true)) faltan.push(`cursoEstado.material.${tipo}`);
    }
    expect(faltan).toEqual([]);
  });
});

// ── Los nombres de los conteos son los que devuelve la base ──────────────
// Si `impacto_cambio_estado_curso` renombra una clave, el diálogo sale sin
// números y nada falla. Se lee la ÚLTIMA migración que define la función.
describe("claves del impacto en la migración", () => {
  it("cada conteo que lee el aviso lo arma impacto_cambio_estado_curso", () => {
    const dir = "supabase/migrations";
    const archivo = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .reverse()
      .find((f) =>
        fs.readFileSync(path.join(dir, f), "utf8").includes("FUNCTION public.impacto_cambio_estado_curso"),
      );
    expect(archivo, "ninguna migración define impacto_cambio_estado_curso").toBeTruthy();
    const sql = fs.readFileSync(path.join(dir, archivo!), "utf8");
    const claves: (keyof ImpactoCambioEstado)[] = [
      "estado_actual",
      "matriculados",
      "a_borrador",
      "con_entregas",
      "retos_en_vivo",
      "compartidos_siguen",
      "pendientes_calificar",
      "a_cerrar",
      "bienvenida",
      "en_borrador",
      "cerrados",
    ];
    const faltan = [...claves, ...TIPOS_DE_MATERIAL].filter((k) => !sql.includes(`'${k}'`));
    expect(faltan).toEqual([]);
  });
});
