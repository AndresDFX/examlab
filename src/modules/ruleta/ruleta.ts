/**
 * Ruleta del curso: elegir al azar entre los estudiantes (o los grupos) para
 * una actividad —quién pasa al tablero, qué grupo expone primero—.
 *
 * PURO: sin React ni Supabase. Acá vive lo que en pantalla no se puede
 * verificar a ojo: que la rueda se detenga EXACTAMENTE en el que se sorteó
 * (si el ángulo final y el sorteo no coinciden, la ruleta «miente» y nadie lo
 * nota), que el sorteo sea parejo, quién entra a la rueda y qué se muestra.
 *
 * Diseño en docs/plans/ruleta-de-estudiantes.md (ver allí lo que se decidió
 * distinto). La ruleta NO escribe en ningún camino de calificación: la
 * consecuencia de salir es pasar al tablero, no una nota.
 */

export interface Participante {
  id: string;
  /** Lo que se escribe en el gajo y en el resultado. */
  etiqueta: string;
  /** Texto extra del resultado (p. ej. los integrantes de un grupo). */
  detalle?: string;
}

/**
 * Azar del navegador (`crypto`), no `Math.random`: si un estudiante reclama
 * que «la ruleta siempre lo elige», el sorteo tiene que poder defenderse.
 */
export function azarCripto(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}

/** Índice al azar en `[0, n)`; -1 si no hay nadie. */
export function elegirIndice(n: number, azar: () => number = azarCripto): number {
  if (n <= 0) return -1;
  return Math.min(n - 1, Math.floor(azar() * n));
}

const normalizar = (grados: number) => ((grados % 360) + 360) % 360;

/**
 * Qué gajo queda bajo el puntero (arriba, a las 12) con la rueda girada
 * `rotacion` grados en sentido horario. Los gajos se numeran en sentido
 * horario desde las 12: el gajo `i` ocupa `[i·s, (i+1)·s)` con `s = 360/n`.
 */
export function indiceBajoElPuntero(rotacion: number, n: number): number {
  if (n <= 0) return -1;
  const s = 360 / n;
  return Math.min(n - 1, Math.floor(normalizar(-rotacion) / s));
}

/**
 * Rotación final para que el gajo `indice` quede bajo el puntero después de
 * `vueltas` vueltas completas. `fraccion` (0..1) decide en qué parte del gajo
 * cae el puntero, siempre lejos de los bordes: caer justo en una línea haría
 * dudar de a quién le tocó.
 *
 * Siempre CRECE respecto de `actual` (acumulativa): si volviera a 0, el
 * siguiente giro iría hacia atrás.
 */
export function rotacionParaCaerEn(
  actual: number,
  indice: number,
  n: number,
  vueltas: number,
  fraccion: number,
): number {
  const s = 360 / n;
  const f = Math.min(Math.max(fraccion, 0), 1);
  const objetivo = indice * s + s * (0.15 + 0.7 * f); // ángulo dentro de la rueda
  const delta = normalizar(-objetivo - normalizar(actual));
  return actual + Math.max(0, Math.floor(vueltas)) * 360 + delta;
}

/**
 * Colores de los gajos, cada uno con el texto que se LEE encima (contraste
 * ≥ 4,5:1, lo fija un test). Son dato —distinguir un gajo del vecino, como en
 * la rueda de referencia que pidió el usuario—, no la marca de la institución:
 * con un solo color a dos opacidades, 30 nombres seguidos no se separan.
 */
export const PALETA: ReadonlyArray<{ fondo: string; texto: string }> = [
  { fondo: "#2563eb", texto: "#ffffff" },
  { fondo: "#f59e0b", texto: "#111827" },
  { fondo: "#16a34a", texto: "#111827" },
  { fondo: "#db2777", texto: "#ffffff" },
  { fondo: "#0891b2", texto: "#111827" },
  { fondo: "#a3e635", texto: "#111827" },
  { fondo: "#7c3aed", texto: "#ffffff" },
  { fondo: "#ea580c", texto: "#111827" },
  { fondo: "#0d9488", texto: "#111827" },
  { fondo: "#dc2626", texto: "#ffffff" },
];

/**
 * Color del gajo `i` de `n`. Ciclan, pero el último toca al primero: si los dos
 * quedaran del mismo color, se verían como un solo gajo gigante.
 */
export function colorDeGajo(i: number, n: number): { fondo: string; texto: string } {
  const p = PALETA.length;
  let k = i % p;
  if (n > 1 && i === n - 1 && k === 0) k = Math.floor(p / 2);
  return PALETA[k];
}

/**
 * Hasta cuántos gajos se escribe el nombre. Con más, cada gajo mide menos de
 * 9° y un nombre no se lee: la rueda va sin texto y el nombre sale ENTERO en
 * el resultado (que es lo que de verdad decide).
 */
export const MAX_GAJOS_CON_NOMBRE = 40;

export function gajosConNombre(n: number): boolean {
  return n > 0 && n <= MAX_GAJOS_CON_NOMBRE;
}

/** Cuántos caracteres caben en un gajo: con más gajos, menos espacio. */
export function caracteresPorGajo(n: number): number {
  if (n <= 8) return 22;
  if (n <= 16) return 18;
  if (n <= 30) return 14;
  return 11;
}

/** La etiqueta recortada para que entre en su gajo (el resultado va completo). */
export function etiquetaCorta(texto: string, n: number): string {
  const max = caracteresPorGajo(n);
  const t = texto.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Tamaño de letra (en unidades del dibujo de 400) según cuántos gajos hay. */
export function tamanoDeLetra(n: number): number {
  if (n <= 1) return 18;
  const arco = (2 * Math.PI * 133) / n; // ancho del gajo a la altura del texto
  return Math.max(8, Math.min(16, Math.round(arco * 0.55)));
}

// ── Quién entra a la ruleta ─────────────────────────────────────────────

/** Estados de matrícula con los que alguien ya no está cursando. */
const YA_NO_CURSA = new Set(["retirado", "aplazado", "graduado"]);

/** `estado` es texto libre: lo desconocido (o vacío) cuenta como que sigue. */
export function sigueCursando(estado: string | null | undefined): boolean {
  return !YA_NO_CURSA.has((estado ?? "").trim().toLowerCase());
}

/**
 * ¿El «nombre» es en realidad un identificador? Una cuenta creada sin nombre
 * queda con la parte local del correo como `full_name`, y muchas veces esa
 * parte es el código de matrícula. Proyectarlo frente al curso —y en la
 * grabación de la videollamada— es una fuga que la ruleta no debe causar.
 */
export function pareceIdentificador(nombre: string, correo: string | null | undefined): boolean {
  const n = nombre.trim().toLowerCase();
  if (!n) return true;
  if (/^\d[\d\s.-]*$/.test(n)) return true;
  const local = (correo ?? "").split("@")[0]?.trim().toLowerCase();
  return !!local && n === local;
}

/**
 * Quiénes están en la rueda: los participantes menos los desmarcados y, sin
 * repetir, menos los que ya salieron. El ÚLTIMO elegido se queda mientras se
 * muestra su resultado (`mostrandoA`): sacarlo en el acto reacomodaría la rueda
 * justo cuando todos la están mirando. Sale al girar de nuevo.
 */
export function enLaRueda(
  participantes: readonly Participante[],
  desmarcados: ReadonlySet<string>,
  elegidos: readonly string[],
  opciones: { noRepetir: boolean; mostrandoA: string | null },
): Participante[] {
  const yaSalieron = new Set(opciones.noRepetir ? elegidos : []);
  if (opciones.mostrandoA) yaSalieron.delete(opciones.mostrandoA);
  return participantes.filter((p) => !desmarcados.has(p.id) && !yaSalieron.has(p.id));
}

/** La lista de elegidos para copiar: «1. Ana Pérez» por renglón. */
export function textoDeElegidos(elegidos: readonly Participante[]): string {
  return elegidos.map((e, i) => `${i + 1}. ${e.etiqueta}`).join("\n");
}

// ── Entre quiénes se sortea ─────────────────────────────────────────────

/**
 * Estudiantes del curso o grupos de una actividad. La asistencia NO es una
 * fuente aparte: es un filtro sobre los estudiantes («solo los que asistieron a
 * la sesión»), para que pasar de «los que vinieron» a «todos» sea desmarcar una
 * casilla y no cambiar de lista.
 */
export type FuenteDeRuleta = "curso" | "grupos";

/**
 * Quiénes participan antes de desmarcar a nadie. Con «solo los que asistieron»,
 * mientras no llegan las marcas de la sesión no hay nadie: mostrar a todo el
 * curso un instante y después recortarlo haría saltar la rueda frente a la clase.
 */
export function quienesParticipan(args: {
  fuente: FuenteDeRuleta;
  soloAsistieron: boolean;
  estudiantes: readonly Participante[];
  /** Los presentes de la sesión elegida; `null` = todavía cargando. */
  presentes: ReadonlySet<string> | null;
  /** Los grupos de la actividad elegida; `null` = todavía cargando. */
  grupos: readonly Participante[] | null;
}): Participante[] {
  if (args.fuente === "grupos") return [...(args.grupos ?? [])];
  if (!args.soloAsistieron) return [...args.estudiantes];
  const presentes = args.presentes;
  return presentes ? args.estudiantes.filter((s) => presentes.has(s.id)) : [];
}

// ── Lo que se recuerda ─────────────────────────────────────────────────

/**
 * Si, abierta desde Asistencia, la ruleta arranca con «solo los que
 * asistieron». Es una comodidad de este navegador (`localStorage`), no un dato
 * del curso: cada docente la deja como prefiere.
 */
export const PREFERENCIA_SOLO_ASISTIERON = "examlab_ruleta_solo_asistieron";

/** Sin preferencia guardada, desde Asistencia entran solo los que asistieron. */
export function leerPreferenciaSoloAsistieron(raw: string | null | undefined): boolean {
  return raw !== "0";
}

export const escribirPreferenciaSoloAsistieron = (solo: boolean) => (solo ? "1" : "0");

export interface RondaGuardada {
  fuente: FuenteDeRuleta;
  /** Con fuente «curso»: solo los presentes de `sesionId`. */
  soloAsistieron: boolean;
  sesionId: string;
  actividadKey: string;
  desmarcados: string[];
  elegidos: Participante[];
  noRepetir: boolean;
  /** Giros de la ronda: se muestra para que la clase vea si se repitió el giro. */
  giros: number;
}

export const claveDeRonda = (courseId: string) => `examlab_ruleta:${courseId}`;

/**
 * Con qué arranca la ruleta al abrirse: la ronda guardada en la pestaña, si
 * sigue valiendo, o los valores de partida. Desde Asistencia manda la sesión
 * (la que se tocó, o la última que se dio) y la preferencia del docente.
 *
 * `conservarRonda` dice si los desmarcados, los elegidos y los giros de la
 * ronda guardada siguen aplicando: solo si los participantes son los MISMOS.
 * Con otra sesión u otra fuente, los ids de la ronda anterior no significan
 * nada, y arrastrar «ya salieron» de otra clase confundiría a la de hoy.
 */
export function estadoInicialDeRonda(args: {
  guardada: RondaGuardada | null;
  /** Las sesiones del curso, de la más nueva a la más vieja. */
  sesiones: readonly { id: string; fecha: string }[];
  actividades: readonly { key: string }[];
  /** Hoy, `YYYY-MM-DD` local. */
  hoy: string;
  desdeAsistencia: boolean;
  sesionInicial?: string | null;
  preferenciaSoloAsistieron: boolean;
}): {
  fuente: FuenteDeRuleta;
  soloAsistieron: boolean;
  sesionId: string;
  actividadKey: string;
  conservarRonda: boolean;
} {
  const { guardada, sesiones, actividades } = args;
  const existeSesion = (id: string) => sesiones.some((s) => s.id === id);
  // La clase de hoy o, si hoy no hay, la última que ya se dio.
  const sesionDefecto = sesiones.find((s) => s.fecha <= args.hoy)?.id ?? sesiones[0]?.id ?? "";

  let fuente: FuenteDeRuleta = guardada?.fuente ?? "curso";
  let solo = guardada?.soloAsistieron ?? false;
  let sesionId = guardada?.sesionId && existeSesion(guardada.sesionId) ? guardada.sesionId : sesionDefecto;
  const actividadKey =
    guardada?.actividadKey && actividades.some((a) => a.key === guardada.actividadKey)
      ? guardada.actividadKey
      : (actividades[0]?.key ?? "");
  if (fuente === "grupos" && actividades.length === 0) fuente = "curso";
  if (sesiones.length === 0) solo = false;

  let conservarRonda =
    !!guardada && fuente === guardada.fuente && (fuente === "grupos" || solo === guardada.soloAsistieron);
  if (fuente === "curso" && solo && guardada?.sesionId !== sesionId) conservarRonda = false;
  if (fuente === "grupos" && guardada?.actividadKey !== actividadKey) conservarRonda = false;

  if (args.desdeAsistencia && sesiones.length > 0) {
    const sId = args.sesionInicial && existeSesion(args.sesionInicial) ? args.sesionInicial : sesionDefecto;
    const nuevoSolo = args.preferenciaSoloAsistieron;
    const mismosParticipantes =
      conservarRonda && fuente === "curso" && solo === nuevoSolo && (!nuevoSolo || sesionId === sId);
    if (!mismosParticipantes) conservarRonda = false;
    fuente = "curso";
    solo = nuevoSolo;
    sesionId = sId;
  }

  return { fuente, soloAsistieron: solo, sesionId, actividadKey, conservarRonda };
}

/**
 * Lee la ronda guardada sin confiar en su forma: viene del navegador, puede ser
 * de una versión anterior o estar a medio escribir. Lo que no encaja se descarta
 * campo por campo; un JSON roto es «no hay ronda».
 */
export function leerRondaGuardada(raw: string | null | undefined): RondaGuardada | null {
  if (!raw) return null;
  let g: unknown;
  try {
    g = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!g || typeof g !== "object") return null;
  const o = g as Record<string, unknown>;
  if (o.fuente !== "curso" && o.fuente !== "sesion" && o.fuente !== "grupos") return null;
  const texto = (v: unknown) => (typeof v === "string" ? v : "");
  // «sesion» era una fuente aparte en la primera versión: hoy es el curso con
  // el filtro de asistencia puesto. Una ronda de esa versión sigue valiendo.
  const deSesion = o.fuente === "sesion";
  return {
    fuente: o.fuente === "grupos" ? "grupos" : "curso",
    soloAsistieron: deSesion || o.soloAsistieron === true,
    sesionId: texto(o.sesionId),
    actividadKey: texto(o.actividadKey),
    desmarcados: Array.isArray(o.desmarcados)
      ? o.desmarcados.filter((x): x is string => typeof x === "string")
      : [],
    elegidos: Array.isArray(o.elegidos)
      ? o.elegidos
          .filter(
            (e): e is Participante =>
              !!e &&
              typeof e === "object" &&
              typeof (e as Participante).id === "string" &&
              typeof (e as Participante).etiqueta === "string",
          )
          .map((e) => ({
            id: e.id,
            etiqueta: e.etiqueta,
            ...(typeof e.detalle === "string" ? { detalle: e.detalle } : {}),
          }))
      : [],
    noRepetir: o.noRepetir !== false,
    giros: typeof o.giros === "number" && Number.isFinite(o.giros) && o.giros >= 0 ? Math.floor(o.giros) : 0,
  };
}
