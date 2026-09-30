/**
 * Los grids del docente (exámenes y talleres) listan cada actividad UNA vez, y
 * sus supletorios y recuperatorios DENTRO de ella —una fila que se despliega—,
 * no como filas sueltas. Suelta, la recuperación se leía como una actividad más
 * del corte y había que adivinar de qué parcial era. Este módulo arma ese árbol.
 *
 * Tres decisiones que no se deducen del código:
 *
 * - **El filtro decide qué FILA aparece, no qué recuperaciones.** Una fila entra
 *   si ella o cualquiera de sus recuperaciones coincide con el filtro, y
 *   desplegada muestra TODAS sus recuperaciones. Filtrar también las hijas deja
 *   al parcial con la historia a medias (el supletorio publicado sí, el
 *   recuperatorio cerrado no), cuando la nota se arma con todas.
 * - **Una recuperación cuyo original no está en la lista sigue siendo una fila**:
 *   el original está en la papelera o es de un curso fuera del alcance del
 *   docente. Colgarla de un padre que no se muestra la haría desaparecer.
 * - **Las hijas van en el orden del pliegue de la nota** (`ordenDePliegue`, el
 *   comparador que usa `plegarRecuperaciones`): la primera que se ve es la
 *   primera que cuenta.
 */
import { ordenDePliegue } from "@/modules/grading/nota-con-recuperacion";

export interface AccesoresDeRecuperacion<T> {
  id: (fila: T) => string;
  /** Id del original, o null/undefined si la fila no es una recuperación. */
  padre: (fila: T) => string | null | undefined;
  creado: (fila: T) => string | null | undefined;
}

export interface ArbolDeRecuperaciones<T> {
  /** Las filas del grid, en el orden en que llegaron las coincidencias. */
  raices: T[];
  /** Recuperaciones de cada fila (por id), en orden del pliegue. */
  hijas: ReadonlyMap<string, T[]>;
  /** Filas que están SOLO porque una recuperación suya coincide con el filtro. */
  soloPorRecuperacion: ReadonlySet<string>;
}

/**
 * `todas`: el universo que el docente puede ver (ya sin papelera y acotado a
 * sus cursos). `coinciden`: las que pasan los filtros de la pantalla, un
 * subconjunto de `todas`.
 */
export function arbolDeRecuperaciones<T>(
  todas: readonly T[],
  coinciden: readonly T[],
  acc: AccesoresDeRecuperacion<T>,
): ArbolDeRecuperaciones<T> {
  const porId = new Map<string, T>();
  for (const fila of todas) porId.set(acc.id(fila), fila);

  const raizDeId = new Map<string, T>();
  const raizDe = (fila: T): T => {
    const inicio = acc.id(fila);
    const ya = raizDeId.get(inicio);
    if (ya) return ya;
    const vistos = new Set<string>([inicio]);
    let actual = fila;
    for (;;) {
      const idPadre = acc.padre(actual);
      if (!idPadre) break;
      const padre = porId.get(idPadre);
      // Huérfana: el original no está en la lista.
      if (!padre) break;
      // Un ciclo no se puede crear desde la plataforma (solo se ofrece como
      // original lo que no es recuperación), pero si aparece en los datos cada
      // fila del ciclo queda como fila propia en vez de colgar de otra.
      if (vistos.has(idPadre)) {
        actual = fila;
        break;
      }
      vistos.add(idPadre);
      actual = padre;
    }
    raizDeId.set(inicio, actual);
    return actual;
  };

  const hijas = new Map<string, T[]>();
  for (const fila of todas) {
    const raiz = raizDe(fila);
    const idRaiz = acc.id(raiz);
    if (idRaiz === acc.id(fila)) continue;
    const lista = hijas.get(idRaiz);
    if (lista) lista.push(fila);
    else hijas.set(idRaiz, [fila]);
  }
  const porPliegue = (a: T, b: T) =>
    ordenDePliegue(
      { creadoEn: acc.creado(a), id: acc.id(a) },
      { creadoEn: acc.creado(b), id: acc.id(b) },
    );
  for (const lista of hijas.values()) lista.sort(porPliegue);

  const coincidentes = new Set(coinciden.map(acc.id));
  const raices: T[] = [];
  const yaEsta = new Set<string>();
  const soloPorRecuperacion = new Set<string>();
  for (const fila of coinciden) {
    const raiz = raizDe(fila);
    const idRaiz = acc.id(raiz);
    if (yaEsta.has(idRaiz)) continue;
    yaEsta.add(idRaiz);
    raices.push(raiz);
    if (!coincidentes.has(idRaiz)) soloPorRecuperacion.add(idRaiz);
  }

  return { raices, hijas, soloPorRecuperacion };
}

/**
 * El título de una recuperación sin su tipo al principio, para la sub-fila: la
 * insignia ya lo dice y el título por defecto lo repite («Supletorio — Parcial
 * 1»), así que en una columna angosta lo único que quedaba a la vista era
 * «Suple…». El título entero sigue en el tooltip.
 *
 * Solo quita el tipo como palabra suelta («Supletorios de…» queda igual) y
 * nunca deja el título vacío.
 */
export function tituloSinTipo(titulo: string, tipo: string): string {
  const limpio = titulo.trim();
  if (!tipo || !limpio.toLowerCase().startsWith(tipo.toLowerCase())) return titulo;
  const resto = limpio.slice(tipo.length);
  if (!/^[\s:·—–-]/.test(resto)) return titulo;
  const sinSeparador = resto.replace(/^[\s:·—–-]+/, "");
  return sinSeparador.length > 0 ? sinSeparador : titulo;
}
