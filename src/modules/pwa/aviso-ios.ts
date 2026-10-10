/**
 * Dónde se muestra el aviso «Instala ExamLab en tu iPhone».
 *
 * Solo en el inicio de la app. Es `fixed` y mide ~130 px: en las demás
 * pantallas tapaba lo que el estudiante vino a hacer — el botón «Iniciar
 * examen» al final de la lista y el campo del código en la asistencia (medido
 * en WebKit el 2026-10-10). En el inicio no hay ninguna acción debajo, y sigue
 * siendo la única vía para que iOS entregue notificaciones con la app cerrada.
 */
export function debeMostrarAvisoIos(pathname: string): boolean {
  return pathname === "/app" || pathname === "/app/";
}
