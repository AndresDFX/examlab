import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TUTOR_CHAT_FALLBACK } from "./tutor-default-prompt";
import { SQL_GENERATION_FALLBACK } from "@/modules/database/sql-generation-prompt";

/**
 * Estos dos prompts están bajo un invariante de 3 lados (seed SQL ↔ copia Deno del
 * edge ↔ constante de `src/`) que CLAUDE.md documenta como "deben ser
 * byte-idénticos". Hasta ahora la sincronía dependía de que alguien se acordara:
 * nada fallaba si divergían, y el síntoma —"Restaurar default" del panel entrega un
 * prompt distinto del que la IA usa en producción— es invisible hasta que alguien
 * los compara a mano.
 *
 * Este test lo vuelve detectable: lee los otros dos lados del disco, así que editar
 * uno solo rompe el build y dice cuál quedó desalineado.
 *
 * Dos trampas que encontré al escribirlo, y por eso la extracción es por índices y
 * no por expresiones regulares:
 *   1. La copia de Deno vive en un template literal, así que los backticks y `${`
 *      van con barra invertida; el seed usa dollar-quoting de Postgres y NO los
 *      escapa. Sin normalizar, esa diferencia de escape se lee como divergencia
 *      real — me pasó al auditarlo y estuve a punto de reportar un bug inexistente.
 *   2. Construir el patrón dentro de un template literal colapsa `\s` a `s` y `\$`
 *      a `$`, así que el regex salía roto en silencio.
 */

/** Quita el escape que exige un template literal de TS. */
const unescapeTemplateLiteral = (s: string) =>
  s.split("\\`").join("`").split("\\${").join("${").trim();

/** Contenido entre dos delimitadores `$tag$` de dollar-quoting de Postgres. */
function readDollarQuoted(file: string, tag: string): string {
  // CRLF → LF: en Windows los archivos del repo están en CRLF, y sin normalizar
  // los 3 lados difieren en la PRIMERA línea aunque el texto sea idéntico — el
  // diff se ve igual y el fallo parece inexplicable.
  const src = readFileSync(file, "utf8").split("\r\n").join("\n");
  const delim = `$${tag}$`;
  const start = src.indexOf(delim);
  const end = src.indexOf(delim, start + delim.length);
  if (start === -1 || end === -1) throw new Error(`No encontré ${delim} en ${file}`);
  return src.slice(start + delim.length, end).trim();
}

/** Contenido del template literal asignado a `constName`. */
function readTsTemplate(file: string, constName: string): string {
  // CRLF → LF: en Windows los archivos del repo están en CRLF, y sin normalizar
  // los 3 lados difieren en la PRIMERA línea aunque el texto sea idéntico — el
  // diff se ve igual y el fallo parece inexplicable.
  const src = readFileSync(file, "utf8").split("\r\n").join("\n");
  const at = src.indexOf(constName);
  if (at === -1) throw new Error(`No encontré ${constName} en ${file}`);
  const open = src.indexOf("`", at);
  if (open === -1) throw new Error(`${constName} no usa template literal en ${file}`);
  // Cierre = el primer backtick NO escapado después del de apertura.
  let i = open + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") break;
    i += 1;
  }
  return unescapeTemplateLiteral(src.slice(open + 1, i));
}

describe("prompt del Tutor IA — invariante de 3 lados", () => {
  const seed = readDollarQuoted(
    "supabase/migrations/20260923000000_tutor_chat_seed_prompt.sql",
    "tpl",
  );
  const edge = readTsTemplate("supabase/functions/tutor-chat/index.ts", "FALLBACK_TEMPLATE");

  it("la constante de src coincide con el seed de la migración", () => {
    expect(TUTOR_CHAT_FALLBACK.trim()).toBe(seed);
  });

  it("la constante de src coincide con el fallback del edge Deno", () => {
    expect(TUTOR_CHAT_FALLBACK.trim()).toBe(edge);
  });

  it("conserva los placeholders que sustituye buildTutorSystemPrompt", () => {
    for (const ph of [
      "{{course_name}}",
      "{{course_description}}",
      "{{course_content_topics}}",
      "{{course_content_material}}",
      "{{current_datetime}}",
    ]) {
      expect(TUTOR_CHAT_FALLBACK).toContain(ph);
    }
  });
});

describe("prompt de generación SQL — invariante de 3 lados", () => {
  const seed = readDollarQuoted(
    "supabase/migrations/20261620000000_ai_prompt_sql_generation.sql",
    "prompt",
  );
  const edge = readTsTemplate(
    "supabase/functions/ai-generate-sql/index.ts",
    "FALLBACK_SQL_GENERATION_PROMPT",
  );

  it("la constante de src coincide con el seed y con el edge", () => {
    expect(SQL_GENERATION_FALLBACK.trim()).toBe(seed);
    expect(SQL_GENERATION_FALLBACK.trim()).toBe(edge);
  });
});
