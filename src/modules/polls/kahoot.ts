/**
 * Kahoot — tipos, scoring puro y configuración visual de las 4 formas.
 *
 * El scoring vive acá (cliente) SOLO para previsualizar/mostrar; la fuente
 * de verdad es el RPC `kahoot_submit_answer` (server-side), que calcula los
 * puntos con la MISMA fórmula. Mantener ambos en sincronía:
 *   correcto → points * (1 - (t/limite)/2)   (instantáneo = full; al límite = mitad)
 *   incorrecto → 0
 */

/** Puntos de una respuesta Kahoot. Espejo de la fórmula en
 *  `kahoot_submit_answer` (migración 20260921000100). */
export function kahootPoints(params: {
  correct: boolean;
  elapsedMs: number;
  timeLimitSeconds: number;
  maxPoints: number;
}): number {
  const { correct, elapsedMs, timeLimitSeconds, maxPoints } = params;
  if (!correct) return 0;
  const limitMs = timeLimitSeconds * 1000;
  if (limitMs <= 0) return maxPoints;
  const elapsed = Math.max(0, Math.min(limitMs, elapsedMs));
  return Math.round(maxPoints * (1 - elapsed / limitMs / 2));
}

/** Las 4 formas+colores de Kahoot, por posición (0..3). `bg` es una clase
 *  Tailwind con valor arbitrario (color literal de marca). `icon` mapea a
 *  un ícono de lucide-react que el componente resuelve. */
export const KAHOOT_SHAPES = [
  { key: "triangle", bg: "bg-[#e21b3c]", ring: "ring-[#e21b3c]", icon: "triangle" },
  { key: "diamond", bg: "bg-[#1368ce]", ring: "ring-[#1368ce]", icon: "diamond" },
  { key: "circle", bg: "bg-[#d89e00]", ring: "ring-[#d89e00]", icon: "circle" },
  { key: "square", bg: "bg-[#26890c]", ring: "ring-[#26890c]", icon: "square" },
] as const;

export type KahootShape = (typeof KAHOOT_SHAPES)[number];

export type KahootStatus = "lobby" | "question" | "reveal" | "leaderboard" | "podium" | "ended";

export interface KahootStateOption {
  id: string;
  label: string;
  position: number;
  /** null = oculto (antes del reveal y no-host). */
  is_correct: boolean | null;
}

export interface KahootStateQuestion {
  id: string;
  text: string;
  image_url: string | null;
  time_limit_seconds: number;
  points: number;
  /** true = el alumno puede marcar VARIAS opciones (acierta si marca el set
   *  correcto exacto). false = una sola opción. */
  multi_select: boolean;
  options: KahootStateOption[];
}

export interface KahootStatePlayer {
  id: string;
  nickname: string;
  score: number;
  user_id: string;
}

export interface KahootStateMe {
  player_id: string;
  nickname: string;
  score: number;
  rank: number;
  answered: boolean;
  my_option_id: string | null;
  /** Set de opciones que el alumno marcó (multiple). null si no respondió. */
  my_option_ids: string[] | null;
  my_is_correct: boolean | null;
  my_points: number;
}

export interface KahootState {
  game: {
    id: string;
    pin: string;
    status: KahootStatus;
    current_index: number;
    total_questions: number;
    question_started_at: string | null;
    question_locked: boolean;
  };
  is_host: boolean;
  question: KahootStateQuestion | null;
  answer_count: number;
  players: KahootStatePlayer[];
  me: KahootStateMe | null;
}

/** Construye la URL del QR para unirse a un Kahoot (deep-link a la app del
 *  estudiante). El alumno escanea → aterriza en /app/student/polls?kahootPin=…
 *  → si no está logueado, el login lo trae de vuelta acá (returnTo) → la
 *  página auto-une por PIN vía `kahoot_join_game` y redirige al juego. La
 *  seguridad la enforza el RPC (matrícula al curso + poll no borrado); el PIN
 *  por sí solo no da acceso. Análogo a `buildAttendanceCheckInUrl`. */
export function buildKahootJoinUrl(origin: string, pin: string): string {
  const url = new URL("/app/student/polls", origin);
  url.searchParams.set("kahootPin", pin);
  return url.toString();
}

/** Segundos restantes de la pregunta actual, dado el reloj local. Devuelve
 *  null si no hay pregunta corriendo. Clamp a [0, limite]. */
export function secondsLeft(
  startedAtIso: string | null,
  timeLimitSeconds: number,
  nowMs: number,
): number | null {
  if (!startedAtIso) return null;
  const started = new Date(startedAtIso).getTime();
  if (Number.isNaN(started)) return null;
  const elapsed = (nowMs - started) / 1000;
  return Math.max(0, Math.min(timeLimitSeconds, Math.ceil(timeLimitSeconds - elapsed)));
}
