import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guardrail: ajustar un check-in ABIERTO no puede cambiar el código proyectado.
 *
 * ── El daño que ataja ─────────────────────────────────────────────────
 * `teacher_open_attendance_check_in` fue durante mucho tiempo un UPSERT cuyo
 * `ON CONFLICT … DO UPDATE` hacía `SET seed = EXCLUDED.seed`. La semilla es de
 * donde sale el código de seis dígitos que el docente proyecta, así que volver a
 * llamar esa función sobre un check-in en curso cambiaba el número de golpe:
 * quien lo había anotado se quedaba con uno muerto, y sin ningún aviso. Desde
 * `20262140000000` la función distingue el AJUSTE (ventana viva) de la
 * RE-APERTURA (fila vencida) y en el primero preserva `seed` y `opened_at`.
 *
 * ── Por qué un test y no solo un comentario ───────────────────────────
 * Esta función se reescribió DIEZ veces, y una de esas migraciones se llama
 * `20261810000000_attendance_open_pgcrypto_regression.sql`: alguien la reescribió
 * partiendo de la primera versión que encontró en el repositorio en vez de la
 * vigente, y revirtió un arreglo sin que nada fallara al aplicar la migración. Un
 * comentario en la migración vieja no lo evita, porque quien la reescribe no la
 * está leyendo. Este test sí — es el mismo mecanismo con el que
 * `pgcrypto-search-path.test.ts` ya frenó tres reincidencias.
 *
 * Solo mira la ÚLTIMA definición (la que gana en la base): que una migración
 * histórica tenga el defecto es correcto si una posterior lo corrigió.
 */

const DIR = "supabase/migrations";
const FUNCION = "public.teacher_open_attendance_check_in";

interface Definicion {
  archivo: string;
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
      salida.set(nombre, { archivo, cuerpo: resto.slice(iniCuerpo, finCuerpo) });
    }
  }
  return salida;
}

describe("ajustar un check-in abierto no cambia el código proyectado", () => {
  const definicion = ultimaDefinicionPorFuncion().get(FUNCION);

  it("el barrido encuentra la función (si no, la búsqueda se rompió)", () => {
    // Sin esta comprobación, un cambio de formato en las migraciones dejaría el
    // resto del archivo en verde por no analizar nada.
    expect(definicion, `no se encontró ninguna definición de ${FUNCION}`).toBeDefined();
    expect(definicion!.cuerpo.length).toBeGreaterThan(1000);
  });

  it("bifurca por VENTANA VIVA, no por la simple existencia de la fila", () => {
    // `seed` es NOT NULL, así que no hay COALESCE que preserve: el único
    // discriminador correcto es si la ventana todavía está corriendo.
    expect(definicion!.cuerpo).toMatch(/closes_at\s*>\s*now\(\)/);
  });

  it("ningún UPDATE de attendance_check_in_state toca seed ni opened_at", () => {
    // Ésta es la aserción que habría atajado la regresión histórica: quien
    // reescriba la función partiendo de una copia vieja pone el test en rojo,
    // no la clase en silencio.
    const updates =
      definicion!.cuerpo.match(/UPDATE\s+public\.attendance_check_in_state[\s\S]*?;/gi) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u, `este UPDATE cambiaría el código proyectado:\n${u}`).not.toMatch(/\bseed\b/i);
      expect(u, `este UPDATE movería la apertura:\n${u}`).not.toMatch(/\bopened_at\b/i);
    }
  });

  it("la semilla solo se asigna en el INSERT … ON CONFLICT (la re-apertura)", () => {
    // La re-apertura de una ventana VENCIDA sí tiene que rotar la semilla: si no,
    // el código fijo de la clase de ayer seguiría valiendo hoy.
    const insert = /INSERT\s+INTO\s+public\.attendance_check_in_state[\s\S]*?ON\s+CONFLICT[\s\S]*?;/i.exec(
      definicion!.cuerpo,
    );
    expect(insert, "no se encontró el INSERT … ON CONFLICT de la re-apertura").not.toBeNull();
    expect(insert![0]).toMatch(/seed\s*=\s*EXCLUDED\.seed/i);
  });

  it("rechaza un cierre en el pasado (es irreversible: se pierde la semilla)", () => {
    expect(definicion!.cuerpo).toMatch(/'closes_in_past'/);
  });

  it("la normalización a código fijo compara la rotación contra la GUARDADA", () => {
    // El código que ve la clase depende de la semilla Y de la rotación:
    // `attendancePeriod(60) ≠ attendancePeriod(0)`. Preservar solo la semilla
    // cubre la mitad del problema.
    //
    // El guard original era `p_rotation_seconds IS NOT NULL`, que NO distingue
    // «la rotación se está editando» de «el cliente la reenvió igual» — y el
    // único llamador la manda siempre. Con eso, ACORTAR la ventana normalizaba a
    // código fijo y los seis dígitos cambiaban sin aviso, con la rotación por
    // defecto y sin que el docente hubiera tocado la rotación.
    expect(definicion!.cuerpo).toMatch(
      /p_rotation_seconds\s+IS\s+DISTINCT\s+FROM\s+v_prev\.rotation_seconds/i,
    );
    expect(
      definicion!.cuerpo,
      "el guard volvió a `IS NOT NULL`: acortar la ventana fijaría el código sin aviso",
    ).not.toMatch(/OR\s+p_rotation_seconds\s+IS\s+NOT\s+NULL/i);
  });

  it("los parámetros opcionales tienen DEFAULT NULL (el contrato es «NULL = no tocar»)", () => {
    // Con `DEFAULT 60` / `DEFAULT false`, un llamador que OMITIERA el argumento
    // en un ajuste ponía rotación 60 — cambiando el código — y apagaba el modo
    // solo-correo. La firma está fuera del cuerpo, así que se lee el archivo.
    const sql = readFileSync(join(DIR, definicion!.archivo), "utf8");
    expect(sql).toMatch(/p_rotation_seconds\s+int\s+DEFAULT\s+NULL/i);
    expect(sql).toMatch(/p_email_only\s+boolean\s+DEFAULT\s+NULL/i);
  });
});
