/**
 * Proctoring helpers: warning types, human-readable labels, and the rule that
 * flips a submission into "sospechoso" when the warning count crosses the
 * configured threshold.
 *
 * Two sets of warning keys exist historically:
 *  - Spanish keys emitted by the student take flow ("pestaña", "copiar", ...)
 *  - English keys used by the monitor dialog ("blur", "copy", ...)
 * Both are mapped here so existing submissions render correctly.
 */

export const MAX_WARNINGS = 3;

export type WarningType =
  // Spanish keys (take flow)
  | "pestaña"
  | "copiar"
  | "pegar"
  | "cortar"
  | "menu"
  // Pulsó «atrás» del navegador y confirmó salir del examen. SUMA strike: lo
  // incrementa la propia pantalla de toma al confirmar el diálogo.
  | "retroceso"
  // Pantallazo detectado por atajo de teclado. SUMA strike. Es distinto de
  // `screenshot_attempt` a propósito: ver `TIPOS_QUE_SUMAN_STRIKE`.
  | "pantallazo"
  // English keys (historical / monitor)
  | "blur"
  | "visibility_hidden"
  | "fullscreen_exit"
  | "copy"
  | "paste"
  | "context_menu"
  // Soft signal: intento de pantallazo. NO suma strike — se registra
  // para que el docente lo vea en el monitor de advertencias.
  | "screenshot_attempt"
  // Señal blanda de móvil: la ventana perdió el foco sin que el documento se
  // ocultara. En un teléfono eso lo produce el corrector ortográfico del
  // sistema, así que NO suma strike — se registra para que el docente lo vea.
  | "blur_movil"
  // Señal blanda de ESCRITORIO: la ventana perdió el foco justo después de
  // abrir el menú contextual sobre un campo de respuesta, o sea el menú del
  // corrector ortográfico. NO suma strike — aceptar una sugerencia no puede
  // costar una advertencia.
  | "blur_correccion"
  // Señal blanda de móvil: el documento se ocultó y volvió en menos de la
  // gracia. Ver `ocultarCuentaComoStrike`.
  | "oculto_breve_movil"
  // Señal blanda de móvil: se perdió la pantalla completa. En un teléfono la
  // suelta el propio sistema al abrir sus superficies (teclado, burbuja del
  // corrector), no el estudiante.
  | "fullscreen_exit_movil"
  // La página del examen se cerró o se recargó (a propósito, por error, por un
  // cuelgue o porque se cayó el internet). Por defecto NO suma: volver a entrar
  // ya exige pantalla completa, y el docente ve cuántas veces pasó. Suma solo si
  // el examen lo pide (`reload_counts_as_warning`), y eso lo dice la marca
  // `suma` del evento — por eso la etiqueta no lleva «(no suma)».
  | "salida_de_la_pagina"
  | (string & {});

export interface WarningEvent {
  type: WarningType;
  /** ISO string or epoch ms — take flow writes ISO, older records wrote ms */
  at?: string | number;
  ts?: number;
  /**
   * Posición de la pregunta EN EL ORDEN DEL ALUMNO. Solo se escribía —y se
   * sigue escribiendo— en exámenes secuenciales, y hay un motivo para no
   * extenderla: con `shuffle_enabled` el orden es distinto para cada
   * estudiante, así que «Pregunta 4» en su pantalla es otra pregunta que la 4
   * del docente. Para ubicar el evento está `questionId`.
   */
  questionIdx?: number | null;
  /**
   * En QUÉ pregunta ocurrió. Es lo que el índice no podía ser: estable frente
   * a la mezcla por alumno y frente a que el docente reordene después.
   *
   * Sin esto, un «Intento de pegar» en un examen de navegación libre llegaba
   * al monitor sin ningún lugar — el docente sabía que alguien pegó algo y no
   * dónde, que es justo el dato que decide si fue copiar la respuesta o mover
   * su propio SQL de una línea a otra.
   */
  questionId?: string | null;
  /**
   * ¿Este evento SUMÓ un strike?
   *
   * Lo escribe quien lo registra, y hace falta desde que pegar puede sumar o
   * no SEGÚN la pregunta: el tipo dejó de alcanzar para saberlo. Los eventos
   * viejos no lo traen y se resuelven por tipo (`isStrikeEvent`), que es como
   * se resolvía antes. Ver `eventoSumoStrike`.
   */
  suma?: boolean;
}

/** Human-readable Spanish label for a warning type. */
export function warningLabel(type: WarningType): string {
  switch (type) {
    case "pestaña":
    case "blur":
      return "Salida de pestaña/ventana";
    case "visibility_hidden":
      return "Pestaña oculta";
    case "fullscreen_exit":
      return "Salida de pantalla completa";
    case "copiar":
    case "copy":
      return "Intento de copiar";
    case "pegar":
    case "paste":
      return "Intento de pegar";
    case "cortar":
      return "Intento de cortar";
    case "menu":
    case "context_menu":
      return "Menú contextual";
    case "pantallazo":
      return "Pantallazo";
    case "screenshot_attempt":
      // Los registrados ANTES de que el pantallazo sumara. Se distinguen en la
      // etiqueta porque el docente los ve mezclados en la misma lista.
      return "Intento de pantallazo (no suma)";
    case "retroceso":
      return "Salió con el botón «atrás»";
    case "blur_movil":
      return "Salida momentánea en móvil (no suma)";
    case "blur_correccion":
      return "Corrección ortográfica (no suma)";
    case "oculto_breve_movil":
      return "Pantalla oculta un instante en móvil (no suma)";
    case "fullscreen_exit_movil":
      return "Salida de pantalla completa en móvil (no suma)";
    case "salida_de_la_pagina":
      return "Cerró o recargó el examen";
    default:
      return String(type);
  }
}

/**
 * ¿Este tipo de evento SUMÓ un strike al contador?
 *
 * `__warning_events` mezcla DOS clases de evento y eso no se ve en el array:
 *
 *   · Los que suman strike: `pestaña`, `fullscreen_exit`, `visibility_hidden`,
 *     `pantallazo` y `retroceso`.
 *
 *     Esta lista decía "EXACTAMENTE los tres con los que se llama
 *     `recordWarning`", y esa definición es la que la dejó incompleta:
 *     `retroceso` SUMA pero lo incrementa el botón del diálogo de salida, no
 *     `recordWarning`, así que no cumplía la regla y quedó afuera. Perdonarlo
 *     desde el monitor borraba la fila y dejaba el strike. Lo que define la
 *     lista es si el evento SUMÓ, no por dónde entró.
 *   · Las señales BLANDAS, que se registran solo para que el docente las vea:
 *     `copiar`/`pegar`/`cortar` (por `recordCopyAlert`). El comentario de esas
 *     funciones dice literal "NO suma strike" — antes sumaban y se cambió a
 *     pedido de varios docentes. Se quedan blandas, y con motivo: en una
 *     pregunta de CÓDIGO, copiar y pegar dentro del propio editor es parte de
 *     escribir la respuesta.
 *
 * ── Por qué el pantallazo tiene DOS claves ────────────────────────────
 * `screenshot_attempt` es la histórica y NO sumaba; hay 11 así en producción.
 * El pantallazo pasa a sumar, pero cambiar el significado de la clave vieja
 * habría hecho que perdonar uno de esos 11 DESCUENTE un strike que nunca se
 * sumó —el mismo error que esta allowlist existe para evitar—. Por eso lo
 * nuevo se emite como `pantallazo` y lo viejo se queda como estaba.
 *
 * Sin esta distinción, borrar una advertencia desde el monitor decrementaba el
 * contador para CUALQUIER evento: perdonar un "Intento de copiar" regalaba un
 * strike que nunca existió y, si eso bajaba del umbral, podía DES-SUSPENDER a
 * un alumno.
 *
 * Es una ALLOWLIST y no una denylist, a propósito. Un tipo desconocido —o uno
 * nuevo que alguien agregue mañana— cae a "no suma": el contador no baja y el
 * docente LO VE, y tiene "Limpiar todas" como salida. Con denylist, un tipo
 * blando nuevo caería a "suma" y el perdón de más sería invisible.
 *
 * Las claves históricas en inglés (`blur`, `copy`, `paste`, `context_menu`,
 * `menu`) quedan FUERA aunque alguna pudo haber sumado en su momento: se yerra
 * hacia no-perdonar, porque no perdonar es visible y tiene alternativa,
 * mientras que perdonar de más es invisible y toca el expediente del alumno.
 */
/** Exportado SOLO para que el test lo compare con el espejo en SQL. Para
 *  preguntar por un tipo suelto está `isStrikeEvent`. */
export const TIPOS_QUE_SUMAN_STRIKE: ReadonlySet<string> = new Set<string>([
  "pestaña",
  "fullscreen_exit",
  "visibility_hidden",
  // Salir con el botón «atrás» del navegador. La pantalla de toma incrementa el
  // contador al confirmar ese diálogo, pero fuera de `recordWarning`, así que
  // faltaba acá: perdonarlo desde el monitor borraba el evento y dejaba el
  // strike puesto, sin forma de quitarlo salvo «Limpiar todas». Hay 1 en
  // producción.
  "retroceso",
  // Pantallazo por atajo de teclado. Suma porque nadie pulsa Impr Pant ni
  // Cmd+Shift+4 sin querer en mitad de un examen: es deliberado y unívoco, al
  // revés que copiar o pegar, que en una pregunta de código son parte de
  // responderla.
  "pantallazo",
]);

export function isStrikeEvent(type: string | null | undefined): boolean {
  return !!type && TIPOS_QUE_SUMAN_STRIKE.has(type);
}

/**
 * ¿Este evento CONCRETO sumó un strike?
 *
 * Preferir lo que quedó escrito en el evento y no deducirlo del tipo es lo que
 * permite que un mismo tipo cuente o no según dónde ocurrió. Un evento viejo
 * —sin la marca— se resuelve por tipo, exactamente como antes: la allowlist
 * sigue gobernando el histórico, que es lo que hay en producción.
 */
export function eventoSumoStrike(ev: {
  type?: string | null;
  suma?: boolean;
}): boolean {
  if (typeof ev.suma === "boolean") return ev.suma;
  return isStrikeEvent(ev.type);
}

/**
 * Tipos de pregunta donde COPIAR Y PEGAR es parte de responder.
 *
 * Es la razón entera por la que el portapapeles dejó de sumar: en una pregunta
 * de código, mover una línea de un lado a otro del propio editor es escribir la
 * respuesta, y sumaba strike. Pero la excepción se aplicó a TODOS los exámenes,
 * también a los que no tienen una sola pregunta de código — y ahí pegar en una
 * respuesta abierta es justo lo que el docente quiere ver.
 */
export const TIPOS_DONDE_PEGAR_ES_NORMAL: ReadonlySet<string> = new Set([
  "codigo",
  "codigo_zip",
  "bd_sql",
  "java_gui",
  "python_gui",
  "so_consola",
]);

/**
 * ¿El portapapeles suma strike en ESTA pregunta?
 *
 * Dos condiciones, y las dos tienen que darse:
 *
 *  1. Que el examen lo pida (`cuentaEnEsteExamen`). Es OPT-IN y no negociable:
 *     con el interruptor apagado el comportamiento es byte-idéntico al de hoy.
 *     Encenderlo para todos haría que, el día que la suspensión vuelva a
 *     funcionar, media clase se suspenda por pegar — un cambio enorme y
 *     silencioso sobre siete instituciones.
 *  2. Que la pregunta NO sea de las que tienen editor. Ahí pegar es normal y la
 *     excepción original se mantiene intacta.
 *
 * **Sin saber en qué pregunta fue, NO suma.** Falla cerrado a propósito: una
 * acusación que no se puede ubicar no se puede defender.
 */
export function pegarCuentaComoStrike(
  tipoDePregunta: string | null | undefined,
  cuentaEnEsteExamen: boolean,
): boolean {
  if (!cuentaEnEsteExamen) return false;
  if (!tipoDePregunta) return false;
  return !TIPOS_DONDE_PEGAR_ES_NORMAL.has(tipoDePregunta);
}

/**
 * ¿Hay que SUSPENDER el examen? La pantalla muestra «advertencia N de MAX» y
 * al llegar al tope cierra la entrega sola.
 *
 * Ojo con el nombre, que quedó de antes: esto **ya no marca la entrega como
 * `sospechoso`**. Ese estado quedó reservado para el fraude que la plataforma
 * DETECTA —IA o copia entre entregas—; haberse salido de la pantalla tres
 * veces no es eso, y marcarlo así ponía a media clase bajo una etiqueta
 * acusatoria por algo que muchas veces es el teclado del teléfono, una
 * notificación del sistema o el propio navegador. Una entrega suspendida por
 * advertencias se guarda como `completado`, y cuántas fueron lo dice
 * `focus_warnings` —con el detalle en `__warning_events`—, que es de donde el
 * monitor ya saca la columna de advertencias.
 */
export function shouldMarkSuspicious(warnings: number, max: number = MAX_WARNINGS): boolean {
  return warnings >= max;
}

/**
 * Cuánto vale la advertencia número N cuando se está SIMULANDO.
 *
 * En un examen real el contador nunca pasa del tope porque al alcanzarlo la
 * entrega se suspende. En el simulacro del docente no se suspende —ese es el
 * punto, ver el proctoring sin quedarse sin pantalla—, así que sin tope el
 * contador seguiría subiendo y la barra mostraría «4/3»: un estado que el
 * alumno no puede ver nunca, en una pantalla cuyo objetivo es mostrar lo que
 * él ve.
 */
export function contarAdvertencia(
  actuales: number,
  max: number = MAX_WARNINGS,
  simulacro = false,
): number {
  const siguiente = actuales + 1;
  return simulacro ? Math.min(siguiente, max) : siguiente;
}

/**
 * ¿Hay que CERRAR la entrega por pasarse de advertencias?
 *
 * En el simulacro NO. El docente entra a ver lo que ve el alumno, y suspenderle
 * el ensayo lo echa de la pantalla justo cuando está probando el proctoring —
 * que es lo único que no puede probar de otra forma. Sigue viendo el aviso; lo
 * que no pasa es que se le acabe la simulación.
 *
 * Se separa de `avisaDelLimite` a propósito: son dos decisiones distintas
 * —avisar y cerrar— y tenerlas en una sola condición fue lo que hizo que el
 * simulacro terminara solo.
 */
export function suspendePorAdvertencias(
  warnings: number,
  max: number = MAX_WARNINGS,
  simulacro = false,
): boolean {
  return shouldMarkSuspicious(warnings, max) && !simulacro;
}

/** ¿Hay que avisar que se llegó al límite? Sí en los dos modos. */
export function avisaDelLimite(warnings: number, max: number = MAX_WARNINGS): boolean {
  return shouldMarkSuspicious(warnings, max);
}

/** Normalizes either `ev.at` (ISO/ms) or `ev.ts` (ms) to epoch ms for display. */
export function warningEventTimestamp(ev: WarningEvent): number | null {
  if (typeof ev.ts === "number") return ev.ts;
  if (typeof ev.at === "number") return ev.at;
  if (typeof ev.at === "string") {
    const n = Date.parse(ev.at);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/**
 * ¿Un `blur` de la VENTANA debe sumar strike en este dispositivo?
 *
 * ── El problema ───────────────────────────────────────────────────────
 * En móvil, el corrector ortográfico del sistema abre su propia burbuja
 * nativa —la sugerencia de reemplazo al tocar una palabra subrayada, el
 * «Replace…» de iOS— y esa burbuja le quita el foco a la ventana sin que el
 * estudiante salga de ningún lado. El examen lo contaba como «salida de
 * pestaña»: corregir una palabra costaba un strike, y al llegar al tope el
 * intento queda SUSPENDIDO (se guarda como `completado`, cerrado con motivo
 * «advertencias»; ver `shouldMarkSuspicious`). Medido en producción: de 131 advertencias
 * registradas, 80 son de este tipo — el más frecuente con diferencia.
 *
 * ── Por qué distinguir por dispositivo y no intentar detectar el corrector ──
 * No hay forma de preguntarle al navegador «¿este blur lo causó una burbuja
 * del sistema?». Lo que sí cambia es qué señal es CONFIABLE en cada uno:
 *
 *  · En un teléfono o tableta, salir de la aplicación de verdad —cambiar de
 *    app, abrir el navegador, bajar el centro de notificaciones— dispara
 *    `visibilitychange` con el documento OCULTO. Esa señal sigue sumando
 *    strike, así que el proctoring no se debilita: lo que se deja de contar
 *    es el blur suelto, que en móvil lo producen las burbujas del sistema.
 *  · En un computador, cambiar de ventana con alt+tab dispara `blur` y muchas
 *    veces NO dispara `visibilitychange` (lo documenta el propio listener de
 *    la pantalla de examen). Ahí el blur es la única señal y se conserva
 *    intacta — el corrector no lo dispara, porque sus sugerencias se abren
 *    dentro de la misma ventana (ver `permiteMenuContextual`, que desde el
 *    2026-09-23 permite ese menú sobre los campos de respuesta).
 *
 * Se exige puntero grueso Y ausencia de puntero fino a propósito: un portátil
 * con pantalla táctil tiene los dos, y ahí el alt+tab sigue siendo posible, así
 * que debe seguir contando como en cualquier computador.
 */
export interface EntornoDePuntero {
  punteroGrueso: boolean;
  punteroFino: boolean;
}

/**
 * Se exige puntero grueso Y ausencia de puntero fino a propósito: un portátil
 * con pantalla táctil tiene los dos, y ahí el alt+tab sigue siendo posible.
 */
export function esPunteroDeMovil(entorno: EntornoDePuntero): boolean {
  return entorno.punteroGrueso && !entorno.punteroFino;
}

export function blurCuentaComoStrike(entorno: EntornoDePuntero): boolean {
  return !esPunteroDeMovil(entorno);
}

/**
 * ¿Perder la PANTALLA COMPLETA debe sumar strike en este dispositivo?
 *
 * En un teléfono la suelta el propio sistema: el teclado, la burbuja del
 * corrector o el menú de selección son superficies nativas y varias versiones
 * de Android salen de pantalla completa al mostrarlas. Medido en producción:
 * de los 3 `fullscreen_exit` registrados en dispositivos móviles, uno ocurrió
 * a menos de 5 s de una corrección ortográfica. Y en iPhone la pantalla
 * completa de un elemento directamente no existe.
 *
 * En un computador sí es una acción del estudiante (Esc, F11, cambiar de
 * ventana), y ahí se conserva intacta.
 */
export function salidaDePantallaCompletaCuentaComoStrike(entorno: EntornoDePuntero): boolean {
  return !esPunteroDeMovil(entorno);
}

/**
 * Cuánto tiene que quedarse OCULTO el documento, en un móvil, para que cuente
 * como que el estudiante se fue.
 *
 * 2,5 s: nadie cambia de aplicación, mira algo y vuelve en menos que eso. Las
 * superficies del sistema, en cambio, ocultan el documento un instante.
 */
export const GRACIA_OCULTO_MOVIL_MS = 2500;

/**
 * ¿Que el documento se haya OCULTADO debe sumar strike?
 *
 * ── Por qué esto existe, y por qué el arreglo del corrector no alcanzó ──
 * Cuando se dejó de contar el `blur` en móvil, el problema siguió igual: los
 * datos de producción muestran que en un teléfono la MISMA corrección dispara
 * `blur` y, entre 0 y 2 segundos después, `visibilitychange` con el documento
 * oculto. O sea que el strike se dejaba de sumar por un lado y se sumaba por
 * el otro — corregir una palabra seguía costando una advertencia. Secuencias
 * reales, medidas: `blur_movil → visibility_hidden (+0s)`,
 * `blur_movil → visibility_hidden (+1s)`, `blur_movil → visibility_hidden (+2s)`.
 *
 * Lo que distingue una cosa de la otra NO es el evento, es CUÁNTO duró:
 * irse a otra aplicación deja el documento oculto hasta que la persona vuelve;
 * una burbuja del sistema lo oculta un instante. Por eso el strike se decide
 * al VOLVER, con el tiempo transcurrido, y no en el momento de ocultarse.
 *
 * En computador se mantiene inmediato: ahí ocultarse es cambiar de pestaña.
 */
export function ocultarCuentaComoStrike(
  entorno: EntornoDePuntero,
  msOculto: number,
): boolean {
  if (!esPunteroDeMovil(entorno)) return true;
  return msOculto >= GRACIA_OCULTO_MOVIL_MS;
}

/**
 * Lee del navegador lo que `blurCuentaComoStrike` necesita. Separado para que
 * la regla se pueda probar sin DOM.
 */
export function entornoDePuntero(): { punteroGrueso: boolean; punteroFino: boolean } {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    // Sin `matchMedia` no se puede distinguir: se asume computador, que es el
    // caso donde NO contar un blur debilitaría el proctoring.
    return { punteroGrueso: false, punteroFino: true };
  }
  return {
    punteroGrueso: window.matchMedia("(pointer: coarse)").matches,
    punteroFino: window.matchMedia("(pointer: fine)").matches,
  };
}

/**
 * Ventanas de deduplicación SEPARADAS para los strikes y para las señales
 * blandas.
 *
 * ── Por qué separadas ─────────────────────────────────────────────────
 * Un mismo gesto dispara varios eventos, y por eso hay una ventana que ignora
 * el segundo. Pero si strikes y señales blandas comparten esa ventana, la
 * blanda se traga al strike: en un teléfono, cambiar de aplicación dispara
 * primero `blur` —que desde el arreglo del corrector ortográfico es señal
 * blanda— y enseguida `visibilitychange`. Con una sola ventana, el blur la
 * consume sin sumar nada y el `visibility_hidden` que viene detrás la encuentra
 * cerrada: el cambio de app quedaba SIN registrar, que es exactamente el hueco
 * que el arreglo decía no abrir.
 *
 * Con ventanas separadas cada clase se deduplica contra sí misma y ninguna
 * silencia a la otra.
 */
export function creaVentanasDeProctoring(ventanaMs = 500) {
  let hastaStrike = 0;
  let hastaBlanda = 0;
  return {
    /** ¿Se puede sumar un strike ahora? Abre la ventana si devuelve true. */
    permiteStrike(ahora: number): boolean {
      if (ahora < hastaStrike) return false;
      hastaStrike = ahora + ventanaMs;
      return true;
    },
    /** Ídem para una señal que no suma. */
    permiteBlanda(ahora: number): boolean {
      if (ahora < hastaBlanda) return false;
      hastaBlanda = ahora + ventanaMs;
      return true;
    },
  };
}

/**
 * ¿Hay que dejar abrir el MENÚ CONTEXTUAL sobre este elemento?
 *
 * ── Por qué existe ────────────────────────────────────────────────────
 * La pantalla de examen bloqueaba el menú contextual en TODA la página con
 * un `preventDefault` a secas. El efecto que nadie midió: en un computador,
 * las sugerencias del corrector ortográfico VIVEN en ese menú. El navegador
 * seguía subrayando la palabra mal escrita en rojo y el estudiante no tenía
 * cómo aceptar la corrección — le quedaba borrar y reescribir a mano, en un
 * examen contrarreloj. En el teléfono el corrector sí funciona (la burbuja
 * es del sistema, no el menú del navegador), así que la plataforma se
 * comportaba distinto en cada dispositivo sin que eso fuera una decisión.
 *
 * ── Por qué NO debilita el proctoring ─────────────────────────────────
 * El bloqueo real de copiar/pegar/cortar no está en el menú: está en el
 * manejador de los eventos de portapapeles, que hace `preventDefault` del
 * `paste` fuera del editor de código y lo registra. Elegir «Pegar» en el
 * menú dispara ese MISMO evento, así que se sigue bloqueando y registrando
 * igual. Lo único que el menú agrega sobre un campo de respuesta son las
 * sugerencias de ortografía, deshacer y seleccionar.
 *
 * Fuera de los campos de respuesta se mantiene bloqueado: ahí el menú no
 * aporta nada al examen y sí ofrece «abrir en otra pestaña» sobre el
 * enunciado.
 */
export function permiteMenuContextual(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.closest("textarea") !== null ||
    target.closest('input[type="text"], input[type="search"], input:not([type])') !== null ||
    target.closest('[contenteditable="true"], [contenteditable=""]') !== null ||
    // El editor de código ya permite copiar y pegar dentro de sí mismo; su
    // menú es parte de cómo se trabaja ahí.
    target.closest(".monaco-editor") !== null
  );
}

/**
 * Cuánto se espera, en computador, antes de cobrar el strike de `blur`,
 * `visibility_hidden` o `fullscreen_exit`.
 *
 * Cerrar o recargar la pestaña dispara esos MISMOS eventos justo antes de que
 * la página muera, y antes se cobraban en el acto: el estudiante al que se le
 * cerró el navegador, se le cayó el internet o recargó por error volvía con una
 * advertencia (o con el examen cerrado). Esperando un instante, si la página se
 * está yendo el temporizador nunca corre; si sigue viva —cambió de pestaña de
 * verdad— el strike llega igual, menos de un segundo después.
 */
export const ESPERA_STRIKE_DIFERIDO_MS = 700;

/**
 * Strikes de escritorio diferidos, para que SALIR de la página no cuente.
 *
 * · `diferir` programa el strike; un gesto que dispara varios eventos (blur +
 *   visibilidad + pantalla completa) deja UNO solo pendiente.
 * · `marcarSalida` (beforeunload / pagehide) cancela el pendiente y descarta lo
 *   que llegue mientras la página se va.
 * · `marcarRegreso` (foco o página visible de nuevo, o el diálogo «¿Salir?»
 *   cancelado) vuelve a la normalidad.
 */
export function creaStrikesDiferidos(
  esperaMs: number = ESPERA_STRIKE_DIFERIDO_MS,
  programar: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  cancelar: (id: unknown) => void = (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
) {
  let pendiente: unknown = null;
  let saliendo = false;
  return {
    diferir(tipo: string, contar: (tipo: string) => void): void {
      if (saliendo || pendiente !== null) return;
      pendiente = programar(() => {
        pendiente = null;
        if (!saliendo) contar(tipo);
      }, esperaMs);
    },
    marcarSalida(): void {
      saliendo = true;
      if (pendiente !== null) cancelar(pendiente);
      pendiente = null;
    },
    marcarRegreso(): void {
      saliendo = false;
    },
    saliendo(): boolean {
      return saliendo;
    },
    cancelarTodo(): void {
      if (pendiente !== null) cancelar(pendiente);
      pendiente = null;
    },
  };
}

/**
 * Lo que se manda al servidor cuando la página del examen se cierra o se
 * recarga, en el `fetch` keepalive de `beforeunload`.
 *
 * Por defecto solo las respuestas: cerrar puede ser un cuelgue, un apagón o el
 * internet, y antes cada salida sumaba una advertencia —y podía cerrar el
 * intento— sin dejar siquiera un evento que el docente pudiera perdonar. Con
 * `cuentaComoAdvertencia` (el examen tiene `reload_counts_as_warning`) suma
 * una y, al llegar al tope, cierra el intento igual que un strike cualquiera.
 *
 * El evento `salida_de_la_pagina` ya tiene que venir dentro de `answers`, con
 * `suma` igual a `cuentaComoAdvertencia`: así el contador y el evento viajan en
 * la MISMA escritura y perdonarlo descuenta lo que sumó.
 */
export function cuerpoAlSalirDeLaPagina(args: {
  answers: Record<string, unknown>;
  warnings: number;
  maxWarnings: number;
  cuentaComoAdvertencia: boolean;
  ahoraIso: string;
  userId: string | null;
}): { body: Record<string, unknown>; warnings: number; cierra: boolean } {
  if (!args.cuentaComoAdvertencia) {
    return { body: { answers: args.answers }, warnings: args.warnings, cierra: false };
  }
  const warnings = args.warnings + 1;
  const body: Record<string, unknown> = { answers: args.answers, focus_warnings: warnings };
  const cierra = shouldMarkSuspicious(warnings, args.maxWarnings);
  if (cierra) {
    // Como el cierre de `performSubmit` por advertencias: «completado» y con la
    // marca de cierre, que es lo que impide que el alumno reabra su propia
    // suspensión (`tg_block_reopen_closed_attempt`).
    body.status = "completado";
    body.submitted_at = args.ahoraIso;
    body.closed_at = args.ahoraIso;
    body.close_reason = "advertencias";
    body.closed_by = args.userId;
  }
  return { body, warnings, cierra };
}

/**
 * Cuántas veces el estudiante cerró o recargó el examen y volvió a entrar.
 * El monitor lo muestra aparte de las advertencias: no castiga, deja decidir.
 */
export function contarSalidasDeLaPagina(events: readonly { type?: unknown }[] | null | undefined): number {
  if (!Array.isArray(events)) return 0;
  return events.filter((e) => e?.type === "salida_de_la_pagina").length;
}
