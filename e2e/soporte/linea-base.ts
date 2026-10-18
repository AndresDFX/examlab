/**
 * El trinquete (decisión de la Fase 1): lo que ya existía al instalar las pruebas queda
 * registrado en `e2e/linea-base.json` y NO frena el despliegue; lo nuevo, sí. Así se puede
 * bloquear desde el primer día sin exigir arreglar antes cientos de detalles viejos.
 *
 * La clave de un hallazgo es capa + pantalla + regla + firma del componente, sin el ancho
 * ni el dispositivo: el mismo problema en otro ancho no es «nuevo». Lo que SÍ es nuevo es
 * un componente distinto con el problema, o una regla que antes no fallaba.
 *
 * Los AVISOS nunca bloquean: quedan anotados en el reporte de cada prueba.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestInfo } from "@playwright/test";
import type { Pantalla } from "./pantallas";
import type { HallazgoCrudo } from "./revisiones";

export type Capa = "anchos" | "escritorio" | "tactil";

export const ARCHIVO_LINEA_BASE = fileURLToPath(new URL("../linea-base.json", import.meta.url));

export interface EntradaLineaBase {
  capa: Capa;
  pantalla: string;
  regla: string;
  elemento: string;
  otro?: string;
  detalle: string;
  perfiles: string[];
}

export interface ArchivoLineaBase {
  nota: string;
  entradas: Record<string, EntradaLineaBase>;
}

export interface Hallazgo extends HallazgoCrudo {
  clave: string;
}

export function claveDe(capa: Capa, pantalla: string, h: HallazgoCrudo): string {
  return [capa, pantalla, h.regla, h.elemento, h.otro ?? ""].join("|");
}

let cache: ArchivoLineaBase | null = null;

export function cargarLineaBase(): ArchivoLineaBase {
  cache ??= existsSync(ARCHIVO_LINEA_BASE)
    ? (JSON.parse(readFileSync(ARCHIVO_LINEA_BASE, "utf8")) as ArchivoLineaBase)
    : { nota: "", entradas: {} };
  return cache;
}

/** Une los hallazgos repetidos (mismo componente en varios anchos) y dice en cuáles. */
function unir(capa: Capa, pantalla: string, hallazgos: HallazgoCrudo[]): Hallazgo[] {
  const porClave = new Map<string, { h: HallazgoCrudo; anchos: number[] }>();
  for (const h of hallazgos) {
    const clave = claveDe(capa, pantalla, h);
    const previo = porClave.get(clave);
    if (!previo) porClave.set(clave, { h, anchos: h.ancho ? [h.ancho] : [] });
    else if (h.ancho && !previo.anchos.includes(h.ancho)) previo.anchos.push(h.ancho);
  }
  return [...porClave.entries()].map(([clave, { h, anchos }]) => ({
    ...h,
    clave,
    detalle: anchos.length ? `En ${anchos.join(", ")} px: ${h.detalle}` : h.detalle,
  }));
}

export async function contrastarConLineaBase(
  testInfo: TestInfo,
  capa: Capa,
  pantalla: Pantalla,
  crudos: HallazgoCrudo[],
): Promise<void> {
  const hallazgos = unir(capa, pantalla.id, crudos);
  const ruta = testInfo.outputPath("hallazgos.json");
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(
    ruta,
    JSON.stringify(
      { capa, pantalla: pantalla.id, perfil: testInfo.project.name, hallazgos },
      null,
      2,
    ),
  );
  await testInfo.attach("hallazgos.json", { path: ruta, contentType: "application/json" });

  const base = cargarLineaBase().entradas;
  const bloqueantes = hallazgos.filter((h) => h.severidad === "bloquea");
  const nuevos = bloqueantes.filter((h) => !base[h.clave]);
  const conocidos = bloqueantes.length - nuevos.length;
  const avisos = hallazgos.filter((h) => h.severidad === "aviso");
  if (conocidos) {
    testInfo.annotations.push({
      type: "conocidos",
      description: `${conocidos} problema(s) que ya estaban registrados en la línea base`,
    });
  }
  for (const a of avisos) {
    testInfo.annotations.push({ type: `aviso: ${a.regla}`, description: a.detalle });
  }
  if (nuevos.length && process.env.E2E_LINEA_BASE !== "registrar") {
    throw new Error(
      [
        `Problemas NUEVOS de UI en «${pantalla.nombre}» (${testInfo.project.name}):`,
        ...nuevos.map(
          (h) =>
            `  • [${h.regla}] ${h.detalle}\n      componente: ${h.elemento}${h.otro ? ` · tapado por ${h.otro}` : ""}`,
        ),
        "",
        "Si son intencionales y se aceptan, se registran en la línea base: bun run e2e:linea-base",
      ].join("\n"),
    );
  }
}
