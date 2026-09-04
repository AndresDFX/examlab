import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CHECKIN_TEACHER_ERRORS, claveDeErrorCheckIn } from "./checkin-errors";

/**
 * Todo código de error que una RPC del check-in pueda devolverle al DOCENTE tiene
 * que tener un mensaje.
 *
 * ── El bug que ataja ──────────────────────────────────────────────────────
 * Un código sin mensaje llega CRUDO a la pantalla. Ya pasó en producción: un
 * estudiante leyó «requirement_pending» en clase. Del lado del docente era peor,
 * porque no había mapa: cualquier validación de la ventana o de los requisitos salía
 * como `closes_in_past` o `requirement_unavailable`.
 *
 * ── Por qué un test que lee las migraciones ───────────────────────────────
 * No hay tipo que relacione un string de PL/pgSQL con una clave i18n. Lo único que
 * lo detecta es leer los `'error', '<codigo>'` que las funciones emiten de verdad y
 * comparar. Así, agregar un `RETURN … 'error', 'algo_nuevo'` en una migración futura
 * pone este test en rojo en vez de sacar el código a pantalla.
 */

const MIGRACIONES = resolve(__dirname, "../../../supabase/migrations");
const LOCALES = resolve(__dirname, "../../i18n/locales");

/** Funciones cuyo resultado LEE la pantalla del docente. */
const FUNCIONES_DEL_DOCENTE = [
  "teacher_open_attendance_check_in",
  "teacher_extend_attendance_check_in",
  "teacher_mark_pending_absent",
];

/**
 * Los códigos que emite cada función, leyendo el cuerpo desde el `CREATE … FUNCTION`
 * hasta el cierre `$$;`. Se recorren TODAS las migraciones porque una función se
 * redefine varias veces y cada versión puede sumar códigos.
 */
function codigosDeLasFunciones(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of readdirSync(MIGRACIONES).filter((f) => f.endsWith(".sql"))) {
    const texto = readFileSync(join(MIGRACIONES, f), "utf8");
    for (const nombre of FUNCIONES_DEL_DOCENTE) {
      // `CREATE …` y no un `FUNCTION` cualquiera: las líneas `REVOKE ALL ON FUNCTION`
      // y `GRANT EXECUTE ON FUNCTION` también nombran la función, y desde ellas el
      // siguiente `$$` abre la función que viene DESPUÉS — con lo que el barrido le
      // atribuía a esta pantalla códigos que solo ve el estudiante.
      const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${nombre}\\s*\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(texto)) !== null) {
        // El cuerpo va del `$$` que lo abre al `$$` que lo cierra. Buscar `"\n$$;"`
        // no alcanza: si esa versión de la función no termina exactamente así, la
        // ventana se estira hasta el final del archivo y absorbe los códigos de las
        // funciones que vienen DESPUÉS (las del estudiante), que esta pantalla no lee.
        const abre = texto.indexOf("$$", m.index);
        if (abre === -1) continue;
        const cierra = texto.indexOf("$$", abre + 2);
        const cuerpo = texto.slice(abre, cierra === -1 ? texto.length : cierra);
        for (const c of cuerpo.matchAll(/'error',\s*'([a-z0-9_]+)'/g)) {
          if (!out.has(nombre)) out.set(nombre, new Set());
          out.get(nombre)!.add(c[1]);
        }
      }
    }
  }
  return out;
}

function locale(l: string): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(join(LOCALES, `${l}.json`), "utf8"));
}

describe("mensajes de error del check-in (docente)", () => {
  const porFuncion = codigosDeLasFunciones();

  it("encuentra las funciones del check-in en las migraciones", () => {
    // Si el barrido no encuentra nada (una función se renombró, cambió el formato
    // del cuerpo), los demás test pasarían en vacío y el guardrail sería decorativo.
    expect([...porFuncion.keys()].sort()).toEqual([...FUNCIONES_DEL_DOCENTE].sort());
  });

  it("todo código que el docente puede recibir tiene mensaje", () => {
    const faltan: string[] = [];
    for (const [fn, codigos] of porFuncion) {
      for (const c of codigos) {
        if (!(c in CHECKIN_TEACHER_ERRORS)) faltan.push(`${fn} → ${c}`);
      }
    }
    expect(
      faltan,
      `Códigos sin mensaje (el docente leería el identificador crudo):\n${faltan.join("\n")}`,
    ).toEqual([]);
  });

  for (const l of ["es", "en"]) {
    it(`toda clave del mapa existe en ${l}`, () => {
      const dic = locale(l);
      const faltan = Object.values(CHECKIN_TEACHER_ERRORS).filter((clave) => {
        const [ns, k] = clave.split(".");
        return typeof dic[ns]?.[k] !== "string";
      });
      // Una clave inexistente hace que i18next imprima la clave: el docente leería
      // «teacherAttendance.errClosesInPast», que es igual de inservible que el código.
      expect(faltan, faltan.join(", ")).toEqual([]);
    });
  }

  it("un código desconocido devuelve null, no el código", () => {
    // Si devolviera el código, quien llama lo pintaría sin darse cuenta y estaríamos
    // otra vez en el bug original.
    expect(claveDeErrorCheckIn("algo_que_no_existe")).toBeNull();
    expect(claveDeErrorCheckIn(null)).toBeNull();
    expect(claveDeErrorCheckIn(undefined)).toBeNull();
    expect(claveDeErrorCheckIn("closes_in_past")).toBe("teacherAttendance.errClosesInPast");
  });
});
