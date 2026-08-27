/**
 * Quiénes tienen el examen asignado y TODAVÍA NO LO ABRIERON.
 *
 * ── Qué resuelve ──────────────────────────────────────────────────────
 * El monitor mostraba "En progreso (11) · Completados (7)" — 18 personas. Lo que
 * no decía es que el examen estaba asignado a 23: las 5 que faltaban eran
 * invisibles, porque toda la pantalla se derivaba de `submissions` y quien no
 * entró no tiene fila. O sea que el dato que el docente necesita mientras el
 * examen está abierto —a quién hay que llamar— era justo el que no estaba.
 *
 * ── Por qué el universo son las ASIGNACIONES y no la matrícula ─────────
 * El acceso a un examen se decide por `exam_assignments` (examen ↔ estudiante),
 * no por estar matriculado: el docente puede asignarlo a una parte del curso.
 * Contra la matrícula, esta lista acusaría de "no entró" a alguien que no tiene
 * el examen asignado — y el docente perseguiría a la persona equivocada.
 *
 * PURO: sin consultas, sin `Date.now()` implícito. El caller trae los datos.
 */

export interface AsignadoParaEntrada {
  userId: string;
  fullName: string;
  email: string | null;
}

/**
 * Resta a los asignados quienes ya tienen alguna entrega (de cualquier estado).
 *
 * "Ingresó" = existe una fila de entrega. Alcanza y es lo correcto: la fila se
 * crea al ABRIR el examen, así que tener una fila —aunque sea `en_progreso` sin
 * una sola respuesta— significa que la persona ya está adentro y el docente no
 * tiene que buscarla. Distinguir "entró pero no contestó" es otra pregunta, y la
 * columna de respondidas de la tabla ya la responde.
 *
 * Orden alfabético con collation es-CO: esta lista se lee en voz alta para llamar
 * a la gente, así que el orden tiene que ser el del listado de clase y no el de
 * la base.
 */
export function quienesNoIngresaron(
  asignados: readonly AsignadoParaEntrada[],
  userIdsConEntrega: ReadonlySet<string>,
): AsignadoParaEntrada[] {
  const vistos = new Set<string>();
  const out: AsignadoParaEntrada[] = [];
  for (const a of asignados) {
    if (!a?.userId) continue;
    // Dedup defensivo: una asignación duplicada mostraría el mismo nombre dos
    // veces y haría dudar del conteo entero.
    if (vistos.has(a.userId)) continue;
    vistos.add(a.userId);
    if (userIdsConEntrega.has(a.userId)) continue;
    out.push(a);
  }
  return out.sort((x, y) => (x.fullName || "").localeCompare(y.fullName || "", "es-CO"));
}
