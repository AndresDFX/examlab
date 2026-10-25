// Baja de Teams web la transcripción (.vtt) y el enlace de la grabación de cada clase
// ya dictada y los deja en la sesión correspondiente de ExamLab.
//
//   node sincronizar.cjs [--dias 21] [--curso 341C-SEM] [--enviar]
//
// Sin --enviar solo descarga y muestra qué subiría. La sesión de Teams queda en el perfil
// de privado/teams-perfil (se inicia sesión una vez; con TEAMS_USUARIO/TEAMS_CLAVE en
// .env.uniajc lo hace solo). Lo subido queda en privado/transcripciones-teams/registro.jsonl.
const fs = require("fs");
const path = require("path");
const RAIZ = path.resolve(__dirname, "../../../..");
const { chromium } = require(path.join(RAIZ, "node_modules/playwright"));

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DIAS = Number(opt("--dias", "21"));
const SOLO = opt("--curso", null);
const ENVIAR = args.includes("--enviar");

const leerEnv = (f) => Object.fromEntries(
  (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "").split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const ENV = { ...leerEnv(path.join(RAIZ, ".env")), ...leerEnv(path.join(RAIZ, ".env.uniajc")) };
const URL_BASE = ENV.VITE_SUPABASE_URL, ANON = ENV.VITE_SUPABASE_PUBLISHABLE_KEY;
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "../cursos.json"), "utf8"));
const SALIDA = path.join(RAIZ, "privado/transcripciones-teams");
fs.mkdirSync(SALIDA, { recursive: true });

const DIAS_SEM = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
/** "2026-10-08" → "jueves, 8 de octubre de 2026", como lo muestra el selector de Resumen. */
function fechaTeams(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12);
  return `${DIAS_SEM[dt.getDay()]}, ${d} de ${MESES[m - 1]} de ${y}`;
}
const hoyIso = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);

// ── ExamLab, como el docente (SuperAdmin → impersonar) ──
async function tokenDocente() {
  const j = async (u, b, tok) => (await fetch(u, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(b) })).json();
  const sa = (await j(`${URL_BASE}/auth/v1/token?grant_type=password`, { email: ENV.EXAMLAB_SA_EMAIL, password: ENV.EXAMLAB_SA_CLAVE })).access_token;
  if (!sa) throw new Error("No se pudo entrar como SuperAdmin (EXAMLAB_SA_* en .env.uniajc)");
  const im = await j(`${URL_BASE}/functions/v1/admin-impersonate`, { userId: CFG.docente_id }, sa);
  const v = await j(`${URL_BASE}/auth/v1/verify`, { type: "email", token_hash: im.hashed_token });
  if (!v.access_token) throw new Error("No se pudo actuar como el docente");
  return v.access_token;
}
function api(tok) {
  const h = { apikey: ANON, Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
  return {
    get: async (p) => { const r = await fetch(`${URL_BASE}/rest/v1/${p}`, { headers: h }); if (!r.ok) throw new Error(`GET ${p}: ${r.status}`); return r.json(); },
    patch: async (p, b) => { const r = await fetch(`${URL_BASE}/rest/v1/${p}`, { method: "PATCH", headers: h, body: JSON.stringify(b) }); if (!r.ok) throw new Error(`PATCH ${p}: ${r.status} ${await r.text()}`); },
    calendar: async (b) => (await fetch(`${URL_BASE}/functions/v1/calendar`, { method: "POST", headers: h, body: JSON.stringify(b) })).json(),
  };
}

// ── Teams ──
async function entrar(p) {
  await p.goto("https://teams.cloud.microsoft/");
  const llego = await Promise.race([
    p.waitForSelector("input[type=email]", { timeout: 60000 }).then(() => "login"),
    p.getByRole("button", { name: /Calendario/ }).first().waitFor({ timeout: 60000 }).then(() => "teams"),
  ]).catch(() => "nada");
  if (llego !== "login") return;
  if (!ENV.TEAMS_USUARIO || !ENV.TEAMS_CLAVE) {
    console.log("Inicia sesión en la ventana de Teams; espero hasta 3 minutos…");
    await p.getByRole("button", { name: /Calendario/ }).first().waitFor({ timeout: 180000 });
    return;
  }
  await p.fill("input[type=email]", ENV.TEAMS_USUARIO);
  await p.getByRole("button", { name: /^(Siguiente|Next)$/ }).first().click();
  await p.waitForSelector("input[type=password]:visible", { timeout: 45000 }); await p.waitForTimeout(1500);
  await p.fill("input[type=password]:visible", ENV.TEAMS_CLAVE);
  await p.getByRole("button", { name: /^(Iniciar sesión|Sign in)$/ }).first().click();
  await p.getByRole("button", { name: /^(Sí|Yes)$/ }).click({ timeout: 30000 }).catch(() => {});
  await p.getByRole("button", { name: /Calendario/ }).first().waitFor({ timeout: 90000 });
}

const marcoCon = async (p, texto) => { for (const f of p.frames()) if (await f.getByText(texto).count().catch(() => 0)) return f; return null; };

/** La app «Resúmenes de reuniones» (fijada en la barra lateral) lista solo las reuniones con
 *  grabación o transcripción, con título y fecha. Se recorre entera desplazando la lista. */
async function abrirResumenes(p) {
  await p.getByRole("button", { name: /Resúmenes de reuniones/ }).first().click();
  await p.waitForTimeout(8000);
  const ok = p.getByText("Entendido", { exact: true });
  if (await ok.count()) await ok.first().click().catch(() => {});
  let antes = -1;
  for (let i = 0; i < 40; i++) {
    await p.evaluate(() => { for (const el of document.querySelectorAll("*")) if (el.scrollHeight > el.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight; });
    await p.waitForTimeout(1500);
    const n = (await p.locator("body").innerText()).split("· ").length;
    if (n === antes && i > 3) break;
    antes = n;
  }
}

/** [{ titulo, fecha: "jueves, 8 de octubre" }] de la lista ya cargada. */
async function listarResumenes(p) {
  const t = await p.locator("body").innerText();
  return [...t.matchAll(/\n([^\n]+)\n((?:lunes|martes|miércoles|jueves|viernes|sábado|domingo), \d+ de \w+) · /g)]
    .filter((m) => m[1] !== "Resumen").map((m) => ({ titulo: m[1], fecha: m[2] }));
}

async function abrirResumen(p, fecha, titulo) {
  const lineas = p.getByText(new RegExp("^" + fecha + " · "));
  const n = await lineas.count();
  for (let i = 0; i < n; i++) {
    const fila = lineas.nth(i).locator('xpath=ancestor::*[.//button[normalize-space()="Resumen"]][1]');
    if (!(await fila.innerText()).includes(titulo)) continue;
    await fila.locator('xpath=.//button[normalize-space()="Resumen"]').first().click();
    await p.waitForTimeout(12000);
    return true;
  }
  return false;
}

async function bajarVtt(p, ctx, nombre) {
  if (await p.getByText("No hay ninguna transcripción disponible").count()) return null;
  const f = await marcoCon(p, "Descargar");
  if (!f) return null;
  await f.getByText("Descargar").first().click();
  await p.waitForTimeout(2000);
  let item = null;
  for (const fr of p.frames()) { const m = fr.getByRole("menuitem", { name: /vtt/i }); if (await m.count().catch(() => 0)) item = m.first(); }
  if (!item) { await p.keyboard.press("Escape"); return null; }
  const [d] = await Promise.all([p.waitForEvent("download", { timeout: 60000 }), item.click()]);
  const ruta = path.join(SALIDA, nombre);
  await d.saveAs(ruta);
  return ruta;
}

async function enlaceGrabacion(p, ctx) {
  const b = p.getByText("Ver en el explorador");
  if (!(await b.count())) return null;
  const [pop] = await Promise.all([ctx.waitForEvent("page", { timeout: 30000 }), b.first().click()]);
  await pop.waitForLoadState("domcontentloaded").catch(() => {});
  await pop.waitForTimeout(3000);
  const u = new URL(pop.url());
  await pop.close();
  // Sin los parámetros de rastreo: el `id` es lo que identifica el video.
  return `${u.origin}${u.pathname}?id=${encodeURIComponent(u.searchParams.get("id") ?? "")}`;
}

(async () => {
  const tok = await tokenDocente();
  const ex = api(tok);
  const desde = new Date(Date.now() - DIAS * 864e5 - 5 * 3600e3).toISOString().slice(0, 10);
  const hoy = hoyIso();
  const registroRuta = path.join(SALIDA, "registro.jsonl");

  const ctx = await chromium.launchPersistentContext(path.join(RAIZ, "privado/teams-perfil"), { headless: false, viewport: { width: 1400, height: 900 }, locale: "es-CO", acceptDownloads: true });
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  await entrar(p);

  const resumen = [];
  // Sesiones de ExamLab pendientes, indexadas por curso + fecha.
  const porClave = new Map();
  for (const c of CFG.cursos) {
    if (SOLO && c.codigo !== SOLO) continue;
    const sesiones = await ex.get(`attendance_sessions?select=id,session_date,title,recording_url&course_id=eq.${c.curso_id}&deleted_at=is.null&session_date=gte.${desde}&session_date=lte.${hoy}&order=session_date`);
    if (!sesiones.length) continue;
    const conTrans = new Set((await ex.get(`session_transcripts?select=session_id&session_id=in.(${sesiones.map((s) => s.id).join(",")})`)).map((t) => t.session_id));
    for (const s of sesiones) {
      const clave = c.codigo + "|" + fechaTeams(s.session_date).replace(/ de \d{4}$/, "");
      if (!porClave.has(clave)) porClave.set(clave, { curso: c, sesion: s, tieneTrans: conTrans.has(s.id) });
    }
  }
  await abrirResumenes(p);
  const items = await listarResumenes(p);
  for (const it of items) {
    const c = CFG.cursos.find((x) => it.titulo.includes(x.titulo));
    if (!c) continue;
    const pend = porClave.get(c.codigo + "|" + it.fecha);
    if (!pend) { resumen.push({ curso: c.codigo, fecha: it.fecha, nota: "sin sesión en ExamLab ese día" }); continue; }
    const { sesion: s, tieneTrans } = pend;
    porClave.delete(c.codigo + "|" + it.fecha);
    if (tieneTrans && s.recording_url) continue;
    const fila = { curso: c.codigo, fecha: s.session_date };
    if (!(await abrirResumen(p, it.fecha, it.titulo))) { resumen.push({ ...fila, error: "no pude abrir el resumen" }); await abrirResumenes(p); continue; }
    const vtt = tieneTrans ? null : await bajarVtt(p, ctx, `${c.codigo}-${s.session_date}.vtt`);
    const grab = s.recording_url ? null : await enlaceGrabacion(p, ctx);
    fila.transcripcion = vtt ? "descargada" : tieneTrans ? "ya estaba" : "no hay";
    fila.grabacion = grab ? "encontrada" : s.recording_url ? "ya estaba" : "no hay";
    if (ENVIAR) {
      if (vtt) {
        const r = await ex.calendar({ action: "upload_transcript", sessionId: s.id, vtt: fs.readFileSync(vtt, "utf8"), fileName: path.basename(vtt) });
        fila.transcripcion = r.ok ? `subida (docente: ${(r.teacherSpeakers ?? []).join(", ") || "sin identificar"})` : `error ${r.error}`;
      }
      if (grab) { await ex.patch(`attendance_sessions?id=eq.${s.id}`, { recording_url: grab }); fila.grabacion = "guardada"; }
      fs.appendFileSync(registroRuta, JSON.stringify({ ...fila, sesion: s.id, grabacion_url: grab, en: new Date().toISOString() }) + "\n");
    }
    resumen.push(fila);
    await abrirResumenes(p);
  }
  for (const { curso, sesion, tieneTrans } of porClave.values())
    if (!tieneTrans || !sesion.recording_url) resumen.push({ curso: curso.codigo, fecha: sesion.session_date, nota: "Teams no tiene resumen de esa clase" });
  console.table(resumen);
  if (!ENVIAR) console.log("Ensayo: no se subió nada. Repite con --enviar.");
  await ctx.close();
})().catch((e) => { console.error("ERROR", e.message); process.exit(1); });
