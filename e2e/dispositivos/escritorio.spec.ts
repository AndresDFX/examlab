/**
 * Capa B, escritorio (Chrome a 1280 px y Safari a 1440 px), con mouse y teclado. Áreas de
 * clic (bloquea bajo 24×24, avisa bajo 32), superposiciones, la señal al pasar el mouse,
 * el recorrido con Tab (cada parada visible y con marca de foco) y el primer menú
 * desplegable con teclado (abre con Enter, cierra con Esc y devuelve el foco).
 */
import { test } from "../soporte/fixtures";
import { contrastarConLineaBase } from "../soporte/linea-base";
import { PANTALLAS } from "../soporte/pantallas";
import {
  UMBRAL_ESCRITORIO,
  analizar,
  probarMenuDeAcciones,
  probarTeclado,
  revisarHover,
  superposicionAlFinal,
  type HallazgoCrudo,
} from "../soporte/revisiones";

for (const pantalla of PANTALLAS) {
  test(pantalla.nombre, async ({ page, abrir }, testInfo) => {
    await abrir(pantalla);
    const hallazgos: HallazgoCrudo[] = [
      ...(await analizar(page, {
        revisar: ["areas", "superposicion", "fuera", "desborde"],
        areas: UMBRAL_ESCRITORIO,
      })),
      ...(await superposicionAlFinal(page)),
      ...(await revisarHover(page)),
      ...(await probarTeclado(page)),
      ...(await probarMenuDeAcciones(page, "teclado")),
    ];
    await contrastarConLineaBase(testInfo, "escritorio", pantalla, hallazgos);
  });
}
