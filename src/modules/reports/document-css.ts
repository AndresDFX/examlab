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

/**
 * Tope de alto del logo del encabezado, y el alto que el cuerpo le reserva en
 * impresión. Los dos números van JUNTOS: el segundo tiene que ser mayor que el
 * primero más el alto del texto del membrete.
 *
 * ── Por qué existe el tope ────────────────────────────────────────────────
 * En impresión el encabezado va `position:fixed` para repetirse en cada página, y
 * el cuerpo le reserva un alto CONSTANTE con `padding-top`. Mientras el logo
 * resolvía a la cadena vacía eso alcanzaba: el encabezado medía 1,45 cm contra
 * 2,2 cm reservados. Al hacer que el logo se vea de verdad, el `<img>` de
 * `width:173px` con una imagen casi cuadrada pasó a medir 190 px de alto y el
 * encabezado creció a 5,27 cm: **3,07 cm de solape, con las tres primeras
 * cláusulas impresas debajo del logo**.
 *
 * Medido con Chromium en `media: print`, con los logos REALES de las dos
 * instituciones que los tienen cargados (FESNA 205×225, UNIAJ 240×240) y las
 * cuatro plantillas con encabezado. Y no se ve en ningún otro lado: la vista
 * previa no usa `position:fixed` y Word agranda su área de encabezado, así que el
 * defecto aparecía SOLO en el papel ya impreso.
 *
 * ── Por qué `width:auto` y `!important` ───────────────────────────────────
 * `max-height` a secas, con el `width` fijo de la plantilla, achata la imagen. Hay
 * que liberar el ancho para que la proporción se conserve. Y va con `!important`
 * porque las plantillas traen el ancho en un estilo EN LÍNEA, que gana a cualquier
 * hoja de estilos: sin eso la regla no aplica y el solape vuelve.
 */
export const TOPE_ALTO_LOGO = "1.8cm";
/** Lo que el cuerpo reserva arriba en impresión. Debe superar el tope + el texto. */
export const RESERVA_ENCABEZADO = "2.6cm";

/** Acota el logo del encabezado para que no tape el cuerpo al imprimir. */
export function cssTopeLogo(prefijo = ""): string {
  const p = prefijo ? `${prefijo} ` : "";
  return `${p}header img { max-height: ${TOPE_ALTO_LOGO} !important; width: auto !important; }`;
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
