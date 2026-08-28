/**
 * Selección de cursos al crear un estudiante desde la pantalla del docente.
 *
 * ── Por qué esto vive fuera del componente ─────────────────────────────
 * El edge `bulk-import-users` NO acepta ids de curso: resuelve los cursos por
 * NOMBRE, y varios nombres van en UN campo (`course_name`) unidos por `|`, el
 * mismo separador que ya usa `roles`. Armar ese string es la parte del alta que
 * puede quedar mal en silencio —un id que ya no está en el catálogo, el mismo
 * curso dos veces, un nombre con el separador adentro— y es la única parte que
 * se puede verificar sin DOM. Por eso está acá con tests, y no inline en el
 * diálogo, que es donde estaba la versión de un solo curso.
 *
 * ── Esto NO es la frontera de permisos ─────────────────────────────────
 * Que el docente solo pueda matricular en cursos que dicta lo garantiza el
 * SERVIDOR: el edge construye su catálogo nombre→id únicamente desde
 * `course_teachers` del caller (+ tenant + `deleted_at IS NULL`), así que un
 * curso ajeno simplemente no resuelve y la fila se rechaza completa. Lo de acá
 * es UX: ofrecer solo lo válido y evitar un viaje que iba a fallar.
 */

/**
 * Separador de listas del contrato del edge. Es el mismo que usa `roles`, y por
 * eso el multi-curso no necesitó un campo nuevo en el payload.
 */
export const COURSE_NAME_SEPARATOR = "|";

export interface TeacherCourseOption {
  id: string;
  name: string;
}

/**
 * `sin-cursos`: el edge exige curso cuando el caller es solo Docente (su
 * permiso se deriva de dictarlo), así que cero cursos no es un alta posible.
 *
 * `nombre-con-separador`: un curso cuyo nombre contenga `|` se partiría en dos
 * nombres que no resuelven, y el docente recibiría "el curso X no existe" sobre
 * un curso que sí ve en la lista. Hoy no existe ninguno así en producción; el
 * chequeo está para que si aparece falle diciendo la verdad.
 */
export type CourseSelectionProblem = "sin-cursos" | "nombre-con-separador";

export interface CourseSelection {
  /** Nombres a matricular, en el orden del catálogo y sin repetidos. */
  names: string[];
  /** Valor exacto del campo `course_name` del payload. */
  courseNameField: string;
  /** Nombres que rompen el contrato por contener el separador. */
  namesWithSeparator: string[];
  /** `null` = se puede guardar. */
  problem: CourseSelectionProblem | null;
}

export function resolveCourseSelection(
  selectedIds: readonly string[],
  catalog: readonly TeacherCourseOption[],
): CourseSelection {
  const marcados = new Set(selectedIds);
  const names: string[] = [];
  const vistos = new Set<string>();

  // Se recorre el CATÁLOGO y no los ids elegidos: así el orden es el que el
  // docente ve en la lista (no el de sus clics), y un id que ya no está en el
  // catálogo —un curso que pasó a la papelera entre la carga y el guardado, o
  // el sentinel del filtro— se cae solo en vez de viajar al servidor.
  for (const curso of catalog) {
    if (!marcados.has(curso.id)) continue;
    const nombre = curso.name.trim();
    if (!nombre) continue;
    // Dedup case-insensitive porque así resuelve el edge (su Map se keyea por
    // `name.trim().toLowerCase()`): dos entradas que difieren solo en
    // mayúsculas apuntan al mismo curso y mandarlas dos veces es ruido.
    const clave = nombre.toLowerCase();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    names.push(nombre);
  }

  const namesWithSeparator = names.filter((n) => n.includes(COURSE_NAME_SEPARATOR));
  const problem: CourseSelectionProblem | null =
    names.length === 0
      ? "sin-cursos"
      : namesWithSeparator.length > 0
        ? "nombre-con-separador"
        : null;

  return {
    names,
    courseNameField: names.join(COURSE_NAME_SEPARATOR),
    namesWithSeparator,
    problem,
  };
}

/**
 * Qué pasó realmente con la fila que devolvió el edge.
 *
 * Existe porque `ok: true` NO significa "se creó una cuenta": cuando el correo
 * ya tenía cuenta y solo faltaban matrículas, el edge devuelve
 * `ok: true, enrolledExisting: true`. Tratar los dos casos igual hace que el
 * docente lea "su contraseña temporal es Temporal#123" sobre una cuenta que ya
 * existía y cuya contraseña nadie cambió. Con varios cursos ese caso se vuelve
 * frecuente (basta que la persona ya esté en uno de los cursos marcados).
 */
export type ImportOutcome = "creado" | "matriculado-existente" | "duplicado" | "error";

export interface ImportRowResult {
  ok?: boolean;
  reason?: string;
  duplicate?: boolean;
  enrolledExisting?: boolean;
  /** El usuario ya existía y la matrícula FALLÓ. Ver el comentario de abajo. */
  enrollFailed?: boolean;
}

export function classifyImportOutcome(row: ImportRowResult | null | undefined): ImportOutcome {
  if (!row) return "error";
  if (row.ok) return row.enrolledExisting ? "matriculado-existente" : "creado";
  // `enrollFailed` va ANTES de `duplicate` porque el edge marca los DOS: el caso
  // "ya existía y la matrícula falló" también lleva `duplicate: true`. Sin este
  // orden, un fallo real que hay que reintentar se pintaría como el aviso
  // tranquilo de "ya estaba matriculado, no había nada que hacer".
  if (row.enrollFailed) return "error";
  // `duplicate` sin `ok` es "ya existía y no había nada que hacer": informa,
  // pero no hay nada que el docente deba corregir → no es un error.
  return row.duplicate ? "duplicado" : "error";
}
