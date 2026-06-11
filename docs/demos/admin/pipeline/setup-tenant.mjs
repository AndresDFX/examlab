// Setup del tenant de demo "Demo Global Corp" en PRODUCCIÓN (Supabase prod).
// Pasos:
//   1) Login SuperAdmin → token.
//   2) Crear tenant (INSERT en tenants; RLS permite is_super_admin).
//   3) provision-tenant-test-user → Admin+Docente+Estudiante (creds una vez).
//   4) Login como ese Admin del tenant.
//   5) Sembrar 3 cursos + ~8 usuarios (.test, sin entrega real de correo).
//   6) Escribir creds + info a tenant-info.json (gitignored / fuera del repo).
import { readFileSync, writeFileSync } from "node:fs";

const ENV_PATH = "c:/Projects/Personal/examlab/.env";
const env = {};
for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const URL = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!URL || !ANON) throw new Error("Falta URL/ANON en .env");

const SA_EMAIL = "castano.julian@correounivalle.edu.co";
const SA_PASS = "Tester#12345";

const TENANT = {
  slug: "demo-global-corp",
  name: "Demo Global Corp",
  primary_color: "#1D4ED8",
  secondary_color: "#2563EB",
  text_color: null,
  icon_color: "#FFFFFF",
  email_domain: "demoglobalcorp.test",
  max_admins: 5,
  max_teachers: 50,
  max_students: 1000,
  logo_url: null,
  logo_path: null,
};

const h = (token) => ({
  apikey: ANON,
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

async function login(email, password) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`login ${email} falló: ${r.status} ${JSON.stringify(j)}`);
  return j.access_token;
}

async function main() {
  console.log("→ Login SuperAdmin");
  const saToken = await login(SA_EMAIL, SA_PASS);

  // ¿Ya existe el tenant?
  console.log("→ Verificando si el tenant ya existe");
  const existRes = await fetch(
    `${URL}/rest/v1/tenants?slug=eq.${TENANT.slug}&select=id,slug,name`,
    { headers: h(saToken) },
  );
  const existing = await existRes.json();
  let tenantId;
  if (Array.isArray(existing) && existing.length > 0) {
    tenantId = existing[0].id;
    console.log(`  ⚠ Tenant ya existe: ${tenantId} — lo reutilizo`);
  } else {
    console.log("→ Creando tenant");
    const cRes = await fetch(`${URL}/rest/v1/tenants`, {
      method: "POST",
      headers: { ...h(saToken), Prefer: "return=representation" },
      body: JSON.stringify(TENANT),
    });
    const cJson = await cRes.json();
    if (!cRes.ok) throw new Error(`crear tenant falló: ${cRes.status} ${JSON.stringify(cJson)}`);
    tenantId = cJson[0].id;
    console.log(`  ✓ Tenant creado: ${tenantId}`);
  }

  // Provision test user (Admin+Docente+Estudiante). Si el email ya existe (409),
  // lo reportamos — el usuario debe resetear desde la setup previa.
  let adminCreds = null;
  console.log("→ Provisionando usuario Admin del tenant");
  const pRes = await fetch(`${URL}/functions/v1/provision-tenant-test-user`, {
    method: "POST",
    headers: h(saToken),
    body: JSON.stringify({ tenant_id: tenantId, tenant_name: TENANT.name, tenant_slug: TENANT.slug }),
  });
  const pJson = await pRes.json();
  if (pRes.ok && pJson.ok) {
    adminCreds = { email: pJson.email, password: pJson.password, roles: pJson.roles };
    console.log(`  ✓ Admin: ${pJson.email} (roles: ${pJson.roles?.join(", ")})`);
  } else {
    console.log(`  ⚠ provision falló (${pRes.status}): ${JSON.stringify(pJson)}`);
    console.log("    Continúo sin credenciales nuevas (probable que el user ya exista).");
  }

  // Necesitamos las creds del Admin para sembrar. Si no las obtuvimos, abortamos
  // la siembra (pero el tenant ya quedó creado).
  if (!adminCreds) {
    writeFileSync(
      "C:/Temp/examlab-rec/tenant-info.json",
      JSON.stringify({ tenantId, tenant: TENANT, adminCreds: null, note: "provision falló — sin creds para sembrar" }, null, 2),
    );
    console.log("\n⚠ Sin creds de Admin: tenant creado pero no sembré datos.");
    return;
  }

  console.log("→ Login como Admin del tenant");
  const adminToken = await login(adminCreds.email, adminCreds.password);

  // Estado del setting global de welcome (solo informativo — no lo tocamos).
  const esRes = await fetch(`${URL}/rest/v1/email_settings?id=eq.1&select=globally_enabled,enabled_kinds`, { headers: h(adminToken) });
  const esJson = await esRes.json().catch(() => null);
  console.log(`  email_settings (global): ${JSON.stringify(esJson)}`);

  // Sembrar cursos (como Admin del tenant; RLS lo permite).
  console.log("→ Sembrando 3 cursos");
  const courses = [
    { name: "Fundamentos de Programación — Grupo A", tenant_id: tenantId, period: "2026-I", start_date: "2026-02-01", end_date: "2026-06-30", description: "Introducción a la programación con Python." },
    { name: "Bases de Datos — Grupo B", tenant_id: tenantId, period: "2026-I", start_date: "2026-02-01", end_date: "2026-06-30", description: "Modelado relacional y SQL." },
    { name: "Arquitectura de Software — Grupo A", tenant_id: tenantId, period: "2026-I", start_date: "2026-02-01", end_date: "2026-06-30", description: "Patrones y estilos arquitectónicos." },
  ];
  const crRes = await fetch(`${URL}/rest/v1/courses`, {
    method: "POST",
    headers: { ...h(adminToken), Prefer: "return=representation" },
    body: JSON.stringify(courses),
  });
  const crJson = await crRes.json();
  if (!crRes.ok) console.log(`  ⚠ cursos: ${crRes.status} ${JSON.stringify(crJson)}`);
  else console.log(`  ✓ ${crJson.length} cursos creados`);

  // Sembrar usuarios via bulk-import-users (como Admin → tenant correcto).
  console.log("→ Sembrando usuarios (bulk-import)");
  const rows = [
    { full_name: "Laura Gómez", institutional_email: "laura.gomez@demoglobalcorp.test", roles: "Docente", password: "DemoPass#2026a", force_password_change: false },
    { full_name: "Carlos Ruiz", institutional_email: "carlos.ruiz@demoglobalcorp.test", roles: "Docente", password: "DemoPass#2026b", force_password_change: false },
    { full_name: "Ana Torres", institutional_email: "ana.torres@demoglobalcorp.test", roles: "Estudiante", student_code: "EST-001", password: "DemoPass#2026c", force_password_change: false },
    { full_name: "Diego Martínez", institutional_email: "diego.martinez@demoglobalcorp.test", roles: "Estudiante", student_code: "EST-002", password: "DemoPass#2026d", force_password_change: false },
    { full_name: "Sofía Herrera", institutional_email: "sofia.herrera@demoglobalcorp.test", roles: "Estudiante", student_code: "EST-003", password: "DemoPass#2026e", force_password_change: false },
    { full_name: "Mateo Rojas", institutional_email: "mateo.rojas@demoglobalcorp.test", roles: "Estudiante", student_code: "EST-004", password: "DemoPass#2026f", force_password_change: false },
    { full_name: "Valentina Díaz", institutional_email: "valentina.diaz@demoglobalcorp.test", roles: "Estudiante", student_code: "EST-005", password: "DemoPass#2026g", force_password_change: false },
    { full_name: "Andrés Castaño", institutional_email: "andres.castano@demoglobalcorp.test", roles: "Estudiante", student_code: "EST-006", password: "DemoPass#2026h", force_password_change: false },
  ];
  const biRes = await fetch(`${URL}/functions/v1/bulk-import-users`, {
    method: "POST",
    headers: h(adminToken),
    body: JSON.stringify({ rows }),
  });
  const biJson = await biRes.json();
  if (!biRes.ok) console.log(`  ⚠ bulk-import: ${biRes.status} ${JSON.stringify(biJson)}`);
  else {
    const ok = (biJson.result ?? biJson.results ?? []).filter?.((r) => r.ok)?.length ?? "?";
    console.log(`  ✓ bulk-import respondió: ${JSON.stringify(biJson).slice(0, 400)}`);
  }

  // Persistir info para los pasos siguientes (grabación).
  const info = { tenantId, tenant: TENANT, adminCreds, appUrl: "https://examlab.lovable.app" };
  writeFileSync("C:/Temp/examlab-rec/tenant-info.json", JSON.stringify(info, null, 2));
  console.log("\n✓ Setup completo. Info en C:/Temp/examlab-rec/tenant-info.json");
  console.log(`  Tenant: ${TENANT.name} (${tenantId})`);
  console.log(`  Admin: ${adminCreds.email}`);
}

main().catch((e) => {
  console.error("\n✗ Error:", e);
  process.exit(1);
});
