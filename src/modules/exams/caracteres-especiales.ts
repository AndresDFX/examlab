/**
 * Caracteres que el estudiante puede insertar con un toque durante un examen,
 * sin copiar ni pegar.
 *
 * ── Por qué existe ────────────────────────────────────────────────────
 * El examen BLOQUEA el portapapeles fuera del editor de código, y con razón:
 * pegar la respuesta de otra pestaña es el fraude más barato que hay. Pero ese
 * bloqueo dejó sin salida a un caso legítimo y frecuente en una sala de
 * cómputo: el teclado que no tiene la tecla. Un teclado en inglés no trae `ñ`
 * ni tildes; uno con una tecla rota se queda sin `;` — y en Java, sin `;` no
 * hay programa. El alumno terminaba buscando el carácter en otra ventana para
 * copiarlo, que es exactamente lo que el proctoring va a marcarle como intento
 * de trampa. Castigarlo por eso convierte un problema de hardware en una
 * acusación.
 *
 * La barra resuelve eso sin abrir ninguna puerta: **inserta el carácter
 * directamente en el campo**, por código. No toca el portapapeles, así que no
 * dispara `copy`/`paste`/`cut` ni deja ninguna señal de proctoring. Y como
 * solo puede insertar los caracteres de esta lista, no sirve para traer texto
 * de ningún otro lado.
 *
 * ── Dos juegos, no uno ────────────────────────────────────────────────
 * Una sola barra con todo sería ruido en las dos pantallas: en una respuesta
 * en prosa nadie necesita `{`, y en Java nadie necesita `¡`. El juego se elige
 * por el tipo de pregunta.
 */

/** Lo que falta al escribir en español en un teclado que no es español. */
export const CARACTERES_DE_TEXTO: readonly string[] = [
  "ñ",
  "Ñ",
  "á",
  "é",
  "í",
  "ó",
  "ú",
  "ü",
  "¿",
  "¡",
];

/**
 * Lo que falta al escribir código. Se ordena por frecuencia real —el `;` de
 * Java primero— y no alfabéticamente: la barra se toca con el pulgar en un
 * teléfono y lo primero es lo que más se usa.
 */
export const CARACTERES_DE_CODIGO: readonly string[] = [
  ";",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  "<",
  ">",
  '"',
  "'",
  "_",
  "|",
  "\\",
  "/",
  "&",
  "#",
  "ñ",
];

/**
 * Qué juego le corresponde a una pregunta, o `null` si NO debe mostrar barra.
 *
 * Devuelve `null` en las de selección: ahí el alumno no escribe nada, así que
 * una barra de caracteres sería un control que no hace nada —y un control que
 * no hace nada enseña que la pantalla está muerta—. Lo mismo con la de red por
 * interfaz gráfica, que se responde arrastrando.
 */
export function caracteresParaTipo(tipo: string): readonly string[] | null {
  switch (tipo) {
    case "cerrada":
    case "cerrada_multi":
    case "red_gui":
    case "codigo_zip":
      return null;
    case "codigo":
    case "java_gui":
    case "python_gui":
    case "bd_sql":
    case "so_consola":
    case "red_consola":
    case "diagrama":
      return CARACTERES_DE_CODIGO;
    default:
      // `abierta` y cualquier tipo nuevo de redacción.
      return CARACTERES_DE_TEXTO;
  }
}

/**
 * Inserta `caracter` reemplazando la selección `[inicio, fin)`.
 *
 * Se devuelve también dónde queda el cursor: sin eso, el campo se re-renderiza
 * con el valor nuevo y el cursor salta al final, así que insertar un `;` en
 * medio de una línea mandaba al alumno al final del archivo. Con una selección
 * activa se reemplaza, que es lo que hace cualquier editor.
 */
export function insertarCaracter(
  valor: string,
  inicio: number,
  fin: number,
  caracter: string,
): { valor: string; cursor: number } {
  const largo = valor.length;
  const a = Math.max(0, Math.min(Number.isFinite(inicio) ? inicio : largo, largo));
  const b = Math.max(a, Math.min(Number.isFinite(fin) ? fin : a, largo));
  return {
    valor: valor.slice(0, a) + caracter + valor.slice(b),
    cursor: a + caracter.length,
  };
}
