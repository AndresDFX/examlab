/**
 * Pruebas de UI en el navegador (`e2e/`). Ver `e2e/README.md`.
 *
 * Corren sobre el BUILD de producción servido en local (`e2e/servidor-estatico.mjs`),
 * contra el backend REAL, con la cuenta multi-rol de la institución de demostración
 * (Demo Global Corp). Las escrituras se interceptan: ninguna prueba modifica datos.
 */
import { defineConfig, devices, type ReporterDescription } from "@playwright/test";

// No el 4173: es el de `vite preview`, y con `reuseExistingServer` en local se usaría ese
// servidor sin avisar, sirviendo otro build.
const PUERTO = Number(process.env.E2E_PUERTO ?? 4319);
const enCI = !!process.env.CI;

const reporteros: ReporterDescription[] = [
  ["list"],
  ["html", { open: "never", outputFolder: "playwright-report" }],
];
if (enCI) reporteros.push(["github"]);

// Cada capa corre en los perfiles que le corresponden. El barrido de anchos usa un solo
// navegador: lo que cambia es el ancho, y lo cambia la propia prueba.
const ANCHOS = /layout[\\/]anchos\.spec\.ts$/;
const ESCRITORIO = /dispositivos[\\/]escritorio\.spec\.ts$/;
const TACTIL = /dispositivos[\\/]tactil\.spec\.ts$/;

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/e2e",
  globalSetup: "./e2e/soporte/preparacion-global.ts",
  globalTeardown: "./e2e/soporte/cierre-global.ts",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: enCI,
  // El backend es el real: una respuesta lenta no debe tumbar el despliegue.
  retries: enCI ? 1 : 0,
  workers: enCI ? 4 : 3,
  reporter: reporteros,
  use: {
    baseURL: `http://127.0.0.1:${PUERTO}`,
    // En el CI NO se graban trazas: una traza guarda cada petición con su encabezado
    // Authorization, y los artefactos de un repo público los puede bajar cualquiera.
    // La captura y el video del fallo solo tienen píxeles de datos ficticios.
    trace: enCI ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // El service worker de la PWA cachea el build: entre corridas serviría uno viejo.
    serviceWorkers: "block",
    locale: "es-CO",
    timezoneId: "America/Bogota",
  },
  webServer: {
    command: `node e2e/servidor-estatico.mjs ${PUERTO}`,
    url: `http://127.0.0.1:${PUERTO}/`,
    reuseExistingServer: !enCI,
    timeout: 30_000,
  },
  projects: [
    { name: "anchos", testMatch: ANCHOS, use: { ...devices["Desktop Chrome"] } },
    {
      name: "escritorio-chrome",
      testMatch: ESCRITORIO,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "escritorio-safari",
      testMatch: ESCRITORIO,
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } },
    },
    // 768×1024 con táctil: el corte `md`, donde el menú lateral reemplaza al botón de menú.
    { name: "ipad", testMatch: TACTIL, use: { ...devices["iPad Mini"] } },
    // 320×568: el teléfono más angosto que todavía circula; el peor caso de la matriz.
    { name: "iphone-se", testMatch: TACTIL, use: { ...devices["iPhone SE"] } },
    { name: "iphone", testMatch: TACTIL, use: { ...devices["iPhone 13"] } },
    { name: "android", testMatch: TACTIL, use: { ...devices["Pixel 7"] } },
  ],
});
