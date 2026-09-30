/**
 * La nota de UN estudiante en UN curso, armada una sola vez para las tres
 * pantallas que la muestran: el libro de calificaciones del docente, «Mis
 * notas» del estudiante y el boletín/acta del informe. Cada una carga sus
 * datos a su manera (el docente ve las entregas de todos; el estudiante, solo
 * las suyas) y los normaliza a `DatosParaNota`; de ahí en adelante el cálculo
 * es ESTE, así que no pueden dar números distintos.
 *
 * Estaba escrito tres veces, y las tres copias ya habían divergido: con un
 * peso vacío, el libro y «Mis notas» contaban 1 % y el boletín 0 %; el libro
 * leía el peso de la fila del curso y el acta caía a la del taller. La regla
 * de qué cuenta vive en nota-relativa.ts; su espejo en SQL es el acta.
 */
import { esIntentoFinalizado, type AttemptForGrade } from "@/modules/exams/exam-attempts";
import { entregaHecha } from "@/modules/submissions/entrega-hecha";
import { diaDe } from "@/shared/lib/rango-de-fechas";
import { notaEfectivaDeTaller } from "./nota-efectiva";
import {
  notaDeExamenParaEstudiante,
  notaDeTallerConRecuperaciones,
  type FilaDeExamen,
  type FilaDeTaller,
  type FuenteDeNota,
} from "./nota-con-recuperacion";
import {
  actividadConRecuperacionesSeDio,
  actividadCuenta,
  asistenciaDelCorte,
  corteYPesoEnCurso,
  notaDelEstudiante,
  pesoEfectivo,
  type AsistenciaDelCorte,
  type CorteParaNota,
  type EstadoDeActividad,
  type ItemDeNota,
  type NotaDelEstudiante,
} from "./nota-relativa";

export interface ExamenParaNota extends FilaDeExamen {
  cut_id?: string | null;
  weight?: number | null;
  end_time?: string | null;
  is_external?: boolean | null;
}

export interface TallerParaNota extends FilaDeTaller {
  course_id?: string | null;
  cut_id?: string | null;
  weight?: number | null;
  due_date?: string | null;
  is_external?: boolean | null;
  max_score?: number | null;
  requires_defense?: boolean | null;
}

export interface ProyectoParaNota {
  id: string;
  course_id?: string | null;
  cut_id?: string | null;
  weight?: number | null;
  due_date?: string | null;
  is_external?: boolean | null;
  max_score?: number | null;
  status?: string | null;
}

export interface FilaDeUnion {
  cut_id?: string | null;
  weight?: number | null;
}

export interface EntregaConNota {
  status?: string | null;
  ai_grade?: number | null;
  final_grade?: number | null;
}

/** Lo que el curso aporta, igual para todos sus estudiantes. */
export interface DatosParaNota {
  courseId: string;
  escala: { min: number; max: number };
  /**
   * Curso finalizado: toda actividad en línea cuenta como dada, aunque su plazo
   * figure en el futuro — el curso terminó y ya no hay nada que esperar. Las
   * externas siguen necesitando una nota cargada y las sesiones, una marca.
   */
  cursoFinalizado?: boolean;
  cortes: readonly CorteParaNota[];
  /** Sin papelera ni borradores; incluye las recuperaciones. */
  examenes: readonly ExamenParaNota[];
  /** Los del curso (por la fila de unión o por ser su curso ancla), sin papelera ni borradores. */
  talleres: readonly TallerParaNota[];
  unionTalleres: ReadonlyMap<string, FilaDeUnion>;
  proyectos: readonly ProyectoParaNota[];
  unionProyectos: ReadonlyMap<string, FilaDeUnion>;
  /** Sin papelera. `session_date` (DATE) solo decide si la nota es parcial. */
  sesiones: readonly { id: string; cut_id?: string | null; session_date?: string | null }[];
  /** Las que tienen al menos una marca (`sesionesDadas`). */
  sesionesDadas: ReadonlySet<string>;
  /** Actividades en las que algún estudiante del curso ya tiene nota. */
  conNota: {
    examenes: ReadonlySet<string>;
    talleres: ReadonlySet<string>;
    proyectos: ReadonlySet<string>;
  };
}

/** Lo que es de UN estudiante. */
export interface DatosDelEstudiante {
  /** Sus intentos de examen (de cualquier examen del curso). */
  intentos: readonly (AttemptForGrade & { exam_id: string })[];
  /** Su entrega del taller: la del grupo antes que la individual vieja. */
  entregaTaller: (workshopId: string) => EntregaConNota | undefined;
  /** Ídem proyectos. */
  entregaProyecto: (projectId: string) => EntregaConNota | undefined;
  /** El `status` de su marca de asistencia en la sesión, si tiene. */
  estadoAsistencia: (sessionId: string) => string | null | undefined;
  /**
   * Lo que tiene ASIGNADO (ids de exámenes, talleres y proyectos, recuperaciones
   * incluidas). Una en línea sin asignar no la pudo ver: sin entrega no le
   * cuenta. Sin el dato (undefined) todo se toma como asignado.
   */
  asignaciones?: {
    examenes: ReadonlySet<string>;
    talleres: ReadonlySet<string>;
    proyectos: ReadonlySet<string>;
  };
}

export type TipoDeItem = "examen" | "taller" | "proyecto";

export interface DetalleDeItem extends ItemDeNota {
  tipo: TipoDeItem;
  id: string;
  /** Si ya se dio (ver nota-relativa.ts). */
  seDio: boolean;
  /** Si presentó algo (original o recuperación). */
  entrego: boolean;
  /** Si la tiene asignada (ella o una recuperación). */
  asignada: boolean;
  /** De dónde salió la nota; `original` si no hubo recuperación. */
  fuente: FuenteDeNota | null;
  /** La actividad de donde salió la nota (para el enlace de revisión). */
  idFuente: string | null;
}

export interface NotaCompleta extends NotaDelEstudiante {
  items: DetalleDeItem[];
  asistencia: Map<string, AsistenciaDelCorte>;
  /**
   * La nota todavía puede cambiar: queda una actividad del curso abierta o
   * entregada sin calificar, o una sesión por darse. Es la nota de lo que ya
   * pasó, no la definitiva — y con ella NO se emite un certificado: a mitad de
   * semestre, quien lleva bien lo hecho «aprueba» un curso que no terminó.
   */
  parcial: boolean;
}

const vigente = (s: string | null | undefined, borrado: string | null | undefined) =>
  s !== "draft" && !borrado;

/**
 * Las recuperaciones que le tocan al estudiante: las que tiene asignadas. Sin el
 * dato de asignaciones, todas (las del estudiante ya vienen filtradas por la RLS).
 */
function recuperacionesDelEstudiante<T extends { id: string }>(
  recs: readonly T[],
  asignadas: ReadonlySet<string> | undefined,
): readonly T[] {
  return asignadas ? recs.filter((r) => asignadas.has(r.id)) : recs;
}

/** Escala una nota cruda (0..tope) a la del curso — la misma fórmula del libro. */
export function aEscalaDelCurso(raw: number, tope: number, escala: { min: number; max: number }) {
  const pct = tope > 0 ? raw / tope : 0;
  return escala.min + pct * (escala.max - escala.min);
}

/**
 * Qué actividades ya tienen alguna nota, a partir de las entregas de TODOS los
 * estudiantes. El docente y el boletín lo calculan acá; el estudiante, que no
 * ve las entregas ajenas, lo recibe del servidor (`senales_nota_relativa`), con
 * la misma definición.
 */
export function actividadesConNota(args: {
  intentos: readonly (AttemptForGrade & { exam_id: string })[];
  entregasTaller: readonly (EntregaConNota & { workshop_id: string })[];
  talleres: readonly TallerParaNota[];
  entregasProyecto: readonly (EntregaConNota & { project_id: string })[];
}): DatosParaNota["conNota"] {
  const examenes = new Set<string>();
  for (const s of args.intentos) {
    if (esIntentoFinalizado(s) && (s.final_override_grade ?? s.ai_grade) != null) {
      examenes.add(s.exam_id);
    }
  }
  const sustentacion = new Map(args.talleres.map((w) => [w.id, !!w.requires_defense]));
  const talleres = new Set<string>();
  for (const s of args.entregasTaller) {
    if (notaEfectivaDeTaller(s, sustentacion.get(s.workshop_id)) != null) talleres.add(s.workshop_id);
  }
  const proyectos = new Set<string>();
  for (const s of args.entregasProyecto) {
    if ((s.final_grade ?? s.ai_grade) != null) proyectos.add(s.project_id);
  }
  return { examenes, talleres, proyectos };
}

export function notaDelEstudianteEnCurso(
  d: DatosParaNota,
  e: DatosDelEstudiante,
  ahora: number,
): NotaCompleta {
  const items: DetalleDeItem[] = [];
  // Con el curso finalizado, una en línea ya se dio aunque su plazo diga otra
  // cosa: se marca como cerrada. La externa se deja igual (necesita una nota).
  const cerrarSiFinalizado = (a: EstadoDeActividad): EstadoDeActividad =>
    d.cursoFinalizado && !a.externa ? { ...a, estado: "closed" } : a;
  // Asignada si lo está ella o alguna de sus recuperaciones; sin el dato, sí.
  const asignadaEn = (conjunto: ReadonlySet<string> | undefined, ids: readonly string[]) =>
    conjunto ? ids.some((id) => conjunto.has(id)) : true;

  // ── Exámenes (solo originales: la recuperación se pliega en el suyo) ──
  const estadoExamen = (x: ExamenParaNota): EstadoDeActividad =>
    cerrarSiFinalizado({
      externa: !!x.is_external,
      estado: x.status,
      cierre: x.end_time,
      alguienConNota: d.conNota.examenes.has(x.id),
    });
  for (const ex of d.examenes) {
    if (ex.parent_exam_id) continue;
    const recs = d.examenes.filter(
      (r) => r.parent_exam_id === ex.id && vigente(r.status, r.deleted_at),
    );
    const r = notaDeExamenParaEstudiante(ex, d.examenes, e.intentos);
    const ids = new Set([ex.id, ...recs.map((x) => x.id)]);
    const entrego = e.intentos.some((i) => ids.has(i.exam_id) && esIntentoFinalizado(i));
    // Solo espera por las recuperaciones que le TOCAN: un supletorio abierto de
    // otros no le deja pendiente la nota a quien no lo puede presentar.
    const recsSuyas = recuperacionesDelEstudiante(recs, e.asignaciones?.examenes);
    const seDio = actividadConRecuperacionesSeDio(estadoExamen(ex), recsSuyas.map(estadoExamen), ahora);
    const externa = !!ex.is_external;
    const nota = r.nota != null ? aEscalaDelCurso(Number(r.nota), d.escala.max, d.escala) : null;
    const asignada = asignadaEn(e.asignaciones?.examenes, [...ids]);
    items.push({
      tipo: "examen",
      id: ex.id,
      cutId: ex.cut_id ?? null,
      weight: pesoEfectivo(ex.weight),
      score: nota,
      cuenta: actividadCuenta({ nota, seDio, externa, entrego, asignada }),
      seDio,
      entrego,
      asignada,
      fuente: r.fuente,
      idFuente: r.examIdFuente,
    });
  }

  // ── Talleres ──
  const estadoTaller = (w: TallerParaNota): EstadoDeActividad =>
    cerrarSiFinalizado({
      externa: !!w.is_external,
      estado: w.status,
      cierre: w.due_date,
      alguienConNota: d.conNota.talleres.has(w.id),
    });
  const tallerPorId = new Map(d.talleres.map((w) => [w.id, w]));
  const notaDeTaller = (wid: string) => {
    const w = tallerPorId.get(wid);
    const sub = e.entregaTaller(wid);
    const raw = notaEfectivaDeTaller(sub ?? null, w?.requires_defense);
    const tope = w?.is_external ? d.escala.max : (w?.max_score ?? 100);
    return {
      id: wid,
      presento: entregaHecha(sub ?? null),
      nota: raw != null ? aEscalaDelCurso(Number(raw), tope, d.escala) : null,
    };
  };
  for (const w of d.talleres) {
    if (w.parent_workshop_id) continue;
    const recs = d.talleres.filter(
      (r) => r.parent_workshop_id === w.id && vigente(r.status, r.deleted_at),
    );
    const r = notaDeTallerConRecuperaciones(
      { id: w.id, parent_workshop_id: null },
      d.talleres,
      notaDeTaller,
    );
    const entrego = [w, ...recs].some((x) => entregaHecha(e.entregaTaller(x.id) ?? null));
    const recsSuyas = recuperacionesDelEstudiante(recs, e.asignaciones?.talleres);
    const seDio = actividadConRecuperacionesSeDio(estadoTaller(w), recsSuyas.map(estadoTaller), ahora);
    const externa = !!w.is_external;
    const { cutId, weight } = corteYPesoEnCurso(d.unionTalleres.get(w.id), w, d.courseId);
    const asignada = asignadaEn(e.asignaciones?.talleres, [w.id, ...recs.map((x) => x.id)]);
    items.push({
      tipo: "taller",
      id: w.id,
      cutId,
      weight,
      score: r.nota,
      cuenta: actividadCuenta({ nota: r.nota, seDio, externa, entrego, asignada }),
      seDio,
      entrego,
      asignada,
      fuente: r.fuente,
      idFuente: r.idFuente,
    });
  }

  // ── Proyectos ──
  for (const p of d.proyectos) {
    const sub = e.entregaProyecto(p.id);
    const raw = sub ? (sub.final_grade ?? sub.ai_grade ?? null) : null;
    const tope = p.is_external ? d.escala.max : (p.max_score ?? 100);
    const nota = raw != null ? aEscalaDelCurso(Number(raw), tope, d.escala) : null;
    const externa = !!p.is_external;
    const entrego = entregaHecha(sub ?? null);
    const seDio = actividadConRecuperacionesSeDio(
      cerrarSiFinalizado({
        externa,
        estado: p.status,
        cierre: p.due_date,
        alguienConNota: d.conNota.proyectos.has(p.id),
      }),
      [],
      ahora,
    );
    const { cutId, weight } = corteYPesoEnCurso(d.unionProyectos.get(p.id), p, d.courseId);
    const asignada = asignadaEn(e.asignaciones?.proyectos, [p.id]);
    items.push({
      tipo: "proyecto",
      id: p.id,
      cutId,
      weight,
      score: nota,
      cuenta: actividadCuenta({ nota, seDio, externa, entrego, asignada }),
      seDio,
      entrego,
      asignada,
      fuente: nota != null ? "original" : null,
      idFuente: nota != null ? p.id : null,
    });
  }

  // ── Asistencia por corte, sobre las sesiones que se dieron ──
  const asistencia = new Map<string, AsistenciaDelCorte>();
  for (const cut of d.cortes) {
    asistencia.set(
      cut.id,
      asistenciaDelCorte(
        d.sesiones.filter((s) => s.cut_id === cut.id),
        d.sesionesDadas,
        e.estadoAsistencia,
        d.escala,
      ),
    );
  }

  return {
    ...notaDelEstudiante(d.cortes, items, asistencia),
    items,
    asistencia,
    parcial: notaEsParcial(d, items, ahora),
  };
}

/**
 * ¿Algo del curso todavía puede mover la nota? Solo mira lo que SUMA: una
 * actividad sin corte o sin peso no cambia nada, y una sesión de un corte cuya
 * asistencia pesa 0 tampoco. Una sesión que ya pasó sin que nadie quedara
 * marcado no se va a dar: no deja la nota abierta. Tampoco una actividad
 * cerrada que no se le asignó: esa ya no va a cambiar para este estudiante.
 */
function notaEsParcial(d: DatosParaNota, items: readonly DetalleDeItem[], ahora: number): boolean {
  const cortes = new Set(d.cortes.map((c) => c.id));
  // Entregada y sin calificar; o abierta, salvo en un curso finalizado: ahí lo
  // único que puede seguir «sin darse» es una externa sin ninguna nota, que ya
  // no se va a dar y no puede dejar la nota abierta para siempre.
  const pendiente = items.some(
    (i) =>
      i.cutId != null &&
      cortes.has(i.cutId) &&
      i.weight > 0 &&
      ((!d.cursoFinalizado && !i.seDio) || (!i.cuenta && i.entrego)),
  );
  if (pendiente) return true;
  if (d.cursoFinalizado) return false;
  const hoy = diaDe(new Date(ahora));
  // Un corte que no terminó puede recibir actividades que el docente todavía no
  // creó: sin esto, un corte vacío dejaba emitir certificados a mitad de semestre.
  if (d.cortes.some((c) => {
    const fin = diaDe(c.end_date ?? null);
    return fin != null && hoy != null && fin >= hoy;
  })) {
    return true;
  }
  const conAsistencia = new Set(
    d.cortes.filter((c) => pesoEfectivo(c.attendance_weight) > 0).map((c) => c.id),
  );
  return d.sesiones.some((s) => {
    if (!s.cut_id || !conAsistencia.has(s.cut_id) || d.sesionesDadas.has(s.id)) return false;
    const dia = diaDe(s.session_date ?? null);
    return dia != null && hoy != null && dia >= hoy;
  });
}
