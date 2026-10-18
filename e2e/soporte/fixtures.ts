/**
 * `test` de las pruebas de UI: cada prueba recibe `abrir(pantalla)`, que inyecta la sesión
 * de la corrida con el rol de esa pantalla, navega, espera que termine de cargar y deja la
 * página quieta (sin transiciones ni animaciones) para medirla.
 */
import { readFileSync } from "node:fs";
import { test as base, type Page } from "@playwright/test";
import { cargarEntorno } from "./entorno";
import { esperarPantallaLista } from "./esperar";
import type { Pantalla, Rol } from "./pantallas";
import { nuevoRegistro, protegerEscrituras, type RegistroDeRed } from "./red";
import { volverArriba } from "./revisiones";
import { leerSesionGuardada } from "./sesion";

const ANALIZADOR = readFileSync(new URL("./analizador-navegador.js", import.meta.url), "utf8");

/**
 * Sin transiciones ni animaciones: medir a mitad de una transición da estilos intermedios
 * (un foco «sin marca» porque el anillo todavía está apareciendo). `animation: none` y no
 * una duración de 0 s: con `none`, los componentes de Radix desmontan al cerrar sin esperar
 * un evento de fin de animación.
 */
const SIN_MOVIMIENTO = `*, *::before, *::after {
  transition: none !important;
  animation: none !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}`;

async function inyectarSesion(page: Page, rol: Rol): Promise<void> {
  const entorno = cargarEntorno();
  const sesion = leerSesionGuardada();
  await page.addInitScript(
    ([clave, valor, claveRol, r]) => {
      try {
        if (!window.localStorage.getItem(clave)) window.localStorage.setItem(clave, valor);
        // El rol activo vive en sessionStorage por usuario (`rol-activo-guardado.ts`).
        window.sessionStorage.setItem(claveRol, r);
      } catch {
        // Un iframe sin almacenamiento: no es la página bajo prueba.
      }
    },
    [
      entorno.claveSesion,
      JSON.stringify(sesion),
      `examlab_rol_activo:${sesion.user.id}`,
      rol,
    ] as const,
  );
}

async function verificarLlegada(page: Page, pantalla: Pantalla): Promise<void> {
  const ruta = new URL(page.url()).pathname.replace(/\/$/, "") || "/";
  const esperada = pantalla.ruta.replace(/\/$/, "") || "/";
  if (pantalla.rol && ruta !== esperada) {
    throw new Error(
      `[e2e] «${pantalla.nombre}» no cargó: la app llevó a ${ruta}. ¿La sesión venció, el rol no tiene acceso o el módulo está apagado en la institución?`,
    );
  }
  if (
    await page
      .getByText(/Módulo no disponible/i)
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    throw new Error(
      `[e2e] «${pantalla.nombre}»: el módulo está apagado para ese rol en la institución.`,
    );
  }
  // Medir una pantalla que no se dibujó registraría hallazgos de una página vacía.
  if (
    pantalla.rol &&
    !(await page
      .locator("main")
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    throw new Error(
      `[e2e] «${pantalla.nombre}»: la app no terminó de dibujarse (sin <main> visible). Mira consola.json.`,
    );
  }
  // El recorrido guiado sale la primera vez que la cuenta entra con un rol, y tapa la
  // pantalla: medida así, todo saldría «tapado».
  if (
    await page
      .locator(".driver-popover")
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    throw new Error(
      `[e2e] «${pantalla.nombre}»: el recorrido guiado está abierto y tapa la pantalla. La cuenta de prueba tiene que tenerlo completado en sus tres roles (profiles.onboarding_completed_roles).`,
    );
  }
}

export const test = base.extend<{ red: RegistroDeRed; abrir: (p: Pantalla) => Promise<void> }>({
  red: async ({ page }, use, testInfo) => {
    const registro = nuevoRegistro();
    // Los errores de la página: si una pantalla sale en blanco, acá está el porqué.
    const consola: string[] = [];
    page.on("pageerror", (e) => consola.push(`[excepción] ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") consola.push(`[consola] ${m.text().slice(0, 500)}`);
    });
    await protegerEscrituras(page, registro);
    await use(registro);
    // Las peticiones en vuelo al cerrar la página (el sondeo de avisos, por ejemplo) no
    // deben dejar manejadores colgados: retienen al proceso de la prueba.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const sinClasificar = [...registro.rpcSinClasificar].sort();
    await testInfo.attach("red.json", {
      body: JSON.stringify(
        {
          bloqueadas: registro.bloqueadas,
          rpcPermitidas: [...registro.rpcPermitidas].sort(),
          rpcSinClasificar: sinClasificar,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    for (const rpc of sinClasificar) {
      testInfo.annotations.push({
        type: "aviso: rpc sin clasificar",
        description: `Se bloqueó «${rpc}» porque no está en la lista de lecturas de e2e/soporte/red.ts. Si solo lee, agrégala a RPC_QUE_LEEN (la pantalla se midió sin ese dato).`,
      });
    }
    if (consola.length) {
      await testInfo.attach("consola.json", {
        body: JSON.stringify(consola, null, 2),
        contentType: "application/json",
      });
    }
  },

  abrir: async ({ page, red }, use, testInfo) => {
    void red;
    await page.addInitScript({ content: ANALIZADOR });
    // Como alguien que ya cerró el aviso de «Instalar ExamLab en iPhone»: con el perfil de
    // iPhone sale en cada contexto nuevo y tapa la pantalla que se quiere medir.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("examlab_ios_install_dismissed_at", String(Date.now()));
      } catch {
        // Sin almacenamiento el aviso aparece; no es la página bajo prueba.
      }
    });
    await use(async (pantalla) => {
      if (pantalla.rol) await inyectarSesion(page, pantalla.rol);
      const dentroDeLaApp = pantalla.rol !== null;
      const anotarVencidas = (vencidas: string[]) => {
        if (vencidas.length) {
          testInfo.annotations.push({ type: "espera vencida", description: vencidas.join(", ") });
        }
      };
      await page.goto(pantalla.ruta);
      anotarVencidas(await esperarPantallaLista(page, { dentroDeLaApp }));
      await verificarLlegada(page, pantalla);
      await page.addStyleTag({ content: SIN_MOVIMIENTO });
      if (pantalla.preparar) {
        await pantalla.preparar(page);
        anotarVencidas(await esperarPantallaLista(page, { dentroDeLaApp }));
        await volverArriba(page);
      }
    });
    // `E2E_CAPTURAS=1`: adjunta cómo quedó la pantalla. Al FINAL y no al abrir: la captura
    // de página completa redimensiona la ventana, y en Chromium con emulación móvil la
    // regla `pointer: coarse` deja de aplicarse en lo que se mide después.
    if (process.env.E2E_CAPTURAS) {
      const ruta = testInfo.outputPath("pantalla.png");
      await page.screenshot({ path: ruta, fullPage: true }).catch(() => undefined);
      await testInfo
        .attach("pantalla.png", { path: ruta, contentType: "image/png" })
        .catch(() => undefined);
    }
  },
});

export { expect } from "@playwright/test";
