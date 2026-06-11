// Marca el onboarding como completado para el usuario Admin demo, así el
// tour driver.js NO se auto-lanza durante la grabación.
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync("c:/Projects/Personal/examlab/.env", "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const URL = env.VITE_SUPABASE_URL, ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));

const lr = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email: INFO.adminCreds.email, password: INFO.adminCreds.password }),
});
const token = (await lr.json()).access_token;
if (!token) throw new Error("no token");

for (const role of ["Admin", "Docente", "Estudiante"]) {
  const r = await fetch(`${URL}/rest/v1/rpc/mark_onboarding_complete`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ _role: role }),
  });
  console.log(`mark_onboarding_complete(${role}) → ${r.status} ${r.ok ? "ok" : await r.text()}`);
}
console.log("DONE");
