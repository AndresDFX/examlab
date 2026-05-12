// Pre-crea auth.users en el destino LEYENDO el dump SQL completo:
// extrae TODOS los UUIDs referenciados por FKs a auth.users(id) (no
// solo los de public.profiles) y crea los que falten antes del restore.
//
// Por que esto importa:
//   El viejo proyecto puede tener users en auth.users que NO tienen
//   profile (admins borrados, cuentas con trigger fallido, etc.) pero
//   que siguen siendo referenciados por user_roles, ai_prompts, etc.
//   Si solo creamos los de profiles, esas FKs se rompen al restaurar.
//
// Estrategia:
//   1. Parsear todas las FKs a auth.users(id) del dump.
//   2. Por cada (tabla, columna), leer el COPY de esa tabla y extraer
//      los UUIDs de esa columna.
//   3. Hacer union de todos los UUIDs encontrados.
//   4. Cruzar con public.profiles del dump:
//      - UUID en profiles -> email + name reales.
//      - UUID huerfano    -> email stub "orphan-<uuid8>@migrated.local"
//        para que el admin lo reconozca despues.
//   5. Filtrar contra auth.users existente en el destino (idempotencia).
//   6. Crear los que falten via admin REST API con password temporal.

import { readFileSync, existsSync } from "fs";

const TGT_URL = process.env.TARGET_SUPABASE_URL;
const TGT_KEY = process.env.TARGET_SUPABASE_SERVICE_ROLE_KEY;
const DUMP_FILE = process.env.DUMP_FILE || "backup/full_public.sql";
const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD || "Temporal#123456";
const DRY_RUN = process.env.DRY_RUN === "true";

if (!TGT_URL || !TGT_KEY) {
  console.error("Faltan env vars: TARGET_SUPABASE_URL, TARGET_SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!existsSync(DUMP_FILE)) {
  console.error(`No existe el dump en: ${DUMP_FILE}`);
  process.exit(1);
}

type ProfileFromDump = {
  id: string;
  full_name: string;
  institutional_email: string;
  personal_email: string | null;
};

// Unescape de COPY: convierte secuencias escapadas del formato de COPY
// (\\, \t, \n, \r) a sus caracteres reales. \N significa NULL — lo
// manejamos arriba con un check previo.
// Usamos un token literal poco probable como placeholder intermedio
// para distinguir el backslash escapado de espacios reales del texto.
const BS_TOKEN = "<<BACKSLASH_TOKEN>>";
function unescapeCopy(s: string): string {
  if (s === "\\N") return "";
  return s
    .split("\\\\")
    .join(BS_TOKEN)
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .split(BS_TOKEN)
    .join("\\");
}

// Parsear FKs a auth.users(id). Buscamos bloques como:
//   ALTER TABLE ONLY public.user_roles
//       ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
function findAuthUserFks(content: string): Array<{ table: string; column: string }> {
  const fks: Array<{ table: string; column: string }> = [];
  const re =
    /ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT \w+ FOREIGN KEY \((\w+)\) REFERENCES auth\.users\(id\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    fks.push({ table: m[1], column: m[2] });
  }
  return fks;
}

// Devuelve { headers, rows } de la primera seccion COPY public.<table>.
function parseCopyBlock(
  content: string,
  table: string,
): { headers: string[]; rows: string[][] } | null {
  const re = new RegExp(`COPY public\\.${table} \\(([^)]+)\\) FROM stdin;`);
  const headerMatch = content.match(re);
  if (!headerMatch) return null;
  const headers = headerMatch[1].split(",").map((c) => c.trim());
  const startIdx = headerMatch.index! + headerMatch[0].length;
  const restAfter = content.slice(startIdx);
  const endMatch = restAfter.match(/\n\\\.\n/);
  if (!endMatch) return null;
  const block = restAfter.slice(1, endMatch.index!);
  const rows = block
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split("\t"));
  return { headers, rows };
}

async function adminFetch(path: string, init?: RequestInit) {
  const url = `${TGT_URL!.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${TGT_KEY!}`,
      apikey: TGT_KEY!,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return res.json();
}

async function listAllAuthUserIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let page = 1;
  const perPage = 1000;
  while (true) {
    const data = (await adminFetch(`/auth/v1/admin/users?page=${page}&per_page=${perPage}`)) as {
      users: Array<{ id: string }>;
    };
    for (const u of data.users) ids.add(u.id);
    if (data.users.length < perPage) break;
    page++;
  }
  return ids;
}

async function main() {
  console.log("=== Pre-crear auth.users desde el dump SQL ===");
  console.log(`  Dump:      ${DUMP_FILE}`);
  console.log(`  Target:    ${TGT_URL}`);
  console.log(`  Password:  ${DEFAULT_PASSWORD} (temporal, igual para todos)`);
  console.log(`  Dry run:   ${DRY_RUN ? "SI" : "NO"}`);
  console.log("");

  const content = readFileSync(DUMP_FILE, "utf-8");

  const fks = findAuthUserFks(content);
  console.log(`FKs a auth.users encontradas: ${fks.length}`);
  for (const fk of fks) console.log(`  - ${fk.table}.${fk.column}`);
  console.log("");

  const referencedIds = new Set<string>();
  for (const { table, column } of fks) {
    const copy = parseCopyBlock(content, table);
    if (!copy) {
      console.log(`  ${table}: sin COPY (tabla vacia)`);
      continue;
    }
    const colIdx = copy.headers.indexOf(column);
    if (colIdx < 0) {
      console.warn(`  ${table}: columna '${column}' no encontrada en headers`);
      continue;
    }
    const before = referencedIds.size;
    for (const row of copy.rows) {
      const val = row[colIdx];
      if (val && val !== "\\N") referencedIds.add(val);
    }
    console.log(`  ${table}.${column}: +${referencedIds.size - before} UUIDs nuevos`);
  }
  console.log(`Total UUIDs referenciados: ${referencedIds.size}`);
  console.log("");

  const profilesCopy = parseCopyBlock(content, "profiles");
  const profilesById = new Map<string, ProfileFromDump>();
  if (profilesCopy) {
    const idIdx = profilesCopy.headers.indexOf("id");
    const nameIdx = profilesCopy.headers.indexOf("full_name");
    const persIdx = profilesCopy.headers.indexOf("personal_email");
    const instIdx = profilesCopy.headers.indexOf("institutional_email");
    for (const row of profilesCopy.rows) {
      const id = row[idIdx];
      profilesById.set(id, {
        id,
        full_name: unescapeCopy(row[nameIdx]),
        institutional_email: unescapeCopy(row[instIdx]),
        personal_email: row[persIdx] === "\\N" ? null : unescapeCopy(row[persIdx]),
      });
    }
  }
  console.log(`Profiles del dump: ${profilesById.size}`);
  const orphans = [...referencedIds].filter((id) => !profilesById.has(id));
  console.log(`UUIDs huerfanos (no en profiles): ${orphans.length}`);
  console.log("");

  console.log("Listando auth.users del destino...");
  const existingIds = await listAllAuthUserIds();
  console.log(`  ${existingIds.size} users ya existentes`);
  console.log("");

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ email: string; id: string; error: string }> = [];

  for (const id of referencedIds) {
    if (existingIds.has(id)) {
      skipped++;
      continue;
    }
    const profile = profilesById.get(id);
    const email = profile?.institutional_email
      ? profile.institutional_email
      : `orphan-${id.slice(0, 8)}@migrated.local`;
    const fullName = profile?.full_name
      ? profile.full_name
      : `[migrado-huerfano ${id.slice(0, 8)}]`;
    const body = {
      id,
      email,
      password: DEFAULT_PASSWORD,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        personal_email: profile?.personal_email ?? null,
        ...(profile ? {} : { migrated_orphan: true }),
      },
    };
    if (DRY_RUN) {
      console.log(`  [DRY] ${email}${profile ? "" : " (huerfano)"} (${id})`);
      created++;
      continue;
    }
    try {
      await adminFetch("/auth/v1/admin/users", { method: "POST", body: JSON.stringify(body) });
      created++;
      if (created % 25 === 0) console.log(`  ... ${created} creados`);
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ email, id, error: msg });
      console.error(`  FAIL ${email}: ${msg}`);
    }
  }

  console.log("");
  console.log("=== Resumen ===");
  console.log(`  Creados:     ${created}`);
  console.log(`  Ya existian: ${skipped}`);
  console.log(`  Fallaron:    ${failed}`);

  if (failures.length > 0) {
    console.log("");
    console.log("Detalle de fallas:");
    for (const f of failures) console.log(`  - ${f.email}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Error fatal:", e);
  process.exit(1);
});
