// Sondea PROD: qué resuelve "footerbar" (closest flex row) vs la unión de los
// 4 íconos del footer, por rol. Diagnóstico del zoom "posición incorrecta".
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const APP = INFO.appUrl ?? "https://examlab.lovable.app";
const role = process.argv[2] || "Docente";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "es-CO" });
const page = await ctx.newPage();
await page.goto(`${APP}/auth`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('input[type="email"]', { timeout: 20000 });
await page.locator("#li-tenant").click();
await page.waitForSelector('[role="option"]', { timeout: 5000 });
await page.getByRole("option", { name: INFO.tenant.name, exact: true }).first().click();
await page.fill('input[type="email"]', INFO.adminCreds.email);
await page.fill('input[type="password"]', INFO.adminCreds.password);
await page.waitForFunction(() => { const b = document.querySelector('button[type="submit"]'); return b && !b.disabled; }, { timeout: 8000 }).catch(() => {});
await page.locator('button[type="submit"]').first().click();
await page.waitForURL(/\/app(\/|$)/, { timeout: 25000 });
await page.waitForTimeout(2000);
if (!/admin/i.test(role)) {
  try {
    const trig = page.locator('[data-tour-id="role-switcher"] [role="combobox"]').first();
    await trig.click({ timeout: 4000 }); await page.waitForTimeout(400);
    await page.getByRole("option", { name: new RegExp(role, "i") }).first().click({ timeout: 4000 });
    await page.waitForTimeout(2000);
  } catch (e) { console.log("role switch fail:", e.message); }
}
const out = await page.evaluate(() => {
  const rc = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  const bell = document.querySelector('[data-tour-id="notifications-bell"]');
  const closestRow = bell ? bell.closest(".flex.items-center.justify-between") : null;
  const ids = ["notifications-bell", "messages-bell", "more-options", "logout"];
  const icons = ids.map((id) => ({ id, rect: rc(document.querySelector(`[data-tour-id="${id}"]`)) }));
  // unión de los íconos visibles
  const rs = icons.map((i) => i.rect).filter((r) => r && r.w > 0);
  let union = null;
  if (rs.length) {
    const l = Math.min(...rs.map((r) => r.left)), t = Math.min(...rs.map((r) => r.top));
    const rgt = Math.max(...rs.map((r) => r.left + r.w)), b = Math.max(...rs.map((r) => r.top + r.h));
    union = { left: l, top: t, w: rgt - l, h: b - t };
  }
  return {
    bell: rc(bell),
    closestRow: closestRow ? { rect: rc(closestRow), cls: closestRow.className.slice(0, 120) } : null,
    bellParent2: bell ? rc(bell.parentElement?.parentElement) : null,
    icons, union,
    roleSwitcher: rc(document.querySelector('[data-tour-id="role-switcher"]')),
  };
});
console.log(`ROLE=${role}`);
console.log(JSON.stringify(out, null, 2));
await browser.close();
