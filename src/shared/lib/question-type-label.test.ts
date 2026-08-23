import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  TIPOS_CON_ETIQUETA,
  questionTypeLabel,
  questionTypeLabelKey,
} from "./question-type-label";

/** `t` de mentira: devuelve la clave, así se puede afirmar CUÁL se pidió. */
const t = (clave: string) => clave;

const es = JSON.parse(readFileSync("src/i18n/locales/es.json", "utf8"));
const en = JSON.parse(readFileSync("src/i18n/locales/en.json", "utf8"));

function valor(dict: Record<string, unknown>, clave: string): unknown {
  return clave.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], dict);
}

describe("questionTypeLabel", () => {
  it("nunca deja pasar el guion bajo del tipo interno", () => {
    // El bug original: `className="capitalize"` sobre `{q.type}` mostraba
    // «Bd_sql» y «Cerrada_multi», porque por UAX#29 el `_` une palabras y
    // capitalize no lo toca.
    for (const tipo of TIPOS_CON_ETIQUETA) {
      expect(questionTypeLabel(tipo, t)).not.toContain("_");
    }
  });

  it("cada tipo conocido tiene su clave traducida en es Y en en", () => {
    const faltantes: string[] = [];
    for (const tipo of TIPOS_CON_ETIQUETA) {
      const clave = questionTypeLabelKey(tipo)!;
      if (typeof valor(es, clave) !== "string") faltantes.push(`es: ${clave} (${tipo})`);
      if (typeof valor(en, clave) !== "string") faltantes.push(`en: ${clave} (${tipo})`);
    }
    expect(faltantes).toEqual([]);
  });

  it("cerrada y cerrada_multi NO comparten etiqueta", () => {
    // El selector de tipo del taller usaba la misma clave para las dos, así que
    // la lista mostraba «Opción múltiple» repetido y no se podían distinguir.
    const a = valor(es, questionTypeLabelKey("cerrada")!);
    const b = valor(es, questionTypeLabelKey("cerrada_multi")!);
    expect(a).not.toBe(b);
    expect(valor(en, questionTypeLabelKey("cerrada")!)).not.toBe(
      valor(en, questionTypeLabelKey("cerrada_multi")!),
    );
  });

  it("un tipo desconocido cae a algo legible, no a la clave ni al crudo", () => {
    expect(questionTypeLabelKey("tipo_que_no_existe")).toBeNull();
    expect(questionTypeLabel("tipo_que_no_existe", t)).toBe("tipo que no existe");
  });

  it("nulo y vacío dan guion", () => {
    expect(questionTypeLabel(null, t)).toBe("—");
    expect(questionTypeLabel(undefined, t)).toBe("—");
    expect(questionTypeLabel("", t)).toBe("—");
  });

  it("cubre los 12 tipos que acepta el CHECK de workshop_questions", () => {
    // Si el CHECK gana un tipo, este test lo señala: sin etiqueta el alumno
    // volvería a ver el código interno.
    const sql = readFileSync(
      "supabase/migrations/20261600000000_bd_sql_support.sql",
      "utf8",
    );
    const m = /workshop_questions_type_check[\s\S]*?CHECK \(type IN \(([^)]+)\)\)/.exec(sql);
    expect(m).not.toBeNull();
    const delCheck = [...m![1].matchAll(/'([\w]+)'/g)].map((x) => x[1]);
    const sinEtiqueta = delCheck.filter((x) => !TIPOS_CON_ETIQUETA.includes(x));
    expect(sinEtiqueta).toEqual([]);
  });
});
