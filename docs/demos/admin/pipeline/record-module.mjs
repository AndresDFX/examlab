// Recorder GENÉRICO dirigido por un spec de módulo (JSON).
// - Login fuera de cámara → storageState → graba ya autenticado (sin login).
// - Escenas "card" (intro/outro) = carátula overlay.
// - Escenas "platform" = secuencia de beats: cámara (zoom/pan) + foco estilo
//   driver.js (spotlight con div "hueco" hijo de body, NO recortado por overflow,
//   que se mueve con la cámara) + popover título/descripción.
// - Todo se define en el JSON: narración, targets, escala, hold, textos.
//
// Uso:  node record-module.mjs [ruta_modulo.json]
import { chromium } from "playwright";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";

const MODULE_PATH = process.argv[2] ?? "C:/Temp/examlab-rec/modules/module-01.json";
const spec = JSON.parse(readFileSync(MODULE_PATH, "utf8"));
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const APP_URL = INFO.appUrl ?? "https://examlab.lovable.app";
const EMAIL = INFO.adminCreds.email;
const PASSWORD = INFO.adminCreds.password;
const TENANT_NAME = INFO.tenant.name;
const OUT = "C:/Temp/examlab-rec/out";
const AUDIO = "C:/Temp/examlab-rec/audio2";
const FFPROBE = "C:/Temp/examlab-rec/ffmpeg/ffmpeg-8.1.1-essentials_build/bin/ffprobe.exe";
const VIEWPORT = { width: 1920, height: 1080 };

const scenes = spec.scenes;
const narrMs = scenes.map((_, i) => Math.round(parseFloat(execFileSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${AUDIO}/scene-${i + 1}.mp3`]).toString().trim()) * 1000));
const target = (i) => narrMs[i] + (scenes[i].bufferMs ?? 700);

const INIT = `(() => {
  if (window.__demoInit) return; window.__demoInit = true;
  const css = document.createElement('style');
  css.textContent = \`
    #demo-cursor{position:fixed;left:50%;top:50%;width:22px;height:22px;border-radius:50%;
      background:rgba(37,99,235,.30);border:2px solid #1D4ED8;z-index:2147483647;pointer-events:none;
      transform:translate(-50%,-50%);box-shadow:0 0 0 5px rgba(37,99,235,.12);}
    .demo-hole{position:absolute;z-index:9000;border-radius:12px;outline:3px solid #1D4ED8;outline-offset:0;
      box-shadow:0 0 0 99999px rgba(2,6,23,.55);pointer-events:none;transition:opacity .2s ease;}
    .demo-pop{position:absolute;z-index:9001;background:#fff;color:#0b1220;border-radius:12px;padding:12px 14px;
      width:240px;box-shadow:0 12px 34px rgba(0,0,0,.32);border:1px solid rgba(2,6,23,.08);
      font-family:Inter,system-ui,sans-serif;pointer-events:none;}
    .demo-pop b{display:block;font-size:15px;margin-bottom:4px;color:#1D4ED8;}
    .demo-pop span{font-size:13px;line-height:1.4;color:#334155;}
  \`;
  (document.head||document.documentElement).appendChild(css);
  const dot=document.createElement('div'); dot.id='demo-cursor';
  const mount=()=>{ if(document.body && !document.body.contains(dot)) document.body.appendChild(dot); };
  if(document.body) mount(); document.addEventListener('DOMContentLoaded',mount);
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overlay(page, card) {
  await page.evaluate((c) => {
    // La carátula es un overlay `position:fixed`. El body conserva
    // `will-change: transform` (lo setea cameraSetup) que, AUNQUE el transform
    // sea none, crea un CONTAINING BLOCK para descendientes fixed → el overlay
    // inset:0 se mide contra el BODY (página alta, ej. calendario) y su texto
    // centrado cae en el tercio inferior. Limpiar transform Y will-change
    // devuelve el fixed al viewport (centrado correcto).
    document.body.style.transition = "none";
    document.body.style.transform = "none";
    document.body.style.willChange = "auto";
    document.documentElement.style.overflow = "";
    let o = document.getElementById("demo-overlay");
    if (!o) { o = document.createElement("div"); o.id = "demo-overlay"; document.body.appendChild(o); }
    o.setAttribute("style", "position:fixed;inset:0;z-index:2147483000;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:linear-gradient(135deg,#0b1220,#1D4ED8);color:#fff;font-family:Inter,system-ui,sans-serif;text-align:center;");
    o.innerHTML = '<div style="font-size:15px;letter-spacing:3px;text-transform:uppercase;opacity:.8">' + (c.kicker || "") + '</div>' +
      '<div style="font-size:54px;font-weight:800">' + (c.title || "") + '</div>' +
      '<div style="font-size:24px;opacity:.92">' + (c.subtitle || "") + '</div>';
  }, card);
}
async function clearOverlay(page) { await page.evaluate(() => { const o = document.getElementById("demo-overlay"); if (o) o.remove(); }); }
async function waitReady(page, selectors) {
  // Espera de carga GENÉRICA por módulo: el spec define qué selectores
  // confirman que la página cargó (default: el nav de cursos del sidebar).
  const sels = selectors && selectors.length ? selectors : ['[data-tour-module="courses"]'];
  for (const s of sels) {
    await page.locator(s).first().waitFor({ timeout: 20000 }).catch(() => {});
  }
  // Espera a que las queries de datos de la página terminen (varias vistas del
  // estudiante hacen N+1 fetches y muestran "Cargando…" varios segundos). Sin
  // esto, los beats miden la página vacía / en spinner. El websocket de Supabase
  // realtime no cuenta como request, así que networkidle se alcanza al cuajar.
  await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(400);
}
async function killTour(page) {
  try { await page.addStyleTag({ content: ".driver-popover,.driver-overlay,.driver-overlay-animated,.driver-active-element{display:none !important;}" }); } catch {}
  await page.keyboard.press("Escape").catch(() => {});
}
// Activa el rol pedido en el role-switcher del sidebar. `roleLabel` viene del
// spec (spec.role; default "Administrador") para soportar series por rol
// (Admin / Docente / Estudiante) con la misma cuenta multi-rol demo.
async function selectRole(page, roleLabel) {
  const rx = new RegExp(roleLabel, "i");
  try {
    await page.waitForSelector('[data-tour-id="role-switcher"]', { timeout: 8000 });
    const trigger = page.locator('[data-tour-id="role-switcher"] [role="combobox"]').first();
    if ((await trigger.count()) === 0) return;
    const cur = (await trigger.textContent().catch(() => "") ?? "").trim();
    if (rx.test(cur)) return;
    await trigger.click({ timeout: 3000 }); await sleep(400);
    const opt = page.getByRole("option", { name: rx }).first();
    if ((await opt.count()) > 0) { await opt.click({ timeout: 3000 }); await sleep(1500); }
    else await page.keyboard.press("Escape");
  } catch { /* noop */ }
}

// Navega por SPA (clic en el nav del sidebar) para PRESERVAR el rol activo,
// que vive en memoria (active-role-signal, NO localStorage): un page.goto
// recarga la página y resetea el rol → RBAC redirige las rutas /app/teacher/*
// al dashboard. Clicar el <Link> del sidebar es navegación in-app y conserva
// el rol. Fallback a page.goto si el link no existe (ej. rutas sin nav item;
// seguro para Admin, cuyo rol por defecto persiste tras el reload).
async function spaNavigate(page, route) {
  const link = page.locator(`[data-tour-nav="${route}"]`).first();
  try {
    await link.waitFor({ timeout: 6000 });
    await link.scrollIntoViewIfNeeded().catch(() => {});
    await link.click({ timeout: 4000 });
    await page.waitForTimeout(900);
    return true;
  } catch {
    await page.goto(`${APP_URL}${route}`, { waitUntil: "domcontentloaded" }).catch(() => {});
    return false;
  }
}

// Cap de escala para que el elemento (a esa escala) quepa en el viewport con
// margen → evita el zoom "recortado" en elementos anchos (filas, cards, stats).
// NUNCA sube la escala: para elementos pequeños, la escala pedida manda.
function fitScale(rect, requested) {
  if (!rect || !rect.width || !rect.height) return requested;
  const maxW = (VIEWPORT.width * 0.9) / rect.width;
  const maxH = (VIEWPORT.height * 0.8) / rect.height;
  return Math.max(1.0, Math.min(requested, maxW, maxH));
}

// ── Cámara (translate+scale sobre body, con clamp para cubrir el viewport) ──
async function cameraSetup(page) {
  await page.evaluate(() => { const b = document.body; b.style.transformOrigin = "0 0"; b.style.willChange = "transform"; b.style.transform = "none"; });
}
async function measureTargets(page, targets, scroll = false) {
  return await page.evaluate(({ targets, scroll }) => {
    const rc = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
    const cardOf = (txt) => { const h = [...document.querySelectorAll("*")].find((e) => (e.textContent || "").trim() === txt && e.children.length <= 3); return h ? h.closest("div") : null; };
    const grids = [...document.querySelectorAll('main .grid, main [class*="grid"]')];
    const statGrid = grids.find((g) => g.children.length >= 3 && g.children.length <= 6);
    return targets.map((ts) => {
      let el = null;
      if (ts.startsWith("stat:")) el = statGrid ? statGrid.children[parseInt(ts.slice(5), 10)] : null;
      else if (ts.startsWith("card:")) el = cardOf(ts.slice(5));
      else if (ts.startsWith("th:")) { const txt = ts.slice(3); el = [...document.querySelectorAll("main th, table th")].find((h) => (h.textContent || "").trim().includes(txt)) || null; }
      else if (ts.startsWith("row:")) {
        // Filas de DATOS: las que tienen <td> (excluye el header, que en el
        // Table resizable puede aparecer como tr sin td propio).
        const n = parseInt(ts.slice(4), 10);
        el = [...document.querySelectorAll("main table tr, table tr")].filter((tr) => tr.querySelector("td"))[n] || null;
      }
      else if (ts.startsWith("rowaction:")) {
        // Botón "tres puntos" de acciones de una fila. Prefiere el hook
        // [data-row-actions] (RowActionsMenu); si no está (deploy viejo en
        // prod), cae al botón de la última celda de la fila de datos N.
        const n = parseInt(ts.slice(10), 10);
        let list = [...document.querySelectorAll("[data-row-actions]")];
        if (!list.length) {
          const dataRows = [...document.querySelectorAll("main table tr, table tr")].filter((tr) => tr.querySelector("td"));
          list = dataRows.map((tr) => { const td = tr.querySelector("td:last-child"); return td ? td.querySelector("button") : null; }).filter(Boolean);
        }
        el = list[n] || null;
      }
      else if (ts === "firstcard") {
        // Primera tarjeta (Card) del panel/tab activo — objetivo robusto para
        // secciones de configuración sin hooks. Siempre resuelve algo.
        const scope = document.querySelector('[data-state="active"][role="tabpanel"]') || document.querySelector('[role="dialog"]') || document.querySelector("main") || document.body;
        el = scope.querySelector('[data-slot="card"]') ||
             [...scope.querySelectorAll("div")].find((d) => /rounded/.test(d.className) && /border/.test(d.className) && d.querySelector("h1,h2,h3")) ||
             scope.firstElementChild;
      }
      else if (ts === "createbtn") {
        // Botón primario "Nuevo/Nueva/Crear/Agregar" de la vista (o tab) activa.
        el = [...document.querySelectorAll("main button")].find((b) => /^\s*(nuev|crear|agregar|añadir)/i.test(b.textContent || "")) || null;
      }
      else if (ts.startsWith("text:")) {
        // Elemento por su TEXTO visible (encabezado/botón/etiqueta), scopeado a
        // la tab activa o al diálogo si lo hay. Para páginas de configuración sin
        // hooks. Devuelve el elemento "hoja-ish" (pocos hijos) que empieza con el texto.
        const txt = ts.slice(5).toLowerCase();
        const scope = document.querySelector('[data-state="active"][role="tabpanel"]') || document.querySelector('[role="dialog"]') || document.querySelector("main") || document.body;
        el = [...scope.querySelectorAll("*")].find((e) => { const o = (e.textContent || "").trim().toLowerCase(); return o.startsWith(txt) && e.children.length <= 6; }) || null;
      }
      else if (ts.startsWith("field:")) {
        // Campo de un formulario por el texto de su <label> (dentro del diálogo
        // abierto si lo hay). Devuelve el contenedor (label + input) para
        // resaltar todo el campo. Útil cuando el campo no tiene data-tour-id.
        const txt = ts.slice(6).toLowerCase();
        const scope = document.querySelector('[role="dialog"]') || document.querySelector('[data-state="active"][role="tabpanel"]') || document.body;
        const lbl = [...scope.querySelectorAll("label")].find((l) => (l.textContent || "").trim().toLowerCase().startsWith(txt));
        el = lbl ? lbl.parentElement : null;
      }
      else el = document.querySelector(ts);
      if (scroll && el) el.scrollIntoView({ block: "center", inline: "nearest" });
      return rc(el);
    });
  }, { targets, scroll });
}
async function cameraTo(page, c, scale, ms = 650) {
  if (!c) return;
  await page.evaluate(({ c, s, ms }) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    let tx = vw / 2 - c.cx * s, ty = vh / 2 - c.cy * s;
    tx = Math.min(0, Math.max(vw * (1 - s), tx));
    ty = Math.min(0, Math.max(vh * (1 - s), ty));
    const b = document.body;
    b.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`;
    b.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    document.documentElement.style.overflow = "hidden";
  }, { c, s: scale, ms });
  await sleep(ms);
}
async function cameraReset(page, ms = 700) {
  await page.evaluate((ms) => { const b = document.body; b.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.2,1)`; b.style.transform = "none"; }, ms);
  await sleep(ms);
}
async function hideCursor(page, hidden) { await page.evaluate((h) => { const c = document.getElementById("demo-cursor"); if (c) c.style.opacity = h ? "0" : ""; }, hidden); }

// Cambia de pestaña (Radix Tabs) clicando el [role=tab] cuyo texto matchea.
// Necesario porque el contenido de tabs inactivas NO está en el DOM (Radix lo
// desmonta), así que hay que activar la tab antes de medir/enfocar su contenido.
async function clickTab(page, label) {
  try {
    const tab = page.getByRole("tab", { name: new RegExp(label, "i") }).first();
    if ((await tab.count()) === 0) { console.log(`  ⚠ tab "${label}" no encontrada`); return; }
    await tab.click({ timeout: 4000 });
    await sleep(900); // montaje + render del contenido de la tab
  } catch (e) { console.log(`  ⚠ tab "${label}":`, e.message); }
}

// ── Foco estilo driver.js: hueco (dim + outline) + popover, glued al rect ──
async function focusOn(page, rect, info, scale, side) {
  if (!rect) return;
  await page.evaluate(({ rect, info, s, side }) => {
    const vw = window.innerWidth, vh = window.innerHeight, M = 22, GAP = 16, popW = 250;
    // Transform de la cámara para este beat (MISMO clamp que cameraTo).
    let tx = vw / 2 - rect.cx * s, ty = vh / 2 - rect.cy * s;
    tx = Math.min(0, Math.max(vw * (1 - s), tx));
    ty = Math.min(0, Math.max(vh * (1 - s), ty));
    // Rect del elemento EN PANTALLA tras el transform.
    const sx = tx + rect.left * s, sy = ty + rect.top * s, sw = rect.width * s, sh = rect.height * s;

    // HUECO (dim + anillo azul) — body-local, se mueve con la cámara.
    const pad = 6;
    let hole = document.getElementById("demo-hole");
    if (!hole) { hole = document.createElement("div"); hole.id = "demo-hole"; document.body.appendChild(hole); }
    hole.setAttribute("style", `position:absolute;z-index:9000;left:${rect.left - pad}px;top:${rect.top - pad}px;width:${rect.width + pad * 2}px;height:${rect.height + pad * 2}px;border-radius:12px;box-shadow:0 0 0 3px #2563EB,0 0 0 99999px rgba(2,6,23,.62);pointer-events:none;opacity:1;`);

    // POPOVER — se posiciona EN PANTALLA, se clampa al viewport, y se convierte
    // de vuelta a body-local para que tras el transform caiga exactamente ahí.
    // Popover OPCIONAL: si el beat no trae focus.title (ej. al abrir un menú
    // real, que ya muestra las acciones), no se dibuja popover.
    let pop = document.getElementById("demo-pop");
    if (!info || !info.title) { if (pop) pop.style.opacity = "0"; return; }
    if (!pop) { pop = document.createElement("div"); pop.id = "demo-pop"; document.body.appendChild(pop); }
    pop.innerHTML = `<b style="display:block;font-size:15px;margin-bottom:4px;color:#1D4ED8">${info.title}</b><span style="font-size:13px;line-height:1.4;color:#334155">${info.body}</span>`;
    pop.style.cssText = `position:absolute;z-index:9001;width:${popW}px;background:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 12px 34px rgba(0,0,0,.32);border:1px solid rgba(2,6,23,.08);font-family:Inter,system-ui,sans-serif;pointer-events:none;left:-9999px;top:-9999px;`;
    const popH = pop.offsetHeight || 76;
    let px, py;
    if (side === "right") { px = sx + sw + GAP; py = sy; if (px + popW > vw - M) px = sx - popW - GAP; }
    else if (side === "left") { px = sx - popW - GAP; py = sy; if (px < M) px = sx + sw + GAP; }
    else { px = sx; py = sy + sh + GAP; if (py + popH > vh - M) py = sy - popH - GAP; }
    px = Math.max(M, Math.min(px, vw - popW - M));
    py = Math.max(M, Math.min(py, vh - popH - M));
    const lx = (px - tx) / s, ly = (py - ty) / s; // pantalla → body-local
    pop.style.left = lx + "px"; pop.style.top = ly + "px";
    pop.style.transformOrigin = "top left";
    pop.style.transform = `scale(${1 / s})`;
    pop.style.opacity = "1";
  }, { rect, info, s: scale, side: side || "bottom" });
}
async function focusOff(page) {
  await page.evaluate(() => { for (const id of ["demo-hole", "demo-pop"]) { const e = document.getElementById(id); if (e) e.style.opacity = "0"; } });
}

// Click en un botón que abre un menú (DropdownMenu) → spotlight sobre el menú
// ABIERTO para que se vean las acciones reales. Requiere cámara en identidad
// (rect.cx/cy == coords de pantalla). Cierra con Escape al terminar.
async function openMenuFocus(page, rect, beat) {
  if (!rect) { console.log("  ⚠ openMenu: rect NULL"); await sleep(beat.hold ?? 4500); return; }
  // Reset INSTANTÁNEO a identidad (sin transición) para que el click caiga
  // exactamente en rect.cx/cy (que son coords de identidad). Si el body sigue
  // a medio camino de una transición, el click no acierta el botón.
  await page.evaluate(() => { document.body.style.transition = "none"; document.body.style.transform = "none"; document.documentElement.style.overflow = ""; });
  await sleep(160);
  console.log(`  → openMenu click @(${Math.round(rect.cx)},${Math.round(rect.cy)})`);
  await page.mouse.click(rect.cx, rect.cy);
  await page.locator('[role="menu"]').first().waitFor({ timeout: 3500 }).catch(() => {});
  await sleep(400);
  console.log(`  → menú abierto: ${await page.evaluate(() => !!document.querySelector('[role="menu"]'))}`);
  // Dim DETRÁS del menú (z-45 < z-50 del DropdownMenuContent Radix;
  // pointer-events:none → no dispara "interact outside", así el menú NO se
  // cierra). Un "hueco" focusOn sobre el menú sí lo cerraba.
  await page.evaluate(() => {
    let d = document.getElementById("demo-dim");
    if (!d) { d = document.createElement("div"); d.id = "demo-dim"; document.body.appendChild(d); }
    d.setAttribute("style", "position:fixed;inset:0;z-index:45;background:rgba(2,6,23,.55);pointer-events:none;");
  });
  await sleep(beat.hold ?? 4500);
  await page.evaluate(() => { const d = document.getElementById("demo-dim"); if (d) d.remove(); });
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(250);
}

async function loginAndGetState(browser) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, locale: "es-CO" });
  const page = await ctx.newPage();
  await page.goto(`${APP_URL}/auth`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  await page.locator("#li-tenant").click();
  await page.waitForSelector('[role="option"]', { timeout: 5000 });
  await page.getByRole("option", { name: TENANT_NAME, exact: true }).first().click();
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.waitForFunction(() => { const b = document.querySelector('button[type="submit"]'); return b && !b.disabled; }, { timeout: 8000 }).catch(() => {});
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 25000 });
  await page.waitForTimeout(1500);
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  console.log(`→ Módulo: ${spec.id} — "${spec.title}"`);
  console.log("→ Login (fuera de cámara)");
  const state = await loginAndGetState(browser);

  const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: OUT, size: VIEWPORT }, locale: "es-CO", storageState: state, deviceScaleFactor: 1 });
  const tCtx = Date.now();
  await context.addInitScript(INIT);
  const page = await context.newPage();

  const offsets = []; let t0 = 0;
  // El rol Admin (default de la cuenta) NO redirige en rutas /app/admin/*, así
  // que para Admin navegamos DIRECTO a appPath (rápido). Docente/Estudiante sí
  // requieren aterrizar en /app, fijar el rol y navegar por SPA (su rol activo
  // es efímero y un reload a /app/teacher|student/* redirige al dashboard).
  const roleLabel = spec.role ?? "Administrador";
  const isAdminRole = /admin/i.test(roleLabel);
  let currentRoute = isAdminRole ? (spec.appPath || "/app") : "/app";
  const mark = (i, label) => { offsets[i] = Date.now() - t0; console.log(`  [${i + 1}/${scenes.length}] @${offsets[i]}ms — ${label}`); };

  try {
    // Admin: directo a appPath (rápido). Docente/Estudiante: a /app (luego SPA-nav).
    await page.goto(`${APP_URL}${isAdminRole ? (spec.appPath || "/app") : "/app"}`, { waitUntil: "domcontentloaded" });
    // Carátula de la 1ª escena ASAP → cubre la carga (pre-roll mínimo).
    if (scenes[0].kind === "card") await overlay(page, scenes[0].card);
    await sleep(300);
    t0 = Date.now();

    for (let i = 0; i < scenes.length; i++) {
      const sc = scenes[i];
      mark(i, `${sc.id} (${sc.kind})`);
      const s = Date.now();

      if (sc.kind === "card") {
        if (i > 0) await overlay(page, sc.card); // la 1ª ya está puesta
        if (i === 0) {
          // Admin: ya estamos en appPath (goto directo). Docente/Estudiante:
          // fijar el rol y navegar por SPA para preservar el rol activo.
          await selectRole(page, roleLabel);
          if (!isAdminRole && spec.appPath && spec.appPath !== "/app") {
            await spaNavigate(page, spec.appPath);
            currentRoute = spec.appPath;
          }
          await waitReady(page, sc.ready ?? spec.readySelectors);
          await killTour(page); await cameraSetup(page); await hideCursor(page, true);
        } else if (sc.route && sc.route !== currentRoute) {
          // Cambio de ruta DETRÁS de la carátula (módulos multi-ruta): la
          // carátula cubre la navegación. Reafirmamos el rol y vamos por SPA.
          await selectRole(page, spec.role ?? "Administrador");
          await spaNavigate(page, sc.route);
          currentRoute = sc.route;
          await waitReady(page, sc.ready ?? spec.readySelectors);
          await killTour(page); await cameraSetup(page); await hideCursor(page, true);
        }
        await sleep(Math.max(0, target(i) - (Date.now() - s)));
        await clearOverlay(page);
      } else {
        // platform: cámara identidad → (opcional) cambiar de tab → medir los
        // targets de ESTA escena just-in-time (las tabs/contenido dinámico no
        // existen hasta activarse) → secuencia de beats.
        await page.evaluate(() => { document.body.style.transition = "none"; document.body.style.transform = "none"; });
        if (sc.tab) await clickTab(page, sc.tab);

        if (sc.openDialog) {
          // Abrir el diálogo de creación (click al trigger) y RECORRER sus
          // campos para mostrar qué se llena y cómo. El diálogo es modal (Radix
          // ya oscurece la página); cada campo se enfoca con spotlight + popover
          // a escala 1.0 (sin zoom de cámara → no se transforma el portal).
          // Se hace scroll dentro del diálogo a cada campo antes de medirlo.
          const [trig] = await measureTargets(page, [sc.openDialog]);
          if (trig) await page.mouse.click(trig.cx, trig.cy);
          await page.locator('[role="dialog"]').first().waitFor({ timeout: 4000 }).catch(() => {});
          await sleep(700);
          console.log(`  → diálogo abierto: ${await page.evaluate(() => !!document.querySelector('[role="dialog"]'))}`);
          for (const beat of sc.beats) {
            // measureTargets con scroll=true hace scrollIntoView del campo
            // (sirve para targets CSS y custom como `field:`) y mide su rect.
            const [rect] = await measureTargets(page, [beat.target], true);
            await sleep(300);
            await focusOn(page, rect, beat.focus, 1.0, beat.side);
            await sleep(beat.hold ?? 3500);
            await focusOff(page);
          }
          await page.keyboard.press("Escape").catch(() => {});
          await sleep(300);
        } else {
          await sleep(250);
          // Medición JUST-IN-TIME por beat (no upfront): el contenido dinámico
          // puede haber cambiado, y permite `scroll:true` para targets bajo el
          // fold (resetea cámara + restaura overflow para poder hacer scroll).
          for (let j = 0; j < sc.beats.length; j++) {
            const beat = sc.beats[j];
            if (beat.scroll) {
              await page.evaluate(() => { document.body.style.transition = "none"; document.body.style.transform = "none"; document.documentElement.style.overflow = ""; });
              await sleep(140);
            }
            const [rect] = await measureTargets(page, [beat.target], !!beat.scroll);
            if (beat.clickToOpen) {
              await cameraReset(page, 500);
              await openMenuFocus(page, rect, beat);
            } else {
              // Escala efectiva con auto-fit → nunca recorta el elemento.
              const fs = fitScale(rect, beat.scale ?? 1.5);
              await cameraTo(page, rect, fs, 600);
              await focusOn(page, rect, beat.focus, fs, beat.side);
              await sleep(beat.hold ?? 1500);
              await focusOff(page);
            }
          }
        }
        await cameraReset(page, 650);
        await sleep(Math.max(0, target(i) - (Date.now() - s)));
      }
    }

    const totalMs = Date.now() - t0;
    console.log(`\n  Duración total grabada ≈ ${(totalMs / 1000).toFixed(1)}s`);
    writeFileSync("C:/Temp/examlab-rec/scene-offsets.json", JSON.stringify({ offsets, totalMs, vstart: t0 - tCtx, sceneCount: scenes.length }, null, 2));
  } finally {
    const video = page.video();
    await context.close();
    const vp = await video?.path().catch(() => null);
    if (vp) { const dest = `${OUT}/${spec.id}-raw.webm`; try { renameSync(vp, dest); console.log(`\n✓ Video crudo: ${dest}`); } catch (e) { console.log("  ⚠ rename:", e.message); } }
    await browser.close();
  }
}
main().catch((e) => { console.error("\n✗ Error:", e); process.exit(1); });
