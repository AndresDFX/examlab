/**
 * Publicar / despublicar una actividad desde la fila del grid, sin abrir el
 * formulario de edición.
 *
 * ── Por qué existe ────────────────────────────────────────────────────
 * Cambiar de borrador a publicado era lo más frecuente que el docente hace con
 * un taller o un examen recién creado, y la única vía era abrir «Editar»,
 * buscar el Select de estado entre el resto del formulario, cambiarlo y
 * guardar — con el riesgo de tocar de paso un peso o una fecha. Ahora es una
 * acción de fila.
 *
 * ── Por qué las tres pantallas comparten este módulo ──────────────────
 * Talleres, exámenes y proyectos tienen el MISMO ciclo de estados y el mismo
 * disparador de notificaciones, y sus grids ya divergieron antes por copiar
 * lógica en vez de compartirla. Acá vive lo que no puede diferir: qué
 * transición se ofrece por estado y si al publicar se le avisa al estudiante
 * en el acto.
 */

export type EstadoActividad = "draft" | "published" | "closed";

export type Transicion = {
  /** El estado al que lleva la acción. */
  a: EstadoActividad;
  /** Qué acción es, para que la pantalla elija etiqueta e ícono. */
  clave: "publicar" | "volverABorrador";
};

/**
 * Qué ofrece la fila según su estado actual.
 *
 * `closed` NO ofrece nada a propósito: reabrir una actividad cerrada vuelve a
 * habilitar entregas sobre notas que quizá ya se publicaron, así que es una
 * decisión con consecuencias que no corresponde a un clic de menú. Sigue
 * disponible desde el formulario de edición, donde el docente ve el resto del
 * contexto.
 */
export function transicionDeFila(status: string | null | undefined): Transicion | null {
  if (status === "draft") return { a: "published", clave: "publicar" };
  if (status === "published") return { a: "draft", clave: "volverABorrador" };
  return null;
}

/**
 * Al publicar, ¿el estudiante se entera YA o cuando se acerque la fecha?
 *
 * Espeja la condición del trigger `trg_*_publish_notify` tal como la dejó la
 * migración 20262210000000: si la fecha de inicio es nula o falta un día o
 * menos, notifica en el acto; si falta más, el aviso queda diferido y lo manda
 * el cron cuando la fecha esté a ≤24 h.
 *
 * Se necesita para que el diálogo de confirmación diga la verdad. «Se les
 * avisará a los estudiantes» sobre un examen de noviembre asusta de más, y no
 * decir nada sobre uno que empieza en dos horas asusta de menos.
 *
 * INVARIANTE: si cambia el umbral del trigger, cambia acá.
 */
export const HORAS_DE_AVISO_INMEDIATO = 24;

export function avisoAlPublicar(
  inicio: string | null | undefined,
  ahora: Date,
): "ahora" | "cuandoSeAcerque" {
  if (!inicio) return "ahora";
  const t = new Date(inicio).getTime();
  if (!Number.isFinite(t)) return "ahora";
  const horas = (t - ahora.getTime()) / 3_600_000;
  return horas > HORAS_DE_AVISO_INMEDIATO ? "cuandoSeAcerque" : "ahora";
}
