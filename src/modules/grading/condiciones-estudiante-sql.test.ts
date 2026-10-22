import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aplicarTopeDeNota, plazoPropioVigente } from "./condiciones-estudiante";

/**
 * Espejo SQL de las condiciones por estudiante.
 *
 * El tope y el plazo propio se aplican al leer la nota en `nota_relativa_items`
 * (que usa el acta, `generate_course_acta`). Este test lee la ÚLTIMA definición
 * de esa función entre todas las migraciones y fija que la regla del cliente
 * (`aplicarTopeDeNota` + `plazoPropioVigente`) tenga su espejo en SQL: si alguien
 * cambia un lado, acá se entera de que falta el otro. La paridad fina se verifica
 * contra PGlite/producción.
 */
describe("espejo SQL: condiciones por estudiante en nota_relativa_items", () => {
  const dir = resolve(__dirname, "../../../supabase/migrations");
  const ultimaDefinicion = (fn: string) => {
    let def = "";
    for (const archivo of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(resolve(dir, archivo), "utf8");
      const i = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      if (i < 0) continue;
      const fin = sql.indexOf("CREATE OR REPLACE FUNCTION", i + 10);
      def = sql.slice(i, fin < 0 ? undefined : fin);
    }
    return def;
  };

  const def = ultimaDefinicion("nota_relativa_items");

  it("la función existe y se redefinió", () => {
    expect(def).not.toBe("");
  });

  it("aplica el TOPE como min(nota, N) en talleres y proyectos (uno por tipo)", () => {
    const topes = def.match(/LEAST\(x\.score, cnd\.nota_maxima\)/g) ?? [];
    expect(topes).toHaveLength(2);
    // El helper del cliente hace exactamente ese min.
    expect(aplicarTopeDeNota(5, 4)).toBe(4);
  });

  it("el plazo propio vigente de quien no entregó evita que la actividad cuente 0 (uno por tipo)", () => {
    const plazos = def.match(/cnd\.plazo_propio IS NOT NULL AND cnd\.plazo_propio > now\(\) AND NOT x\.entrego/g) ?? [];
    expect(plazos).toHaveLength(2);
    expect(plazoPropioVigente("2026-12-31T00:00:00Z", Date.parse("2026-10-21T00:00:00Z"))).toBe(true);
  });

  it("lee la condición por tipo y usuario, para taller y proyecto", () => {
    expect(def).toContain("ce.tipo = 'taller' AND ce.actividad_id = w.id AND ce.user_id = p_user_id");
    expect(def).toContain("ce.tipo = 'proyecto' AND ce.actividad_id = p.id AND ce.user_id = p_user_id");
  });

  it("los exámenes NO llevan condición (el tope es solo de talleres y proyectos)", () => {
    // El bloque de exámenes usa x.score directo, sin pasar por el LATERAL `ef`.
    const bloqueExamen = def.slice(def.indexOf("'examen'::text"), def.indexOf("'taller'::text"));
    expect(bloqueExamen).not.toContain("condiciones_estudiante");
  });
});
