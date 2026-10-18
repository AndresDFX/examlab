/**
 * Las revisiones de la Fase 1 vistas desde la prueba. Lo que mide la página vive en
 * `analizador-navegador.js` (`window.__qaUI`); acá están las interacciones —tocar,
 * tabular, pasar el mouse, abrir el teclado— y los umbrales que se acordaron.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { esperarReflujo } from "./esperar";

export type Regla =
  | "scroll-horizontal"
  | "fuera-de-pantalla"
  | "desborde-texto"
  | "superposicion"
  | "area-tactil"
  | "letra-pequena"
  | "letra-mayoria-pequena"
  | "menu-movil"
  | "foco-invisible"
  | "foco-tapado"
  | "trampa-de-foco"
  | "menu-desplegable"
  | "sin-senal-hover"
  | "teclado-virtual";

export type Severidad = "bloquea" | "aviso";

export interface HallazgoCrudo {
  regla: Regla;
  severidad: Severidad;
  /** Firma del componente (etiqueta, rol, clases y zona), sin textos de datos. */
  elemento: string;
  /** En una superposición: lo que tapa. */
  otro?: string;
  detalle: string;
  /** En el barrido: el ancho en que apareció. */
  ancho?: number;
}

type Revision = "scroll" | "fuera" | "desborde" | "superposicion" | "areas" | "letra";

export interface OpcionesAnalisis {
  revisar: Revision[];
  /** `espaciado`: aplica la excepción por espaciado de WCAG 2.5.8 (ver el analizador). */
  areas?: { bloquea: number; avisa?: number; espaciado?: boolean };
  letra?: { minima: number; comoda: number; proporcion: number };
  /** Superposición: con la página arriba (por defecto) o desplazada hasta el final. */
  momento?: "inicio" | "final";
  /** Selector CSS: revisar solo dentro de ese elemento (un menú, un panel). */
  dentroDe?: string;
}

/**
 * Los anchos del barrido. Los pares 639/640, 767/768, 1023/1024 y 1279/1280 son los
 * cortes `sm`, `md`, `lg` y `xl` de Tailwind: un diseño se rompe justo a un píxel del corte.
 */
export const ANCHOS = [320, 375, 390, 414, 639, 640, 767, 768, 1023, 1024, 1279, 1280, 1440, 1920];

/** Umbrales acordados (pregunta 4 de la Fase 1). */
export const UMBRAL_TACTIL = { bloquea: 44 };
export const UMBRAL_ESCRITORIO = { bloquea: 24, avisa: 32, espaciado: true };
export const UMBRAL_LETRA = { minima: 10, comoda: 12, proporcion: 0.5 };

const es = JSON.parse(
  readFileSync(new URL("../../src/i18n/locales/es.json", import.meta.url), "utf8"),
) as { hc_sharedComponentsAppLayout: { menu: string } };

/** El texto del botón de menú del teléfono (su `aria-label`), de los textos de la app. */
export const ETIQUETA_MENU = es.hc_sharedComponentsAppLayout.menu;

type QA = {
  analizar: (o: OpcionesAnalisis) => HallazgoCrudo[];
  revisarMenu: (ancho: number, etiqueta: string) => HallazgoCrudo[];
  diagnosticoMenu: (etiqueta: string) => string;
  irAlFinal: () => void;
  irAlInicio: () => void;
  enfocarInicio: () => void;
  analizarFoco: () => {
    id: string;
    firma: string;
    describe: string;
    enPantalla: boolean;
    indicador: boolean;
    tapadoPor: { firma: string; describe: string } | null;
    tabulables: number;
  } | null;
  marcarMuestras: (max: number) => Array<{ i: number; firma: string; describe: string }>;
  estiloVisual: (el: Element) => { estilo: string; cursor: string };
  campoConTeclado: (el: Element) => {
    firma: string;
    describe: string;
    visible: boolean;
    tapadoPor: { firma: string; describe: string } | null;
  };
  firma: (el: Element) => string;
};
type ConQA = { __qaUI: QA };

export function analizar(page: Page, opciones: OpcionesAnalisis): Promise<HallazgoCrudo[]> {
  return page.evaluate((o) => (window as unknown as ConQA).__qaUI.analizar(o), opciones);
}

export function revisarMenu(page: Page, ancho: number): Promise<HallazgoCrudo[]> {
  return page.evaluate(([a, e]) => (window as unknown as ConQA).__qaUI.revisarMenu(a, e), [
    ancho,
    ETIQUETA_MENU,
  ] as const);
}

/**
 * La página arriba y sin foco, como la ve quien acaba de llegar. Elegir un curso de los
 * atajos deja la página desplazada hasta el atajo: medida así, la cabecera fija «tapaba»
 * la barra de herramientas, que con la página arriba está a la vista.
 */
export async function volverArriba(page: Page): Promise<void> {
  await page.evaluate(() => {
    const activo = document.activeElement;
    if (activo instanceof HTMLElement && activo !== document.body) activo.blur();
    (window as unknown as ConQA).__qaUI.irAlInicio();
  });
  await esperarReflujo(page);
}

/** La parte de abajo de la página: ahí viven el botón flotante y las barras fijas. */
export async function superposicionAlFinal(page: Page): Promise<HallazgoCrudo[]> {
  await page.evaluate(() => (window as unknown as ConQA).__qaUI.irAlFinal());
  await esperarReflujo(page);
  const h = await analizar(page, { revisar: ["superposicion"], momento: "final" });
  await page.evaluate(() => (window as unknown as ConQA).__qaUI.irAlInicio());
  await esperarReflujo(page);
  return h;
}

/** Tab por el contenido: cada parada se tiene que ver, con marca de foco y sin tapar. */
export async function probarTeclado(page: Page, paradas = 25): Promise<HallazgoCrudo[]> {
  const out: HallazgoCrudo[] = [];
  await page.evaluate(() => (window as unknown as ConQA).__qaUI.enfocarInicio());
  const ids: string[] = [];
  let mismoSeguido = 0;
  for (let i = 0; i < paradas; i++) {
    await page.keyboard.press("Tab");
    // Safari desplaza hasta lo enfocado en el cuadro SIGUIENTE, no en el acto: medido al
    // instante, una celda bajo el borde de la pantalla salía «enfocada fuera de la vista».
    await esperarReflujo(page);
    const f = await page.evaluate(() => (window as unknown as ConQA).__qaUI.analizarFoco());
    if (!f) continue;
    mismoSeguido = ids.at(-1) === f.id ? mismoSeguido + 1 : 0;
    ids.push(f.id);
    if (mismoSeguido >= 2 && f.tabulables > 1) {
      out.push({
        regla: "trampa-de-foco",
        severidad: "bloquea",
        elemento: f.firma,
        detalle: `El foco queda atrapado en ${f.describe}: Tab no avanza.`,
      });
      break;
    }
    if (!f.enPantalla) {
      out.push({
        regla: "foco-invisible",
        severidad: "bloquea",
        elemento: f.firma,
        detalle: `${f.describe} recibe el foco pero no se ve en pantalla.`,
      });
    } else if (!f.indicador) {
      out.push({
        regla: "foco-invisible",
        severidad: "bloquea",
        elemento: f.firma,
        detalle: `${f.describe} recibe el foco sin ninguna marca visible.`,
      });
    }
    if (f.tapadoPor) {
      out.push({
        regla: "foco-tapado",
        severidad: "aviso",
        elemento: f.firma,
        otro: f.tapadoPor.firma,
        detalle: `Con el foco en ${f.describe}, lo tapa ${f.tapadoPor.describe}.`,
      });
    }
  }
  return out;
}

/** Pasar el mouse: algo tiene que cambiar (color, fondo, sombra o el cursor de mano). */
export async function revisarHover(page: Page, maximo = 12): Promise<HallazgoCrudo[]> {
  const out: HallazgoCrudo[] = [];
  const muestras = await page.evaluate(
    (m) => (window as unknown as ConQA).__qaUI.marcarMuestras(m),
    maximo,
  );
  for (const m of muestras) {
    const el = page.locator(`[data-qa-muestra="${m.i}"]`);
    const antes = await el.evaluate((e) => (window as unknown as ConQA).__qaUI.estiloVisual(e));
    const ok = await el
      .hover({ timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) continue;
    const despues = await el.evaluate((e) => (window as unknown as ConQA).__qaUI.estiloVisual(e));
    if (antes.estilo === despues.estilo && despues.cursor !== "pointer") {
      out.push({
        regla: "sin-senal-hover",
        severidad: "aviso",
        elemento: m.firma,
        detalle: `${m.describe} no cambia al pasar el mouse ni muestra la mano.`,
      });
    }
  }
  await page.mouse.move(0, 0);
  return out;
}

/**
 * El primer menú desplegable del contenido (en las grillas, el de acciones de la fila):
 * se abre, cabe en la pantalla, se cierra con Esc y, con teclado, devuelve el foco.
 */
export async function probarMenuDeAcciones(
  page: Page,
  modo: "teclado" | "tactil",
): Promise<HallazgoCrudo[]> {
  const disparador = page.locator('main [aria-haspopup="menu"]:visible').first();
  if (!(await disparador.count())) return [];
  const firma = await disparador.evaluate((e) => (window as unknown as ConQA).__qaUI.firma(e));
  // Desde arriba y con la página quieta: el recorrido con Tab deja la página desplazada y,
  // en Safari, enfocar el botón la sigue moviendo un cuadro después. Abierto en medio de ese
  // desplazamiento, el menú quedaba ubicado donde ya no estaba el botón («se sale»).
  await volverArriba(page);
  if (modo === "tactil") await disparador.tap();
  else {
    await disparador.focus();
    await esperarReflujo(page);
    await page.keyboard.press("Enter");
  }
  const menu = page.locator('[role="menu"]:visible').first();
  const abierto = await menu
    .waitFor({ state: "visible", timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (abierto) await esperarReflujo(page);
  if (!abierto) {
    return [
      {
        regla: "menu-desplegable",
        severidad: "bloquea",
        elemento: firma,
        detalle: `El menú no se abrió ${modo === "tactil" ? "al tocarlo" : "con Enter"}.`,
      },
    ];
  }
  const out: HallazgoCrudo[] = [];
  const caja = await menu.boundingBox();
  const vp = page.viewportSize();
  if (
    caja &&
    vp &&
    (caja.x < -1 ||
      caja.y < -1 ||
      caja.x + caja.width > vp.width + 1 ||
      caja.y + caja.height > vp.height + 1)
  ) {
    out.push({
      regla: "menu-desplegable",
      severidad: "bloquea",
      elemento: firma,
      detalle: `El menú se sale de la pantalla (${Math.round(caja.width)}×${Math.round(caja.height)} px en ${vp.width}×${vp.height}).`,
    });
  }
  out.push(
    ...(await analizar(page, {
      revisar: ["areas", "desborde"],
      areas: modo === "tactil" ? UMBRAL_TACTIL : UMBRAL_ESCRITORIO,
      dentroDe: '[role="menu"]',
    })),
  );
  await page.keyboard.press("Escape");
  const cerrado = await menu
    .waitFor({ state: "hidden", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!cerrado) {
    out.push({
      regla: "menu-desplegable",
      severidad: "bloquea",
      elemento: firma,
      detalle: "El menú no se cerró con Esc.",
    });
  } else if (modo === "teclado") {
    const vuelve = await disparador.evaluate((e) => document.activeElement === e);
    if (!vuelve) {
      out.push({
        regla: "menu-desplegable",
        severidad: "bloquea",
        elemento: firma,
        detalle: "Al cerrar el menú, el foco no vuelve al botón que lo abrió.",
      });
    }
  }
  return out;
}

/** En un teléfono: el botón de menú abre el panel, todo cabe y se cierra con Esc. */
export async function probarMenuMovil(page: Page): Promise<HallazgoCrudo[]> {
  const boton = page.getByRole("button", { name: ETIQUETA_MENU, exact: true });
  if (!(await boton.isVisible().catch(() => false))) {
    const porQue = await page.evaluate(
      (e) => (window as unknown as ConQA).__qaUI.diagnosticoMenu(e),
      ETIQUETA_MENU,
    );
    return [
      {
        regla: "menu-movil",
        severidad: "bloquea",
        elemento: "menu",
        detalle: `En el teléfono no aparece el botón de menú (${porQue}).`,
      },
    ];
  }
  await boton.tap();
  // El panel del menú es el diálogo con los enlaces de la app (hay otros diálogos, como
  // el aviso para instalar la app en iPhone).
  const panel = page
    .locator('[role="dialog"]:visible')
    .filter({ has: page.locator('a[href^="/app"]') })
    .first();
  const abierto = await panel
    .waitFor({ state: "visible", timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (!abierto) {
    return [
      {
        regla: "menu-movil",
        severidad: "bloquea",
        elemento: "menu",
        detalle: "Tocar el botón de menú no abrió el menú.",
      },
    ];
  }
  await esperarReflujo(page);
  const out = await analizar(page, {
    revisar: ["areas", "fuera", "desborde"],
    areas: UMBRAL_TACTIL,
    dentroDe: '[role="dialog"]',
  });
  await page.keyboard.press("Escape");
  const cerrado = await panel
    .waitFor({ state: "hidden", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!cerrado) {
    out.push({
      regla: "menu-movil",
      severidad: "bloquea",
      elemento: "menu",
      detalle: "El menú del teléfono no se cerró con Esc.",
    });
  }
  return out;
}

/**
 * Aproximación del teclado virtual: se toca el primer campo de texto y se achica el alto
 * de la ventana como lo hace Android al abrir el teclado. El campo tiene que quedar a la
 * vista y sin nada fijo encima. NO reproduce el teclado de iOS (que no achica la ventana
 * sino el área visible): por eso es un aviso, y la prueba real es en un teléfono.
 */
export async function probarTecladoVirtual(page: Page): Promise<HallazgoCrudo[]> {
  const campo = page
    .locator(
      [
        'input:visible:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"]):not([type="range"]):not([type="color"]):not([readonly]):not([disabled])',
        "textarea:visible:not([readonly]):not([disabled])",
      ].join(", "),
    )
    .first();
  if (!(await campo.count())) return [];
  const vp = page.viewportSize();
  if (!vp) return [];
  await campo.tap();
  await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.55) });
  await esperarReflujo(page);
  const r = await campo.evaluate((e) => (window as unknown as ConQA).__qaUI.campoConTeclado(e));
  await page.setViewportSize(vp);
  await esperarReflujo(page);
  if (!r.visible) {
    return [
      {
        regla: "teclado-virtual",
        severidad: "aviso",
        elemento: r.firma,
        detalle: `Con el teclado abierto, ${r.describe} queda fuera de la vista.`,
      },
    ];
  }
  if (r.tapadoPor) {
    return [
      {
        regla: "teclado-virtual",
        severidad: "aviso",
        elemento: r.firma,
        otro: r.tapadoPor.firma,
        detalle: `Con el teclado abierto, ${r.describe} queda tapado por ${r.tapadoPor.describe}.`,
      },
    ];
  }
  return [];
}
