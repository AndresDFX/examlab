/**
 * Quién presenta una recuperación de un examen, y por qué.
 *
 * La lista la arma el diálogo «Crear recuperatorio», y es la parte que no se
 * puede dejar al ojo: en un curso de 30 personas nadie recuerda quién perdió,
 * y asignar a TODOS —lo que hace el formulario de crear examen— le ofrece el
 * recuperatorio a quien aprobó.
 *
 * Se decide con la nota EFECTIVA (`notaDeExamenParaEstudiante`), no con la del
 * original a secas: quien no presentó el parcial pero ya aprobó su supletorio
 * no necesita otra oportunidad, y quien ya recuperó en un primer recuperatorio
 * tampoco.
 *
 * Tres motivos, y solo dos se marcan solos:
 *  - `no_presento`: ningún intento finalizado, ni del original ni de sus
 *    recuperaciones. Es de supletorio y también de recuperatorio.
 *  - `perdio`: nota efectiva por debajo de la de aprobación del curso. Solo de
 *    recuperatorio: un supletorio no cuenta para quien presentó el original.
 *  - `sin_nota`: presentó y la nota todavía no existe (la IA va en cola, o el
 *    docente no calificó). Se LISTA pero no se marca: todavía no se sabe si
 *    perdió, y marcarlo le ofrecería el recuperatorio a alguien que quizá
 *    aprobó.
 */
import type { AttemptForGrade } from "@/modules/exams/exam-attempts";
import {
  notaDeExamenParaEstudiante,
  notaDeTallerConRecuperaciones,
  type FilaDeExamen,
  type FilaDeTaller,
  type ItemResuelto,
  type TipoRecuperacion,
} from "./nota-con-recuperacion";

export type MotivoDeRecuperacion = "perdio" | "no_presento" | "sin_nota";

export interface Candidato {
  userId: string;
  motivo: MotivoDeRecuperacion;
  /** Nota efectiva en la escala del curso; `null` si no presentó o no tiene nota. */
  nota: number | null;
  /** Si el diálogo lo marca de entrada. */
  sugerido: boolean;
}

export interface EscalaDelCurso {
  min: number;
  max: number;
  /** `courses.passing_grade`, en la escala del curso. */
  aprobacion: number;
}

/**
 * Nota cruda (0..max) a la escala del curso. Es la MISMA fórmula que el
 * `toScale` del libro de notas, del boletín y de las notas del estudiante:
 * comparar la cruda contra `passing_grade` daría otro resultado en un curso
 * cuya escala no arranca en 0.
 */
export function notaEnEscala(raw: number, escala: Pick<EscalaDelCurso, "min" | "max">): number {
  const pct = escala.max > 0 ? raw / escala.max : 0;
  return escala.min + pct * (escala.max - escala.min);
}

export interface ResultadoDeCandidatos {
  candidatos: Candidato[];
  /** Presentaron algo (el original o una recuperación) — no son de supletorio. */
  presentaron: number;
  /** Tienen nota efectiva aprobatoria — no son de recuperatorio. */
  aprobaron: number;
}

export function candidatosParaRecuperacion(args: {
  tipo: TipoRecuperacion;
  /** Estudiantes del curso. El llamador ya sacó a quien dicta el curso. */
  estudiantes: readonly string[];
  examen: FilaDeExamen;
  /** Todos los exámenes del curso: de acá salen las recuperaciones que ya existen. */
  examenes: readonly FilaDeExamen[];
  intentos: readonly (AttemptForGrade & { exam_id: string; user_id: string })[];
  escala: EscalaDelCurso;
}): ResultadoDeCandidatos {
  const candidatos: Candidato[] = [];
  let presentaron = 0;
  let aprobaron = 0;

  for (const userId of args.estudiantes) {
    const propios = args.intentos.filter((i) => i.user_id === userId);
    const r = notaDeExamenParaEstudiante(args.examen, args.examenes, propios);

    if (r.fuente === null) {
      candidatos.push({ userId, motivo: "no_presento", nota: null, sugerido: true });
      continue;
    }
    presentaron++;
    if (args.tipo === "supletorio") continue;

    if (r.nota == null) {
      candidatos.push({ userId, motivo: "sin_nota", nota: null, sugerido: false });
      continue;
    }
    const nota = notaEnEscala(r.nota, args.escala);
    if (nota < args.escala.aprobacion) {
      candidatos.push({ userId, motivo: "perdio", nota, sugerido: true });
    } else {
      aprobaron++;
    }
  }

  // Primero los que perdieron (el caso del que se trata), después los que no
  // presentaron y al final los que todavía no tienen nota.
  const orden: Record<MotivoDeRecuperacion, number> = { perdio: 0, no_presento: 1, sin_nota: 2 };
  candidatos.sort((a, b) => orden[a.motivo] - orden[b.motivo]);
  return { candidatos, presentaron, aprobaron };
}

/**
 * Igual que `candidatosParaRecuperacion` pero para TALLERES. La diferencia es
 * cómo se resuelve la nota de cada estudiante: un taller no tiene intentos, así
 * que el llamador pasa `notaDe(tallerId, userId)` que ya devuelve el
 * `ItemResuelto` (presentó + nota YA en la escala del curso, vía
 * `notaEfectivaDeTaller`). El pliegue de recuperaciones es el mismo.
 */
export function candidatosDeTallerParaRecuperacion(args: {
  tipo: TipoRecuperacion;
  estudiantes: readonly string[];
  taller: FilaDeTaller;
  talleres: readonly FilaDeTaller[];
  /** Presentó + nota EN ESCALA DEL CURSO de un (taller, estudiante). */
  notaDe: (tallerId: string, userId: string) => ItemResuelto;
  escala: EscalaDelCurso;
}): ResultadoDeCandidatos {
  const candidatos: Candidato[] = [];
  let presentaron = 0;
  let aprobaron = 0;

  for (const userId of args.estudiantes) {
    const r = notaDeTallerConRecuperaciones(args.taller, args.talleres, (id) =>
      args.notaDe(id, userId),
    );
    if (r.fuente === null) {
      candidatos.push({ userId, motivo: "no_presento", nota: null, sugerido: true });
      continue;
    }
    presentaron++;
    if (args.tipo === "supletorio") continue;
    if (r.nota == null) {
      candidatos.push({ userId, motivo: "sin_nota", nota: null, sugerido: false });
      continue;
    }
    // La nota ya viene en la escala del curso (a diferencia de exámenes, que la
    // reescalan acá): comparar directo contra la de aprobación.
    if (r.nota < args.escala.aprobacion) {
      candidatos.push({ userId, motivo: "perdio", nota: r.nota, sugerido: true });
    } else {
      aprobaron++;
    }
  }

  const orden: Record<MotivoDeRecuperacion, number> = { perdio: 0, no_presento: 1, sin_nota: 2 };
  candidatos.sort((a, b) => orden[a.motivo] - orden[b.motivo]);
  return { candidatos, presentaron, aprobaron };
}

const HORA_MS = 60 * 60 * 1000;
const SEMANA_MS = 7 * 24 * HORA_MS;

/**
 * Fechas de partida para la recuperación: las del original, corridas de a
 * SEMANAS enteras hasta que el inicio quede en el futuro.
 *
 * La copia hereda las fechas del original, que ya pasaron: publicada así, la
 * ventana nace cerrada y nadie puede presentarla. Correr de a semanas conserva
 * el día y la hora —la franja de la clase, que es donde casi siempre se toma—,
 * en vez de proponer «dentro de 7 días desde ahora» a una hora cualquiera. El
 * docente las ajusta igual; esto solo evita que el default sea inservible.
 *
 * Un original sin duración —fin igual o anterior al inicio— propone UNA hora.
 * Es el caso de las actividades externas guardadas cuando tenían una sola
 * fecha (inicio = fin): sin esto, el diálogo abría con un rango que él mismo
 * rechaza por inválido.
 */
export function sugerirFechasDeRecuperacion(
  inicio: Date,
  fin: Date,
  ahora: Date,
): { inicio: Date; fin: Date } {
  const i = inicio.getTime();
  const f = fin.getTime();
  if (!Number.isFinite(i) || !Number.isFinite(f)) return { inicio, fin };
  const duracion = f > i ? f - i : HORA_MS;
  const semanas = i > ahora.getTime() ? 0 : Math.floor((ahora.getTime() - i) / SEMANA_MS) + 1;
  const nuevoInicio = i + semanas * SEMANA_MS;
  return { inicio: new Date(nuevoInicio), fin: new Date(nuevoInicio + duracion) };
}
