/**
 * Cómo se mueve la rueda durante un giro, como función PURA del progreso.
 *
 * El giro lo anima el navegador cuadro a cuadro (no una transición de CSS)
 * porque hace falta saber en cada cuadro qué gajo pasa bajo el puntero: de eso
 * salen el «clac» de cada gajo y el rebote del puntero. Con una transición de
 * CSS el ángulo intermedio no se puede leer sin trucos.
 *
 * Tres tramos, como una rueda de verdad:
 * 1. **Toma impulso**: retrocede unos grados.
 * 2. **Gira y frena**: arranca rápido y frena largo (las últimas vueltas se
 *    oyen gajo por gajo).
 * 3. **Se asienta**: se pasa apenas del punto y vuelve. Nunca lo bastante como
 *    para cruzar al gajo vecino (ver `amplitudDeAsentamiento`).
 *
 * El ángulo final es EXACTAMENTE `hasta`: lo calcula `rotacionParaCaerEn` para
 * que el puntero quede sobre el sorteado, y este módulo no lo puede mover.
 */

/** Cuánto dura un giro animado. */
export const DURACION_GIRO_MS = 5200;
/** Vueltas completas de un giro animado. */
export const VUELTAS_GIRO = 7;
/** Cuánto retrocede al tomar impulso. */
export const RETROCESO_GRADOS = 14;

/** Fracción del giro que dura el impulso. */
const FRACCION_IMPULSO = 0.05;
/** Desde qué fracción del avance se asienta. */
const INICIO_ASENTAMIENTO = 0.9;

/**
 * Cuánto se pasa al asentarse. Un décimo de gajo como máximo: el puntero cae a
 * por lo menos un 15 % del borde del gajo (`rotacionParaCaerEn`), así que el
 * rebote no lo puede llevar al vecino — si lo hiciera, la rueda mostraría a
 * otro un instante y se oiría un «clac» de más.
 */
export function amplitudDeAsentamiento(gradosPorGajo: number): number {
  if (!(gradosPorGajo > 0)) return 0;
  return Math.min(2.5, gradosPorGajo * 0.1);
}

const suave = (x: number) => x * x * (3 - 2 * x);
/** Frena largo: rápido al principio, gajo por gajo al final. */
const frenar = (u: number) => 1 - (1 - u) ** 4;

/**
 * Ángulo de la rueda en un momento del giro. `progreso` va de 0 (arranca) a 1
 * (se detiene); fuera de ese rango se recorta.
 */
export function anguloDelGiro(args: {
  desde: number;
  hasta: number;
  progreso: number;
  gradosPorGajo: number;
}): number {
  const { desde, hasta, gradosPorGajo } = args;
  const t = Math.min(Math.max(args.progreso, 0), 1);
  if (t >= 1) return hasta;
  if (t <= 0) return desde;
  const atras = desde - RETROCESO_GRADOS;
  if (t < FRACCION_IMPULSO) return desde - RETROCESO_GRADOS * suave(t / FRACCION_IMPULSO);
  const u = (t - FRACCION_IMPULSO) / (1 - FRACCION_IMPULSO);
  const avance = atras + (hasta - atras) * frenar(u);
  if (u < INICIO_ASENTAMIENTO) return avance;
  // Se pasa y vuelve: medio seno, que vale cero en los dos extremos.
  const k = (u - INICIO_ASENTAMIENTO) / (1 - INICIO_ASENTAMIENTO);
  return avance + amplitudDeAsentamiento(gradosPorGajo) * Math.sin(Math.PI * k) * (1 - k);
}

/**
 * Cuánto se tuerce el puntero (en grados) después de que un gajo lo golpea:
 * salta al máximo y vuelve solo. Depende del tiempo transcurrido, no de los
 * cuadros, para que se vea igual en una pantalla de 60 Hz que en una de 120.
 */
export const DESVIO_MAXIMO_PUNTERO = 22;

export function desvioDelPuntero(desvioAnterior: number, msTranscurridos: number): number {
  const ms = Math.max(0, msTranscurridos);
  return desvioAnterior * 0.82 ** (ms / 16.7);
}

/**
 * Cada cuánto, como mínimo, suena un «clac». Al arrancar pasan cientos de
 * gajos por segundo con un curso grande: sonarlos todos satura el audio y se
 * oye un zumbido, no una rueda.
 */
export const MS_MINIMO_ENTRE_TICS = 28;

export function tocaTic(ultimoTicMs: number | null, ahoraMs: number): boolean {
  return ultimoTicMs == null || ahoraMs - ultimoTicMs >= MS_MINIMO_ENTRE_TICS;
}
