import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guardrail: ninguna función SECURITY DEFINER puede llamar a pgcrypto sin poder
 * resolverlo.
 *
 * ── El error que ataja ────────────────────────────────────────────────
 * `function gen_random_bytes(integer) does not exist`, en producción, al iniciar
 * el check-in con QR. En Supabase pgcrypto vive en el schema `extensions`, así
 * que una función con `SET search_path = public` NO ve `gen_random_bytes` ni
 * `digest`. Se arregla de dos formas, y hace falta al menos una: poner
 * `extensions` en el search_path, o llamar con el prefijo `extensions.`.
 *
 * ── Por qué un test y no solo un comentario ───────────────────────────
 * Ya pasó TRES veces en este proyecto:
 *   1. mayo — `20260507100100_attendance_check_in_pgcrypto_fix.sql` lo arregló
 *      en `compute_attendance_code` y en `teacher_open_attendance_check_in`;
 *   2. `20261750000000` (modo solo-correo) reescribió esa segunda función
 *      copiando la versión ANTERIOR al fix, y lo revirtió sin que nada fallara
 *      al aplicar la migración;
 *   3. `20261800000000` (topes más largos) arrastró la misma copia.
 *
 * El patrón es siempre el mismo: alguien reescribe una función con CREATE OR
 * REPLACE partiendo de la primera versión que encuentra en el repositorio, no de
 * la vigente. Un comentario en la migración vieja no lo evita, porque quien la
 * reescribe no la está leyendo. Este test sí.
 *
 * Solo mira la ÚLTIMA definición de cada función (la que gana en la base): que
 * una migración histórica tenga el defecto es correcto si una posterior lo
 * corrigió.
 */

const DIR = "supabase/migrations";
const FUNCIONES_PGCRYPTO = ["gen_random_bytes", "digest", "hmac", "crypt", "gen_salt"];

interface Definicion {
  archivo: string;
  cabecera: string;
  cuerpo: string;
}

/** Última definición de cada función, recorriendo las migraciones en orden. */
function ultimaDefinicionPorFuncion(): Map<string, Definicion> {
  const salida = new Map<string, Definicion>();
  const archivos = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const archivo of archivos) {
    const sql = readFileSync(join(DIR, archivo), "utf8");
    const re = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([\w.]+)\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const nombre = m[1];
      // El cuerpo va entre la primera pareja de dollar-quotes después del
      // encabezado. La etiqueta es arbitraria ($$, $function$, $fn$…).
      const resto = sql.slice(m.index + m[0].length);
      const etiqueta = /(\$[A-Za-z_]*\$)/.exec(resto.slice(0, 4000));
      if (!etiqueta) continue;
      const iniCuerpo = etiqueta.index + etiqueta[1].length;
      const finCuerpo = resto.indexOf(etiqueta[1], iniCuerpo);
      if (finCuerpo < 0) continue;
      salida.set(nombre, {
        archivo,
        cabecera: resto.slice(0, etiqueta.index),
        cuerpo: resto.slice(iniCuerpo, finCuerpo),
      });
    }
  }
  return salida;
}

/** Llamadas a pgcrypto SIN el prefijo `extensions.`. */
function llamadasSinPrefijo(cuerpo: string): string[] {
  const encontradas: string[] = [];
  for (const fn of FUNCIONES_PGCRYPTO) {
    const re = new RegExp(`(\\w+\\s*\\.\\s*)?\\b${fn}\\s*\\(`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(cuerpo)) !== null) {
      const califica = (m[1] ?? "").replace(/[\s.]/g, "");
      if (califica !== "extensions") encontradas.push(fn);
    }
  }
  return [...new Set(encontradas)];
}

describe("pgcrypto en funciones SECURITY DEFINER", () => {
  const definiciones = ultimaDefinicionPorFuncion();

  it("el barrido encuentra funciones (si no, la expresión de búsqueda se rompió)", () => {
    // Sin esta comprobación, un cambio de formato en las migraciones dejaría el
    // test en verde por no analizar nada — que es como mi barrido anterior dio
    // un resultado tranquilizador y falso.
    expect(definiciones.size).toBeGreaterThan(100);
  });

  it("ninguna función vigente llama a pgcrypto sin poder resolverlo", () => {
    const rotas: string[] = [];
    for (const [nombre, def] of definiciones) {
      const sinPrefijo = llamadasSinPrefijo(def.cuerpo);
      if (sinPrefijo.length === 0) continue; // usa el prefijo: resuelve siempre
      const buscaEnExtensions = /search_path\s*=\s*[^;\n]*\bextensions\b/i.test(def.cabecera);
      if (!buscaEnExtensions) {
        rotas.push(
          `${nombre} (${def.archivo}): llama ${sinPrefijo.join(", ")} sin prefijo y sin \`extensions\` en el search_path`,
        );
      }
    }
    expect(rotas).toEqual([]);
  });

  it("hay al menos una función que usa pgcrypto (el test no es vacuo)", () => {
    const conPgcrypto = [...definiciones.values()].filter((d) =>
      FUNCIONES_PGCRYPTO.some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(d.cuerpo)),
    );
    expect(conPgcrypto.length).toBeGreaterThan(0);
  });
});
