// Lee del libro de calificaciones de ExamLab la nota de un corte de cada curso de UNIAJ y
// arma un CSV por curso para pasar-notas.cjs. La nota sale de la PANTALLA del libro (el
// mismo cálculo que ve el docente), no de una consulta propia: así lo que se sube a la
// universidad es exactamente lo que muestra ExamLab.
//
//   node .claude/skills/notas-a-uniajc/leer-libro.cjs <carpeta-salida> [--corte=1] [--solo=LB141F]
//
// Entra como SuperAdmin (EXAMLAB_SA_EMAIL / EXAMLAB_SA_CLAVE en .env.uniajc). El libro
// del SuperAdmin está apagado en el panel de Módulos: se habilita SOLO en la respuesta que
// recibe este navegador (nunca en la base), y toda escritura se bloquea con un 204.
// El documento de cada estudiante se lee con la service_role de .env.local (solo GET).
const path = require("path");
const fs = require("fs");
const RAIZ = path.resolve(__dirname, "../../..");
const { chromium } = require(path.join(RAIZ, "node_modules/playwright"));

const args = process.argv.slice(2);
const opcion = (k, def) => (args.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${def}`).slice(k.length + 3);
const SALIDA = args.find((a) => !a.startsWith("--"));
const CORTE = Number(opcion("corte", "1"));
const SOLO = opcion("solo", "");
if (!SALIDA) {
  console.error("Uso: leer-libro.cjs <carpeta-salida> [--corte=N] [--solo=GRUPO]");
  process.exit(1);
}

const leer = (archivo, k) => (new RegExp(`${k}="?([^"\\r\\n]+)`).exec(fs.readFileSync(path.join(RAIZ, archivo), "utf8")) || [])[1];
const SB = leer(".env", "VITE_SUPABASE_URL");
const ANON = leer(".env", "VITE_SUPABASE_PUBLISHABLE_KEY");
const SERVICE = leer(".env.local", "SUPABASE_SERVICE_ROLE_KEY");
const SA_EMAIL = leer(".env.uniajc", "EXAMLAB_SA_EMAIL");
const SA_CLAVE = leer(".env.uniajc", "EXAMLAB_SA_CLAVE");
const BASE = "https://uniaj.examlab.workers.dev";

// Clave para elegir el curso en el selector del libro → nombre del archivo que espera
// pasar-notas.cjs. Los 341C se distinguen por la asignatura porque comparten código.
const CURSOS = [
  { clave: "6303C", archivo: "Arquitectura 6303C" },
  { clave: "641A-2", archivo: "Bases de Datos II 641A-2" },
  { clave: "LB141F", archivo: "Introduccion LB141F" },
  { clave: "SB141B", archivo: "Introduccion SB141B" },
  { clave: "SB141C", archivo: "Introduccion SB141C" },
  { clave: "II-2026-2-341C", archivo: "Programacion II 341C" },
  { clave: "Sistemas-2026-2-341C", archivo: "Seminario de Sistemas 341C" },
];
// El dueño de la plataforma está matriculado en todos los cursos de UNIAJ a propósito.
const EXCLUIR = new Set(["andres_dfx@hotmail.com"]);

const r2 = (x) => Math.round((x + 1e-9) * 100) / 100;
const coma = (x) => x.toFixed(2).replace(".", ",");

async function documentos(correos) {
  const lista = correos.map((c) => `"${c}"`).join(",");
  const r = await fetch(`${SB}/rest/v1/profiles?select=institutional_email,documento,codigo&institutional_email=in.(${encodeURIComponent(lista)})`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  if (!r.ok) throw new Error(`profiles → ${r.status}`);
  return new Map((await r.json()).map((p) => [String(p.institutional_email).toLowerCase(), p.documento ?? p.codigo ?? ""]));
}

(async () => {
  fs.mkdirSync(SALIDA, { recursive: true });
  const ses = await (
    await fetch(`${SB}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email: SA_EMAIL, password: SA_CLAVE }),
    })
  ).json();
  if (!ses.access_token) throw new Error("No se pudo entrar como SuperAdmin a ExamLab");
  const b = await chromium.launch();
  try {
    for (const curso of CURSOS) {
      if (SOLO && !curso.clave.includes(SOLO) && !curso.archivo.includes(SOLO)) continue;
      const c = await b.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
      await c.addInitScript((s) => {
        localStorage.setItem("sb-uxxpzfsfcnqiwwdxoelm-auth-token", JSON.stringify(s));
        localStorage.setItem("examlab_tenant_override", "uniaj");
        sessionStorage.setItem("examlab_rol_activo:" + s.user.id, "SuperAdmin");
      }, ses);
      await c.route(`${SB}/**`, (r) => {
        const m = r.request().method(), u = r.request().url();
        if (["GET", "HEAD", "OPTIONS"].includes(m) || u.includes("/rpc/") || u.includes("/auth/v1/token")) return r.continue();
        return r.fulfill({ status: 204, body: "" });
      });
      await c.route("**/rest/v1/module_visibility*", async (r) => {
        const res = await r.fetch();
        let j;
        try {
          j = await res.json();
        } catch {
          return r.fulfill({ response: res });
        }
        return r.fulfill({ response: res, json: Array.isArray(j) ? j.map((x) => ({ ...x, enabled: true })) : j });
      });
      const p = await c.newPage();
      await p.goto(`${BASE}/app/teacher/gradebook`);
      await p.waitForTimeout(9000);
      const combos = p.locator('main button[role="combobox"]');
      let elegido = false;
      for (let i = 0; i < (await combos.count()) && !elegido; i++) {
        await combos.nth(i).click();
        await p.waitForTimeout(800);
        const op = p.getByRole("option").filter({ hasText: curso.clave });
        if (await op.count()) {
          await op.first().click();
          elegido = true;
        } else await p.keyboard.press("Escape");
      }
      if (!elegido) throw new Error(`No encontré el curso ${curso.clave} en el libro`);
      await p.waitForTimeout(12000);
      const tabla = await p.evaluate(() => {
        const t = [...document.querySelectorAll("table")].sort((a, b) => b.rows.length - a.rows.length)[0];
        return t ? [...t.rows].map((r) => [...r.cells].map((x) => x.innerText.replace(/\s+/g, " ").trim())) : null;
      });
      await c.close();
      if (!tabla) throw new Error(`El libro de ${curso.clave} no mostró la tabla`);
      if (!new RegExp(`^Corte ${CORTE}\\b`).test(tabla[0][CORTE] || "")) throw new Error(`La columna ${CORTE} del libro no es «Corte ${CORTE}»: ${tabla[0][CORTE]}`);
      // El encabezado dice «Corte 1 30% · 3 ítems»: el peso del corte en la definitiva.
      const peso = Number(((/(\d+(?:[.,]\d+)?)\s*%/.exec(tabla[0][CORTE]) || [])[1] || "").replace(",", "."));
      if (!peso) throw new Error(`No pude leer el peso del Corte ${CORTE}: ${tabla[0][CORTE]}`);
      const filas = [];
      for (const r of tabla.slice(1)) {
        const m = /^(.*?) (\S+@\S+)$/.exec(r[0]);
        if (!m || EXCLUIR.has(m[2].toLowerCase())) continue;
        const nota = Number(r[CORTE]);
        if (!Number.isFinite(nota)) throw new Error(`${curso.clave}: «${m[1]}» no tiene nota numérica en el Corte ${CORTE} (${r[CORTE]})`);
        filas.push({ nombre: m[1], correo: m[2], nota });
      }
      const doc = await documentos(filas.map((f) => f.correo));
      const lineas = [["Estudiante", "Documento", "Correo", `Corte ${CORTE}`, `Aporte a la definitiva (${peso} %)`]];
      for (const f of filas) lineas.push([f.nombre, doc.get(f.correo.toLowerCase()) ?? "", f.correo, coma(f.nota), coma(r2((f.nota * peso) / 100))]);
      const csv = lineas.map((l) => l.map((x) => (/[;"\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(";")).join("\r\n");
      fs.writeFileSync(path.join(SALIDA, `Corte${CORTE} - ${curso.archivo}.csv`), "﻿" + csv);
      const sinDoc = filas.filter((f) => !doc.get(f.correo.toLowerCase())).length;
      console.log(`${curso.archivo}: ${filas.length} estudiantes, ${filas.filter((f) => f.nota === 0).length} en 0${sinDoc ? `, ${sinDoc} SIN documento` : ""}`);
    }
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error("ERROR", e.message);
  process.exit(1);
});
