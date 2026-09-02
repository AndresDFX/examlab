/**
 * Ranuras de FIRMA dentro del documento: la celda "Firma" de cada estudiante
 * pasa de un rectángulo en blanco para lapicera a un lugar donde esa persona
 * —y solo esa— puede firmar, y donde después queda su firma.
 *
 * ── Por qué la firma NO se resuelve al generar el informe ──────────────
 * `generated_reports` guarda un SNAPSHOT de HTML: es lo que se firma, y tiene que
 * ser inmutable (el hash de la firma se calcula sobre él). Pero al generarlo
 * todavía no hay ninguna firma. Si `{{firma}}` fuera una variable normal del
 * contexto, se resolvería en ese momento y quedaría vacía para siempre.
 *
 * Por eso la plantilla emite una RANURA anclada al estudiante, el snapshot la
 * guarda tal cual, y las firmas se pintan al MOSTRAR el documento: en la vista
 * previa del docente, en la descarga, en el enlace público y en la pantalla del
 * estudiante. El snapshot no cambia; cambia lo que se dibuja sobre él.
 *
 * ── El ancla es el user_id ─────────────────────────────────────────────
 * No el nombre ni el correo. El nombre se repite (dos "Juan Pérez" en un curso no
 * es raro) y el correo se puede corregir —de hecho se corrigió uno esta semana—,
 * mientras que `report_signatures.user_id` es la clave real de la solicitud. Un
 * UUID en un atributo no filtra nada que el documento no muestre ya: el documento
 * ES la lista del curso.
 *
 * ── Lo que resuelve el contexto es la RANURA, no la firma ──────────────
 * `ranuraHtml(uid)` existe para que el contexto del informe pueda entregar la
 * ranura YA ANCLADA como un valor (`{{{firmantes.estudiante.ranura}}}`), y así la
 * firma se pueda poner en cualquier lugar del documento —al pie de una carta, en
 * una celda, al lado de un párrafo— y no solo dentro de la tabla de
 * `{{#each estudiantes}}`, que era el único sitio donde `{{user_id}}` resolvía.
 *
 * Eso NO rompe lo de arriba: lo que viaja por el contexto es el recuadro vacío
 * con su ancla, nunca una firma. El snapshot sigue guardando una ranura en blanco
 * y `renderizarRanuras` sigue siendo el único que dibuja. Si alguien "mejora"
 * esto haciendo que el contexto resuelva la FIRMA, el documento firmado queda con
 * el recuadro vacío para siempre, porque al generar todavía no hay firmas.
 *
 * ── Cuatro estados, y el tercero es el que hace que esto sirva ─────────
 *   firmada   → se dibuja la firma (nombre, fecha y código de verificación).
 *   pendiente → recuadro en blanco. Es lo que hace que el papel siga sirviendo:
 *               un documento sin firmar se imprime y se firma a mano igual que
 *               antes.
 *   firmable  → SOLO en la fila de quien está mirando: un botón para firmar ahí
 *               mismo. Sin esto el estudiante tiene que buscar un botón al final
 *               de un documento de tres páginas y confiar en que corresponde a su
 *               renglón.
 *   sin ancla → un renglón para firmar a mano. Es el caso de una ranura que quedó
 *               sin `data-firma-uid` (una plantilla que puso la firma donde el
 *               ancla no resolvía). NUNCA el botón: ofrecer "firmar aquí" sobre
 *               una ranura que la base no puede registrar es prometer algo que
 *               falla al hacer clic.
 *
 * ── Estilos en línea, a propósito ─────────────────────────────────────
 * Este HTML va a Word y a la impresión, donde no llega ninguna hoja de estilos de
 * la aplicación. Es la misma razón por la que `signature-block.ts` los usa, y la
 * excepción está contemplada: la regla de no usar estilos en línea es para los
 * componentes de React, no para el HTML de un documento generado.
 */

import { formatDateTime } from "@/shared/lib/format";

/** Clase de la ranura. Se usa para encontrarla y para darle estilo al imprimir. */
export const CLASE_RANURA = "examlab-firma";
/**
 * Clase del renglón para firmar A MANO. NO es una ranura: no se registra ninguna
 * firma sobre él.
 *
 * El nombre NO puede contener `examlab-firma`: `tieneRanuras` compara por
 * SUBSTRING, así que un `examlab-firma-manual` haría que un documento sin una
 * sola ranura firmable se ofrezca para "enviar a firmar" — y nadie podría.
 */
export const CLASE_RENGLON = "examlab-renglon";
/** Atributo con el id del firmante al que corresponde la ranura. */
export const ATTR_UID = "data-firma-uid";
/** Marca el botón de firmar, para la delegación de eventos del contenedor. */
export const ATTR_ACCION = "data-firma-accion";

export interface FirmaDeInforme {
  /** `report_signatures.id`. Sale en el código de verificación. */
  id: string;
  /** A quién corresponde. Es el ancla. */
  user_id: string;
  /** Nombre del firmante, para dibujar la firma. */
  nombre?: string | null;
  /** ISO. `null` ⇒ pendiente. */
  signed_at?: string | null;
  /**
   * TRAZO de la firma, como PNG en data URL. `null` ⇒ firmó con un clic y la
   * marca es su nombre tipeado.
   */
  dibujo?: string | null;
}

/**
 * ¿Es un trazo de firma aceptable?
 *
 * MISMA regla que el CHECK de la base (`chk_report_signatures_drawing`) y que
 * `_signature_drawing_ok`. Se repite acá porque este módulo también renderiza
 * datos que NO vienen de esa columna —el arnés de pruebas, y cualquier futuro
 * llamador que arme el objeto a mano— y un `<img src>` con un valor arbitrario es
 * justo lo que no se quiere inyectar en un documento.
 *
 * Solo `image/png`: un SVG puede traer un `<script>`. Y el patrón no admite `"`
 * ni `<`, así que el valor no puede romper el atributo aunque alguien se olvide
 * de escaparlo.
 */
export function dibujoValido(d: string | null | undefined): boolean {
  if (typeof d !== "string" || d === "") return false;
  if (d.length > 120000) return false;
  return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(d);
}

/**
 * Fragmento que la PLANTILLA emite en la celda de firma.
 *
 * Va con `{{user_id}}` sin resolver: lo resuelve el motor dentro de
 * `{{#each estudiantes}}`, y como el motor escapa por defecto, el UUID entra
 * escapado sin que este módulo tenga que hacer nada.
 *
 * El `min-height` no es decorativo: sin él la celda se colapsa al alto del texto
 * y no queda espacio material donde firmar a mano.
 */
export function ranuraPlantillaHtml(): string {
  return (
    `<span class="${CLASE_RANURA}" ${ATTR_UID}="{{user_id}}"` +
    ' style="display:block;min-height:30px;">&nbsp;</span>'
  );
}

/**
 * La misma ranura pero YA ANCLADA a una persona. Es lo que el contexto del
 * informe entrega como valor (`{{{firmantes.estudiante.ranura}}}`), para que la
 * firma se pueda poner en cualquier lugar del documento y no solo donde
 * `{{user_id}}` resolvía.
 *
 * SIN ancla devuelve el renglón para firmar a mano, nunca una ranura vacía: una
 * ranura sin `data-firma-uid` se ve idéntica a un recuadro para firmar pero no se
 * puede firmar NUNCA —el motor de plantillas vacía en silencio los paths que no
 * resuelven, así que ese caso no llega como error— y quedaría en el documento
 * como una promesa que no se puede cumplir.
 */
export function ranuraHtml(uid: string | null | undefined): string {
  const anclada = typeof uid === "string" ? uid.trim() : "";
  if (!anclada) return renglonManualHtml();
  return (
    `<span class="${CLASE_RANURA}" ${ATTR_UID}="${esc(anclada)}"` +
    ' style="display:block;min-height:30px;">&nbsp;</span>'
  );
}

/**
 * Renglón para firmar A MANO: la línea de toda la vida.
 *
 * Sirve para los firmantes que la plataforma NO puede registrar: alguien que no
 * pertenece al curso —un coordinador, un acudiente, el "Director" del Acuerdo
 * Pedagógico— y el vocero de un curso que todavía no marcó ninguno. Anclarles una
 * ranura produciría un recuadro imposible de firmar, porque
 * `request_report_signatures` solo acepta a quien esté matriculado en el curso o
 * lo dicte. Con el renglón, el documento se imprime y se firma como siempre, y
 * queda claro cuál firma es digital y cuál a mano.
 *
 * El DOCENTE ya no está en esa lista: desde la migración 20262030000000 puede
 * firmar como cualquier otro firmante del curso, y su ranura se ancla igual
 * (`{{{firmantes.docente.ranura}}}`).
 */
export function renglonManualHtml(): string {
  return (
    `<span class="${CLASE_RENGLON}"` +
    ' style="display:block;min-height:30px;border-bottom:1px solid #444;">&nbsp;</span>'
  );
}

/**
 * Código de verificación de una firma: los primeros 6 caracteres hexadecimales
 * del id, en mayúsculas.
 *
 * Deriva del id en vez de guardarse en una columna nueva porque no aporta
 * seguridad —quien tiene el documento tiene el código—: sirve para que alguien
 * pueda señalar UNA firma concreta al reclamar ("la que dice 3F9A2C"). Como es
 * función del id, el mismo documento reimpreso dos veces muestra el mismo código.
 */
export function codigoVerificacion(idFirma: string): string {
  return (idFirma || "").replace(/-/g, "").slice(0, 6).toUpperCase();
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * La firma puesta: el TRAZO si lo hay, y siempre la fecha y el código debajo.
 *
 * Con trazo, el nombre no se repite arriba —el trazo ya es la firma— pero sí queda
 * en el `alt` de la imagen: es lo que se lee si el correo o el visor no cargan
 * imágenes, y lo que oye un lector de pantalla.
 *
 * Sin trazo se mantiene la marca de antes (nombre en cursiva). Un documento con
 * firmas de las dos clases es válido: quien firma desde un computador sin pantalla
 * táctil firma con un clic.
 *
 * El alto de la imagen se limita a 34px y el ancho al 100%: el PNG viene de un
 * lienzo de 600×200 y sin tope estiraría la fila del listado.
 */
export function firmaHtml(f: FirmaDeInforme): string {
  const nombre = esc((f.nombre ?? "").trim() || "—");
  const fecha = f.signed_at ? esc(formatDateTime(f.signed_at)) : "";
  const codigo = esc(codigoVerificacion(f.id));
  const marca = dibujoValido(f.dibujo)
    ? `<img src="${esc(f.dibujo as string)}" alt="${nombre}"` +
      ' style="display:block;max-width:100%;max-height:34px;height:auto;" />'
    : `<span style="display:block;font-family:Georgia,serif;font-style:italic;font-size:10pt;">${nombre}</span>`;
  return (
    '<span style="display:block;line-height:1.25;">' +
    marca +
    `<span style="display:block;font-size:6.5pt;color:#555;">${fecha}</span>` +
    `<span style="display:block;font-size:6pt;color:#777;letter-spacing:.04em;">${codigo}</span>` +
    "</span>"
  );
}

/** Botón para firmar en el propio renglón. */
function botonFirmarHtml(etiqueta: string): string {
  return (
    `<button type="button" ${ATTR_ACCION}="1"` +
    ' style="display:block;width:100%;min-height:30px;cursor:pointer;' +
    "border:1px dashed #2563eb;border-radius:4px;background:#eff6ff;color:#1d4ed8;" +
    `font-size:8pt;font-weight:600;">${esc(etiqueta)}</button>`
  );
}

export interface OpcionesRender {
  /** Firmas conocidas del informe. Las que no estén quedan pendientes. */
  firmas?: readonly FirmaDeInforme[];
  /**
   * Quién está mirando. Su ranura, si está pendiente, se vuelve el botón de
   * firmar. `null`/ausente ⇒ nadie firma desde acá (vista del docente, descarga,
   * impresión).
   */
  firmanteId?: string | null;
  /** Etiqueta del botón. La pasa la pantalla ya traducida. */
  etiquetaFirmar?: string;
}

/**
 * Encuentra dónde cierra el `<span>` que abre en `desdeApertura`, contando la
 * anidación.
 *
 * Hace falta un escáner y no alcanza una expresión regular: una vez que la ranura
 * tiene una firma dibujada adentro, su contenido son tres `<span>` anidados, y un
 * `([\s\S]*?)</span>` no codicioso cierra en el PRIMER `</span>` —el interno— y
 * deja el resto afuera. El síntoma es que re-renderizar duplica la fecha y el
 * código; lo encontró el test de idempotencia, no la lectura.
 *
 * Devuelve el índice donde empieza el `</span>` de cierre, o -1 si no cierra.
 */
function finDelSpan(html: string, desdeApertura: number): number {
  const re = /<span\b|<\/span>/gi;
  re.lastIndex = desdeApertura;
  let nivel = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[0].toLowerCase() === "</span>") {
      nivel -= 1;
      if (nivel === 0) return m.index;
    } else {
      nivel += 1;
    }
  }
  return -1;
}

/**
 * Pinta las firmas sobre el HTML del snapshot.
 *
 * No usa el DOM a propósito: esto también corre al armar la descarga de Word y el
 * HTML de impresión, donde no hay documento. Y lo que recorre no es HTML
 * arbitrario sino una marca que emite este mismo módulo.
 *
 * Es idempotente: reemplaza el contenido COMPLETO de la ranura cada vez, así que
 * aplicarlo dos veces da el mismo resultado. Importa porque la vista del
 * estudiante lo re-ejecuta al firmar, sobre el mismo HTML.
 */
export function renderizarRanuras(html: string, op: OpcionesRender = {}): string {
  const { firmas = [], firmanteId = null, etiquetaFirmar = "Firmar aquí" } = op;
  if (!html) return html;
  const porUsuario = new Map<string, FirmaDeInforme>();
  for (const f of firmas) if (f.user_id) porUsuario.set(f.user_id, f);

  // La etiqueta de apertura se repone INTACTA: el snapshot es inmutable —el hash
  // de la firma se calcula sobre él— así que renderizar no puede reescribirlo.
  //
  // Se recorren TODAS las etiquetas `<span>` y se decide adentro si son una
  // ranura, en vez de exigir en el propio patrón que `class` venga ANTES de
  // `data-firma-uid`. Con el patrón acoplado al orden, una ranura que emitiera los
  // atributos al revés —o que pasara por un editor que los normaliza— dejaba de
  // reconocerse y el documento se volvía no firmable sin un solo error.
  const reApertura = /<span\b[^>]*>/gi;
  const reClaseRanura = new RegExp(`class\\s*=\\s*"[^"]*\\b${CLASE_RANURA}\\b[^"]*"`, "i");
  const reUid = new RegExp(`${ATTR_UID}\\s*=\\s*"([^"]*)"`, "i");

  let salida = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = reApertura.exec(html)) !== null) {
    const apertura = m[0];
    if (!reClaseRanura.test(apertura)) continue;
    const mUid = reUid.exec(apertura);
    if (!mUid) continue;
    const uid = mUid[1].trim();
    const finContenido = finDelSpan(html, m.index);
    // Ranura sin cierre: se deja tal cual en vez de tragarse el resto del
    // documento. Un HTML roto no debería borrar el acuerdo.
    if (finContenido < 0) continue;

    const f = uid ? porUsuario.get(uid) : undefined;
    const dentro = !uid
      ? // Sin ancla: NO es de nadie, así que no se puede firmar nunca. Se dibuja
        // el renglón para firmar a mano para que el documento siga sirviendo, y
        // NUNCA el botón (fallaría al hacer clic). La apertura igual se repone
        // intacta: el snapshot no se toca.
        renglonManualHtml()
      : f?.signed_at
        ? firmaHtml(f)
        : firmanteId && uid === firmanteId
          ? botonFirmarHtml(etiquetaFirmar)
          : // Pendiente y no es quien mira: en blanco, para que el papel siga sirviendo.
            "&nbsp;";

    salida += html.slice(cursor, m.index) + apertura + dentro;
    cursor = finContenido;
    // El cursor de la búsqueda salta el contenido viejo: si no, una firma ya
    // dibujada adentro volvería a matchear como si fuera otra ranura.
    reApertura.lastIndex = finContenido;
  }
  return salida + html.slice(cursor);
}

/** true si el HTML del snapshot trae ranuras (o sea, se puede firmar dentro). */
export function tieneRanuras(html: string | null | undefined): boolean {
  if (!html) return false;
  return new RegExp(`class="[^"]*${CLASE_RANURA}[^"]*"`).test(html);
}

/**
 * Los `user_id` que el documento REALMENTE ancla, en orden de aparición y sin
 * repetir.
 *
 * ── Para qué ──────────────────────────────────────────────────────────────
 * El documento es la fuente de verdad de quién firma. Reconstruir la lista de
 * firmantes desde `course_enrollments` da la respuesta equivocada en dos casos que
 * ya existen:
 *
 *   - Un informe de curso del que el docente EXCLUYÓ estudiantes: el documento
 *     lista 19 y dice "Total: 19", pero la matrícula sigue teniendo 21. Ofrecerles
 *     la firma —y peor, marcarlos con el botón de selección masiva— les manda a
 *     firmar un documento en el que no aparecen.
 *   - Un informe POR ESTUDIANTE con la ranura del docente: el docente no está
 *     matriculado, así que la lista de matriculados no lo incluye y su casilla
 *     queda imposible de firmar para siempre.
 *
 * ── Una ranura sin ancla no devuelve nada ─────────────────────────────────
 * `data-firma-uid=""` es el renglón para firmar A MANO (el "Director" del Acuerdo,
 * o el vocero de un curso que no marcó ninguno). No hay a quién pedírsela, así que
 * se omite en vez de devolver una cadena vacía que el caller tendría que filtrar.
 */
export function uidsDeRanuras(html: string | null | undefined): string[] {
  if (!html) return [];
  const re = new RegExp(
    `class="[^"]*${CLASE_RANURA}[^"]*"[^>]*${ATTR_UID}="([^"]*)"|${ATTR_UID}="([^"]*)"[^>]*class="[^"]*${CLASE_RANURA}[^"]*"`,
    "g",
  );
  const vistos = new Set<string>();
  const salida: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const uid = (m[1] ?? m[2] ?? "").trim();
    if (!uid || vistos.has(uid)) continue;
    vistos.add(uid);
    salida.push(uid);
  }
  return salida;
}
