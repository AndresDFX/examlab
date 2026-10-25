/**
 * Bloque de LOGÍSTICA del curso para el Tutor IA — helpers PUROS.
 *
 * Arma el texto «Calendario del curso» que se concatena al material del tutor
 * para que pueda responder «¿cuándo es el Parcial 2?», «¿hasta cuándo el
 * taller?», «¿qué me falta entregar?», «¿cuándo es la próxima clase?». NO hay
 * clasificador de intención: el bloque va SIEMPRE en el contexto (compacto) y el
 * prompt decide qué usar.
 *
 * La fuente de verdad de la logística es lo PUBLICADO en la plataforma, y SOLO
 * lo que ESE estudiante ve: status publicado, asignado a él, sin papelera, del
 * curso de la sesión de chat. Esas condiciones las aplica el handler del edge
 * (que usa el admin client y filtra a mano); acá solo van las transformaciones
 * puras: formato de fecha en Bogotá con día de la semana, estado de entrega
 * (misma lista negra que `src/modules/submissions/entrega-hecha.ts`), y el
 * armado/ordenado/recorte del bloque.
 *
 * Invariante cross-file: `ESTADOS_SIN_ENTREGAR_LOGISTICA` debe coincidir con
 * `ESTADOS_SIN_ENTREGAR` de `src/modules/submissions/entrega-hecha.ts` (Deno no
 * importa de src). Lo verifica `src/modules/tutor/logistica-tutor.test.ts`.
 */

const TZ = "America/Bogota";

// Ventana de la logística: lo útil es lo cercano. Lo muy viejo o lo muy lejano
// (otro corte que arranca en mes y medio) solo mete ruido.
export const DIAS_ATRAS = 21;
export const DIAS_ADELANTE = 90;
const MS_DIA = 86_400_000;

// Topes (defensivos; con la ventana un curso normal queda muy por debajo).
const MAX_ACTIVIDADES = 30;
const MAX_SESIONES_PROXIMAS = 8;
const MAX_SESIONES_CON_GRABACION = 6;
// Tope global del bloque pedido por el dueño (~2.500 caracteres).
export const MAX_CHARS_BLOQUE = 2500;

/**
 * Estados en los que la fila existe pero el estudiante NO entregó todavía.
 * COPIA de `ESTADOS_SIN_ENTREGAR` de `src/modules/submissions/entrega-hecha.ts`.
 */
export const ESTADOS_SIN_ENTREGAR_LOGISTICA: readonly string[] = [
  "en_progreso",
  "iniciado",
  "borrador",
  "draft",
  "pendiente",
  "no_entregado",
];

/** ¿Este `status` representa una entrega REAL? Nulo o desconocido → sí. */
export function entregaRealizada(status: string | null | undefined): boolean {
  if (!status) return true;
  return !ESTADOS_SIN_ENTREGAR_LOGISTICA.includes(status.trim());
}

// ── Formato de fecha en hora de Bogotá, con día de la semana ─────────────

function fmtFechaLarga(d: Date): string {
  // "jueves, 5 de noviembre" → quitamos la coma para "jueves 5 de noviembre".
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  })
    .format(d)
    .replace(",", "");
}

function fmtHora(d: Date): string {
  // "6:30 p. m."
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

/** Un timestamptz ISO → «jueves 5 de noviembre, 6:30 p. m.» (hora de Bogotá). */
export function formatFechaHoraBogota(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return `${fmtFechaLarga(d)}, ${fmtHora(d)}`;
}

/**
 * Una sesión de clase: `fecha` es DATE (YYYY-MM-DD, día de Bogotá) y `hora` es
 * TIME (HH:MM[:SS], hora de pared de Bogotá). Bogotá es UTC-5 fijo (sin horario
 * de verano), así que anclamos con el offset -05:00. Sin hora, solo el día.
 */
export function formatFechaSesionBogota(
  fecha: string,
  hora?: string | null,
): string | null {
  if (!fecha) return null;
  const hhmmss = hora ? (hora.length === 5 ? `${hora}:00` : hora.slice(0, 8)) : "12:00:00";
  const d = new Date(`${fecha}T${hhmmss}-05:00`);
  if (!Number.isFinite(d.getTime())) return null;
  return hora ? `${fmtFechaLarga(d)}, ${fmtHora(d)}` : fmtFechaLarga(d);
}

/** Fecha de hoy en Bogotá como YYYY-MM-DD (para comparar con session_date). */
export function hoyBogotaISO(ahora: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ahora));
}

// ── Shapes que recibe el armado (ya resueltos por el handler) ────────────

export interface ActividadLog {
  tipo: "examen" | "taller" | "proyecto";
  titulo: string;
  /** timestamptz ISO (exam.start_time); null si no aplica. */
  inicioIso: string | null;
  /** timestamptz ISO (exam.end_time / due_date); null si no tiene plazo. */
  cierreIso: string | null;
  corteNombre: string | null;
  /** % de la nota FINAL del curso en este curso (ya resuelto). */
  peso: number;
  /** Externa: presencial o en otra herramienta, no se entrega en la plataforma. */
  externa: boolean;
  /** ¿Este estudiante ya entregó (individual o por su grupo)? */
  entrego: boolean;
  /** Supletorio / recuperatorio. */
  esRecuperacion: boolean;
  /** Etiqueta de la recuperación ("Supletorio" / "Recuperatorio"). */
  makeupLabel?: string | null;
}

export interface SesionLog {
  titulo: string | null;
  /** session_date (YYYY-MM-DD). */
  fecha: string;
  /** start_time (HH:MM[:SS]) o null. */
  hora: string | null;
  /** presencial / virtual / autonoma. */
  tipo: string | null;
  tieneGrabacion: boolean;
}

// ── Armado del bloque ────────────────────────────────────────────────────

const TIPO_LABEL: Record<ActividadLog["tipo"], string> = {
  examen: "Examen",
  taller: "Taller",
  proyecto: "Proyecto",
};

function tipoSesionLabel(tipo: string | null): string {
  if (tipo === "presencial") return "presencial";
  if (tipo === "autonoma") return "autónoma";
  return "virtual";
}

/** Fecha de referencia de una actividad (para ventana y orden): cierre, si no inicio. */
function refActividad(a: ActividadLog): number | null {
  const c = a.cierreIso ? Date.parse(a.cierreIso) : Number.NaN;
  if (Number.isFinite(c)) return c;
  const i = a.inicioIso ? Date.parse(a.inicioIso) : Number.NaN;
  return Number.isFinite(i) ? i : null;
}

function lineaActividad(a: ActividadLog): string {
  const base = a.esRecuperacion
    ? `${a.makeupLabel || "Recuperación"} de ${TIPO_LABEL[a.tipo].toLowerCase()}`
    : TIPO_LABEL[a.tipo];
  const partes: string[] = [`- ${base} «${a.titulo}»`];
  const meta: string[] = [];
  if (a.corteNombre) meta.push(a.corteNombre);
  meta.push(`${a.peso}% de la nota final`);
  partes.push(` (${meta.join(", ")}).`);
  if (a.externa) {
    partes.push(" Actividad EXTERNA (presencial o en otra herramienta): no se entrega en la plataforma.");
  }
  // El formato de hora termina en «p. m.» / «a. m.» (con punto), así que no
  // agregamos otro para no dejar «6:50 p. m..».
  const conPunto = (s: string) => (s.endsWith(".") ? s : s + ".");
  const abre = formatFechaHoraBogota(a.inicioIso);
  const cierra = formatFechaHoraBogota(a.cierreIso);
  if (abre && a.tipo === "examen") partes.push(` Abre: ${conPunto(abre)}`);
  if (cierra) partes.push(` ${a.tipo === "examen" ? "Cierra" : "Entrega hasta"}: ${conPunto(cierra)}`);
  else if (!abre) partes.push(" Sin fecha definida todavía.");
  if (!a.externa) {
    partes.push(a.entrego ? " Ya entregaste." : " Pendiente de entregar.");
  }
  return partes.join("");
}

function lineaSesion(s: SesionLog, conGrabacion: boolean): string {
  const cuando = formatFechaSesionBogota(s.fecha, s.hora);
  const titulo = s.titulo ? `«${s.titulo}»` : "Clase";
  if (conGrabacion) {
    return `- ${titulo} — ${cuando ?? s.fecha} (${tipoSesionLabel(s.tipo)}). Tiene grabación disponible (míra la grabación en Cursos o Asistencia).`;
  }
  return `- ${titulo} — ${cuando ?? s.fecha} (${tipoSesionLabel(s.tipo)}).`;
}

/**
 * Arma el bloque de logística. Devuelve "" si no hay NADA que mostrar (para no
 * gastar presupuesto ni invitar a inventar). El handler ya filtró a lo
 * publicado + asignado + sin papelera del curso de la sesión.
 */
export function construirBloqueLogistica(args: {
  ahora: number;
  actividades: ActividadLog[];
  sesiones: SesionLog[];
}): string {
  const { ahora, actividades, sesiones } = args;
  const desde = ahora - DIAS_ATRAS * MS_DIA;
  const hasta = ahora + DIAS_ADELANTE * MS_DIA;
  const hoy = hoyBogotaISO(ahora);

  // Actividades en ventana (las sin fecha se incluyen: siguen pendientes).
  const actsEnVentana = actividades.filter((a) => {
    const ref = refActividad(a);
    if (ref == null) return true;
    return ref >= desde && ref <= hasta;
  });
  actsEnVentana.sort((a, b) => {
    const ra = refActividad(a);
    const rb = refActividad(b);
    if (ra == null && rb == null) return 0;
    if (ra == null) return 1; // sin fecha al final
    if (rb == null) return -1;
    return ra - rb;
  });
  const acts = actsEnVentana.slice(0, MAX_ACTIVIDADES);

  // Sesiones: próximas (hoy o después) y recientes con grabación (antes de hoy,
  // dentro de la ventana hacia atrás).
  const desdeDia = hoyBogotaISO(desde);
  const proximas = sesiones
    .filter((s) => s.fecha >= hoy)
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .slice(0, MAX_SESIONES_PROXIMAS);
  const conGrabacion = sesiones
    .filter((s) => s.fecha < hoy && s.fecha >= desdeDia && s.tieneGrabacion)
    .sort((a, b) => b.fecha.localeCompare(a.fecha))
    .slice(0, MAX_SESIONES_CON_GRABACION);

  if (acts.length === 0 && proximas.length === 0 && conGrabacion.length === 0) {
    return "";
  }

  const bloques: string[] = [
    "## Calendario del curso (datos de ExamLab — fuente de verdad para fechas y entregas)",
    "Solo incluye lo PUBLICADO y asignado a este estudiante; las fechas y horas están en hora de Colombia (America/Bogota). Si algo no aparece aquí, NO lo inventes: dile al estudiante que lo verifique en el calendario del curso o con el docente.",
  ];

  if (acts.length > 0) {
    bloques.push("### Exámenes, talleres y proyectos");
    for (const a of acts) bloques.push(lineaActividad(a));
  }
  if (proximas.length > 0) {
    bloques.push("### Próximas clases");
    for (const s of proximas) bloques.push(lineaSesion(s, false));
  }
  if (conGrabacion.length > 0) {
    bloques.push("### Clases recientes con grabación");
    for (const s of conGrabacion) bloques.push(lineaSesion(s, true));
  }

  let texto = bloques.join("\n");
  if (texto.length > MAX_CHARS_BLOQUE) {
    texto = texto.slice(0, MAX_CHARS_BLOQUE).trimEnd() + " …";
  }
  return texto;
}
