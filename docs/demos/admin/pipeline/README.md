# Pipeline de producción de las demos (Rol Administrador)

Genera videos reales de la app con voz en español sincronizada, **cámara
dinámica** (zoom/pan) y **foco estilo onboarding** (spotlight + popover tipo
driver.js). Todo es **dirigido por un spec declarativo por módulo** — para
cambiar un módulo (guion, narración, qué se resalta, tiempos) se edita un solo
JSON; el motor (voz, grabación, mux) es genérico y reutilizable para los
módulos 2–11.

## Arquitectura

```
modules/module-XX.json   ← SPEC declarativo (la única fuente de verdad del módulo)
        │
        ├─ gen-voice.py        lee narration[] → audio2/scene-N.mp3 (edge-tts)
        ├─ record-module.mjs   lee escenas → graba webm + scene-offsets.json
        └─ build-mux.mjs       webm + mp3 (en su instante) → output/modulo-XX.mp4
```

- **Login fuera de cámara**: el login se hace en un contexto Playwright sin
  grabación; se captura la sesión (`storageState`) y el contexto grabado arranca
  **ya autenticado**, directo al dashboard. NO se muestra login ni selector de
  institución (acceso futuro por subdominio).
- **Relato centrado en una sola institución** (Demo Global Corp); sin mencionar
  el modelo multi-institución.
- **Cámara dinámica**: `transform: translate+scale` animado sobre `document.body`,
  con clamp para cubrir siempre el viewport. Recorre/zoomea los targets.
- **Foco estilo driver.js**: por cada beat, un div "hueco" (hijo directo de
  `body`, con `box-shadow` enorme = dim del resto + `outline` del elemento) NO
  recortado por overflow y que se mueve con la cámara, + un **popover**
  (título/descripción) contra-escalado para tamaño constante.

## El spec del módulo (`modules/module-XX.json`)

```jsonc
{
  "id": "modulo-01",
  "title": "...",
  "appPath": "/app",                         // ruta donde arranca la grabación
  "voice": { "name": "es-CO-GonzaloNeural", "rate": "-4%" },
  "scenes": [
    // Escena de carátula (intro / outro):
    { "id": "intro", "kind": "card", "narration": "…",
      "card": { "kicker": "…", "title": "…", "subtitle": "…" }, "bufferMs": 600 },

    // Escena de plataforma (recorre la UI con cámara + foco):
    { "id": "modulos", "kind": "platform", "narration": "…", "bufferMs": 900,
      "beats": [
        { "target": "<selector>", "scale": 1.55, "hold": 1500, "side": "right",
          "focus": { "title": "Cursos", "body": "Crea y administra los cursos." } }
      ]
    }
  ]
}
```

- **`narration`**: texto que la voz (edge-tts) sintetiza para esa escena. La
  duración en pantalla de la escena = duración del audio + `bufferMs`.
- **`beats[].target`**: cómo localizar el elemento a enfocar. Formas:
  - selector CSS normal: `[data-tour-module="courses"]`, `main h1`, …
  - `stat:N` → la N-ésima tarjeta de estadística del dashboard.
  - `card:Texto` → la tarjeta cuyo encabezado es exactamente "Texto".
  - `th:Texto` → el encabezado de columna de una tabla que contiene "Texto".
  - `row:N` → la N-ésima fila de **datos** de una tabla (filtra el header:
    solo filas con `<td>`; en el `Table resizable` el header puede aparecer como
    `tr` sin `td`, por eso no se usa `tbody tr` a secas).
  - `createbtn` → el botón primario "Nuevo/Nueva/Crear/Agregar" de la vista (o
    de la tab) activa.
  - `field:Etiqueta` → un campo de formulario por el texto de su `<label>` (dentro
    del diálogo abierto si lo hay). Devuelve el contenedor (label + input) para
    resaltar todo el campo. Para formularios cuyos campos NO tienen
    `data-tour-id` (ej. el diálogo "Nuevo contenido"). En `openDialog` los campos
    se hacen scroll a la vista automáticamente (`measureTargets(..., scroll=true)`).
  - `rowaction:N` → el **botón de acciones** ("tres puntos") de la fila N.
    Resuelve por `[data-row-actions]` (hook del componente `RowActionsMenu`); si
    el deploy de prod aún no lo tiene, cae al botón de la última celda de la fila
    de datos N. **Evita resaltar la fila entera** (una barra ancha) cuando lo que
    se quiere mostrar son las acciones.
- **Hook `data-row-actions`** (en [src/components/ui/row-actions-menu.tsx](../../../../src/components/ui/row-actions-menu.tsx)):
  atributo estable en el trigger del menú de acciones de fila, agregado para que
  los videos enfoquen con precisión el botón (no la fila). No afecta el
  comportamiento de la app. Si se necesita un anclaje preciso para un demo y el
  elemento no lo tiene, **agregar un `data-*` estable al componente y documentarlo
  aquí** (preferible a depender de selectores frágiles por posición).
- **`scale`** zoom de cámara; **`hold`** ms que se mantiene el foco;
  **`side`** `"right"` | `"left"` | `"bottom"` posición del popover; **`focus`**
  texto del popover (si se omite, no se dibuja popover — útil al abrir un menú
  real que ya muestra las acciones).
  - **Escala para elementos de ancho completo** (una fila de tabla, un encabezado
    ancho): usar **`scale: 1.0`**. Cualquier zoom > 1 recorta horizontalmente un
    elemento que ya ocupa todo el ancho; a 1.0 se ve completo y el spotlight
    (dim alrededor) hace el foco.
- **`tab: "Texto"`** (en una escena `platform`): antes de medir/enfocar, el
  recorder **cambia a esa pestaña** (Radix Tabs, `[role=tab]` por texto). Necesario
  porque el contenido de tabs inactivas NO está en el DOM (Radix lo desmonta). Los
  targets de la escena se miden **just-in-time** tras activar la tab. Usado en el
  Módulo 3 (Carreras / Asignaturas / Periodos).
- **`openDialog: "<selector del trigger>"`** (en una escena `platform`): el
  recorder **hace click** en ese botón para **abrir el diálogo de creación** y
  RECORRER sus campos — mostrando qué información se llena y cómo. Cada beat de la
  escena enfoca un campo (por su `[data-tour-id="..."]`), con scroll dentro del
  diálogo si el campo está bajo el fold, spotlight + popover a escala 1.0 (el
  diálogo es modal, Radix ya oscurece la página). Cierra con Escape al terminar.
  **Convención (a partir del Módulo 4):** todo módulo con una entidad creable
  debe **abrir su "Nuevo X"** y recorrer los campos clave, dentro del tope de 60 s.
  Usado en el Módulo 4 (Nuevo curso: nombre · periodo · asignatura · fechas · cortes).
- **`clickToOpen: true`**: el beat **hace click** en el target para abrir un menú
  (DropdownMenu) y resaltar las **acciones reales** (no solo el botón). El recorder
  resetea la cámara a identidad (para que el click acierte), abre el menú, y lo
  resalta con un **dim por detrás** (z-index 45, bajo el `z-50` del menú Radix,
  `pointer-events:none` → no lo cierra). Cierra con Escape al terminar el `hold`.
  Usado para "Acciones por usuario" en el Módulo 2.

**Para cambiar el módulo** (guion + interacción): editás `module-XX.json` y
re-corrés los 3 pasos. **Para un módulo nuevo (2–11)**: copiás el JSON, cambiás
`id`/`title` y las escenas, y corrés el pipeline con `node record-module.mjs
modules/module-02.json` (y los demás aceptan la ruta como argumento).

## Requisitos (one-time)

- **Node** (probado con v24).
- **Playwright + Chromium** en una carpeta scratch fuera del repo
  (`C:\Temp\examlab-rec`) para no tocar el `bun.lock`:
  ```powershell
  $dir="C:\Temp\examlab-rec"; New-Item -ItemType Directory -Force $dir | Out-Null
  Set-Content "$dir\package.json" '{ "name":"examlab-rec","private":true,"type":"module" }' -Encoding utf8
  npm install --prefix $dir playwright
  & "$dir\node_modules\.bin\playwright.cmd" install chromium
  ```
- **ffmpeg** estático (gyan.dev) — el de Playwright no muxea audio externo.
- **edge-tts**: `python -m pip install --user edge-tts` (Python + internet).

## Pasos

Los scripts leen la `anon key` del `.env` del repo y las credenciales del Admin
del tenant de `C:\Temp\examlab-rec\tenant-info.json` (generado por
`setup-tenant.mjs`; NO se versiona — trae la password temporal del usuario demo).

```powershell
node docs/demos/admin/pipeline/setup-tenant.mjs        # 1) crea tenant + datos demo (one-time)
node docs/demos/admin/pipeline/disable-onboarding.mjs  # 2) apaga el tour driver.js del user demo (one-time)
python docs/demos/admin/pipeline/gen-voice.py  docs/demos/admin/pipeline/modules/module-01.json
node   docs/demos/admin/pipeline/record-module.mjs docs/demos/admin/pipeline/modules/module-01.json
node   docs/demos/admin/pipeline/build-mux.mjs     docs/demos/admin/pipeline/modules/module-01.json
```

(En la práctica se corrieron desde `C:\Temp\examlab-rec`, donde están Playwright
y ffmpeg; las rutas internas apuntan a ese scratch. Ajustá las constantes de ruta
si reubicás el pipeline.)

El Δ de arranque del video (`vstart`) se captura automáticamente en la grabación
y `build-mux.mjs` lo usa para colocar cada narración en su instante, con pasada
anti-solapamiento.

## Limitaciones de este corte

- **Voz**: TTS neural `es-CO-GonzaloNeural` (masculina, colombiana) — natural,
  pero sintética. Para más expresividad: ElevenLabs / Azure Neural con las mismas
  narraciones (cambiar `voice` en el spec / el generador).
- **Pre-roll**: ~1 s de pantalla de carga antes de la carátula intro.
- **Peso**: el movimiento de cámara sube el bitrate (H.264 comprime menos); ~12 MB
  para ~53 s. Subir `-crf` en `build-mux.mjs` lo reduce si hace falta.

## Datos del tenant de demo

- **Institución**: `Demo Global Corp` (slug `demo-global-corp`), branding azul.
- **Admin multi-rol**: `test-demo-global-corp@examlab.test` (password en el
  `tenant-info.json` scratch, mostrada una sola vez por `provision-tenant-test-user`).
- **Sembrado**: 3 cursos (2026-I) + 8 usuarios (`@demoglobalcorp.test`, dominio
  `.test` reservado → sin entrega real de correo).
- El tenant queda visible en producción. Para removerlo: SuperAdmin →
  `/app/superadmin/tenants` → eliminar (hard-delete con cascada).
