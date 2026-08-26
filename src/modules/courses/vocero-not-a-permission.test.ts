/**
 * GUARDRAIL: la etiqueta de vocero NO puede convertirse en un permiso.
 *
 * ── Por qué existe este test ───────────────────────────────────────────
 * El dato es tentador: ya está a mano, dice "representante del curso", y el día
 * que alguien quiera que el vocero pueda moderar el foro, subir la entrega del
 * grupo o ver algo del curso, el camino de menor esfuerzo es un `if` sobre esta
 * columna. Eso convertiría una etiqueta informativa —escrita por el docente, sin
 * revisión, sin auditoría de privilegio— en autorización.
 *
 * Cuando el vocero necesite HACER algo, eso es una capacidad nueva con su propia
 * autorización, no un `if` sobre este campo. Este test es lo que fuerza esa
 * conversación en vez de dejarla pasar en un diff.
 *
 * Falla si `vocero_marcado_at` / `vocero_marcado_por` aparecen en un contexto de
 * decisión: una policy RLS, un `has_role`, un `canX`, un guard de ruta.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const RAIZ = process.cwd();

function archivos(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "dist", ".git", "universidades"].includes(e.name)) continue;
      archivos(f, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(f);
    }
  }
  return out;
}

const COLUMNAS = /vocero_marcado_(at|por)/;

describe("la etiqueta de vocero no es un permiso", () => {
  it("no aparece en ninguna policy RLS fuera de la migración que la creó", () => {
    const migs = archivos(path.join(RAIZ, "supabase", "migrations"), [".sql"]);
    const ofensores: string[] = [];
    for (const f of migs) {
      const txt = fs.readFileSync(f, "utf8");
      if (!COLUMNAS.test(txt)) continue;
      // La migración que la crea SÍ la nombra en el SELECT (para que los
      // compañeros vean al vocero). Eso es VISIBILIDAD, no permiso, y es su
      // única aparición legítima en una policy.
      if (path.basename(f).startsWith("20261880000000_")) continue;
      // Cualquier otra migración que la mezcle con CREATE/ALTER POLICY es el
      // caso que este test existe para frenar.
      if (/CREATE\s+POLICY|ALTER\s+POLICY/i.test(txt)) {
        ofensores.push(path.basename(f));
      }
    }
    expect(
      ofensores,
      "una policy nueva usa la etiqueta de vocero: el vocero se MUESTRA, no habilita nada",
    ).toEqual([]);
  });

  it("no se mezcla con `has_role` ni con `is_super_admin` en ninguna migración", () => {
    const migs = archivos(path.join(RAIZ, "supabase", "migrations"), [".sql"]);
    const ofensores: string[] = [];
    for (const f of migs) {
      const txt = fs.readFileSync(f, "utf8");
      if (!COLUMNAS.test(txt)) continue;
      // Se mira línea por línea: la migración que la crea usa `has_role` en
      // otras líneas (el SELECT que ya existía), y eso no es el problema.
      for (const linea of txt.split(/\r?\n/)) {
        if (COLUMNAS.test(linea) && /has_role|is_super_admin/.test(linea)) {
          ofensores.push(`${path.basename(f)}: ${linea.trim().slice(0, 90)}`);
        }
      }
    }
    expect(ofensores, "la etiqueta se está usando como si fuera un rol").toEqual([]);
  });

  it("en el cliente no decide nada: nunca gatea una acción", () => {
    const src = archivos(path.join(RAIZ, "src"), [".ts", ".tsx"]).filter(
      (f) => !f.endsWith("vocero-not-a-permission.test.ts"),
    );
    const ofensores: string[] = [];
    // `puede`/`can`/`allow`/`disabled`/`hasPermission` en la MISMA línea que la
    // columna: la forma que tendría el atajo.
    const GATE = /\b(puede|can[A-Z]|allow|permiso|permission|authoriz|autoriz|isAllowed)/;
    for (const f of src) {
      const txt = fs.readFileSync(f, "utf8");
      if (!COLUMNAS.test(txt) && !/voceroEn|isVocero/.test(txt)) continue;
      for (const linea of txt.split(/\r?\n/)) {
        // Los comentarios que ADVIERTEN sobre esto no son ofensores.
        const esComentario = /^\s*(\/\/|\*|\/\*)/.test(linea);
        if (esComentario) continue;
        if ((COLUMNAS.test(linea) || /voceroEn|isVocero/.test(linea)) && GATE.test(linea)) {
          ofensores.push(`${path.relative(RAIZ, f)}: ${linea.trim().slice(0, 90)}`);
        }
      }
    }
    expect(
      ofensores,
      "la etiqueta de vocero está gateando algo en el cliente; si el vocero debe poder hacer eso, es una capacidad con su propia autorización",
    ).toEqual([]);
  });

  it("el rol 'Vocero' NO existe: no está en app_role ni en el selector de roles", () => {
    // Si alguien lo agrega, entra al role-switcher, a ALL_ROLES y a ~370
    // policies que branchean por `has_role`.
    const migs = archivos(path.join(RAIZ, "supabase", "migrations"), [".sql"]);
    const enEnum = migs.filter((f) => {
      const t = fs.readFileSync(f, "utf8");
      return /ALTER\s+TYPE\s+.*app_role.*ADD\s+VALUE\s+'Vocero'/i.test(t);
    });
    expect(
      enEnum.map((f) => path.basename(f)),
      "se agregó 'Vocero' a app_role",
    ).toEqual([]);

    const roles = fs.readFileSync(path.join(RAIZ, "src", "shared", "lib", "roles.ts"), "utf8");
    expect(roles).not.toMatch(/["']Vocero["']/);
  });

  it("el comentario de la columna sigue diciendo que está PROHIBIDO usarla para autorizar", () => {
    // Si alguien reescribe la migración y borra la advertencia, este test avisa:
    // el comentario es lo que un DBA lee antes de escribir una policy.
    const mig = fs.readFileSync(
      path.join(RAIZ, "supabase", "migrations", "20261880000000_course_vocero_label.sql"),
      "utf8",
    );
    expect(mig).toMatch(/PROHIBIDO usarla en policies RLS/);
    expect(mig).toMatch(/NO otorga permisos/);
  });
});
