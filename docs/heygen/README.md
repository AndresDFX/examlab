# Videos de onboarding con HeyGen

Pipeline para producir videos de bienvenida con avatar IA por rol
(Admin / Docente / Estudiante). El resultado es un MP4 con avatar
hablando ENCIMA de una grabación real de la app.

## Flujo completo

```
[bun run record:tour:teacher]
        ↓
recordings/teacher-YYYYMMDD-HHmmss.webm   (1280×720, ~60-90s, silenciado)
        ↓
ffmpeg → teacher.mp4                       (H.264, calidad CRF 18)
        ↓
HeyGen: subir como "background video"
   + pegar script de docs/heygen/docente.md como narración
   + elegir avatar
        ↓
HeyGen rendea el avatar overlay encima
        ↓
[video final.mp4] → hospedarlo (Cloudflare, YouTube unlisted, Vimeo)
        ↓
Pegar URL en el tour (tour-config.ts videoUrl)
```

---

## 1. Setup inicial (una sola vez)

### 1.1 Instalar el browser de Playwright

```bash
bunx playwright install chromium
```

Esto baja ~150 MB de chromium aislado en `~/.cache/ms-playwright/`. No
toca tu Chrome del sistema.

### 1.2 Credenciales del usuario demo

Crear `.env.recording` en la raíz del repo (NO se commitea — está en
`.gitignore`):

```env
APP_URL=http://localhost:5173
DEMO_EMAIL=demo-docente@tu-institucion.edu
DEMO_PASSWORD=passwordSeguro123!
```

Cada rol necesita su propio usuario demo. Si tu institución tiene una
única cuenta con multi-rol, usá esa cuenta y el `role-switcher` del
sidebar respeta el rol "activo" durante la grabación.

### 1.3 Instalar `ffmpeg` (para convertir .webm → .mp4)

- **macOS**: `brew install ffmpeg`
- **Windows**: `winget install ffmpeg` o `choco install ffmpeg`
- **Linux**: `sudo apt install ffmpeg`

HeyGen acepta .webm pero la conversión a .mp4 mejora la compresión y
compatibilidad. Es opcional.

> **Nota — ffmpeg de Playwright es minimal**: Playwright bundle-ea su
> propio `ffmpeg` en `~/.cache/ms-playwright/ffmpeg-*/` pero ese build
> es solo para muxing VP8/VP9 (lo que graba) y NO incluye el encoder
> `libx264` ni el flag `-preset`. Si querés convertir a mp4, hay que
> instalar ffmpeg standalone — Playwright **no sirve para conversión**.

### 1.4 Runtime: usar `node`, NO `bun`

Los scripts `record:tour:*` usan `node --experimental-strip-types`
(no `bun`). Razón: `bun + playwright` en Windows tiene un bug conocido
donde `chromium.launch()` timeouts 180s por problemas del
`remote-debugging-pipe` con el runtime de Bun. `node 22+` corre los
mismos `.ts` (gracias a `--experimental-strip-types`) y completa
`chromium.launch()` en <1s. Mac/Linux con bun probablemente funcione
— el bug es específico de Windows.

---

## 2. Grabar el video

```bash
# En una terminal:
bun run dev

# En otra terminal (con .env.recording listo):
npm run record:tour:teacher
# o directo:
node --experimental-strip-types scripts/record-tour.ts --role=teacher
```

El script:

- Abre Chromium en modo headless (no se ve nada).
- Loguea con tu usuario demo.
- Navega por cada módulo dwelleando 5-10s en cada uno.
- Guarda el video en `recordings/teacher-<timestamp>.webm`.
- Imprime el path final + los próximos pasos.

**Para ver el browser en vivo** (debug): añadí `--headless=false`:

```bash
node --experimental-strip-types scripts/record-tour.ts --role=teacher --headless=false
```

---

## 3. Convertir a MP4

```bash
ffmpeg -i recordings/teacher-20260817-103045.webm \
       -c:v libx264 -preset slow -crf 18 -an \
       teacher.mp4
```

Flags:

- `-c:v libx264`: codec H.264 (HeyGen lo prefiere sobre VP9).
- `-preset slow`: mejor compresión, ~2× más lento.
- `-crf 18`: calidad alta visualmente lossless.
- `-an`: sin audio (HeyGen pone el del avatar; cualquier audio nuestro chocaría).

---

## 4. Subir a HeyGen

1. En HeyGen → **Create video** → **Custom video**.
2. **Background**: subí `teacher.mp4`.
3. **Avatar**: elegí uno (recomendaciones en cada `.md`).
4. **Script**: pegá el contenido del bloque `> Script` de `docs/heygen/<rol>.md`.
5. **Voice**: español neutro o es-CO.
6. **Render** → descargar el MP4 final.

---

## 5. Hospedar y enlazar en el tour

Subí el MP4 final donde prefieras:

- **YouTube unlisted** (gratis, sin overhead).
- **Vimeo** (mejor calidad de embed).
- **Cloudflare Stream** (control total).

Después pegá la URL en `src/modules/onboarding/tour-config.ts`:

```ts
export const ADMIN_TOUR_META = {
  videoUrl: "https://youtu.be/XXXXXXXX",
};
```

El primer paso del tour interactivo mostrará un botón "Ver video
introductorio" que abre el video en una pestaña nueva.

---

## Tips

- **Si el login falla** durante la grabación: verificá que el usuario
  demo no tenga `must_change_password = true` en `profiles`. Si lo
  tiene, abrí la app a mano, cambiá la password una vez, y volvé a correr
  el script.
- **Si el video sale en negro o con skeletons**: subí los `dwellMs` de
  los modules pesados (Asistencia, Pizarras) en `SCENES_BY_ROLE` del
  script. Default es 6-8s; podés llevarlo a 10-12s.
- **Si querés cambiar la resolución**: editá `VIEWPORT` en el script.
  Para 1080p ajustá a `{ width: 1920, height: 1080 }`. Pesa ~3× más.
- **Para grabar solo UNA escena específica**: comentá las demás en
  `SCENES_BY_ROLE` y volvé a correr.
- **Los videos en `recordings/`** quedan ignorados por git (ver
  `.gitignore`). Si querés versionar el final, subilo a tu hosting
  externo y pegá la URL en el tour.
