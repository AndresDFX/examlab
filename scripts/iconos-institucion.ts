/**
 * Genera los PNG del ícono de UNA institución y los deja en
 * `dist/client/icons/<slug>/`, para que su `manifest.json` los referencie.
 *
 * ── Por qué hace falta ────────────────────────────────────────────────
 * El ícono de la app es una composición: el de ExamLab a sangre completa y el
 * logo de la institución como distintivo abajo a la derecha. Mientras el
 * manifest se armaba en el navegador, esos PNG se rasterizaban con canvas y
 * viajaban dentro del propio manifest como `data:`. Al pasar el manifest al
 * despliegue —para que su URL sea estable y Android pueda actualizar la app
 * instalada— esa parte se habría perdido: el manifest publicado se quedaba con
 * los íconos genéricos de ExamLab y la app instalada en Android perdía el
 * distintivo. Esto lo devuelve.
 *
 * ── Qué se comparte con el navegador y qué no ─────────────────────────
 * La GEOMETRÍA es la misma función que usa el cliente (`medidasDistintivo`,
 * `medidasIcono`): dónde va el círculo, cuánto mide, cómo se contiene el logo
 * sin deformarlo y cómo se corre hacia adentro en el ícono `maskable` para
 * sobrevivir al recorte de Android. Lo único distinto es quién dibuja —acá
 * `sharp`, allá `canvas`— porque en el despliegue no hay DOM. Si la geometría
 * se hubiera copiado, el ícono publicado y el del navegador podrían separarse
 * sin que nada avise.
 *
 * Uso:  bun scripts/iconos-institucion.ts <slug> <url-del-logo>
 * Sale con 0 y sin escribir nada si el logo no se puede usar: una institución
 * sin logo utilizable se queda con los íconos de ExamLab, que es el
 * comportamiento correcto y no una falla del despliegue.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import sharp from "sharp";

import {
  FRACCION_LOGO_EN_DISTINTIVO,
  LADO_ICONO_CHICO,
  LADO_ICONO_GRANDE,
  medidasDistintivo,
  medidasIcono,
} from "../src/modules/tenants/pwa-branding";

const BASE = "public/icons/icon-512.png";

interface Salida {
  archivo: string;
  lado: number;
  maskable: boolean;
}

const SALIDAS: Salida[] = [
  { archivo: "icon-192.png", lado: LADO_ICONO_CHICO, maskable: false },
  { archivo: "icon-512.png", lado: LADO_ICONO_GRANDE, maskable: false },
  { archivo: "icon-512-maskable.png", lado: LADO_ICONO_GRANDE, maskable: true },
];

async function componer(logo: Buffer, lado: number, maskable: boolean): Promise<Buffer> {
  const d = medidasDistintivo(lado, maskable);
  if (!d) throw new Error("medidas del distintivo inservibles");

  const base = await sharp(BASE).resize(lado, lado).png().toBuffer();

  // El círculo blanco va como SVG: el ícono de ExamLab es índigo oscuro y los
  // logos institucionales suelen ser azul marino sobre transparente — sin este
  // fondo el logo desaparece contra la base. El aro tenue lo despega del borde.
  const aro = Math.max(1, lado * 0.006);
  // `viewBox` explícito: sin él el rasterizador recorta el trazo del
  // círculo en los cuatro puntos cardinales y el borde sale mordido.
  const svg = (interior: string) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}" ` +
        `viewBox="0 0 ${lado} ${lado}">${interior}</svg>`,
    );
  const relleno = svg(`<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}" fill="#ffffff"/>`);
  // El aro se dibuja SOBRE el logo, no debajo: un logo sin canal alfa pinta su
  // rectángulo opaco y, por dentro, le tapaba pedazos al aro cerca de las
  // diagonales. Encima, el anillo queda entero.
  const anillo = svg(
    `<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}" fill="none" ` +
      `stroke="rgba(15,23,42,0.18)" stroke-width="${aro}"/>`,
  );

  // El logo, contenido dentro del círculo sin deformarse.
  const ladoUtil = Math.round(d.r * 2 * FRACCION_LOGO_EN_DISTINTIVO);
  const dim = await sharp(logo).metadata();
  const m = medidasIcono(dim.width ?? 0, dim.height ?? 0, ladoUtil, 1);
  if (!m) throw new Error("el logo no tiene medidas utilizables");

  const logoRedim = await sharp(logo)
    .resize(Math.max(1, Math.round(m.w)), Math.max(1, Math.round(m.h)), { fit: "fill" })
    .png()
    .toBuffer();

  const izq = Math.round(d.cx - d.r + (d.r * 2 - ladoUtil) / 2 + m.x);
  const arriba = Math.round(d.cy - d.r + (d.r * 2 - ladoUtil) / 2 + m.y);

  // El distintivo se arma aparte y se RECORTA al círculo antes de pegarlo.
  // Sin esto, un logo sin canal alfa —el de UNIAJ es un webp opaco de fondo
  // blanco, verificado— pega su rectángulo entero y las cuatro esquinas
  // asoman por fuera del círculo. Es el equivalente del `clip()` que hace la
  // versión del navegador; sin él los dos íconos no serían el mismo dibujo.
  const capa = await sharp({
    create: { width: lado, height: lado, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: relleno, top: 0, left: 0 },
      { input: logoRedim, top: arriba, left: izq },
    ])
    .png()
    .toBuffer();

  const mascara = svg(`<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}" fill="#ffffff"/>`);
  const distintivo = await sharp(capa)
    .composite([{ input: mascara, blend: "dest-in" }])
    .png()
    .toBuffer();

  return sharp(base)
    .composite([
      { input: distintivo, top: 0, left: 0 },
      { input: anillo, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
}

async function main(): Promise<void> {
  const [slug, urlLogo] = process.argv.slice(2);
  if (!slug || !urlLogo) {
    console.log("sin logo: la institucion se queda con los iconos de ExamLab");
    return;
  }

  let logo: Buffer;
  try {
    const r = await fetch(urlLogo);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    logo = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    // Que no se pueda bajar un logo NO puede tumbar el despliegue de una
    // institución: se publica con los íconos de ExamLab y se avisa.
    console.log(`aviso: no se pudo bajar el logo de ${slug} (${String(e)}); se usan los de ExamLab`);
    return;
  }

  const dir = `dist/client/icons/${slug}`;
  mkdirSync(dir, { recursive: true });

  for (const s of SALIDAS) {
    try {
      const png = await componer(logo, s.lado, s.maskable);
      writeFileSync(`${dir}/${s.archivo}`, png);
    } catch (e) {
      console.log(`aviso: no se pudo componer ${s.archivo} de ${slug} (${String(e)})`);
      return;
    }
  }
  console.log(`iconos de ${slug}: ${SALIDAS.length} generados en ${dir}`);
}

await main();
