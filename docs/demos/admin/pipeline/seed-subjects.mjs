import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync("c:/Projects/Personal/examlab/.env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/); if (m) env[m[1]] = m[2];
}
const URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const TID = INFO.tenantId;
const token = (await (await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify({ email: INFO.adminCreds.email, password: INFO.adminCreds.password }) })).json()).access_token;
const h = { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" };

const existing = await (await fetch(`${URL}/rest/v1/academic_subjects?tenant_id=eq.${TID}&select=id`, { headers: h })).json();
if (Array.isArray(existing) && existing.length > 0) { console.log(`Ya hay ${existing.length} asignaturas — no siembro.`); process.exit(0); }

const progs = await (await fetch(`${URL}/rest/v1/academic_programs?tenant_id=eq.${TID}&code=eq.ING-SW&select=id`, { headers: h })).json();
const ingSw = progs?.[0]?.id;

const r = await fetch(`${URL}/rest/v1/academic_subjects`, { method: "POST", headers: h, body: JSON.stringify([
  { tenant_id: TID, program_id: ingSw, name: "Programación I", code: "SW-101", semestre: 1, credits: 4, intensidad_horaria: 4, objetivos: "Desarrollar el pensamiento algorítmico y los fundamentos de la programación estructurada.", contenidos: "Variables y tipos. Estructuras de control. Funciones. Arreglos. Introducción a la POO.", bibliografia: "Deitel & Deitel, Cómo programar. Sebesta, Conceptos de lenguajes de programación.", active: true },
  { tenant_id: TID, program_id: ingSw, name: "Estructuras de Datos", code: "SW-201", semestre: 2, credits: 4, intensidad_horaria: 4, objetivos: "Diseñar y analizar estructuras de datos y su complejidad.", contenidos: "Listas, pilas, colas. Árboles. Grafos. Tablas hash. Análisis de complejidad.", bibliografia: "Cormen et al., Introduction to Algorithms.", active: true },
  { tenant_id: TID, program_id: ingSw, name: "Bases de Datos", code: "SW-301", semestre: 3, credits: 3, intensidad_horaria: 3, objetivos: "Modelar y consultar bases de datos relacionales.", contenidos: "Modelo entidad-relación. Normalización. SQL. Transacciones.", bibliografia: "Elmasri & Navathe, Fundamentals of Database Systems.", active: true },
]) });
const j = await r.json();
console.log(r.ok ? `✓ ${j.length} asignaturas` : `⚠ ${r.status} ${JSON.stringify(j)}`);
