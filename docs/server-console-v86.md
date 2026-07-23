# Consola de servidor — Linux real en el navegador (v86)

La pregunta **"Consola de servidor" (`so_consola`)** dejó de usar el simulador
determinista y ahora bootea un **Linux x86 REAL** dentro del navegador con
[v86](https://github.com/copy/v86) (emulador x86 → WebAssembly), expuesto por su
**consola serial** vía [xterm.js](https://xtermjs.org/). Concepto tipo
[jslinux](https://bellard.org/jslinux/): **todos** los comandos funcionan de
verdad (no hay simulación de comandos).

## Arquitectura

| Pieza | Archivo |
|---|---|
| Carga de v86 + xterm por CDN (patrón CheerpJ: singleton + SSR guard + cache-clear) | `src/modules/serverconsole/v86-loader.ts` |
| Componente de terminal (boot + serial ↔ xterm + transcript) | `src/modules/serverconsole/V86Console.tsx` |
| (De)serialización de la respuesta (transcript + comandos) | `src/modules/serverconsole/v86-answer.ts` |
| Punto de montaje (taker de taller) | `src/modules/workshops/WorkshopQuestions.tsx` (rama `so_consola`) |

- **v86 + BIOS + xterm** se cargan desde jsDelivr (`cdn.jsdelivr.net/npm/v86`,
  `.../npm/xterm`). No se agregaron dependencias npm (el lockfile es `bun.lock`
  y cargar por CDN evita regenerarlo) — mismo camino ya probado por CheerpJ.
- El **service worker** (`public/sw.js`) ya cachea `.wasm`, así que el módulo
  de v86 se cachea igual que el de CheerpJ.

## Imagen del SO — default público + override recomendado

Bootear Linux necesita la **imagen del sistema** (varios MB). NO se puede
embeber en el bundle ni en el repo.

**Por defecto** (sin definir ninguna env `VITE_V86_*`) la consola bootea una
imagen pública: `https://i.copy.sh/buildroot-bzimage68.bin` (buildroot con
consola serial integrada, CDN de v86 con CORS `*`). Así la hoja de consola de
las pizarras funciona out-of-the-box (ver `DEFAULT_BZIMAGE_URL` en
`V86Console.tsx`). Es una **dependencia externa** (~10 MB por sesión, sin
snapshot → boot más lento), aceptable como default pero no ideal para producción.

**Producción (recomendado)**: overridear con las env vars de abajo apuntando a
una imagen (idealmente un `VITE_V86_STATE_URL` = snapshot) hosteada en el
**Storage propio** del proyecto → boot en ~1-2s y sin depender de un host
externo. Si se define cualquier fuente en env, el default queda ignorado.

### Env vars (`.env` — todas `VITE_`, opcionales según el modo de boot)

| Var | Para qué |
|---|---|
| `VITE_V86_STATE_URL` | **Recomendado.** Snapshot (`initial_state`) → boot al prompt en ~1-2s. |
| `VITE_V86_BZIMAGE_URL` | Kernel `bzimage` (boot alterno; se le agrega `console=ttyS0`). |
| `VITE_V86_INITRD_URL` | initrd para el boot por kernel. |
| `VITE_V86_IMAGE_URL` | Imagen ISO (se monta como `cdrom`). |
| `VITE_V86_HDA_URL` | Disco raw (se monta como `hda`). |
| `VITE_V86_FS_JSON_URL` + `VITE_V86_FS_BASEURL` | Filesystem 9p (`filesystem.basefs` + `baseurl`). |
| `VITE_V86_CMDLINE` | Override del kernel cmdline. |
| `VITE_V86_MEMORY_MB` | RAM del VM (default `128`). |

Se necesita **al menos una** fuente de imagen (`STATE`, `BZIMAGE`, `IMAGE` o `HDA`).

### De dónde sacar una imagen

1. **Rápido para probar**: las imágenes públicas de v86 (`copy.sh/v86/images/`)
   — p.ej. la de buildroot bzimage bootea a una shell serial en segundos. Sirven
   para validar el flujo, pero **no** para producción (dependencia externa, CORS
   no garantizado).
2. **Producción (recomendado)**: construir/descargar una imagen (Alpine o
   buildroot con serial habilitada, ver
   [Alpine serial console](https://wiki.alpinelinux.org/wiki/Enable_Serial_Console_on_Boot))
   y **subirla a un bucket público de Supabase Storage** (mismo proyecto).
   Para el boot rápido, arrancarla una vez, `save_state()` y subir el snapshot
   como `VITE_V86_STATE_URL`.

> La imagen debe tener la **consola serial en `ttyS0`** (autologin ideal para un
> examen). Para boots por `bzimage` el cmdline ya incluye `console=ttyS0`.

## Calificación → IA con el transcript como insumo

Un VM real **no se puede auto-calificar por estado** (no se introspecciona como
el simulador determinista). En su lugar, la sesión de consola alimenta el prompt
de la IA. La rama `so_consola`:

- Guarda el **transcript** de la sesión en `answer_text` (JSON `{v86,transcript,commands}`).
- En la calificación (submit del taller sync/async + re-grade del docente vía
  `buildWorkshopItems`) se manda al edge `ai-grade-submission` como un batch item:
  `userAnswer` = los comandos tecleados, `executionOutput` = el transcript de la
  terminal. El prompt incluye una sección **"SALIDA DE EJECUCIÓN / SESIÓN DE
  CONSOLA"** + una directiva `so_consola` que le dice a la IA que evalúe la tarea
  según lo que MUESTRA el transcript.
- El docente siempre puede ajustar con su override.

Invariante cross-file del campo: `GradeBatchItem.executionOutput`
([grade-submission.ts](../src/modules/ai/grade-submission.ts)) ↔ `BatchItem.executionOutput`
del edge ([ai-grade-submission](../supabase/functions/ai-grade-submission/index.ts)) ↔
`batchItems` en [WorkshopQuestions.tsx](../src/modules/workshops/WorkshopQuestions.tsx).

El motor del simulador viejo (`shell.ts`, `system.ts`, `scenario.ts`,
`grading.ts` + `server-console.test.ts`) **queda en el repo** (tests verdes) por
si se quiere una futura calificación por *probe-and-parse* (correr comandos de
verificación dentro del VM y parsear su salida) — hoy no se usa.

## CSP (si algún día se agrega a nivel host)

Hoy **no hay CSP** en el repo (Lovable no la inyecta). Si se agrega una CSP a
nivel host, v86 necesita:

- `script-src` con `'wasm-unsafe-eval'` (o `'unsafe-eval'` en navegadores viejos).
- `connect-src` permitiendo el host de la imagen (Supabase Storage) + jsDelivr.
- `worker-src blob:` (v86 usa workers/blobs).

`SharedArrayBuffer` (v86 va más rápido con él) exigiría COOP+COEP, lo que podría
romper la carga cross-origin de CheerpJ — **no** habilitar sin verificar. v86
funciona sin SAB.

## Cómo probar (requiere navegador — no se puede headless)

1. Definí `VITE_V86_IMAGE_URL` (o `_STATE_URL`) en `.env` con una imagen booteable.
2. `bun run dev`, entrá a un taller con una pregunta `so_consola`.
3. Debe aparecer "Iniciando Linux…" y luego un prompt real; probá `python3`,
   `apt`, `ls`, etc.
