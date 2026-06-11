// Siembra estructura académica para Demo Global Corp (carreras, periodos,
// asignaturas con sílabo) como el Admin del tenant. Idempotente: si ya hay
// carreras, no duplica.
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync("c:/Projects/Personal/examlab/.env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const TID = INFO.tenantId;

const lr = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email: INFO.adminCreds.email, password: INFO.adminCreds.password }),
});
const token = (await lr.json()).access_token;
if (!token) throw new Error("no token");
const h = { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function rest(path, method, body) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { method, headers: { ...h, Prefer: "return=representation" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) { console.log(`  ⚠ ${method} ${path}: ${r.status} ${JSON.stringify(j)}`); return null; }
  return j;
}

// ¿Ya hay carreras?
const existing = await fetch(`${URL}/rest/v1/academic_programs?tenant_id=eq.${TID}&select=id`, { headers: h }).then((r) => r.json());
if (Array.isArray(existing) && existing.length > 0) {
  console.log(`Ya hay ${existing.length} carreras — no siembro.`); process.exit(0);
}

console.log("→ Carreras");
const programs = await rest("academic_programs", "POST", [
  { tenant_id: TID, name: "Ingeniería de Software", code: "ING-SW", faculty: "Facultad de Ingeniería", active: true },
  { tenant_id: TID, name: "Diseño Gráfico", code: "DIS-GRAF", faculty: "Facultad de Artes y Diseño", active: true },
  { tenant_id: TID, name: "Administración de Empresas", code: "ADM-EMP", faculty: "Facultad de Ciencias Económicas", active: true },
]);
const ingSw = (programs ?? []).find((p) => p.code === "ING-SW")?.id ?? (programs ?? [])[0]?.id;
console.log(`  ✓ ${programs?.length} carreras`);

console.log("→ Periodos");
const periods = await rest("academic_periods", "POST", [
  { tenant_id: TID, code: "2026-1", name: "Primer semestre 2026", start_date: "2026-02-01", end_date: "2026-06-30", status: "activo" },
  { tenant_id: TID, code: "2026-2", name: "Segundo semestre 2026", start_date: "2026-08-01", end_date: "2026-12-15", status: "planificado" },
]);
console.log(`  ✓ ${periods?.length} periodos`);

console.log("→ Asignaturas (con sílabo)");
const subjects = await rest("academic_subjects", "POST", [
  {
    tenant_id: TID, program_id: ingSw, name: "Programación I", code: "SW-101", semestre: 1, credits: 4, intensidad_horaria: 64,
    objetivos: "Desarrollar el pensamiento algorítmico y los fundamentos de la programación estructurada.",
    contenidos: "Variables y tipos. Estructuras de control. Funciones. Arreglos. Introducción a la POO.",
    bibliografia: "Deitel & Deitel, Cómo programar. Sebesta, Conceptos de lenguajes de programación.",
    active: true,
  },
  {
    tenant_id: TID, program_id: ingSw, name: "Estructuras de Datos", code: "SW-201", semestre: 2, credits: 4, intensidad_horaria: 64,
    objetivos: "Diseñar y analizar estructuras de datos y su complejidad.",
    contenidos: "Listas, pilas, colas. Árboles. Grafos. Tablas hash. Análisis de complejidad.",
    bibliografia: "Cormen et al., Introduction to Algorithms.",
    active: true,
  },
  {
    tenant_id: TID, program_id: ingSw, name: "Bases de Datos", code: "SW-301", semestre: 3, credits: 3, intensidad_horaria: 48,
    objetivos: "Modelar y consultar bases de datos relacionales.",
    contenidos: "Modelo entidad-relación. Normalización. SQL. Transacciones.",
    bibliografia: "Elmasri & Navathe, Fundamentals of Database Systems.",
    active: true,
  },
]);
console.log(`  ✓ ${subjects?.length} asignaturas`);
console.log("DONE");
