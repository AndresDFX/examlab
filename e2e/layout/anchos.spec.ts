/**
 * Capa A — barrido de anchos. Cada pantalla se recorre de 320 a 1920 px, incluidos los
 * dos lados de cada corte de Tailwind. En cada ancho: sin desplazamiento horizontal, nada
 * interactivo fuera de la pantalla, ningún texto saliéndose de su caja, nada tapado, y el
 * menú correcto (lateral desde 768 px, botón de menú por debajo).
 */
import { test } from "../soporte/fixtures";
import { contrastarConLineaBase } from "../soporte/linea-base";
import { PANTALLAS } from "../soporte/pantallas";
import { ANCHOS, analizar, revisarMenu, type HallazgoCrudo } from "../soporte/revisiones";
import { esperarReflujo } from "../soporte/esperar";

for (const pantalla of PANTALLAS) {
  test(pantalla.nombre, async ({ page, abrir }, testInfo) => {
    await abrir(pantalla);
    const hallazgos: HallazgoCrudo[] = [];
    for (const ancho of ANCHOS) {
      await page.setViewportSize({ width: ancho, height: 900 });
      await esperarReflujo(page);
      const h = await analizar(page, { revisar: ["scroll", "fuera", "desborde", "superposicion"] });
      if (pantalla.rol) h.push(...(await revisarMenu(page, ancho)));
      hallazgos.push(...h.map((x) => ({ ...x, ancho })));
    }
    await contrastarConLineaBase(testInfo, "anchos", pantalla, hallazgos);
  });
}
