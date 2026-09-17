/**
 * Reescribe `dist/client/manifest.json` con el nombre de UNA institución, justo
 * antes de publicar su Worker.
 *
 * ── Por qué en el despliegue y no en el navegador ─────────────────────
 * El nombre y el ícono de la app se armaban en runtime y se colgaban de un
 * `<link rel="manifest">` apuntando a un `blob:`. Eso tenía dos costos medidos:
 *
 *  1. **Una ventana en la que la app se instala genérica.** El cambio ocurre
 *     después de consultar la institución, bajar su logo y rasterizarlo:
 *     cronometrado, 5,7 s en la primera visita y 1,5 s con caché. Quien pulsa
 *     «Instalar» en esos segundos se lleva «ExamLab — Plataforma de Exámenes».
 *     Medido de verdad: en una corrida en frío el navegador reportó ese nombre.
 *  2. **La app instalada no se puede actualizar.** Android relee el manifest en
 *     la URL que registró al instalar, y una `blob:` solo existe mientras vive
 *     esa pestaña. En la sesión siguiente no hay nada que releer.
 *
 * Como cada institución ya tiene su propio Worker (mismo build, distinto
 * nombre), el despliegue puede escribirle su manifest real. La URL vuelve a ser
 * `/manifest.json` —estable— y el nombre correcto está desde el primer
 * milisegundo.
 *
 * ── Por qué TypeScript y no un .mjs ───────────────────────────────────
 * Para importar `nombreAppInstitucion` del código de la app en vez de repetir
 * la regla acá. Si se duplicara, el nombre del manifest publicado y el que la
 * app calcula en runtime podrían divergir sin que nada avise — la clase de
 * invariante cross-file que este repo ya pagó caro. El CI corre con bun, que
 * importa TS directo.
 *
 * Uso:  bun scripts/manifest-institucion.ts <slug> [nombre]
 *       bun scripts/manifest-institucion.ts --restaurar
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { nombreAppInstitucion } from "../src/modules/tenants/pwa-branding";

const ORIGEN = "public/manifest.json";
const DESTINO = "dist/client/manifest.json";

function main(): void {
  const args = process.argv.slice(2);
  const base = JSON.parse(readFileSync(ORIGEN, "utf8")) as Record<string, unknown>;

  // `--restaurar` deja el manifest general. Lo usa el despliegue general y,
  // sobre todo, evita que una corrida a medias deje el manifest de la última
  // institución publicada pegado al build.
  if (args[0] === "--restaurar" || !args[0]) {
    writeFileSync(DESTINO, JSON.stringify(base, null, 2) + "\n");
    console.log("manifest general restaurado");
    return;
  }

  const slug = args[0].trim();
  const nombre = (args[1] ?? "").trim() || null;
  const nombreApp = nombreAppInstitucion(slug, nombre);

  // Los íconos compuestos, si el paso anterior los pudo generar. Se comprueba
  // en disco y no se asume: una institución sin logo utilizable no los tiene, y
  // apuntar a un archivo que no existe dejaría la app SIN ícono — peor que el
  // genérico.
  const dirIconos = `dist/client/icons/${slug}`;
  const hayCompuestos = ["icon-192.png", "icon-512.png", "icon-512-maskable.png"].every((f) =>
    existsSync(`${dirIconos}/${f}`),
  );
  const icons = hayCompuestos
    ? [
        { src: `/icons/${slug}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
        { src: `/icons/${slug}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
        {
          src: `/icons/${slug}/icon-512-maskable.png`,
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ]
    : base.icons;

  const manifest = {
    ...base,
    icons,
    name: nombreApp,
    // El MISMO texto que `name`: es lo que se lee bajo el ícono. Ver
    // `nombreAppInstitucion`.
    short_name: nombreApp,
    description: nombre
      ? `Plataforma académica de ${nombre}: exámenes, talleres y seguimiento.`
      : base.description,
  };

  writeFileSync(DESTINO, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`manifest de ${slug}: ${nombreApp}`);
}

main();
