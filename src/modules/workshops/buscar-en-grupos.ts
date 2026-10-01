/**
 * Buscador del tablero de grupos (talleres y proyectos).
 *
 * Con 30 estudiantes en «Sin grupo», encontrar a uno para moverlo era leer la
 * lista entera. Este filtro decide QUÉ tarjetas se ven mientras hay una
 * búsqueda; no mueve a nadie ni cambia ningún grupo. Lo usan
 * `WorkshopGroupsEditor` y su espejo `ProjectGroupsEditor`.
 *
 * Dos reglas que no se deducen:
 *  - Los grupos se siguen viendo TODOS aunque no tengan a nadie que coincida:
 *    son el destino del arrastre. Si se ocultaran, encontrar al estudiante
 *    dejaría sin dónde soltarlo.
 *  - Si la búsqueda coincide con el NOMBRE de un grupo, ese grupo se muestra
 *    completo: buscar «Grupo 3» es querer ver quiénes lo forman.
 *
 * La comparación es la del buscador global (`matchesQuery`): por palabras y
 * sin tildes, así «jose rodri» encuentra a «José Rodríguez».
 */
import { matchesQuery, queryTokens } from "@/modules/search/search-text";

export type EstudianteDeTablero = {
  id: string;
  full_name: string;
  institutional_email: string;
};

export type GrupoDeTablero = { id: string; name: string };

export function estudianteCoincide(s: EstudianteDeTablero, consulta: string): boolean {
  return matchesQuery(`${s.full_name} ${s.institutional_email}`, consulta);
}

export interface TableroFiltrado<S extends EstudianteDeTablero> {
  /** Hay una búsqueda escrita (no solo espacios). */
  activa: boolean;
  sinGrupo: S[];
  porGrupo: Map<string, S[]>;
  /** Grupos cuyo nombre coincide: se muestran con todos sus integrantes. */
  gruposQueCoinciden: Set<string>;
  /** Estudiantes visibles en todo el tablero. */
  visibles: number;
}

export function filtrarTablero<S extends EstudianteDeTablero>(
  sinGrupo: readonly S[],
  porGrupo: ReadonlyMap<string, readonly S[]>,
  grupos: readonly GrupoDeTablero[],
  consulta: string,
): TableroFiltrado<S> {
  const activa = queryTokens(consulta).length > 0;
  const gruposQueCoinciden = new Set<string>();
  const filtrados = new Map<string, S[]>();
  let visibles = 0;

  const libres = activa ? sinGrupo.filter((s) => estudianteCoincide(s, consulta)) : [...sinGrupo];
  visibles += libres.length;

  for (const g of grupos) {
    const integrantes = porGrupo.get(g.id) ?? [];
    let mostrados: S[];
    if (!activa) {
      mostrados = [...integrantes];
    } else if (matchesQuery(g.name, consulta)) {
      gruposQueCoinciden.add(g.id);
      mostrados = [...integrantes];
    } else {
      mostrados = integrantes.filter((s) => estudianteCoincide(s, consulta));
    }
    filtrados.set(g.id, mostrados);
    visibles += mostrados.length;
  }

  return { activa, sinGrupo: libres, porGrupo: filtrados, gruposQueCoinciden, visibles };
}
