/**
 * Segmentación del texto que el docente PEGA, para el paso «Identificar
 * preguntas desde un texto».
 *
 * ── Por qué existe, y por qué es puro ─────────────────────────────────
 * El texto pegado no tiene formato garantizado. `Pregunta 1 / … / Pregunta 2`
 * es UN caso; también llegan `1.`, `1)`, `a)`, guiones, viñetas, enunciados de
 * varias líneas, encabezados sueltos y líneas en blanco de más. Un
 * `split("\n")` ingenuo parte un enunciado de tres líneas en tres preguntas.
 *
 * Este módulo NO decide el tipo de pregunta (eso lo hace el modelo). Solo:
 *   1. cuenta cuántas preguntas parece haber, para poder decirlo ANTES de
 *      gastar una llamada a la IA;
 *   2. corta el texto en lotes, para que un documento largo no se mande en
 *      una sola llamada gigante;
 *   3. después de clasificar, dice qué bloques del texto original NO
 *      aparecen entre los enunciados devueltos, que es lo único que permite
 *      avisarle al docente «detectamos 10 y la IA clasificó 8» en vez de
 *      dejarlo creer que está completo.
 *
 * Es puro (sin React, sin DOM, sin red) porque es la única parte de este
 * flujo verificable sin gastar cuota del proveedor de IA.
 *
 * ── Qué se duplica en el edge y qué no ────────────────────────────────
 * La SEGMENTACIÓN no: el edge recibe el texto crudo de un lote y lo manda al
 * modelo tal cual, así que si esta heurística cambia el edge sigue igual.
 *
 * Los TOPES sí, y ahí hay invariante cross-file: `MAX_TEXTO_CHARS` y
 * `MAX_ITEMS_POR_LLAMADA` son espejo de `MAX_TEXT_CHARS` / `MAX_ITEMS` de
 * `supabase/functions/_shared/identify-questions.ts`. Si el edge baja su tope y
 * acá no, el diálogo deja pegar texto que el edge rechaza con un 400 y el
 * docente lo cobra recién al pulsar «Identificar». Lo fija
 * `identify-types.test.ts`, que importa las constantes REALES de los dos lados.
 */

/** Tope de caracteres por lote enviado al edge (espejo de `MAX_TEXT_CHARS`). */
export const MAX_TEXTO_CHARS = 20000;

/**
 * Cuántas preguntas se le piden al modelo por llamada (espejo de `MAX_ITEMS`).
 * Iba hardcodeada en el body del diálogo, donde nada la ataba al edge.
 */
export const MAX_ITEMS_POR_LLAMADA = 12;

/** Tope total de texto pegado acumulado, sumando los «Pegar más texto». */
export const MAX_TEXTO_TOTAL_CHARS = 60000;

/** Cuántas preguntas se mandan por llamada al edge. */
export const MAX_PREGUNTAS_POR_LOTE = 8;

/** Tope de filas del borrador. Más que esto no se revisa, se hojea. */
export const MAX_FILAS_BORRADOR = 50;

/** Un segmento más corto que esto es residuo de la marca, no una pregunta. */
const MIN_SEGMENTO_CHARS = 6;

/**
 * Marcas de ALTA confianza al inicio de línea: `Pregunta 3`, `Punto 3`,
 * `Ejercicio 3`, `Question 3`, `3.`, `3)`, `3 -`, `3:`.
 *
 * Son las únicas por las que se corta un LOTE: si el corte estuviera mal, el
 * modelo recibiría media pregunta y la clasificaría mal, y eso es peor que
 * mandar un lote más grande.
 */
const MARCA_ALTA =
  /^\s*(?:(?:pregunta|punto|ejercicio|item|ítem|question)\s*(?:n[.°º]?\s*)?\d+|\d{1,3})\s*(?:[.)\-–:]|$)/i;

/**
 * Marcas de BAJA confianza: viñetas y letras (`a)`, `-`, `•`, `*`).
 *
 * Sirven para CONTAR y para emparejar, no para cortar lotes: `a)` suele ser
 * una OPCIÓN de una pregunta cerrada, no una pregunta nueva. Cortar ahí
 * convertiría cada alternativa en una pregunta suelta.
 */
const MARCA_BAJA = /^\s*(?:[a-hA-H]\s*[.)]|[-–—•*+·])\s+/;

/** Un segmento del texto pegado. */
export interface Segmento {
  /** Enunciado limpio: sin la marca inicial, sin líneas vacías al borde. */
  texto: string;
  /** El bloque tal como venía (marca incluida). Es lo que se manda al edge. */
  crudo: string;
  /**
   * `true` si el corte lo produjo una marca de ALTA confianza. Solo estos
   * cortes se usan como frontera de lote.
   */
  confiable: boolean;
}

/** Un lote listo para enviar al edge. */
export interface Lote {
  /** Texto crudo de los segmentos del lote, en orden, separados por línea en blanco. */
  texto: string;
  /** Índices (sobre el array de segmentos) que componen este lote. */
  indices: number[];
}

/** Normaliza saltos de línea, tabs y espacios invisibles. */
function normalizarTexto(texto: string): string {
  return (
    texto
      .replace(/\r\n?/g, "\n")
      // Espacio duro (U+00A0): llega al pegar desde Word y hace que la marca
      // `1.` no matchee `^\s*` en navegadores viejos.
      .replace(/\u00A0/g, " ")
      // Zero-width, word-joiner y BOM: invisibles, rompen las marcas.
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\t/g, "  ")
      .replace(/[ ]+$/gm, "")
  );
}

/** Quita la marca inicial (`Pregunta 3`, `3.`, `a)`, `-`…) de una línea. */
function quitarMarca(linea: string): string {
  const alta = MARCA_ALTA.exec(linea);
  if (alta) return linea.slice(alta[0].length).trim();
  const baja = MARCA_BAJA.exec(linea);
  if (baja) return linea.slice(baja[0].length).trim();
  return linea.trim();
}

/** Recorta líneas vacías al inicio y al final, preservando las internas. */
function recortarBloque(texto: string): string {
  return texto.replace(/^\n+/, "").replace(/\n+$/, "").trim();
}

/**
 * Enunciado normalizado para COMPARAR (no para mostrar): minúsculas, sin
 * marca inicial, sin acentos, sin puntuación y con los espacios colapsados.
 *
 * Se quitan los acentos y la puntuación porque el modelo devuelve el
 * enunciado REESCRITO (le agrega el signo de apertura «¿», corrige tildes,
 * cierra con «?»), así que una comparación literal no empareja casi nunca y
 * el aviso de reconciliación mentiría diciendo que todo quedó sin clasificar.
 */
export function normalizarEnunciado(s: string): string {
  // Se usa la primera línea que aporte texto. La marca sola en su propia línea
  // («Pregunta 3» y el enunciado abajo) es justo el formato del caso de uso
  // original, así que quedarse con la primera línea a secas devolvería vacío.
  const lineas = String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let primeraLinea = "";
  for (const l of lineas) {
    const limpia = quitarMarca(l);
    if (limpia) {
      primeraLinea = limpia;
      break;
    }
  }
  return quitarMarca(primeraLinea)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[¿?¡!.,;:()[\]{}"'`´–—_*]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parte el texto pegado en segmentos, un segmento por pregunta aparente.
 *
 * Estrategia, en orden:
 *   1. Si hay al menos DOS líneas con marca (alta o baja), se corta en las
 *      marcas. El texto anterior a la primera marca es un encabezado y se
 *      descarta salvo que parezca contenido.
 *   2. Si no hay marcas, se corta por líneas en blanco (bloques de párrafo).
 *   3. Si eso deja un solo bloque, se devuelve el texto completo como un
 *      único segmento y que el modelo lo separe.
 */
export function segmentarPreguntas(textoOriginal: string): Segmento[] {
  const texto = normalizarTexto(String(textoOriginal ?? ""));
  if (!texto.trim()) return [];

  const lineas = texto.split("\n");
  // Las fronteras se construyen SOLO con marcas de ALTA confianza. Meter aca
  // `MARCA_BAJA` —lo que hacia la primera version, contradiciendo su propio
  // comentario— convertia cada alternativa de una pregunta cerrada en un
  // segmento suelto que despues se descartaba por corto: al pegar un parcial
  // de opcion multiple ("1. …?" y debajo "a) IaaS", "b) PaaS"…) las CUATRO
  // opciones desaparecian del texto que se le manda al modelo, y con ellas la
  // unica razon para proponer una `cerrada` con las opciones que el docente ya
  // escribio.
  const altas: number[] = [];
  const bajas: number[] = [];
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    if (!l.trim()) continue;
    if (MARCA_ALTA.test(l)) altas.push(i);
    else if (MARCA_BAJA.test(l)) bajas.push(i);
  }
  // Las marcas BAJAS (`a)`, `-`, `•`) cortan SOLO si no hay ninguna alta.
  //
  // Si el texto trae `1.` o `Pregunta N`, un `a)` es una OPCIÓN de la pregunta
  // anterior, no una pregunta nueva: cortar ahí convertía cada alternativa en un
  // segmento suelto que después se descartaba por corto, y al pegar un parcial de
  // opción múltiple las CUATRO opciones desaparecían del texto que se le manda al
  // modelo. Si NO hay marcas altas, las bajas son la única estructura que el
  // texto ofrece y entonces sí se usan.
  const usandoAltas = altas.length >= 2;
  const marcas = usandoAltas ? altas : bajas;

  if (marcas.length >= 2) {
    const segmentos: Segmento[] = [];
    // Encabezado: lo que va antes de la primera marca. Se descarta solo cuando
    // de verdad parece un encabezado; un «Parcial de Arquitectura — 2026-2» no
    // es una pregunta y ensuciaría la revisión.
    //
    // Las tres razones para CONSERVARLO, y las dos últimas se agregaron porque
    // el descarte estaba borrando contenido del docente:
    //
    //  - Tiene «?» o es largo: parece un enunciado. Es lo que ya había.
    //
    //  - `!usandoAltas`: si no estamos cortando por marcas ALTAS, entonces las
    //    marcas son bajas (`a)`, `-`) y esas son las OPCIONES de una pregunta
    //    cuyo enunciado es justo el preámbulo. Un stem imperativo —«1.
    //    Seleccione el modelo correcto», «Marque la verdadera», o cualquiera
    //    terminado en «:»— no tiene «?» y no llega a 120 caracteres, así que se
    //    descartaba en silencio y al modelo le llegaban CUATRO opciones sin
    //    pregunta. Los stems imperativos son mayoría en los parciales en
    //    español; el rescate por «?» era accidental.
    //
    //  - Empieza con una marca BAJA: una viñeta o una letra de opción nunca es
    //    el encabezado de un parcial, es una opción que el docente pegó
    //    cortada. Se dispara con `usandoAltas === true`, así que no lo cubre la
    //    condición anterior.
    //
    // Invariante que esto sostiene: la unión de los `crudo` contiene todas las
    // líneas del texto pegado.
    const preambulo = recortarBloque(lineas.slice(0, marcas[0]).join("\n"));
    const preambuloEsContenido =
      preambulo.includes("?") ||
      preambulo.length >= 120 ||
      !usandoAltas ||
      MARCA_BAJA.test(preambulo);
    if (preambulo && preambuloEsContenido) {
      segmentos.push({ texto: preambulo, crudo: preambulo, confiable: false });
    }
    for (let m = 0; m < marcas.length; m++) {
      const desde = marcas[m];
      const hasta = m + 1 < marcas.length ? marcas[m + 1] : lineas.length;
      const crudo = recortarBloque(lineas.slice(desde, hasta).join("\n"));
      if (!crudo) continue;
      const propias = crudo.split("\n");
      const limpio = recortarBloque([quitarMarca(propias[0]), ...propias.slice(1)].join("\n"));
      // Un bloque demasiado corto NO se descarta: se anexa al anterior.
      // Tirarlo perdia texto del docente sin avisarle, y lo primero que se
      // pierde es lo mas corto: las opciones de una pregunta cerrada.
      // Invariante: la union de los `crudo` contiene todas las lineas
      // del texto pegado.
      if (limpio.length < MIN_SEGMENTO_CHARS) {
        const previo = segmentos[segmentos.length - 1];
        if (previo) {
          previo.crudo = previo.crudo + "\n" + crudo;
          continue;
        }
      }
      segmentos.push({ texto: limpio, crudo, confiable: usandoAltas });
    }
    if (segmentos.length) return segmentos;
  }

  // Mismo rescate que en la vía de marcas: un bloque corto NO se descarta, se
  // anexa al anterior. Antes esta vía lo filtraba, así que el invariante «la
  // unión de los `crudo` contiene todas las líneas» valía para una vía y no
  // para la otra: con «Explique…» / línea en blanco / «IaaS» / línea en blanco
  // / «Compare…», el bloque «IaaS» desaparecía del texto que se le manda al
  // modelo. El arreglo se había aplicado a una sola de las dos rutas.
  const bloques: string[] = [];
  for (const bruto of texto.split(/\n\s*\n+/)) {
    const b = recortarBloque(bruto);
    if (!b) continue;
    if (b.length < MIN_SEGMENTO_CHARS && bloques.length) {
      bloques[bloques.length - 1] = bloques[bloques.length - 1] + "\n" + b;
      continue;
    }
    bloques.push(b);
  }

  if (bloques.length >= 2) {
    return bloques.map((b) => {
      const propias = b.split("\n");
      return {
        texto: recortarBloque([quitarMarca(propias[0]), ...propias.slice(1)].join("\n")),
        crudo: b,
        confiable: false,
      };
    });
  }

  const completo = recortarBloque(texto);
  if (completo.length < MIN_SEGMENTO_CHARS) return [];
  return [{ texto: completo, crudo: completo, confiable: false }];
}

/**
 * Agrupa segmentos en lotes de a lo sumo `max` preguntas.
 *
 * Solo corta en fronteras CONFIABLES. Si el texto no traía marcas de alta
 * confianza (o traía una sola), devuelve UN lote con todo: es preferible una
 * llamada grande a cortar un enunciado por la mitad.
 *
 * Un lote que por sí solo pasa `MAX_TEXTO_CHARS` se recorta — el edge rechaza
 * cualquier cosa más larga que eso.
 */
export function agruparEnLotes(
  segmentos: Segmento[],
  max: number = MAX_PREGUNTAS_POR_LOTE,
): Lote[] {
  if (!segmentos.length) return [];
  const tope = Math.max(1, Math.floor(max) || MAX_PREGUNTAS_POR_LOTE);

  const unir = (indices: number[]): Lote => ({
    indices,
    texto: indices
      .map((i) => segmentos[i].crudo)
      .join("\n\n")
      .slice(0, MAX_TEXTO_CHARS),
  });

  const confiables = segmentos.filter((s) => s.confiable).length;
  if (confiables < 2) {
    return [unir(segmentos.map((_, i) => i))];
  }

  const lotes: Lote[] = [];
  let actual: number[] = [];
  for (let i = 0; i < segmentos.length; i++) {
    if (segmentos[i].confiable && actual.length >= tope) {
      lotes.push(unir(actual));
      actual = [];
    }
    actual.push(i);
  }
  if (actual.length) lotes.push(unir(actual));
  return lotes;
}

/**
 * Cruza los segmentos detectados con los enunciados que devolvió la IA y
 * dice cuáles quedaron sin clasificar.
 *
 * Compara los primeros 40 caracteres normalizados. No es exacto a propósito:
 * el modelo reescribe el enunciado, así que se busca un prefijo compartido,
 * no igualdad. Un falso «emparejado» solo hace que no se ofrezca agregar un
 * bloque; un falso «huérfano» ofrece agregar algo que ya está, y el docente
 * lo ve y no lo agrega. Los dos errores son visibles y reversibles.
 */
export function emparejarConSegmentos(
  segmentos: Segmento[],
  enunciados: string[],
): { emparejados: number[]; huerfanos: number[] } {
  const CLAVE = 40;
  const claves = enunciados
    .map((e) => normalizarEnunciado(e).slice(0, CLAVE))
    .filter((k) => k.length > 0);
  const emparejados: number[] = [];
  const huerfanos: number[] = [];
  for (let i = 0; i < segmentos.length; i++) {
    const clave = normalizarEnunciado(segmentos[i].texto).slice(0, CLAVE);
    if (!clave) {
      emparejados.push(i);
      continue;
    }
    const hit = claves.some((k) => k.startsWith(clave) || clave.startsWith(k));
    (hit ? emparejados : huerfanos).push(i);
  }
  return { emparejados, huerfanos };
}
