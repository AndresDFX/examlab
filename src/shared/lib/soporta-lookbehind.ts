/**
 * ¿El motor entiende expresiones regulares con lookbehind?
 *
 * remark-gfm (mdast-util-gfm-autolink-literal) arma en CADA render una regex
 * con lookbehind; Safari la soporta desde 16.4. En un iPhone con iOS más viejo
 * (un iPhone 8 o X queda en iOS 16) el render lanza y la pantalla cae en «Algo
 * salió mal»: taller, examen y encuestas. Sin lookbehind se renderiza sin GFM
 * (se pierden tablas y tachado, pero el contenido se lee).
 */
let cache: boolean | undefined;
export function soportaLookbehind(): boolean {
  if (cache === undefined) {
    try {
      new RegExp("(?<=a)b");
      cache = true;
    } catch {
      cache = false;
    }
  }
  return cache;
}
