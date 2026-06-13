// Graba la pantalla de INGRESO (/auth) para el video corto de "cómo entrar a la
// demo": muestra la selección de institución y los campos de usuario/contraseña.
// No inicia sesión (es el punto). Output: webm en out/login-raw/.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const INFO = JSON.parse(readFileSync("C:/Temp/examlab-rec/tenant-info.json", "utf8"));
const APP = INFO.appUrl ?? "https://examlab.lovable.app";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  locale: "es-CO",
  recordVideo: { dir: "C:/Temp/examlab-rec/out/login-raw", size: { width: 1920, height: 1080 } },
});
const page = await ctx.newPage();
await page.goto(`${APP}/auth`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('input[type="email"]', { timeout: 30000 });
await page.waitForTimeout(2500); // mostrar la pantalla de ingreso
// 1) Abrir el selector de institución
await page.locator("#li-tenant").click({ timeout: 6000 }).catch(() => {});
await page.waitForTimeout(2200); // mostrar la lista de instituciones
// 2) Elegir una institución (la demo o la primera)
const opt = page.getByRole("option").first();
await opt.click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1600);
// 3) Mostrar el campo de usuario — escribir un correo de ejemplo
await page.locator('input[type="email"]').click({ timeout: 4000 }).catch(() => {});
await page.locator('input[type="email"]').pressSequentially("docente1@demo-examlab.co", { delay: 60 }).catch(() => {});
await page.waitForTimeout(1200);
// 4) Mostrar el campo de contraseña
await page.locator('input[type="password"]').click({ timeout: 4000 }).catch(() => {});
await page.locator('input[type="password"]').pressSequentially("ExamlabDemo2026", { delay: 55 }).catch(() => {});
await page.waitForTimeout(1800);
await ctx.close(); // finaliza el webm
await browser.close();
console.log("LOGIN RAW grabado en out/login-raw/");
