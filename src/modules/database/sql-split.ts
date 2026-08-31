/**
 * Parte un guion de SQL en sentencias, con la posición de cada una.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────
 * `SqlRunner` mandaba la hoja COMPLETA en un solo `exec`, y Postgres ejecuta un
 * lote de sentencias dentro de una **transacción implícita**: si cualquier
 * sentencia falla, se revierten TODAS las anteriores. Efecto medido con PGlite
 * 0.5.4 sobre este guion:
 *
 *     SELECT * FROM v_agenda_recepcion;   -- la vista no existe → error
 *     CREATE TABLE duenoss (...);
 *     select * from duenoss;
 *
 * el `CREATE TABLE` quedaba deshecho y la tabla NO existía. Visto desde la
 * pizarra eso se lee como "no puedo crear tablas desde el editor": el error que
 * se ve es el de la primera línea, y la creación —que era correcta— desaparece
 * sin dejar rastro. Ejecutando sentencia por sentencia, la tabla queda creada y
 * cada error queda al lado de la sentencia que lo produjo.
 *
 * ── Por qué no alcanza `split(";")` ───────────────────────────────────────
 * Para ETIQUETAR resultados el split crudo era aceptable (desalinear un rótulo
 * no rompe nada). Para EJECUTAR no: un `;` dentro de un literal, de un
 * comentario o de un bloque `$$ ... $$` de PL/pgSQL partiría la sentencia al
 * medio y el motor recibiría SQL inválido — se rompería justo el ejemplo
 * avanzado que hoy funciona. Por eso acá se recorre el texto respetando:
 *
 *  - literales `'...'` con `''` como escape, y `E'...'` donde además `\` escapa;
 *  - identificadores `"..."` con `""` como escape;
 *  - comentarios `-- hasta el fin de línea` y `/* ... *\/`, que en Postgres ANIDAN;
 *  - dólar-comillas `$$ ... $$` / `$tag$ ... $tag$`, que solo cierra el MISMO tag.
 *
 * Es una función pura y con tests: la partición es lo único que separa "corre el
 * guion" de "el motor recibe basura".
 */

export type SqlStatement = {
  /** La sentencia sin el `;` final, ya recortada. */
  sql: string;
  /** Posición del primer carácter en el texto original. */
  start: number;
  /** Posición del carácter siguiente al último (fin exclusivo, sin el `;`). */
  end: number;
};

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

/** Si en `i` empieza una dólar-comilla, devuelve su tag completo (`$$`, `$x$`). */
function dollarTagAt(s: string, i: number): string | null {
  if (s[i] !== "$") return null;
  let j = i + 1;
  while (j < s.length && s[j] !== "$") {
    const c = s[j];
    // El tag es un identificador; `$1` (parámetro) NO es una dólar-comilla.
    if (j === i + 1 ? !IDENT_START.test(c) : !IDENT_CHAR.test(c)) return null;
    j++;
  }
  if (j >= s.length) return null;
  return s.slice(i, j + 1);
}

/** ¿La comilla simple en `i` abre un literal con escapes de barra (`E'...'`)? */
function esLiteralConEscapes(s: string, i: number): boolean {
  const prev = s[i - 1];
  if (prev !== "E" && prev !== "e") return false;
  const antes = s[i - 2];
  // `E'x'` sí; `case'x'` no (la E es parte de una palabra).
  return antes === undefined || !IDENT_CHAR.test(antes);
}

export function splitSqlStatements(input: string): SqlStatement[] {
  const s = input ?? "";
  const out: SqlStatement[] = [];
  let inicio = 0;
  let i = 0;

  const empujar = (fin: number) => {
    const crudo = s.slice(inicio, fin);
    const recortado = crudo.trim();
    if (!recortado) return;
    // Una "sentencia" que solo son comentarios no se manda al motor.
    if (!soloComentarios(recortado)) {
      const desplazamiento = crudo.length - crudo.trimStart().length;
      out.push({
        sql: recortado,
        start: inicio + desplazamiento,
        end: inicio + desplazamiento + recortado.length,
      });
    }
  };

  while (i < s.length) {
    const c = s[i];

    if (c === "-" && s[i + 1] === "-") {
      const salto = s.indexOf("\n", i);
      i = salto === -1 ? s.length : salto + 1;
      continue;
    }

    if (c === "/" && s[i + 1] === "*") {
      // Los comentarios de bloque de Postgres ANIDAN: hay que contar.
      let nivel = 1;
      i += 2;
      while (i < s.length && nivel > 0) {
        if (s[i] === "/" && s[i + 1] === "*") {
          nivel++;
          i += 2;
        } else if (s[i] === "*" && s[i + 1] === "/") {
          nivel--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    if (c === "'") {
      const conEscapes = esLiteralConEscapes(s, i);
      i++;
      while (i < s.length) {
        if (conEscapes && s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === "'") {
          if (s[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (c === '"') {
      i++;
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    const tag = dollarTagAt(s, i);
    if (tag) {
      const cierre = s.indexOf(tag, i + tag.length);
      // Sin cierre, el resto del texto es el cuerpo: mejor mandar una sentencia
      // que el motor rechaza con un error claro que partirla por un `;` interno.
      i = cierre === -1 ? s.length : cierre + tag.length;
      continue;
    }

    if (c === ";") {
      empujar(i);
      i++;
      inicio = i;
      continue;
    }

    i++;
  }

  empujar(s.length);
  return out;
}

/** ¿Este fragmento son puros comentarios y espacios? */
function soloComentarios(frag: string): boolean {
  let i = 0;
  while (i < frag.length) {
    const c = frag[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c === "-" && frag[i + 1] === "-") {
      const salto = frag.indexOf("\n", i);
      i = salto === -1 ? frag.length : salto + 1;
      continue;
    }
    if (c === "/" && frag[i + 1] === "*") {
      let nivel = 1;
      i += 2;
      while (i < frag.length && nivel > 0) {
        if (frag[i] === "/" && frag[i + 1] === "*") {
          nivel++;
          i += 2;
        } else if (frag[i] === "*" && frag[i + 1] === "/") {
          nivel--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    return false;
  }
  return true;
}
