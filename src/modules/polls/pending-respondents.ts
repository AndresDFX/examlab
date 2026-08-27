/**
 * Quiénes tienen acceso a una encuesta y TODAVÍA NO RESPONDIERON, por curso.
 *
 * ── Qué resuelve ──────────────────────────────────────────────────────
 * Los resultados mostraban quiénes SÍ respondieron (chips por opción). Quien no
 * respondió no tiene fila en ninguna tabla, así que era invisible: el docente
 * veía "12 respuestas" sin saber si faltaban 3 o 30, ni a quién recordarle.
 *
 * ── Por qué el desglose es POR CURSO ──────────────────────────────────
 * Una encuesta se puede compartir con varios cursos (`poll_courses`). Con una
 * lista plana de 40 nombres el docente no puede hacer nada útil: no sabe a qué
 * grupo escribirle ni si un curso entero se quedó sin responder mientras otro ya
 * está completo. Por curso, cada fila es una acción posible.
 *
 * Con UN solo curso el desglose es una sola sección, así que no hace falta un
 * modo aparte: el mismo dato sirve para los dos casos.
 *
 * ── "Tiene acceso" = está matriculado en un curso vinculado ────────────
 * No se usa una lista de invitados propia porque no existe: el acceso de una
 * encuesta se deriva de la matrícula de los cursos vinculados. Alguien
 * matriculado en DOS cursos vinculados aparece en los dos si no respondió — es
 * la verdad del dato, y esconderlo en uno haría que los conteos por curso no
 * sumen lo que el docente ve en su lista de clase.
 *
 * PURO: sin consultas. El caller trae matrículas, nombres y quiénes respondieron.
 */

export interface MatriculaEncuesta {
  courseId: string;
  userId: string;
}

export interface CursoEncuesta {
  id: string;
  name: string;
}

export interface PersonaPendiente {
  userId: string;
  fullName: string;
}

export interface CursoPendientes {
  courseId: string;
  courseName: string;
  /** Con acceso a la encuesta por este curso. */
  total: number;
  /** Cuántos ya respondieron. */
  respondieron: number;
  /** Quiénes faltan, en orden alfabético es-CO. */
  faltan: PersonaPendiente[];
}

export interface ResumenPendientes {
  porCurso: CursoPendientes[];
  /** Personas ÚNICAS con acceso (sin contar dos veces a quien está en 2 cursos). */
  totalUnico: number;
  /** Personas únicas que respondieron. */
  respondieronUnico: number;
  /** Personas únicas que faltan. */
  faltanUnico: number;
}

/**
 * Agrupa por curso a quienes no respondieron.
 *
 * Los totales generales se cuentan por persona ÚNICA, no sumando los por-curso:
 * si alguien está en dos cursos vinculados, sumar daría "41 de 40" y el docente
 * dejaría de creerle al número. El desglose por curso sí lo cuenta en ambos,
 * porque ahí la pregunta es "a quién le escribo en ESTE grupo".
 */
export function resumirPendientes(
  cursos: readonly CursoEncuesta[],
  matriculas: readonly MatriculaEncuesta[],
  nombrePorUsuario: ReadonlyMap<string, string>,
  usuariosQueRespondieron: ReadonlySet<string>,
): ResumenPendientes {
  const porCursoMap = new Map<string, Set<string>>();
  for (const c of cursos) porCursoMap.set(c.id, new Set());
  for (const m of matriculas) {
    if (!m?.courseId || !m?.userId) continue;
    // Una matrícula de un curso que no está vinculado a la encuesta no da
    // acceso: ignorarla evita inventar pendientes.
    const set = porCursoMap.get(m.courseId);
    if (!set) continue;
    set.add(m.userId);
  }

  const todos = new Set<string>();
  for (const set of porCursoMap.values()) for (const u of set) todos.add(u);

  const porCurso: CursoPendientes[] = cursos.map((c) => {
    const conAcceso = porCursoMap.get(c.id) ?? new Set<string>();
    const faltan: PersonaPendiente[] = [];
    let respondieron = 0;
    for (const userId of conAcceso) {
      if (usuariosQueRespondieron.has(userId)) {
        respondieron++;
        continue;
      }
      faltan.push({ userId, fullName: nombrePorUsuario.get(userId) ?? "—" });
    }
    faltan.sort((a, b) => a.fullName.localeCompare(b.fullName, "es-CO"));
    return {
      courseId: c.id,
      courseName: c.name,
      total: conAcceso.size,
      respondieron,
      faltan,
    };
  });

  // El orden de las secciones: primero donde MÁS falta. El docente entra a esta
  // vista para saber dónde insistir, no para leer un índice alfabético.
  porCurso.sort((a, b) => b.faltan.length - a.faltan.length || a.courseName.localeCompare(b.courseName, "es-CO"));

  let respondieronUnico = 0;
  for (const u of todos) if (usuariosQueRespondieron.has(u)) respondieronUnico++;

  return {
    porCurso,
    totalUnico: todos.size,
    respondieronUnico,
    faltanUnico: todos.size - respondieronUnico,
  };
}
