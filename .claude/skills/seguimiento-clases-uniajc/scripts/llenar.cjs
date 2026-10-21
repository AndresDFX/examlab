#!/usr/bin/env node
/**
 * Llena el formulario «Seguimientos a programas FI» (Microsoft Forms) con los encuentros LISTOS
 * de privado/<periodo>/encuentros.json. Una respuesta por encuentro.
 *
 *   node .claude/skills/seguimiento-clases-uniajc/scripts/llenar.cjs            (prueba: llena todo, NO envía)
 *   node .claude/skills/seguimiento-clases-uniajc/scripts/llenar.cjs --enviar   (envía)
 *        [--max N] [--solo "<curso>|<fecha>"]
 *
 * Reglas que no se negocian:
 *  - Un envío de Forms no se edita ni se borra. Cada envío confirmado se anota en
 *    `enviados.jsonl` ANTES de seguir, y lo anotado nunca se vuelve a mandar.
 *  - Antes de cada «Siguiente» se relee la página y se compara con lo que se quería escribir;
 *    si algo no coincide, se detiene sin enviar.
 *  - Inicio de sesión: en la ventana visible. Si el docente no está, se usan OUTLOOK_EMAIL y
 *    OUTLOOK_CLAVE del entorno (nunca de un archivo). El perfil del navegador va a un directorio
 *    temporal y se borra al terminar.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SKILL = path.join(__dirname, "..");
const CFG = JSON.parse(fs.readFileSync(path.join(SKILL, "cursos.json"), "utf8"));
const args = process.argv.slice(2);
const ENVIAR = args.includes("--enviar");
const MAX = Number(args[args.indexOf("--max") + 1]) || Infinity;
const SOLO = args.includes("--solo") ? args[args.indexOf("--solo") + 1] : null;

const envUniajc = fs.existsSync(".env.uniajc") ? fs.readFileSync(".env.uniajc", "utf8") : "";
const DOCUMENTO = (envUniajc.match(/^UNIAJC_DOCUMENTO\s*=\s*"?([^"\r\n]+)"?/m) ?? [])[1];
if (!DOCUMENTO) throw new Error("Falta UNIAJC_DOCUMENTO en .env.uniajc");
if (!CFG.lms || CFG.cursos.some((c) => !c.sede)) throw new Error("Faltan «lms» o la «sede» de algún curso en cursos.json: los decide el docente.");

const CARPETA = CFG.carpetaPrivada;
const LEDGER = path.join(CARPETA, "enviados.jsonl");
const enviados = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
const yaEnviado = new Set(enviados.map((e) => e.clave));
const grupoConVocero = new Set(enviados.map((e) => `${e.asignatura}|${e.grupo}`));

const filas = JSON.parse(fs.readFileSync(path.join(CARPETA, "encuentros.json"), "utf8"))
  .filter((f) => f.estado === "listo" && f.sede && !yaEnviado.has(f.clave) && (!SOLO || f.clave === SOLO))
  .slice(0, MAX);

const PERFIL = fs.mkdtempSync(path.join(os.tmpdir(), "uniajc-forms-"));
const ESPERA = (p, ms) => p.waitForTimeout(ms);

async function iniciarSesion(p) {
  await p.goto(CFG.formulario, { timeout: 60000 });
  // La página de Microsoft tarda en pintar el campo de correo: esperar a que aparezca él o el formulario.
  const enFormulario = (u) => new URL(u).host.includes("forms.") && !/login\.microsoftonline/.test(u);
  // Por CONTENIDO y no por dirección: el enlace corto es de forms.* y redirige al login después.
  const llego = await Promise.race([
    p.waitForSelector("input[type=email]", { timeout: 45000 }).then(() => "login"),
    p.getByText(/Empezar ahora|Selecciona la respuesta/).first().waitFor({ timeout: 45000 }).then(() => "formulario"),
  ]).catch(() => "nada");
  if (llego === "formulario") return;
  if (process.env.OUTLOOK_EMAIL && process.env.OUTLOOK_CLAVE) {
    // Botones por su NOMBRE (Microsoft cambia los selectores de esta página), con Enter de respaldo.
    const pulsar = async (nombre) => {
      const b = p.getByRole("button", { name: nombre }).first();
      try { await b.click({ timeout: 10000 }); } catch { await p.keyboard.press("Enter"); }
    };
    await p.fill("input[type=email]", process.env.OUTLOOK_EMAIL);
    await pulsar(/^(Siguiente|Next)$/);
    // La página se redibuja mientras carga: un `fill` puede caer en un campo que se reemplaza y
    // el botón se pulsa con la contraseña vacía («Escriba su contraseña»). Confirmar antes de pulsar.
    for (let i = 0; i < 4; i++) {
      const clave = p.locator("input[type=password]:visible").first();
      await clave.waitFor({ timeout: 45000 }); await ESPERA(p, 1500);
      await clave.click(); await clave.fill(process.env.OUTLOOK_CLAVE); await ESPERA(p, 600);
      if ((await clave.inputValue().catch(() => "")).length) break;
    }
    await pulsar(/^(Iniciar sesión|Sign in)$/);
    // «¿Mantener la sesión iniciada?»
    try { await p.getByRole("button", { name: /^(Sí|Yes)$/ }).click({ timeout: 45000 }); } catch {}
  } else {
    console.log("Inicie sesión en la ventana del navegador (espero hasta 5 minutos)…");
  }
  await p.waitForURL(enFormulario, { timeout: 300000 });
}

async function abrirFormulario(p) {
  await p.goto(CFG.formulario, { timeout: 60000 });
  await ESPERA(p, 8000);
  const emp = p.getByRole("button", { name: "Empezar ahora" });
  if (await emp.count()) { await emp.first().click(); await ESPERA(p, 4000); }
  // Un borrador puede reabrir en otra página: volver a la primera.
  for (let i = 0; i < 4 && (await p.getByRole("button", { name: "Atrás" }).count()); i++) {
    await p.getByRole("button", { name: "Atrás" }).first().click(); await ESPERA(p, 2000);
  }
}

async function elegir(p, idx, texto) {
  await p.locator('[aria-haspopup="listbox"]').nth(idx).click(); await ESPERA(p, 1200);
  await p.getByRole("option", { name: texto, exact: true }).first().click(); await ESPERA(p, 600);
}
const radio = (p, sel, n = 0) => p.locator(`input[type=radio]${sel}`).nth(n).check({ force: true });
const textos = (p) => p.evaluate(() => ({
  t: [...document.querySelectorAll('input[aria-label="Texto de una sola línea"], input[aria-label="Selector de fecha"]')].map((i) => i.value),
  a: [...document.querySelectorAll("textarea")].map((i) => i.value),
  r: [...document.querySelectorAll("input[type=radio]:checked")].map((i) => i.value.trim()),
  d: [...document.querySelectorAll('[aria-haspopup="listbox"]')].map((i) => i.innerText.trim()),
}));
function exigir(cond, que) { if (!cond) throw new Error(`No coincide: ${que}`); }

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
/**
 * La fecha se escribe en el campo de texto y se VERIFICA en el calendario, que es lo que el
 * formulario envía. El texto no alcanza: en 2026-10 una corrida escribió «05/10/2026» y el campo
 * quedó en «10/5/2026» (el selector lo releyó como mes/día: 10 de mayo). Fue intermitente, y un
 * texto que se ve bien no garantiza la fecha que quedó elegida.
 */
async function escribirFecha(p, f) {
  const campo = p.locator('input[aria-label="Selector de fecha"]');
  const [aa, mm, dd] = f.fecha.split("-").map(Number);
  for (let intento = 1; ; intento++) {
    await campo.click(); await campo.fill(""); await campo.type(f.fechaFormulario, { delay: 30 });
    await p.keyboard.press("Escape");
    await p.getByText("Fecha del encuentro").first().click(); // sacar el foco: ahí el selector la interpreta
    await ESPERA(p, 1200);
    const texto = await campo.inputValue();
    await campo.click(); await ESPERA(p, 1200);
    const cal = await p.evaluate(() => {
      const s = document.querySelector('[aria-selected="true"], .is-selected');
      const h = [...document.querySelectorAll('[class*="monthAndYear"], [class*="currentItemButton"]')].map((e) => e.innerText.trim()).find(Boolean);
      return { dia: s ? s.innerText.trim() : "", mes: (h || "").toLowerCase() };
    });
    await p.keyboard.press("Escape"); await ESPERA(p, 400);
    const textoOk = [f.fechaFormulario, `${dd}/${mm}/${aa}`].includes(texto);
    const calOk = cal.dia === String(dd) && cal.mes === `${MESES[mm - 1]} ${aa}`;
    if (textoOk && calOk) return;
    if (intento >= 2) throw new Error(`No coincide: fecha (texto «${texto}», calendario «${cal.dia} ${cal.mes}»)`);
  }
}

async function llenar(p, f) {
  await abrirFormulario(p);
  // Página 1 — profesor y asignación
  await elegir(p, 0, CFG.docente);
  await p.locator('input[aria-label="Texto de una sola línea"]').nth(0).fill(DOCUMENTO);
  await elegir(p, 1, CFG.programa);
  await elegir(p, 2, f.asignatura);
  await radio(p, `[value="${f.tipo}"]`);
  await radio(p, `[value*="${f.sede}"]`);
  await p.locator('input[aria-label="Texto de una sola línea"]').last().fill(f.grupo);
  let v = await textos(p);
  exigir(v.d[0] === CFG.docente && v.d[1] === CFG.programa && v.d[2] === f.asignatura, `desplegables ${v.d.join(" / ")}`);
  exigir(v.t[0] === DOCUMENTO && v.t[1] === f.grupo, "documento o grupo");
  exigir(v.r.includes(f.tipo) && v.r.some((x) => x.includes(f.sede)), "tipo de encuentro o sede");
  await p.getByRole("button", { name: "Siguiente" }).click(); await ESPERA(p, 3500);

  // Página 2 — el encuentro
  const ta = p.locator("textarea");
  await ta.nth(0).fill(f.encuentro); await ta.nth(1).fill(f.actividades);
  await escribirFecha(p, f);
  await radio(p, `[value^="${f.franja.trim()}"]`);
  await radio(p, `[value="${CFG.lms}"]`, 0);                       // primer grupo con Moodle/Teams = LMS
  await radio(p, '[value^="Remota asistida"]');
  await radio(p, `[value^="${f.plataforma}"]`, f.plataforma === "Teams" ? 1 : 0); // segundo «Teams» = videoconferencia
  v = await textos(p);
  exigir(v.a[0] === f.encuentro && v.a[1] === f.actividades, "tema o actividades");
  const [aa, mm, dd] = f.fecha.split("-").map(Number);
  exigir(v.t.some((x) => [f.fechaFormulario, `${dd}/${mm}/${aa}`].includes(x)), `fecha (quedó ${v.t.join(" / ")})`);
  exigir(v.r.some((x) => x.startsWith(f.franja.trim())) && v.r.includes(CFG.lms) && v.r.some((x) => x.startsWith("Remota")), "franja, LMS o modalidad");
  exigir(v.r.filter((x) => x === f.plataforma).length >= (f.plataforma === CFG.lms ? 2 : 1), "plataforma");
  await p.getByRole("button", { name: "Siguiente" }).click(); await ESPERA(p, 3500);

  // Página 3 — asistencia
  const t3 = p.locator('input[aria-label="Texto de una sola línea"]');
  await t3.nth(0).fill(String(f.matriculados)); await t3.nth(1).fill(String(f.asistentes));
  const a3 = p.locator("textarea");
  await a3.nth(0).fill(f.ausentes); await a3.nth(1).fill(f.observaciones || "NA");
  v = await textos(p);
  exigir(v.t[0] === String(f.matriculados) && v.t[1] === String(f.asistentes) && v.a[0] === f.ausentes, "asistencia");
  await p.getByRole("button", { name: "Siguiente" }).click(); await ESPERA(p, 3500);

  // Página 4 — vocero: solo la primera vez por grupo (el formulario lo pide una vez)
  const t4 = p.locator('input[aria-label="Texto de una sola línea"]');
  const conVocero = f.vocero && !grupoConVocero.has(`${f.asignatura}|${f.grupo}`);
  for (const [i, val] of [f.vocero?.nombre, f.vocero?.telefono, f.vocero?.correo].entries()) await t4.nth(i).fill(conVocero ? val ?? "" : "");
  exigir(await p.getByRole("button", { name: "Enviar" }).count(), "no se llegó a la página de envío");

  if (!ENVIAR) { console.log(`PRUEBA OK  ${f.clave}  ${f.encuentro}`); return false; }
  await p.getByRole("button", { name: "Enviar" }).click(); await ESPERA(p, 9000);
  const r = await p.evaluate(() => document.body.innerText);
  // Cada formulario lo dice distinto: «La respuesta se ha enviado.», «…enviado correctamente».
  exigir(/se ha enviado|se han enviado|enviado correctamente/i.test(r), `el formulario no confirmó el envío: ${r.slice(0, 200)}`);
  const reg = { clave: f.clave, curso: f.curso, asignatura: f.asignatura, grupo: f.grupo, fecha: f.fecha, encuentro: f.encuentro, vocero: conVocero, enviado_at: new Date().toISOString() };
  fs.appendFileSync(LEDGER, JSON.stringify(reg) + "\n");
  grupoConVocero.add(`${f.asignatura}|${f.grupo}`);
  console.log(`ENVIADO    ${f.clave}  ${f.encuentro}`);
  return true;
}

(async () => {
  console.log(`${filas.length} encuentro(s) para ${ENVIAR ? "ENVIAR" : "probar (sin enviar)"}`);
  // es-CO fijo: el selector de fecha lee día/mes según el idioma del navegador.
  const ctx = await chromium.launchPersistentContext(PERFIL, { headless: false, viewport: { width: 1300, height: 900 }, locale: "es-CO" });
  const p = ctx.pages()[0] || (await ctx.newPage());
  let n = 0;
  try {
    await iniciarSesion(p);
    for (const f of filas) { if (await llenar(p, f)) n++; }
  } catch (e) {
    const shot = path.join(os.tmpdir(), "uniajc-forms-error.png");
    await p.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(`ERROR en ${p.url()}`);
    console.error(String(e.message).split(/\r?\n/)[0]);
    console.error(`pantallazo: ${shot}`);
    console.error((await p.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 600));
    process.exitCode = 1;
  } finally {
    await ctx.close();
    fs.rmSync(PERFIL, { recursive: true, force: true });
    console.log(`enviados en esta corrida: ${n}`);
  }
})();
