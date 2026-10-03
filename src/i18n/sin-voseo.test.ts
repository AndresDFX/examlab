import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * La interfaz en español es es-CO, o sea TUTEO. El voseo se había colado en
 * cientos de textos («podés», «elegí», «revisá») mezclado con textos en tuteo,
 * así que una misma pantalla le hablaba al usuario de dos maneras.
 *
 * Se buscan las formas que NO existen en tuteo: verbos agudos con tilde en
 * -ás/-és/-ís del presente que en tuteo serían llanos, e imperativos agudos.
 * Los futuros («podrás», «verá») y «está/estás» no entran: sí son tuteo.
 */
const VOSEO =
  /(?<![\p{L}])(podés|tenés|querés|sabés|necesitás|elegís|volvés|preferís|pedís|ponés|dejás|usás|elegí|eligí|escribí|revisá|volvé|probá|pegá|creá|usá|subí|abrí|definí|intentá|esperá|seleccioná|recargá|activá|agregá|contactá|recordá|poné|mirá|fijate|asegurate|vos)(?![\p{L}])/iu;

function textos(obj: unknown, ruta = ""): Array<[string, string]> {
  if (typeof obj === "string") return [[ruta, obj]];
  if (obj && typeof obj === "object")
    return Object.entries(obj).flatMap(([k, v]) => textos(v, ruta ? `${ruta}.${k}` : k));
  return [];
}

describe("es.json habla en tuteo", () => {
  it("ningún texto usa formas del voseo", () => {
    const es = JSON.parse(readFileSync("src/i18n/locales/es.json", "utf8"));
    const conVoseo = textos(es)
      .filter(([, v]) => VOSEO.test(v))
      .map(([k, v]) => `${k}: ${v.slice(0, 80)}`);
    expect(conVoseo).toEqual([]);
  });
});
