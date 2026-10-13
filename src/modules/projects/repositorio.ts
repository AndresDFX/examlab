/**
 * Si la entrega de un proyecto pide el link al repositorio (GitHub o Drive).
 *
 * Es configurable por proyecto (`projects.requires_repository`, mig 20262820000000): en un curso
 * sin código —Introducción a la Ingeniería entrega un informe— pedirlo obligaba a pegar cualquier
 * enlace para poder entregar. Falla hacia «sí»: sin la columna (una base que todavía no tiene la
 * migración) o sin el dato, se pide, que es como funcionó siempre.
 */
export function pideRepositorio(
  proyecto: { requires_repository?: boolean | null } | null | undefined,
): boolean {
  return proyecto?.requires_repository !== false;
}

/**
 * Lo que el formulario del docente agrega al guardar un proyecto. La columna se manda SOLO cuando se
 * apaga, o cuando se vuelve a encender una que estaba apagada: mientras la base no tenga la
 * migración, un proyecto que se queda en el default se guarda igual que antes, sin chocar con una
 * columna que PostgREST todavía no conoce (el mismo cuidado que `is_external`).
 */
export function requiresRepositoryAlGuardar(
  formulario: { requires_repository?: boolean | null },
  original: { requires_repository?: boolean | null } | null | undefined,
): { requires_repository?: boolean } {
  const pide = pideRepositorio(formulario);
  return !pide || (original != null && !pideRepositorio(original)) ? { requires_repository: pide } : {};
}
