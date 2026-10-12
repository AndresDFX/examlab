// Lo que comparten los scripts de notas-a-uniajc: la configuración del periodo, las
// credenciales locales, la carpeta privada de cada corte y las reglas del portal.
const path = require("path");
const fs = require("fs");

const RAIZ = path.resolve(__dirname, "../../..");
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "cursos.json"), "utf8"));

/** Valor de una clave en un archivo .env de la raíz del repo (con o sin comillas). */
function leerEnv(archivo, clave) {
  const ruta = path.join(RAIZ, archivo);
  if (!fs.existsSync(ruta)) throw new Error(`Falta ${archivo} en la raíz del repo (ver SKILL.md)`);
  const m = new RegExp(`^${clave}="?([^"\\r\\n]+)`, "m").exec(fs.readFileSync(ruta, "utf8"));
  if (!m) throw new Error(`Falta ${clave} en ${archivo}`);
  return m[1].trim();
}

/** `--clave=valor`, `--bandera` y el primer argumento suelto. */
function argumentos(argv = process.argv.slice(2)) {
  const opciones = {};
  let suelto = null;
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) opciones[m[1]] = m[2] === undefined ? true : m[2];
    else if (suelto == null) suelto = a;
  }
  return { opciones, suelto };
}

/**
 * Carpeta de los CSV de un corte. Por omisión `privado/notas-<periodo>/corte<N>`: los
 * archivos llevan nombre, documento y nota de cada estudiante, y el repo es público —
 * `privado/` está en .gitignore.
 */
function carpetaDelCorte(corte, explicita) {
  return explicita ? path.resolve(explicita) : path.join(RAIZ, "privado", `notas-${CONFIG.periodo}`, `corte${corte}`);
}

const archivoCsv = (carpeta, corte, curso) => path.join(carpeta, `Corte${corte} - ${curso.archivo}.csv`);

/** Filas de un CSV de leer-libro: Estudiante;Documento;Correo;Corte N;Aporte. */
function leerCsv(ruta) {
  return fs
    .readFileSync(ruta, "utf8")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [estudiante, documento, correo, nota] = l.split(";");
      return { estudiante, documento: String(documento).trim(), correo, nota: Number(String(nota).replace(",", ".")) };
    });
}

/** Cursos a procesar: todos, o los que coinciden con `--solo` (archivo, libro o grupo). */
function cursosElegidos(solo) {
  if (!solo) return CONFIG.cursos;
  const s = String(solo).toLowerCase();
  return CONFIG.cursos.filter((c) => [c.archivo, c.libro, c.grupo].some((x) => x.toLowerCase().includes(s)));
}

// El portal acepta UNA cifra decimal con punto («4.5»: la caja tiene maxlength 3).
// Redondeo con la mitad hacia arriba, el mismo criterio que el libro de notas.
const aPortal = (nota) => (Math.round(nota * 10 + 1e-9) / 10).toFixed(1);

const norm = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

const paso = (m) => console.log(new Date().toISOString().slice(11, 19), m);

module.exports = { RAIZ, CONFIG, leerEnv, argumentos, carpetaDelCorte, archivoCsv, leerCsv, cursosElegidos, aPortal, norm, paso };
