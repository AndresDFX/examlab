/**
 * Sonido del Reto en vivo — efectos SINTETIZADOS con la Web Audio API (sin
 * archivos de audio: nada que empaquetar ni servir, cero peso extra ni problemas
 * de CSP). Se pueden SILENCIAR y la preferencia se persiste en localStorage,
 * compartida entre el host (docente) y los jugadores (estudiantes), y entre
 * pestañas/instancias (mismo patrón de sincronización que use-theme).
 *
 * Los navegadores bloquean el audio hasta que hay un gesto del usuario, así que
 * el AudioContext se crea/reanuda de forma perezosa (`unlockAudio()` se llama al
 * togglear el sonido y al primer tap). Si el contexto sigue suspendido, los
 * sonidos simplemente no suenan (sin errores) hasta el primer gesto.
 */

const STORAGE_KEY = "examlab_kahoot_muted";
const EVENT_NAME = "examlab:kahoot-muted-changed";

/** ¿El sonido está silenciado? (default: NO — suena, como Kahoot). SSR-safe. */
export function isKahootMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persiste la preferencia + avisa a todas las instancias del hook. */
export function setKahootMuted(muted: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, muted ? "1" : "0");
  } catch {
    /* noop */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: muted }));
  } catch {
    /* noop */
  }
}

// AudioContext perezoso y único por pestaña.
let ctx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Desbloquea el audio (llamar dentro de un gesto del usuario: click/tap). */
export function unlockAudio(): void {
  getCtx();
}

interface Tone {
  freq: number;
  /** Duración en segundos. */
  dur: number;
  type?: OscillatorType;
  /** Offset de inicio en segundos (para secuencias/acordes). */
  delay?: number;
  /** Ganancia pico (0..1). */
  gain?: number;
}

function playTones(tones: Tone[]): void {
  if (isKahootMuted()) return;
  const c = getCtx();
  if (!c || c.state !== "running") return;
  const now = c.currentTime;
  for (const tn of tones) {
    try {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = tn.type ?? "sine";
      osc.frequency.value = tn.freq;
      const start = now + (tn.delay ?? 0);
      const peak = tn.gain ?? 0.14;
      // Envolvente rápida (ataque 10ms, caída exponencial) — evita clicks.
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + tn.dur);
      osc.connect(g);
      g.connect(c.destination);
      osc.start(start);
      osc.stop(start + tn.dur + 0.03);
    } catch {
      /* si un tono falla, no rompe el resto */
    }
  }
}

/** Catálogo de efectos del Reto en vivo. Melodías cortas sintetizadas. */
export const kahootSound = {
  /** Un jugador entró a la sala. */
  join: () => playTones([{ freq: 660, dur: 0.12, type: "triangle" }]),
  /** Arranca el juego / abre una pregunta. */
  start: () =>
    playTones([
      { freq: 523, dur: 0.12, type: "triangle" },
      { freq: 784, dur: 0.18, delay: 0.1, type: "triangle" },
    ]),
  /** El alumno envió su respuesta. */
  submit: () => playTones([{ freq: 880, dur: 0.09, type: "triangle" }]),
  /** Se bloquea la pregunta / se revela. */
  reveal: () =>
    playTones([
      { freq: 587, dur: 0.1, type: "triangle" },
      { freq: 440, dur: 0.16, delay: 0.08, type: "triangle" },
    ]),
  /** Respuesta correcta (alegre, ascendente). */
  correct: () =>
    playTones([
      { freq: 659, dur: 0.12, type: "triangle" },
      { freq: 988, dur: 0.22, delay: 0.1, type: "triangle" },
    ]),
  /** Respuesta incorrecta (grave, descendente). */
  wrong: () =>
    playTones([
      { freq: 330, dur: 0.14, type: "sawtooth", gain: 0.1 },
      { freq: 220, dur: 0.24, delay: 0.12, type: "sawtooth", gain: 0.1 },
    ]),
  /** Se abre la tabla de posiciones (arpegio ascendente). */
  leaderboard: () =>
    playTones([
      { freq: 523, dur: 0.1, type: "triangle" },
      { freq: 659, dur: 0.1, delay: 0.08, type: "triangle" },
      { freq: 784, dur: 0.18, delay: 0.16, type: "triangle" },
    ]),
  /** Podio final (fanfarria). */
  podium: () =>
    playTones([
      { freq: 523, dur: 0.13, type: "triangle" },
      { freq: 659, dur: 0.13, delay: 0.13, type: "triangle" },
      { freq: 784, dur: 0.13, delay: 0.26, type: "triangle" },
      { freq: 1047, dur: 0.32, delay: 0.39, type: "triangle" },
    ]),
};

export type KahootSoundName = keyof typeof kahootSound;
