import { cargarEntorno } from "./entorno";
import { elegirArchivoSesion, guardarSesion, iniciarSesion } from "./sesion";

export default async function preparacionGlobal(): Promise<void> {
  elegirArchivoSesion();
  guardarSesion(await iniciarSesion(cargarEntorno()));
}
