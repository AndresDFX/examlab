/**
 * Los sonidos de la ruleta, sintetizados con Web Audio: no hay archivos de
 * audio que bajar ni que alojar, y suenan igual sin conexión.
 *
 * El navegador solo deja sonar audio que arranca con un gesto del usuario, así
 * que `prepararAudio` se llama DENTRO del clic (o la tecla) que gira. Un solo
 * contexto para toda la página: los navegadores limitan cuántos se pueden
 * abrir, y crear uno por giro termina en silencio.
 */

let contexto: AudioContext | null = null;

type ConWebkit = typeof globalThis & { webkitAudioContext?: typeof AudioContext };

/** El contexto de audio listo para sonar, o `null` si el navegador no tiene. */
export function prepararAudio(): AudioContext | null {
  try {
    const Ctor = globalThis.AudioContext ?? (globalThis as ConWebkit).webkitAudioContext;
    if (!Ctor) return null;
    if (!contexto || contexto.state === "closed") contexto = new Ctor();
    if (contexto.state === "suspended") void contexto.resume();
    return contexto;
  } catch {
    return null;
  }
}

/** Una nota con ataque corto y caída exponencial. */
function nota(
  ctx: AudioContext,
  args: { frecuencia: number; inicio: number; duracion: number; volumen: number; tipo: OscillatorType },
) {
  const osc = ctx.createOscillator();
  const ganancia = ctx.createGain();
  osc.type = args.tipo;
  osc.frequency.setValueAtTime(args.frecuencia, args.inicio);
  ganancia.gain.setValueAtTime(0.0001, args.inicio);
  ganancia.gain.exponentialRampToValueAtTime(args.volumen, args.inicio + 0.012);
  ganancia.gain.exponentialRampToValueAtTime(0.0001, args.inicio + args.duracion);
  osc.connect(ganancia).connect(ctx.destination);
  osc.start(args.inicio);
  osc.stop(args.inicio + args.duracion + 0.05);
}

/** El «clac» del puntero contra un gajo: corto, seco y agudo. */
export function sonarTic(ctx: AudioContext): void {
  try {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const ganancia = ctx.createGain();
    osc.type = "triangle";
    // Un poco distinto cada vez: idénticos suenan a máquina, no a madera.
    osc.frequency.setValueAtTime(1500 + Math.random() * 300, t);
    osc.frequency.exponentialRampToValueAtTime(650, t + 0.035);
    ganancia.gain.setValueAtTime(0.0001, t);
    ganancia.gain.exponentialRampToValueAtTime(0.2, t + 0.002);
    ganancia.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(ganancia).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.07);
  } catch {
    /* sin audio no hay «clac», y el giro sigue igual */
  }
}

/** «¡Salió!»: un arpegio de Do mayor que termina en un acorde sostenido. */
export function sonarGanador(ctx: AudioContext): void {
  try {
    const t0 = ctx.currentTime + 0.03;
    const arpegio = [523.25, 659.25, 783.99, 1046.5];
    arpegio.forEach((frecuencia, i) =>
      nota(ctx, { frecuencia, inicio: t0 + i * 0.08, duracion: 0.32, volumen: 0.16, tipo: "triangle" }),
    );
    const acorde = t0 + arpegio.length * 0.08;
    for (const frecuencia of [523.25, 659.25, 783.99]) {
      nota(ctx, { frecuencia, inicio: acorde, duracion: 1.1, volumen: 0.09, tipo: "sine" });
    }
    nota(ctx, { frecuencia: 1046.5, inicio: acorde, duracion: 1.1, volumen: 0.07, tipo: "triangle" });
  } catch {
    /* sin audio, el resultado igual se ve */
  }
}
