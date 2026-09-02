/**
 * Estilos que TODO informe necesita para no romperse, en un solo lugar.
 *
 * ── El bug que lo origina ─────────────────────────────────────────────────
 * En el Acuerdo Pedagógico la casilla del correo se veía
 * `kabarona@estudiante.uniajc.e` y el texto se salía del borde de la tabla. No es
 * de esa plantilla: es de cualquier documento importado de Word.
 *
 * Medido sobre el HTML real de la plantilla global: la tabla trae
 * `table-layout:fixed` (lo pone `docx-import.ts` cuando el .docx declara
 * `<w:tblGrid>`, para respetar los anchos exactos del original) y la celda del
 * correo mide `width:20%`. Con ancho fijo, una cadena SIN espacios —un correo, una
 * URL, un documento de identidad largo— no tiene dónde partir, y el navegador la
 * deja desbordar el recuadro. En los 10.259 caracteres de esa plantilla no hay
 * **ni una** aparición de `word-break` u `overflow-wrap`, ni en ninguna otra parte
 * del pipeline de informes.
 *
 * ── Por qué `overflow-wrap: anywhere` y no `word-break: break-all` ────────
 * `break-all` parte CUALQUIER palabra en cuanto llega al borde, así que picaría
 * también el texto normal del documento ("Progra-\nmación"). `anywhere` solo parte
 * cuando la palabra no cabe ni sola en su renglón, que es exactamente el caso del
 * correo y de nada más. En un acta que se imprime y se firma, cortar mal una
 * palabra es peor que el problema que se arregla.
 *
 * ── Una regla, un solo texto ──────────────────────────────────────────────
 * `cssCorteEnCeldas(prefijo)` existe porque la MISMA regla hace falta con dos
 * selectores distintos: pelada en el HTML del documento (que va al PDF y a Word) y
 * prefijada por `.examlab-page` en la vista previa paginada, donde los estilos
 * están scopeados a la hoja. Escribirla dos veces a mano es la forma conocida de
 * que una se actualice y la otra no.
 *
 * ── Y `conEstilosDeDocumento` para lo que YA está guardado ────────────────
 * `generated_reports.html` es un SNAPSHOT inmutable: es lo que se firma y el hash
 * de la firma se calcula sobre él. Reescribir esos snapshots invalidaría las firmas
 * existentes. Así que los informes ya generados NO se tocan: se les inyecta la
 * regla al MOSTRARLOS, igual que `signature-slots.ts` dibuja las firmas sobre el
 * snapshot sin modificarlo.
 */

/** La regla, con el prefijo de selector que necesite cada superficie. */
export function cssCorteEnCeldas(prefijo = ""): string {
  const p = prefijo ? `${prefijo} ` : "";
  return `${p}td, ${p}th { overflow-wrap: anywhere; }`;
}

/** Marca de idempotencia: si ya está inyectado, no se vuelve a poner. */
const MARCA = "data-examlab-doc-css";

/**
 * Inyecta la regla en un HTML ya armado (un snapshot guardado), sin tocar su
 * contenido.
 *
 * El `<style>` va DENTRO del `<head>` cuando el documento lo tiene. Ponerlo antes
 * del `<!doctype html>` deja al navegador en *quirks mode* —el doctype tiene que
 * ser lo primero del archivo— y eso cambia el modelo de caja de las tablas, que es
 * justo lo que estamos tratando de arreglar. Solo cuando el HTML es un fragmento
 * suelto (sin `<head>`) se antepone, que ahí sí es correcto.
 */
export function conEstilosDeDocumento(html: string): string {
  if (!html) return html;
  if (html.includes(MARCA)) return html; // ya inyectado
  const bloque = `<style ${MARCA}="1">${cssCorteEnCeldas()}</style>`;

  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const i = head.index + head[0].length;
    return html.slice(0, i) + bloque + html.slice(i);
  }
  // Sin <head>: si hay <html> (o doctype) el estilo va justo después de la
  // apertura; si no hay nada, es un fragmento y se antepone.
  const abre = /<html\b[^>]*>/i.exec(html);
  if (abre) {
    const i = abre.index + abre[0].length;
    return html.slice(0, i) + `<head>${bloque}</head>` + html.slice(i);
  }
  return bloque + html;
}
