import { existsSync } from "node:fs";
import { cargarEntorno } from "./entorno";
import { archivoSesion, borrarSesionGuardada, cerrarSesion, leerSesionGuardada } from "./sesion";

/**
 * Cierra la sesión de la corrida: aunque una traza local se comparta por error, su token
 * de refresco ya no sirve para abrir otra.
 */
export default async function cierreGlobal(): Promise<void> {
  if (!existsSync(archivoSesion())) return;
  await cerrarSesion(cargarEntorno(), leerSesionGuardada());
  borrarSesionGuardada();
}
