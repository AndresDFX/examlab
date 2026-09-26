/**
 * Qué falta del CORTE: lo que falta calificar y lo que los estudiantes ni han
 * empezado.
 *
 * Responde la pregunta con la que el docente entra a Estadísticas cuando se
 * acerca el cierre de un corte. La primera versión contestaba solo la mitad
 * —«qué porcentaje no tiene nota»— y esa mitad sola desinforma de dos maneras
 * concretas, las dos vistas en producción:
 *
 *  - **Confundía el trabajo del docente con el del estudiante.** «Falta el
 *    40%» puede significar que hay 139 entregas esperando nota (trabajo suyo,
 *    esta semana) o que 139 estudiantes no han abierto nada (trabajo de ellos,
 *    y hay que ir a buscarlos). Son dos acciones distintas y el número único
 *    no distinguía cuál.
 *  - **Pintaba en rojo un corte que no había empezado.** El Corte 3 va del
 *    27-oct al 20-nov y salía «100% sin calificar»: literalmente cierto y
 *    completamente inútil, porque nadie puede haber entregado todavía. Un
 *    panel que alarma por trabajo que no existe enseña a ignorarlo.
 *
 * ── Los cuatro estados, y por qué son cuatro ──────────────────────────
 *
 * Cada par (actividad, estudiante) del corte cae en exactamente uno:
 *
 *  - `calificadas` — listo.
 *  - `porCalificar` — **le toca al docente**: el estudiante ya entregó y falta
 *    la nota. Acá entran también las actividades EXTERNAS sin nota cargada,
 *    porque en ellas no hay nada que el estudiante deba entregar: la acción
 *    pendiente es del docente igual.
 *  - `enCurso` — el estudiante lo abrió y no lo terminó. Es su propio estado:
 *    un examen empezado y abandonado no es lo mismo que uno intacto, y el
 *    docente puede cerrarlo.
 *  - `sinEmpezar` — **le toca al estudiante**: no existe ni la fila.
 *
 * `sinEmpezar` NUNCA incluye actividades externas. Contar a alguien como «no
 * empezó» algo que nunca tuvo que empezar convierte el panel en una acusación
 * falsa, que es justo lo que hace que un docente deje de creerle.
 *
 * ── Qué cuenta como entregado ─────────────────────────────────────────
 *
 * Lo decide `entregaHecha`, la lista NEGRA compartida — la misma que ya fija
 * qué está vencido en las pantallas del estudiante. Reimplementarla acá con
 * una lista blanca repetiría el bug que dejó 37 entregas reales marcadas como
 * no entregadas.
 *
 * Y «calificada» la decide `effectiveGrade`: en un taller con sustentación la
 * nota NO es `ai_grade` mientras falte registrarla, así que darla por final
 * daría por calificado algo que no lo está.
 *
 * ── El denominador ────────────────────────────────────────────────────
 *
 * Son las entregas ESPERADAS: una por estudiante matriculado y por actividad
 * del corte. No las existentes. Si el denominador fueran las entregas, un
 * estudiante que no entregó nada desaparecería de la cuenta y el corte se
 * vería «100% calificado» teniendo media clase sin nota. Los borradores no
 * entran: `loadCourseDataset` ya los descarta, así que acá toda actividad está
 * publicada o cerrada. Y **solo cuentan las actividades con porcentaje
 * asignado** (ver `cuentaParaElCorte`): una que pesa 0 no mueve ninguna nota,
 * y contarla llenaba el panel de trabajo pendiente que a nadie le importa.
 *
 * Sin React ni consultas: consume el `CourseDataset` que la pantalla ya carga.
 */
import { effectiveGrade, type Cut, type SubmissionLike } from "@/shared/lib/statistics";
import { entregaHecha } from "@/modules/submissions/entrega-hecha";

/** En qué momento está el corte respecto de hoy. */
export type EstadoDeCorte = "futuro" | "en_curso" | "terminado" | "sin_fechas";

/** Lo que falta en un corte, desglosado por quién tiene que actuar. */
export interface PendientesDeCorte {
  cutId: string;
  cutName: string;
  /** Actividades publicadas del corte (los borradores no llegan hasta acá). */
  actividades: number;
  /** Matriculados considerados. */
  estudiantes: number;
  /** Entregas esperadas: actividades × estudiantes. */
  esperadas: number;
  /** Ya tienen nota. */
  calificadas: number;
  /** Entregado (o externa) y sin nota. **Trabajo del docente.** */
  porCalificar: number;
  /** Abierto y sin terminar. */
  enCurso: number;
  /** Ni siquiera empezado. **Trabajo del estudiante.** */
  sinEmpezar: number;
  /** Porcentaje SIN calificar, 0..100. `null` si el corte no tiene actividades. */
  pctSinCalificar: number | null;
  /** Cuántos estudiantes no tienen NINGUNA nota en el corte. */
  estudiantesSinNingunaNota: number;
  /** Cuántos no han empezado NADA del corte (teniendo algo que empezar). */
  estudiantesSinEmpezarNada: number;
  estado: EstadoDeCorte;
}

/** Una actividad del corte, ya resuelta para el curso. */
export interface ActividadDeCorte {
  id: string;
  cut_id: string | null;
  is_external?: boolean;
  /** Porcentaje de la nota final. Ver `cuentaParaElCorte`. */
  weight?: number | null;
}

/**
 * ¿Esta actividad cuenta como trabajo del corte?
 *
 * **Solo si tiene un porcentaje asignado.** Una actividad con peso 0 —o sin
 * peso— no mueve ninguna nota: contarla infla el trabajo pendiente con algo
 * que, esté calificado o no, da exactamente lo mismo. En producción eso no es
 * un caso de borde: los cursos de Introducción tienen 17 talleres «Clase N»
 * con peso 0 que hacían que el panel reportara decenas de notas faltantes
 * sobre actividades que no afectan a nadie, y el docente dejaba de mirarlo.
 *
 * El corte también hace falta: sin él no hay a qué corte atribuirla.
 */
export function cuentaParaElCorte(a: ActividadDeCorte): boolean {
  if (!a.cut_id) return false;
  if (a.weight == null) return false;
  const w = Number(a.weight);
  return Number.isFinite(w) && w > 0;
}

/**
 * El día local de un instante, como `YYYY-MM-DD`.
 *
 * `start_date` / `end_date` son columnas DATE: un día del calendario, sin hora
 * ni zona. Compararlas como INSTANTES es el error que este proyecto ya pagó
 * —`formatDateOnly` existe por lo mismo—: `Date.parse("2026-09-25T12:00:00")`
 * es mediodía LOCAL, así que en UTC-5 queda por encima de un «hoy» expresado en
 * UTC y el primer día del corte se lee como futuro. Reducir los dos lados al
 * día del calendario elimina la aritmética de zonas: el orden lexicográfico de
 * `YYYY-MM-DD` ya es el cronológico.
 */
function diaLocal(instante: number): string {
  const d = new Date(instante);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** En qué momento está el corte. Sin fechas no se puede afirmar nada. */
export function estadoDeCorte(cut: Cut, hoy: number): EstadoDeCorte {
  const ini = cut.start_date?.slice(0, 10) || null;
  const fin = cut.end_date?.slice(0, 10) || null;
  if (!ini && !fin) return "sin_fechas";
  const dia = diaLocal(hoy);
  // Los dos extremos son INCLUSIVOS: el primer y el último día el corte está
  // vivo, que es cuando más se mira este panel.
  if (ini && dia < ini) return "futuro";
  if (fin && dia > fin) return "terminado";
  return "en_curso";
}

/** El estado de un par (actividad, estudiante), de más avanzado a menos. */
type Casilla = "calificada" | "porCalificar" | "enCurso";
const RANGO: Record<Casilla, number> = { calificada: 3, porCalificar: 2, enCurso: 1 };

/**
 * Desglose por corte.
 *
 * `actividades` son las del curso (exámenes + talleres + proyectos, ya
 * achatadas y sin borradores). `entregas` son todas las del curso.
 * `estudiantes` es la cantidad de matriculados. `hoy` decide el estado del
 * corte; se pasa para que el cálculo sea reproducible en los tests.
 */
export function pendientesPorCorte(
  cuts: readonly Cut[],
  actividades: readonly ActividadDeCorte[],
  entregas: readonly SubmissionLike[],
  estudiantes: number,
  hoy = 0,
): PendientesDeCorte[] {
  const alumnos = Math.max(0, estudiantes);
  return cuts.map((cut) => {
    const delCorte = actividades.filter((a) => a.cut_id === cut.id && cuentaParaElCorte(a));
    const porId = new Map(delCorte.map((a) => [a.id, a]));
    const esperadas = delCorte.length * alumnos;

    // Mejor estado observado por par. Un examen con varios intentos tiene
    // varias filas y la nota es una sola, así que gana el más avanzado.
    const mejor = new Map<string, Casilla>();
    const conNota = new Set<string>();
    const conAlgoEmpezado = new Set<string>();
    // Pares CON fila, separados por si su actividad es externa: es lo que hay
    // que restar del total para saber cuántos NO dejaron fila.
    let conFilaExternas = 0;
    let conFilaPropias = 0;

    for (const s of entregas) {
      const act = porId.get(s.ref_id);
      if (!act) continue;
      const casilla: Casilla =
        effectiveGrade(s) != null ? "calificada" : entregaHecha(s) ? "porCalificar" : "enCurso";
      const clave = `${s.ref_id}|${s.user_id}`;
      const previo = mejor.get(clave);
      if (!previo) {
        if (act.is_external) conFilaExternas++;
        else conFilaPropias++;
      }
      if (!previo || RANGO[casilla] > RANGO[previo]) mejor.set(clave, casilla);
      if (casilla === "calificada") conNota.add(s.user_id);
      if (!act.is_external) conAlgoEmpezado.add(s.user_id);
    }

    let calificadas = 0;
    let porCalificar = 0;
    let enCurso = 0;
    for (const c of mejor.values()) {
      if (c === "calificada") calificadas++;
      else if (c === "porCalificar") porCalificar++;
      else enCurso++;
    }

    // Lo que no dejó fila. Una externa sin fila es nota que falta CARGAR, no un
    // estudiante que no empezó: él no tenía nada que empezar.
    const externas = delCorte.filter((a) => a.is_external).length;
    const propias = delCorte.length - externas;
    porCalificar += Math.max(0, externas * alumnos - conFilaExternas);
    const sinEmpezar = Math.max(0, propias * alumnos - conFilaPropias);

    const sinCalificar = Math.max(0, esperadas - calificadas);
    return {
      cutId: cut.id,
      cutName: cut.name,
      actividades: delCorte.length,
      estudiantes: alumnos,
      esperadas,
      calificadas: Math.min(calificadas, esperadas),
      porCalificar,
      enCurso,
      sinEmpezar,
      pctSinCalificar: esperadas === 0 ? null : Math.round((sinCalificar / esperadas) * 1000) / 10,
      estudiantesSinNingunaNota: delCorte.length === 0 ? 0 : Math.max(0, alumnos - conNota.size),
      estudiantesSinEmpezarNada: propias === 0 ? 0 : Math.max(0, alumnos - conAlgoEmpezado.size),
      estado: estadoDeCorte(cut, hoy),
    };
  });
}

/**
 * Suma varios cursos en un solo desglose, agrupando por NOMBRE de corte.
 *
 * Se agrupa por nombre y no por id porque cada curso tiene sus propios cortes:
 * el «Corte 1» de Bases de Datos y el de Seminario son filas distintas de
 * `grade_cuts`, y la pregunta del docente —«¿cómo viene el Corte 1 de todo el
 * periodo?»— los trata como el mismo. El nombre se normaliza sin distinguir
 * mayúsculas ni espacios de más, que es como difieren en la práctica.
 */
export function unirPorNombreDeCorte(
  porCurso: ReadonlyArray<readonly PendientesDeCorte[]>,
): PendientesDeCorte[] {
  const acc = new Map<string, PendientesDeCorte>();
  for (const lista of porCurso) {
    for (const p of lista) {
      const clave = p.cutName.trim().toLowerCase();
      const previo = acc.get(clave);
      if (!previo) {
        acc.set(clave, { ...p, cutId: clave });
        continue;
      }
      previo.actividades += p.actividades;
      previo.estudiantes += p.estudiantes;
      previo.esperadas += p.esperadas;
      previo.calificadas += p.calificadas;
      previo.porCalificar += p.porCalificar;
      previo.enCurso += p.enCurso;
      previo.sinEmpezar += p.sinEmpezar;
      previo.estudiantesSinNingunaNota += p.estudiantesSinNingunaNota;
      previo.estudiantesSinEmpezarNada += p.estudiantesSinEmpezarNada;
      previo.pctSinCalificar =
        previo.esperadas === 0
          ? null
          : Math.round(((previo.esperadas - previo.calificadas) / previo.esperadas) * 1000) / 10;
      previo.estado = combinarEstado(previo.estado, p.estado);
    }
  }
  // Orden por nombre: «Corte 1», «Corte 2»… con numérico para que 10 no vaya
  // antes que 2.
  return [...acc.values()].sort((a, b) =>
    a.cutName.localeCompare(b.cutName, "es", { numeric: true }),
  );
}

/**
 * Estado combinado de un corte que vive en varios cursos.
 *
 * «En curso» gana a todo, y «terminado» solo si TODOS terminaron: si a un solo
 * curso le queda el corte abierto, dar el conjunto por cerrado esconde trabajo
 * que todavía se puede hacer.
 */
function combinarEstado(a: EstadoDeCorte, b: EstadoDeCorte): EstadoDeCorte {
  if (a === b) return a;
  if (a === "en_curso" || b === "en_curso") return "en_curso";
  if (a === "sin_fechas" || b === "sin_fechas") return "sin_fechas";
  // Uno futuro y otro terminado: hay trabajo vivo en el medio.
  return "en_curso";
}
