/**
 * La ÚNICA acción de la tarjeta de una actividad en las listas del estudiante
 * (`TarjetaDeActividad`). Cada tarjeta muestra una sola: lo que el estudiante
 * vino a hacer o, si no puede hacer nada, por qué. El orden de las ramas ES la
 * regla: la primera que aplica gana. Lo demás (el detalle cuando la acción es
 * otra, borrar la entrega, el porqué largo) va en «Ver más».
 *
 * Vive acá y no en cada pantalla porque son reglas de negocio con prioridad —
 * sin grupo en grupal estricto no hay entrega, con los intentos agotados no se
 * re-entrega— y copiadas en tres pantallas se separan en silencio.
 */

/** Taller o proyecto. */
export type AccionDeEntrega =
  /** Grupal estricto, los grupos los arman los estudiantes y no tiene grupo. */
  | "armar"
  /** Proyecto externo sin nota: se hace fuera de la plataforma. */
  | "externo"
  /** Grupal estricto y el grupo lo asigna el docente: no puede entregar. */
  | "sinGrupo"
  /** Iniciar, seguir o actualizar la entrega. */
  | "entregar"
  /** Ver la nota y la retroalimentación. */
  | "detalle"
  /** Entregó y falta la nota (de la IA o del docente). */
  | "porCalificar"
  | "proximo"
  /** Publicada, pasó el plazo y no entregó. */
  | "vencido"
  | "cerrado";

export function accionDeEntrega(e: {
  /** `grupoEnTarjetaMuestraAlgo("accion", resumen)`. */
  armarGrupo: boolean;
  /** Proyecto externo. Los talleres externos no llegan a la lista del estudiante. */
  externa: boolean;
  /** Publicada, ya empezó y no venció. */
  abierta: boolean;
  /** Grupal estricto y no está en ningún grupo. */
  sinGrupoObligatorio: boolean;
  /** Consumió los intentos y la última entrega ya tiene nota. */
  intentosAgotados: boolean;
  /** `retroDeTallerVisible`: la entrega tiene nota. */
  conNota: boolean;
  /** `entregaHecha`. */
  entregada: boolean;
  proxima: boolean;
  /** Publicada y pasó el plazo. */
  vencida: boolean;
}): AccionDeEntrega {
  if (e.armarGrupo) return "armar";
  // Un externo no se entrega por acá: con nota se ve el detalle, sin nota no
  // hay nada que hacer. Ni «Vencido» ni «Iniciar entrega».
  if (e.externa) return e.conNota ? "detalle" : "externo";
  if (e.abierta && e.sinGrupoObligatorio) return "sinGrupo";
  // Mientras esté abierta se puede actualizar aunque ya tenga nota de la IA:
  // al re-entregar se vuelve a calificar.
  if (e.abierta && !e.intentosAgotados) return "entregar";
  if (e.conNota) return "detalle";
  if (e.entregada) return "porCalificar";
  if (e.proxima) return "proximo";
  if (e.vencida) return "vencido";
  return "cerrado";
}

export type AccionDeExamen =
  | "reintentar"
  /** Ver la nota y la retroalimentación del último intento. */
  | "detalle"
  /** Terminó el último intento y falta la nota. */
  | "porCalificar"
  /** Dejó un intento a medias y la ventana ya cerró. */
  | "ventanaCerrada"
  | "sinIntentos"
  /** Llegó al tope de advertencias con el intento abierto. */
  | "suspendido"
  /** Iniciar o reanudar. */
  | "presentar"
  | "proximo"
  | "cerrado";

export function accionDeExamen(e: {
  /** El último intento terminó (`completado` o `sospechoso`). */
  completado: boolean;
  /** Ahora está dentro de la ventana del examen. */
  abierto: boolean;
  sinIntentos: boolean;
  /** `retroDeExamenVisible` del último intento. */
  conNota: boolean;
  /** El último intento sigue `en_progreso`. */
  enCurso: boolean;
  /** La ventana ya cerró. */
  ventanaTerminada: boolean;
  /** La ventana todavía no abre. */
  antesDeAbrir: boolean;
  advertenciasAlTope: boolean;
}): AccionDeExamen {
  if (e.completado && !e.sinIntentos && e.abierto) return "reintentar";
  // La retroalimentación se ve recién con nota (retroalimentacion-visible.ts).
  if (e.completado) return e.conNota ? "detalle" : "porCalificar";
  if (e.enCurso && !e.abierto && e.ventanaTerminada) return "ventanaCerrada";
  if (e.sinIntentos) return "sinIntentos";
  if (e.abierto && e.enCurso && e.advertenciasAlTope) return "suspendido";
  if (e.abierto) return "presentar";
  if (e.antesDeAbrir) return "proximo";
  return "cerrado";
}
