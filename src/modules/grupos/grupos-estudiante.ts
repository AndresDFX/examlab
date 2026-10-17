/**
 * Grupos que arman los propios estudiantes (talleres y proyectos).
 *
 * Las reglas —una persona por grupo, solo compañeros de su curso, tope de
 * integrantes, nada cambia cuando el grupo ya entregó o pasó el plazo— viven en
 * la base (mig 20262830000000): las tablas de grupos solo las escribe el staff,
 * así que las RPC son el único camino del estudiante. Acá está solo lo que la
 * PANTALLA decide: qué mostrar en la tarjeta, cuándo habilitar «Crear grupo» y
 * qué manda el formulario del docente. Puro, sin red, con tests.
 */

export type TipoActividadGrupal = "proyecto" | "taller";

/** Por qué el estudiante NO puede armar o cambiar su grupo ahora. Son los
 *  códigos que devuelve `_grupo_est_situacion` (NULL = sí puede); un test lee
 *  la migración y falla si la lista de la base y esta se separan. */
export const MOTIVOS_GRUPO_CERRADO = [
  "no_encontrada",
  "no_asignada",
  "no_publicada",
  "externa",
  "individual",
  "los_arma_el_docente",
  "plazo_vencido",
  "grupo_entregado",
] as const;
export type MotivoGrupoCerrado = (typeof MOTIVOS_GRUPO_CERRADO)[number];

export type ModoDeGrupo = "individual" | "teacher_assigned" | "self_signup" | "group_required";

export interface ResumenDeGrupo {
  motivo: MotivoGrupoCerrado | null;
  modo: ModoDeGrupo;
  arman_estudiantes: boolean;
  externa: boolean;
  minimo: number;
  maximo: number;
  grupo: {
    id: string;
    nombre: string;
    integrantes: number;
    entregado: boolean;
    /** Lo agrega `cargarResumenDeGrupos`, no la RPC: ver `armadoPorElDocente`. */
    armado_por_docente?: boolean;
  } | null;
  individual: { entregada: boolean } | null;
}

/** `por_su_cuenta`: entregó o empezó de forma individual. La base no dice cuál
 *  de las dos a propósito: sería mostrarle a un estudiante el avance de otro. */
export type EstadoDeCompanero = "disponible" | "en_grupo" | "por_su_cuenta";

export interface Companero {
  id: string;
  nombre: string;
  grupo: string | null;
  estado: EstadoDeCompanero;
}

export interface EstadoDeGrupo {
  motivo: MotivoGrupoCerrado | null;
  modo: ModoDeGrupo;
  arman_estudiantes: boolean;
  externa: boolean;
  minimo: number;
  maximo: number;
  grupo: {
    id: string;
    nombre: string;
    entregado: boolean;
    integrantes: { id: string; nombre: string }[];
    /** Lo agrega `cargarEstadoDeGrupo`, no la RPC: ver `armadoPorElDocente`. */
    armado_por_docente?: boolean;
  } | null;
  individual: { id: string; entregada: boolean } | null;
  companeros: Companero[];
}

/** Los dos modos con grupos: grupal estricto y mixto. */
export function esModoGrupal(modo: string | null | undefined): boolean {
  return modo === "group_required" || modo === "teacher_assigned";
}

/** Lo que la tarjeta de la actividad muestra sobre el grupo del estudiante. */
export type GrupoEnLaTarjeta =
  | { tipo: "nada" }
  | {
      tipo: "con_grupo";
      nombre: string;
      integrantes: number;
      entregado: boolean;
      /** Puede agregar compañeros o salirse (los arman los estudiantes, en plazo, sin entregar). */
      puedeCambiar: boolean;
      /** Quedó por debajo del mínimo (alguien se salió): se avisa, no se impide. */
      bajoElMinimo: boolean;
      minimo: number;
    }
  | {
      tipo: "armar";
      /** Grupal estricto: sin grupo no puede entregar. En mixto, armarlo es opcional. */
      estricto: boolean;
      /** Tiene un borrador individual sin entregar, que pasará a ser del grupo. */
      conBorrador: boolean;
    };

export function grupoEnLaTarjeta(resumen: ResumenDeGrupo | null | undefined): GrupoEnLaTarjeta {
  if (!resumen) return { tipo: "nada" };
  const abierto = resumen.motivo === null;
  if (resumen.grupo) {
    return {
      tipo: "con_grupo",
      nombre: resumen.grupo.nombre,
      integrantes: resumen.grupo.integrantes,
      entregado: resumen.grupo.entregado,
      puedeCambiar: abierto,
      bajoElMinimo: avisarBajoElMinimo({
        abierto,
        integrantes: resumen.grupo.integrantes,
        minimo: resumen.minimo,
        armadoPorElDocente: resumen.grupo.armado_por_docente === true,
      }),
      minimo: resumen.minimo,
    };
  }
  // Sin grupo: solo se ofrece armarlo si lo pueden armar los estudiantes y nada
  // lo impide. Quien ya entregó solo NO puede (la base lo rechaza): no se le
  // ofrece un botón que va a fallar.
  if (!abierto || resumen.individual?.entregada) return { tipo: "nada" };
  return {
    tipo: "armar",
    estricto: resumen.modo === "group_required",
    conBorrador: !!resumen.individual,
  };
}

/**
 * Un grupo que lo armó el DOCENTE, no un estudiante. La RPC de crear guarda en
 * `created_by` al estudiante que lo armó; la ventana «Grupos» del docente (y
 * «Repartir al azar», y «Desde una imagen») no lo llena. Con eso alcanza para
 * distinguirlos sin otra columna: un `created_by` vacío es del docente.
 * También queda vacío si se borra la cuenta de quien lo creó (la FK es ON
 * DELETE SET NULL): ese grupo pierde el aviso de mínimo, que es lo único que
 * depende de esto, y no se impide nada.
 */
export function armadoPorElDocente(grupo: { created_by?: string | null }): boolean {
  return grupo.created_by == null;
}

/**
 * ¿Se le avisa al estudiante que su grupo quedó por debajo del mínimo? Solo si
 * el grupo lo armaron los estudiantes y todavía puede arreglarse. El mínimo es
 * una regla para ELLOS: el docente puede armar un grupo del tamaño que quiera
 * —de una sola persona, para quien no encontró grupo— y a ese estudiante no se
 * le dice que le falta gente. En ningún caso se impide entregar.
 */
export function avisarBajoElMinimo(opts: {
  abierto: boolean;
  integrantes: number;
  minimo: number;
  armadoPorElDocente: boolean;
}): boolean {
  return opts.abierto && !opts.armadoPorElDocente && opts.integrantes < opts.minimo;
}

export type ProblemaDeSeleccion =
  | { tipo: "faltan"; cuantos: number }
  | { tipo: "sobran"; cuantos: number }
  | { tipo: "vacia" };

/**
 * ¿Alcanza la selección para crear el grupo o para agregar? Espejo de lo que
 * valida la RPC, para deshabilitar el botón en vez de dejar pulsar y fallar.
 *
 *  - Crear: el grupo queda de 1 (quien lo crea) + los elegidos, y tiene que
 *    estar entre el mínimo y el máximo.
 *  - Agregar: hace falta al menos uno, y el total no pasa del máximo. El mínimo
 *    no aplica: agregar nunca empeora un grupo que quedó corto.
 */
export function problemaDeSeleccion(opts: {
  modo: "crear" | "agregar";
  minimo: number;
  maximo: number;
  /** Integrantes que ya tiene el grupo (al crear: 1, quien lo crea). */
  actuales: number;
  elegidos: number;
}): ProblemaDeSeleccion | null {
  const total = opts.actuales + opts.elegidos;
  if (opts.modo === "agregar" && opts.elegidos === 0) return { tipo: "vacia" };
  if (total > opts.maximo) return { tipo: "sobran", cuantos: total - opts.maximo };
  if (opts.modo === "crear" && total < opts.minimo) {
    return { tipo: "faltan", cuantos: opts.minimo - total };
  }
  return null;
}

/** Cuántos más caben: lo que limita las casillas que se pueden marcar. */
export function cuposLibres(maximo: number, actuales: number): number {
  return Math.max(0, maximo - actuales);
}

export const TOPE_INTEGRANTES = 50;

/** Topes del formulario del docente, saneados: enteros, mínimo ≥ 1, máximo ≥ mínimo. */
export function topesDeGrupo(
  minimo: number | null | undefined,
  maximo: number | null | undefined,
): { minimo: number; maximo: number } {
  const entero = (v: number | null | undefined, porDefecto: number) =>
    Number.isFinite(Number(v)) && v != null ? Math.trunc(Number(v)) : porDefecto;
  const min = Math.min(Math.max(entero(minimo, 2), 1), TOPE_INTEGRANTES);
  const max = Math.min(Math.max(entero(maximo, 5), min), TOPE_INTEGRANTES);
  return { minimo: min, maximo: max };
}

/** El máximo que escribió el docente es menor que el mínimo: se avisa en vez de corregirlo a escondidas. */
export function topesInvalidos(
  minimo: number | null | undefined,
  maximo: number | null | undefined,
): boolean {
  return minimo != null && maximo != null && Number(maximo) < Number(minimo);
}

/**
 * Lo que el formulario del docente manda sobre quién arma los grupos.
 *
 * `students_form_groups` es una columna nueva: se manda solo cuando dice algo
 * distinto del default (encendida) o cuando hay que apagarla. Así, si el
 * despliegue de la pantalla llega antes que la migración, guardar una actividad
 * que no usa la opción no choca contra una columna que todavía no existe. Los
 * topes (`group_size_*`) existen desde siempre y van cuando los estudiantes
 * arman los grupos, que es cuando se hacen cumplir.
 */
export function gruposAlGuardar(
  form: {
    group_mode?: string | null;
    students_form_groups?: boolean | null;
    group_size_min?: number | null;
    group_size_max?: number | null;
  },
  original: { students_form_groups?: boolean | null } | null | undefined,
): { students_form_groups?: boolean; group_size_min?: number; group_size_max?: number } {
  const arman = esModoGrupal(form.group_mode) && !!form.students_form_groups;
  const out: { students_form_groups?: boolean; group_size_min?: number; group_size_max?: number } =
    {};
  if (arman || original?.students_form_groups) out.students_form_groups = arman;
  if (arman) {
    const { minimo, maximo } = topesDeGrupo(form.group_size_min, form.group_size_max);
    out.group_size_min = minimo;
    out.group_size_max = maximo;
  }
  return out;
}
