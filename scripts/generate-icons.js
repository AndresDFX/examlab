#!/usr/bin/env node
/**
 * Regenera los iconos PNG a partir de los SVG fuente.
 *
 * Por qué PNG y no SVG:
 *   - Android Chrome DESCARTA notificaciones cuyo `icon` sea SVG (sin
 *     mostrar error ni log — sólo no llega). Notificaciones desde el SW
 *     deben referenciar PNG.
 *   - iOS Safari no acepta SVG en `apple-touch-icon`.
 *   - Algunos browsers viejos también prefieren PNG para favicon.
 *
 * Cuándo correr:
 *   - Después de cambiar `public/icons/icon-{192,512}.svg`.
 *   - npm run icons (también queda en package.json).
 */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

async function main() {
  const root = path.resolve(__dirname, "..");
  const iconsDir = path.join(root, "public", "icons");

  const svg192 = fs.readFileSync(path.join(iconsDir, "icon-192.svg"));
  const svg512 = fs.readFileSync(path.join(iconsDir, "icon-512.svg"));

  const outputs = [
    // Notificación + favicon principal (Chrome/Android).
    { name: "icon-192.png", src: svg192, size: 192 },
    // Manifest + Android splash.
    { name: "icon-512.png", src: svg512, size: 512 },
    // Badge en status bar de Android — recomendación oficial 72x72.
    { name: "badge-72.png", src: svg192, size: 72 },
    // apple-touch-icon (iOS PWA).
    { name: "apple-touch-icon.png", src: svg192, size: 180 },
  ];

  for (const o of outputs) {
    await sharp(o.src).resize(o.size, o.size).png().toFile(path.join(iconsDir, o.name));
    const stat = fs.statSync(path.join(iconsDir, o.name));
    console.log(`  ✓ ${o.name}  (${o.size}×${o.size}, ${stat.size} bytes)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
