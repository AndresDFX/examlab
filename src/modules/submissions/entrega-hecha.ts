/**
 * ¿El estudiante YA ENTREGÓ? Y por lo tanto: ¿qué está de verdad **vencido**?
 *
 * ── El bug que originó el módulo ──────────────────────────────────────
 * Las pantallas del estudiante decidían «entregado» con una lista BLANCA de
 * dos estados:
 *
 *   if (s === "calificado") return "graded";
 *   if (s === "entregado")  return "submitted";
 *   if (pasoElPlazo)        return "overdue";     // ← todo lo demás cae acá
 *
 * `ai_revisado` —que la plataforma escribe sola cuando la IA revisa una
 * entrega— nunca entró en esa lista. Resultado: **37 entregas reales de
 * producción** quedaban clasificadas como VENCIDAS. El alumno había
 * entregado, y su pantalla le mostraba un badge rojo con triángulo de alerta
 * diciendo que no. Peor: el filtro por defecto del listado no incluye lo
 * vencido, así que la tarjeta **desaparecía** de su lista.
 *
 * ── Por qué lista NEGRA y no blanca ───────────────────────────────────
 * Se enumeran los estados en los que TODAVÍA NO entregó, y cualquier otro
 * cuenta como entrega hecha. Es la única forma de que el bug no vuelva: los
 * estados nuevos de estas tablas nacen del pipeline de CALIFICACIÓN
 * (`ai_revisado`, `requiere_revision`), o sea que aparecen *después* de
 * entregar. Con lista blanca, cada estado nuevo se cae al peor default; con
 * lista negra, se cae al correcto.
 *
 * El costo de equivocarse tampoco es simétrico: decirle «Vencido» a quien
 * entregó le hace creer que perdió la nota y le esconde la tarjeta, mientras
 * que el caso contrario lo cubren igual el plazo visible y la propia tarjeta.
 *
 * ── El criterio, en una línea ─────────────────────────────────────────
 * Vencido = **ya pasó el plazo Y no entregó**. Pasar el plazo, solo, no
 * vence nada: una entrega a término sigue siendo una entrega aunque el
 * plazo haya quedado atrás hace un mes.
 */

/**
 * Estados en los que la fila existe pero el alumno NO entregó todavía.
 *
 * Esta lista es la ÚNICA del proyecto: vivía dentro de `courses/diagnostic.ts`
 * —el módulo del docente— y por eso las pantallas del estudiante no la usaban
 * y se escribieron su propia lista blanca de dos estados. Se mudó acá, que es
 * donde el nombre dice de qué se trata; `diagnostic.ts` la importa.
 *
 * Los exámenes crean la fila al INICIAR (`en_progreso`) y solo pasan a
 * `completado`/`sospechoso` al entregar; talleres y proyectos crean la fila
 * recién al entregar.
 */
export const ESTADOS_SIN_ENTREGAR: readonly string[] = [
  "en_progreso",
  "iniciado",
  "borrador",
  "draft",
  "pendiente",
  "no_entregado",
];

/** ¿Este `status` representa una entrega REAL? Nulo o desconocido → sí. */
export function esEstadoDeEntrega(status: string | null | undefined): boolean {
  if (!status) return true;
  return !ESTADOS_SIN_ENTREGAR.includes(status.trim());
}

/**
 * ¿Esta entrega cuenta como entregada?
 *
 * Sin fila no hay entrega. Con fila, lo es salvo que el estado esté en la
 * lista de «todavía no» — ver el encabezado para por qué el default es sí.
 */
export function entregaHecha(
  entrega: { status?: string | null } | null | undefined,
): boolean {
  if (!entrega) return false;
  return esEstadoDeEntrega(entrega.status);
}

/**
 * ¿Está vencido? Pasó el plazo **y** no entregó.
 *
 * `plazo` acepta lo que traen las columnas (`due_date`, `end_time`), que son
 * nullable: sin plazo nada puede vencer. Una fecha ilegible tampoco vence —
 * marcar «Vencido» por no haber podido leer una fecha es el peor resultado.
 */
export function estaVencido(args: {
  plazo: string | null | undefined;
  entrega: { status?: string | null } | null | undefined;
  ahora: number;
}): boolean {
  if (entregaHecha(args.entrega)) return false;
  if (!args.plazo) return false;
  const limite = new Date(args.plazo).getTime();
  if (!Number.isFinite(limite)) return false;
  return limite < args.ahora;
}
