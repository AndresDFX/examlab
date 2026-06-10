/**
 * returnTo — recordar a qué ruta protegida volver tras el login.
 *
 * El login de ExamLab redirige siempre a `/app` (window.location.href). Eso
 * pierde el deep-link cuando un usuario NO logueado abre una URL protegida
 * (ej. el QR de un Kahoot → `/app/student/polls?kahootPin=…`, o el QR de
 * asistencia). Este helper guarda la ruta intentada ANTES de rebotar a
 * `/auth` (lo hace el guard de AppLayout) y la restaura en el login.
 *
 * SEGURIDAD: solo se acepta una ruta INTERNA (empieza con `/app`). Así un
 * valor manipulado en sessionStorage no puede convertirse en open-redirect a
 * otro origen.
 */
const KEY = "examlab_return_to";

/** Guarda la ruta actual (path + query) si es interna, para volver tras login. */
export function captureReturnTo(): void {
  if (typeof window === "undefined") return;
  const path = window.location.pathname + window.location.search;
  if (!path.startsWith("/app")) return;
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    /* sessionStorage lleno/bloqueado — no es crítico */
  }
}

/** Lee y LIMPIA la ruta de retorno. Devuelve null si no hay o no es interna. */
export function consumeReturnTo(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return v && v.startsWith("/app") ? v : null;
  } catch {
    return null;
  }
}
