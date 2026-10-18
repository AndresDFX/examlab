/**
 * Capa B, teléfonos y tableta (iPhone SE, iPhone, Android, iPad), con táctil. Áreas de
 * toque de 44×44 —la regla `pointer: coarse` de styles.css ya agranda los botones; acá se
 * comprueba que nada quede afuera—, letra, superposiciones arriba y al final de la página,
 * el botón de menú del teléfono, el primer menú desplegable y el teclado virtual.
 */
import { test } from "../soporte/fixtures";
import { contrastarConLineaBase } from "../soporte/linea-base";
import { PANTALLAS } from "../soporte/pantallas";
import {
  UMBRAL_LETRA,
  UMBRAL_TACTIL,
  analizar,
  probarMenuDeAcciones,
  probarMenuMovil,
  probarTecladoVirtual,
  superposicionAlFinal,
  type HallazgoCrudo,
} from "../soporte/revisiones";

for (const pantalla of PANTALLAS) {
  test(pantalla.nombre, async ({ page, abrir }, testInfo) => {
    await abrir(pantalla);
    const ancho = page.viewportSize()?.width ?? 0;
    const hallazgos: HallazgoCrudo[] = [
      ...(await analizar(page, {
        revisar: ["areas", "letra", "superposicion", "fuera", "desborde"],
        areas: UMBRAL_TACTIL,
        letra: UMBRAL_LETRA,
      })),
      ...(await superposicionAlFinal(page)),
    ];
    if (pantalla.rol && ancho < 768) hallazgos.push(...(await probarMenuMovil(page)));
    hallazgos.push(...(await probarMenuDeAcciones(page, "tactil")));
    hallazgos.push(...(await probarTecladoVirtual(page)));
    await contrastarConLineaBase(testInfo, "tactil", pantalla, hallazgos);
  });
}
