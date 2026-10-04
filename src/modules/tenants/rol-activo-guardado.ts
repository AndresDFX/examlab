import type { AppRole } from "@/hooks/use-auth";

/**
 * El rol activo sobrevive a una RECARGA. Sin esto, un usuario multi-rol que
 * recargaba volvía al rol por defecto (Docente) y el control de acceso, al ver
 * una pantalla de otro rol, lo mandaba al inicio: perdía el rol Y la pantalla.
 *
 * `sessionStorage` y no `localStorage` a propósito: dura lo que la pestaña. Una
 * sesión nueva (iniciar sesión, abrir la app de cero) sigue entrando con el rol
 * por defecto, que es la decisión vigente; lo que se conserva es la elección
 * hecha DENTRO de la pestaña. La clave lleva el usuario: al impersonar o cambiar
 * de cuenta en la misma pestaña, el rol de otro no se hereda.
 */
const CLAVE = "examlab_rol_activo:";

/** Rol por defecto: Docente > Admin > Estudiante; si no, el primero. */
export function rolPorDefecto(roles: readonly AppRole[]): AppRole | null {
  const orden: AppRole[] = ["Docente", "Admin", "Estudiante"];
  return orden.find((r) => roles.includes(r)) ?? roles[0] ?? null;
}

/** El guardado manda si el usuario todavía tiene ese rol; si no, el de defecto. */
export function elegirRolInicial(roles: readonly AppRole[], guardado: string | null): AppRole | null {
  if (guardado && roles.includes(guardado as AppRole)) return guardado as AppRole;
  return rolPorDefecto(roles);
}

export function leerRolGuardado(userId: string): string | null {
  try {
    return sessionStorage.getItem(CLAVE + userId);
  } catch {
    return null;
  }
}

export function guardarRol(userId: string, rol: AppRole): void {
  try {
    sessionStorage.setItem(CLAVE + userId, rol);
  } catch {
    // Navegación privada o almacenamiento bloqueado: se pierde solo la comodidad.
  }
}
