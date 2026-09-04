/**
 * Empareja un nombre LEÍDO de una captura de la videollamada con un estudiante
 * matriculado.
 *
 * ── El problema real ──────────────────────────────────────────────────────
 * Google Meet muestra el nombre que cada persona puso en su cuenta, y eso NO es el
 * `full_name` de la matrícula. Medido sobre los datos reales de producción, donde los
 * nombres están como "Reyes Mompotes Jean Paul" (apellidos primero, Title Case), un
 * recuadro puede decir:
 *
 *   "Jean Paul Reyes"      → el mismo orden invertido y sin un apellido
 *   "JEAN PAUL R."         → mayúsculas y apellido abreviado
 *   "Jean Paul (tú)"       → con el sufijo que agrega Meet
 *   "jpaulreyes"           → la parte local del correo institucional
 *
 * ── Por qué NUNCA se elige "el mejor" candidato ───────────────────────────
 * Este módulo devuelve `ambiguo` con TODOS los candidatos en vez de quedarse con el
 * primero. Elegir por puntaje pondría a un estudiante en el grupo de otro sin que
 * nadie lo note: la nota del taller es del grupo, así que el error se paga con la
 * nota de dos personas. Un `ambiguo` cuesta un clic del docente; un emparejamiento
 * silencioso mal hecho cuesta un reclamo.
 *
 * "Vela" está contenido en "Velandia" y en "Velasco": ese caso es AMBIGUO, no "el
 * primero que matcheó".
 */
import { normalizeForSearch } from "@/modules/search/search-text";

export interface EstudianteMatriculado {
  user_id: string;
  full_name: string | null;
  institutional_email?: string | null;
}

export interface Candidato {
  user_id: string;
  full_name: string;
  /** Por qué se consideró: sirve para explicarle al docente el ambiguo. */
  via: "correo" | "nombre_completo" | "tokens";
}

export type EstadoEmparejamiento = "unico" | "ambiguo" | "sin_coincidencia";

export interface Emparejamiento {
  estado: EstadoEmparejamiento;
  candidatos: Candidato[];
}

/** Sufijos que Meet/Zoom agregan al nombre y que no son parte de él. */
const SUFIJOS = /\((tú|tu|you|anfitri[oó]n|host|organizador|presentando|presenting)\)/gi;

/**
 * Limpia lo que el modelo leyó del recuadro: viñetas, numeración, los sufijos de la
 * plataforma y la puntuación de las abreviaturas ("R." → "R").
 *
 * Delega la parte difícil —minúsculas, acentos, espacios— en `normalizeForSearch`,
 * que es el mismo normalizador que usa el buscador del proyecto. No se reimplementa
 * la comparación de texto: dos normalizadores distintos divergen y entonces el mismo
 * nombre matchea en una pantalla y no en la otra.
 */
export function normalizarNombreLeido(leido: string | null | undefined): string {
  return normalizeForSearch(
    (leido ?? "")
      .replace(SUFIJOS, " ")
      // Viñetas y numeración con las que a veces vuelve una lista.
      .replace(/^[\s*\-–—•·]+|^\d+[.)]\s*/g, " ")
      .replace(/[.,;:_]+/g, " "),
  );
}

/** Qué clase de dato parece el token leído. */
export function formaDelToken(leido: string | null | undefined): "correo" | "usuario" | "nombre" {
  const s = (leido ?? "").trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "correo";
  // Un solo token sin espacios y con dígitos o puntos internos parece un usuario
  // ("jpaulreyes", "cn.moralesp") y no un nombre de persona.
  if (!/\s/.test(s) && s.length >= 3 && /^[a-z0-9._-]+$/i.test(s)) return "usuario";
  return "nombre";
}

const partes = (s: string): string[] => s.split(" ").filter((p) => p.length >= 2);

/**
 * ¿Cada palabra leída encuentra una palabra real DISTINTA que la satisfaga?
 *
 * El "distinta" es el punto. Comparando conjuntos, "Ana Ana Ana" satisface tres veces
 * la única "Ana" del nombre real y matchea — lo detectó el test de este módulo, no una
 * revisión. Un emparejamiento así es exactamente el que pone a alguien en el grupo
 * de otro.
 */
function cubre(
  leidas: readonly string[],
  disponibles: readonly string[],
  satisface: (real: string, leida: string) => boolean,
): boolean {
  if (!disponibles.length) return false;
  const usadas = new Set<number>();
  return leidas.every((p) => {
    const i = disponibles.findIndex((d, idx) => !usadas.has(idx) && satisface(d, p));
    if (i === -1) return false;
    usadas.add(i);
    return true;
  });
}

/**
 * Empareja UN nombre leído contra la matrícula.
 *
 * La escalera es de más fuerte a más débil y **se corta en el primer nivel que dé
 * resultado**: un acierto por correo no se contamina con coincidencias flojas de
 * nombre. Dentro de un nivel, dos o más candidatos ⇒ `ambiguo`.
 */
export function emparejarNombre(
  leido: string | null | undefined,
  roster: readonly EstudianteMatriculado[],
): Emparejamiento {
  const crudo = (leido ?? "").trim();
  if (!crudo) return { estado: "sin_coincidencia", candidatos: [] };

  const forma = formaDelToken(crudo);
  const norm = normalizarNombreLeido(crudo);
  if (!norm) return { estado: "sin_coincidencia", candidatos: [] };

  const con = (e: EstudianteMatriculado, via: Candidato["via"]): Candidato => ({
    user_id: e.user_id,
    full_name: e.full_name ?? "",
    via,
  });

  // ── Nivel 1: el correo, o su parte local ────────────────────────────────
  if (forma === "correo" || forma === "usuario") {
    const buscado = crudo.toLowerCase();
    const local = buscado.split("@")[0];
    const porCorreo = roster.filter((e) => {
      const c = (e.institutional_email ?? "").toLowerCase();
      if (!c) return false;
      return c === buscado || c.split("@")[0] === local;
    });
    if (porCorreo.length) {
      return {
        estado: porCorreo.length === 1 ? "unico" : "ambiguo",
        candidatos: porCorreo.map((e) => con(e, "correo")),
      };
    }
    // Un "usuario" que no matcheó ningún correo se sigue probando como nombre: puede
    // ser alguien que puso "juanperez" sin espacio en su cuenta de Google.
  }

  const rosterNorm = roster.map((e) => ({ e, norm: normalizeForSearch(e.full_name) }));

  // ── Nivel 2: el nombre completo, en cualquier orden ─────────────────────
  // "Jean Paul Reyes" vs "Reyes Mompotes Jean Paul": se comparan los CONJUNTOS de
  // palabras, así que el orden de apellidos y nombres deja de importar.
  const leidas = partes(norm);
  if (leidas.length >= 2) {
    const exactos = rosterNorm.filter(({ norm: n }) => cubre(leidas, partes(n), (r, l) => r === l));
    if (exactos.length) {
      return {
        estado: exactos.length === 1 ? "unico" : "ambiguo",
        candidatos: exactos.map(({ e }) => con(e, "nombre_completo")),
      };
    }
  }

  // ── Nivel 3: por prefijos, para abreviaturas y nombres truncados ────────
  // "Angie Paulette M." contra "Murillo Espinosa Angie Paulette".
  const porPrefijo = rosterNorm.filter(({ norm: n }) =>
    cubre(leidas, partes(n), (r, l) => r.startsWith(l)),
  );
  if (porPrefijo.length) {
    return {
      estado: porPrefijo.length === 1 ? "unico" : "ambiguo",
      candidatos: porPrefijo.map(({ e }) => con(e, "tokens")),
    };
  }

  return { estado: "sin_coincidencia", candidatos: [] };
}

/** Un participante tal como lo leyó el modelo. */
export interface ParticipanteLeido {
  nombre: string;
  confianza?: "alta" | "media" | "baja";
}

/** Un grupo tal como lo leyó el modelo. */
export interface GrupoLeido {
  etiqueta: string;
  participantes: ParticipanteLeido[];
}

export interface FilaLeida {
  /** Identificador estable de la fila en el borrador (no es de la base). */
  id: string;
  /** Lo que decía el recuadro, tal cual: el docente tiene que poder reconocerlo. */
  leido: string;
  etiqueta: string;
  confianza: "alta" | "media" | "baja";
  estado: EstadoEmparejamiento;
  candidatos: Candidato[];
  /** El elegido. Arranca puesto solo cuando el emparejamiento fue único. */
  user_id: string | null;
  /**
   * `true` si ESTE nombre aparece en más de un grupo de la imagen. No se resuelve
   * automáticamente: una sala compartida y un nombre repetido por error se ven igual
   * desde acá, y adivinar mueve a alguien de grupo sin avisar.
   */
  duplicado_en_imagen: boolean;
  /** El docente la sacó del borrador. No cuenta ni bloquea. */
  descartada?: boolean;
}

/**
 * Convierte lo leído en las filas del borrador que el docente revisa.
 *
 * El orden de salida respeta el de la imagen (grupo por grupo): revisar en el mismo
 * orden en que se ve la captura es lo que hace la revisión rápida.
 */
export function emparejarLectura(
  grupos: readonly GrupoLeido[],
  roster: readonly EstudianteMatriculado[],
): FilaLeida[] {
  const vecesPorNombre = new Map<string, number>();
  for (const g of grupos) {
    for (const p of g.participantes) {
      const k = normalizarNombreLeido(p.nombre);
      if (k) vecesPorNombre.set(k, (vecesPorNombre.get(k) ?? 0) + 1);
    }
  }

  const filas: FilaLeida[] = [];
  let n = 0;
  for (const g of grupos) {
    for (const p of g.participantes) {
      const m = emparejarNombre(p.nombre, roster);
      const k = normalizarNombreLeido(p.nombre);
      filas.push({
        id: `f${n++}`,
        leido: p.nombre,
        etiqueta: g.etiqueta,
        confianza: p.confianza ?? "media",
        estado: m.estado,
        candidatos: m.candidatos,
        user_id: m.estado === "unico" ? m.candidatos[0].user_id : null,
        duplicado_en_imagen: (vecesPorNombre.get(k) ?? 0) > 1,
      });
    }
  }
  return filas;
}
