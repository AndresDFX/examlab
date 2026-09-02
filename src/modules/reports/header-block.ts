/**
 * El ENCABEZADO institucional de un informe, en una posición estándar.
 *
 * ── Qué es "la posición estándar" ─────────────────────────────────────────
 * No se inventó: se leyó de los dos formatos institucionales que ya viven en la
 * plataforma (el Acuerdo Pedagógico y el Informe de evaluación, los dos importados
 * de un `.docx` real). Los dos traen la misma estructura, y es la de cualquier
 * formato con membrete:
 *
 *     ┌──────────────┬───────────────────────┬──────────────┐
 *     │    LOGO      │     TÍTULO (centro)   │  código y    │
 *     │  (~26%)      │       (~48%)          │  versión     │
 *     └──────────────┴───────────────────────┴──────────────┘
 *
 * Las otras cuatro plantillas globales no tienen encabezado, y armarlo a mano
 * significaba escribir esa tabla en HTML dentro de un textarea.
 *
 * ── El logo va SIEMPRE dentro de un condicional ───────────────────────────
 * `{{#if institucion.logo}}` no es una cortesía: medido en producción, cuatro de
 * las seis instituciones no tienen logo cargado, y un `<img src="">` pinta el
 * recuadro roto del navegador — en un acta que se imprime y se firma. Con el
 * condicional, esa celda simplemente queda vacía.
 *
 * ── Estilos en línea, a propósito ─────────────────────────────────────────
 * Este HTML va a Word y a la impresión, donde no llega ninguna hoja de estilos de
 * la aplicación. Misma razón —y misma excepción contemplada— que en
 * `signature-block.ts` y `signature-slots.ts`.
 *
 * ── Y el `height` se deja en `auto` ───────────────────────────────────────
 * Es lo correcto para pantalla y PDF, y el exportador a Word ya no se rompe con
 * eso: lee las dimensiones reales de la imagen (`image-size.ts`) en vez de
 * inventar la altura. Antes ese `auto` era la causa de que el Word achatara los
 * logos 2,5 veces.
 */

import { TOPE_ALTO_LOGO } from "./document-css";

export interface OpcionesEncabezado {
  /** Título grande al centro. Vacío ⇒ la celda queda en blanco. */
  titulo?: string;
  /** Línea chica bajo el título (ej. el programa o la dependencia). */
  subtitulo?: string;
  /** Código del formato, arriba a la derecha (ej. "DO-F-021"). */
  codigoFormato?: string;
  /** Versión del formato, bajo el código (ej. "V – 1.0 – 2019"). */
  version?: string;
  /** Imprime el nombre de la institución bajo el logo. */
  mostrarNombre?: boolean;
  /** Imprime la fecha de emisión a la derecha. */
  mostrarFecha?: boolean;
  /** Ancho del logo en px. El alto sale de su proporción real. */
  anchoLogo?: number;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const CELDA = "padding:2px 6px;vertical-align:middle;";

/**
 * Arma el HTML del encabezado. Es una plantilla —lleva `{{variables}}`— así que se
 * inserta en el campo "Encabezado" y se resuelve al generar cada informe.
 */
export function institutionalHeaderHtml(op: OpcionesEncabezado = {}): string {
  const {
    titulo = "",
    subtitulo = "",
    codigoFormato = "",
    version = "",
    mostrarNombre = false,
    mostrarFecha = false,
    // 68 px, no 150: es el ancho que un logo casi cuadrado puede tener sin pasarse
    // del tope de alto. Con 150 el navegador lo achicaba igual por `max-height` y el
    // número del formulario mentía sobre lo que se iba a ver.
    anchoLogo = 68,
  } = op;

  const ancho = Number.isFinite(anchoLogo) && anchoLogo > 0 ? Math.round(anchoLogo) : 68;

  // El `{{#if}}` envuelve al `<img>`, nunca al contrario: sin logo cargado, un
  // `src` vacío pinta el recuadro roto del navegador.
  const izquierda =
    `{{#if institucion.logo}}` +
    `<img src="{{institucion.logo}}" alt="" ` +
    // `max-height` en el estilo, además de la regla del documento: así el HTML es
    // correcto por sí solo, y si alguien lo copia a otra plantilla se lleva el
    // tope puesto. Sin él, en impresión el encabezado tapa las primeras líneas
    // del cuerpo (medido: 3,07 cm de solape con el logo real de FESNA).
    `style="width:${ancho}px;max-width:100%;max-height:${TOPE_ALTO_LOGO};height:auto;" />` +
    `{{/if}}` +
    (mostrarNombre
      ? `<p style="margin:2px 0"><span style="font-size:8pt">{{institucion.nombre}}</span></p>`
      : "");

  const centro =
    (titulo
      ? `<p style="text-align:center;margin:0">` +
        `<span style="font-size:14pt"><strong>${esc(titulo)}</strong></span></p>`
      : "") +
    (subtitulo
      ? `<p style="text-align:center;margin:2px 0">` +
        `<span style="font-size:9pt">${esc(subtitulo)}</span></p>`
      : "");

  const derecha =
    (version
      ? `<p style="text-align:right;margin:0"><span style="font-size:8pt">${esc(version)}</span></p>`
      : "") +
    (codigoFormato
      ? `<p style="text-align:right;margin:0"><span style="font-size:8pt">${esc(codigoFormato)}</span></p>`
      : "") +
    (mostrarFecha
      ? `<p style="text-align:right;margin:0"><span style="font-size:8pt">{{fecha_emision}}</span></p>`
      : "");

  // `&nbsp;` en las celdas que quedan vacías: una celda literalmente vacía la
  // colapsa el navegador y se pierde el borde de la tabla.
  const celda = (ancho: string, contenido: string) =>
    `<td style="${CELDA}width:${ancho};">${contenido || "&nbsp;"}</td>`;

  return (
    `<table style="border-collapse:collapse;width:100%;table-layout:fixed;"><tr>` +
    celda("26%", izquierda) +
    celda("48%", centro) +
    celda("26%", derecha) +
    `</tr></table>`
  );
}
