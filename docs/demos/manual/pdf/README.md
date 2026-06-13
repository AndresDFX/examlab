# Manuales en PDF

PDFs generados a partir de los `.md` de [`docs/demos/manual/`](../). Incluyen los
pantallazos (`screenshots/<rol>/*.png`) embebidos. Listos para enviar por correo o
adjuntar a una carpeta compartida.

- `manual.pdf` — índice + cómo ingresar + uso móvil (PWA).
- `manual-administrador.pdf`
- `manual-docente.pdf`
- `manual-estudiante.pdf`

## Regenerar los PDF (tras editar los `.md`)

Los PDF **no se editan a mano**: son una salida derivada de los `.md`. Cuando cambies
cualquier manual `.md`, regenera los PDF con:

```bash
# Todos los manuales:
npm run manual:pdf          # = node scripts/gen-manual-pdfs.mjs

# Solo uno:
node scripts/gen-manual-pdfs.mjs manual-docente
```

El generador vive en [`scripts/gen-manual-pdfs.mjs`](../../../../scripts/gen-manual-pdfs.mjs):
convierte cada `.md` a HTML (marked), le aplica el CSS de impresión y exporta el PDF con
Playwright (Chromium). Las rutas relativas de imágenes resuelven porque escribe un HTML
temporal en la misma carpeta del `.md`.

> **Windows:** usar `node` (no `bun`) — bun + Playwright en Windows tiene un bug con
> `chromium.launch()` (igual que `scripts/record-tour.ts`). El `npm run manual:pdf` ya
> usa node. Requiere el Chromium de Playwright instalado (`npx playwright install chromium`
> si hiciera falta).

> El flujo de trabajo es: **editar el `.md` → `npm run manual:pdf` → commitear ambos**
> (el `.md` y el `.pdf` regenerado).
