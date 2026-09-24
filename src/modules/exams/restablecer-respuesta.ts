/**
 * Devolver la caja de respuesta de una pregunta a como estaba al empezar.
 *
 * ── Por qué no es simplemente «borrar» ────────────────────────────────
 * En una pregunta abierta, restablecer es dejarla vacía. En una de CÓDIGO no:
 * ahí la caja no arrancó vacía, arrancó con la **plantilla** del docente —los
 * imports, la clase, el `main`, los comentarios que dicen dónde escribir—. Un
 * «borrar» literal dejaría al estudiante con un editor en blanco y sin el
 * andamiaje que el propio enunciado le daba, obligándolo a reescribir a mano
 * algo que él nunca escribió. Por eso el código vuelve a la plantilla y no a
 * la nada.
 *
 * ── Coherencia con el conteo de respondidas ───────────────────────────
 * Lo que este módulo devuelve es, por construcción, lo que
 * `@/modules/exams/answered` considera NO respondido: la plantilla intacta
 * cuenta como en blanco. Así, restablecer y que la pregunta siga figurando
 * como contestada sería imposible — que es justo el tipo de contradicción que
 * el repo ya pagó cuando la plantilla se guardaba como si fuera la respuesta.
 */
import { defaultStarterFor, type QuestionForAnswered } from "@/modules/exams/answered";

/** Qué pasa al restablecer, para poder decírselo a la persona ANTES. */
export type EfectoDeRestablecer = "plantilla" | "vacio";

const TIPOS_DE_CODIGO = new Set(["codigo", "java_gui", "python_gui"]);

export function efectoDeRestablecer(q: QuestionForAnswered): EfectoDeRestablecer {
  return TIPOS_DE_CODIGO.has(q.type) ? "plantilla" : "vacio";
}

/**
 * El valor al que vuelve la respuesta.
 *
 * `undefined` significa «sin responder», que es como estaba la pregunta antes
 * de que la tocaran: no se escribe una cadena vacía ni un arreglo vacío porque
 * varios tipos guardan estructuras distintas (un índice, un arreglo de
 * índices, un JSON) y un vacío inventado por tipo se vuelve otra lista que
 * mantener sincronizada.
 */
export function respuestaRestablecida(q: QuestionForAnswered): unknown {
  if (!TIPOS_DE_CODIGO.has(q.type)) return undefined;
  const propia = (q.starter_code ?? "").trim();
  if (propia !== "") return q.starter_code;
  const porDefecto = defaultStarterFor(q);
  // Un lenguaje sin plantilla conocida no tiene a qué volver: se vacía, que es
  // exactamente su estado inicial.
  return porDefecto || undefined;
}

/**
 * ¿Tiene sentido ofrecer el botón? Sin nada escrito no hay nada que
 * restablecer, y un botón que no hace nada enseña que la pantalla está muerta.
 */
export function hayAlgoQueRestablecer(q: QuestionForAnswered, valor: unknown): boolean {
  if (valor === undefined || valor === null) return false;
  if (typeof valor === "string") {
    if (valor.trim() === "") return false;
    const destino = respuestaRestablecida(q);
    if (typeof destino === "string" && valor.trim() === destino.trim()) return false;
    return true;
  }
  if (Array.isArray(valor)) return valor.length > 0;
  return true;
}
