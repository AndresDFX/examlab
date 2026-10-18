import type { Page } from "@playwright/test";

/**
 * Espera a que la pantalla termine de cargar: algo dibujado (y, dentro de la app, su
 * título), la red quieta, sin indicadores de carga a la vista y con la fuente lista.
 * Revisar el diseño a medio cargar daría hallazgos falsos (una tabla vacía no desborda;
 * un esqueleto tapa lo que vendrá).
 *
 * El primer paso no es redundante: en un entorno lento la red se aquieta ANTES de que la
 * app dibuje nada, y una página en blanco no tiene indicadores de carga. Así pasó en el
 * contenedor de Linux: se midieron páginas vacías y salió «no existe el botón de menú».
 */
export async function esperarPantallaLista(
  page: Page,
  opciones: { dentroDeLaApp?: boolean } = {},
): Promise<string[]> {
  // Una espera vencida no falla la prueba (la página puede seguir siendo medible), pero
  // se devuelve para anotarla: si una pantalla tarda, el reporte dice en qué paso.
  const vencidas: string[] = [];
  const paso = (nombre: string, espera: Promise<unknown>) =>
    espera.then(
      () => undefined,
      () => {
        vencidas.push(nombre);
      },
    );

  await page.waitForLoadState("domcontentloaded");
  await paso(
    "algo dibujado",
    page.waitForFunction(() => (document.body?.innerText ?? "").trim().length > 0, undefined, {
      timeout: 45_000,
    }),
  );
  if (opciones.dentroDeLaApp) {
    await paso(
      "título de la pantalla",
      page.locator("main h1, main h2").first().waitFor({ state: "visible", timeout: 45_000 }),
    );
  }
  await paso("red quieta", page.waitForLoadState("networkidle", { timeout: 15_000 }));
  await paso(
    "indicadores de carga",
    page.waitForFunction(
      () => {
        const visible = (el: Element) =>
          typeof (el as HTMLElement).checkVisibility === "function"
            ? (el as HTMLElement).checkVisibility()
            : (el as HTMLElement).offsetParent !== null;
        return ![
          ...document.querySelectorAll(".animate-spin, .animate-pulse, [aria-busy='true']"),
        ].some(visible);
      },
      undefined,
      { timeout: 45_000 },
    ),
  );
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
  await page.waitForTimeout(300);
  return vencidas;
}

/** Tras cambiar el tamaño de la ventana: dos cuadros de animación y un respiro. */
export async function esperarReflujo(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))),
  );
  await page.waitForTimeout(150);
}
