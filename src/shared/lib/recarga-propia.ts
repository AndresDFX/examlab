/**
 * Recargas que hace la PROPIA plataforma —una versión nueva desplegada, un
 * archivo viejo que ya no existe, un error que se recupera recargando— y no
 * el usuario.
 *
 * El examen las distingue: con «cerrar o recargar cuenta como advertencia»
 * encendido, un despliegue a mitad del parcial le cobraría al estudiante una
 * salida que no hizo (ver `onBeforeUnload` en `TakeExamScreen.tsx`). El
 * script previo a la hidratación de `__root.tsx` no puede importar módulos y
 * marca la MISMA bandera a mano; lo fija `salida-de-la-pagina.test.ts`.
 */
declare global {
  interface Window {
    __examlabRecargaPropia?: boolean;
  }
}

export function marcarRecargaPropia(): void {
  try {
    window.__examlabRecargaPropia = true;
  } catch {
    /* sin window (prerender): no hay nada que marcar */
  }
}

/** Recarga la página dejando constancia de que la pidió la plataforma. */
export function recargarLaApp(): void {
  marcarRecargaPropia();
  window.location.reload();
}

export function esRecargaPropia(): boolean {
  return typeof window !== "undefined" && window.__examlabRecargaPropia === true;
}
