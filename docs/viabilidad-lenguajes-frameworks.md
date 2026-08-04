# Viabilidad: más lenguajes y frameworks (tipo CodeSandbox)

> Análisis pedido el 2026-08-03. Mide contra lo que la plataforma **ya tiene**, no contra cero.

## Resumen

Son **dos pedidos distintos** con costos que se diferencian en un orden de magnitud, y conviene no
tratarlos juntos:

| Pedido | Estado | Costo |
|---|---|---|
| **Más lenguajes** (Go, Rust, C, C++, C#, PHP, Ruby, TS, Haskell, F#) | **Ya está construido.** La UI expone 4 de 14 a propósito | Horas. Es destrabar una lista |
| **Frameworks con preview** (React, Vue, Node…) | No existe, y la infraestructura actual **no puede** darlo | Semanas, y obliga a elegir infraestructura nueva |

La conclusión incómoda del análisis es que **"tipo CodeSandbox" y "más lenguajes" no se resuelven con
lo mismo**: el runner actual es un ejecutor por lotes (entra código, sale texto) y CodeSandbox es un
servidor de desarrollo vivo. Ningún ajuste al runner lo convierte en el otro.

---

## Punto de partida: lo que ya está construido

Esto es lo que más cambia el análisis, así que va primero.

[`language-support.ts`](../src/modules/code/language-support.ts) ya mapea **14 lenguajes** contra 4
compiladores, con sus identificadores verificados: Java, Kotlin, Python, JavaScript, TypeScript, C,
C++, C#, F#, Go, Rust, PHP, Ruby y Haskell. Existe una **VM propia con Judge0** detrás del proveedor
`aws_lambda`, ruteo con fallback automático (`resolveProviderFor`), y un verificador de ids
([`scripts/judge0-verify-languages.mjs`](../scripts/judge0-verify-languages.mjs)).

Y la UI ofrece **4**:

```ts
export const UI_EXECUTABLE_LANGUAGES: readonly CodeLanguage[] = ["java", "kotlin", "python", "javascript"];
```

El propio archivo dice que el recorte es deliberado: *"el mapeo documenta todo lo que el motor puede
correr, pero exponer 14 lenguajes en el editor del alumno es una decisión de producto aparte"*.

O sea: **la pregunta técnica de "más lenguajes" ya está contestada.** Lo que queda es una decisión de
producto y tres condiciones reales que van abajo.

Además ya existe, y suele olvidarse al pensar en frameworks:

- **Multi-archivo** en el runner (`files[]` + [`combine-files.ts`](../src/modules/code/combine-files.ts)).
- **`stdin`**, así que se pueden evaluar programas interactivos.
- **`codigo_zip`**: el alumno sube un proyecto COMPLETO en ZIP y la IA lo califica leyendo el código
  (descomprime, filtra por extensión, arma el prompt). **Un proyecto de React ya es evaluable hoy** —
  lo que no hay es forma de *correrlo*.
- **GUI de escritorio** (Swing y tkinter) por captura de pantalla en Lambda.
- **Consola Linux real** en el navegador (v86).

---

## Parte 1 — Más lenguajes: viable ya, con tres condiciones

Destrabar los 10 restantes es agregar entradas a `UI_EXECUTABLE_LANGUAGES`, un starter en
[`CodeEditor.tsx`](../src/modules/code/CodeEditor.tsx) (`getStarterCode` + `LANGUAGE_CONFIG`) y
regenerar la réplica Deno. **No hace falta migración**: ninguna columna `language` tiene CHECK que
restrinja valores (el único CHECK de `language` en el esquema es el de `courses`, que es el idioma
es/en, no un lenguaje de programación). Los 6 selectores de la UI ya derivan del módulo, así que se
actualizan solos.

Las tres condiciones, en orden de importancia:

### 1. Solo 3 lenguajes corren en infraestructura propia — los otros 11 cuestan plata por corrida

`AWS_LAMBDA_LANGUAGES` tiene **Java, Python y Kotlin**. Todo lo demás se rutea a **JDoodle** o
**OnlineCompiler.io**, que son terceros con cuota. El comentario del código es explícito en que la
lista se declara a mano y no se deriva de Judge0 justamente para no mandar a la VM algo que no tiene
instalado.

Entonces "habilitar 14 lenguajes" hoy significa **mover el costo a terceros y depender de su cuota en
medio de un examen**. La secuencia correcta es al revés:

1. Correr el verificador contra la VM: `node scripts/judge0-verify-languages.mjs`.
2. Cada lenguaje que la VM confirme → agregarlo a `AWS_LAMBDA_LANGUAGES` (costo marginal cero).
3. Recién entonces exponerlo en la UI.

Judge0 CE trae GCC, Go, Rust, C#, PHP, Ruby y Haskell en su imagen estándar, así que lo esperable es
que **la mayoría ya esté en la VM** y el paso 2 sea casi gratis. Pero hay que verificarlo, no
asumirlo: un id equivocado **no falla al arrancar, ejecuta otro lenguaje** — un fallo mudo que el
propio módulo advierte.

### 2. Los compilados multi-archivo están a medias

[`combine-files.ts`](../src/modules/code/combine-files.ts) tiene lógica real solo para **Java**
(pone la clase con `main` primero, degrada `public`, quita `package`). Todo lo demás cae en
"lenguajes script: concatenación con encabezado por archivo".

Para C, C++, Go, Rust y C# eso **no compila** cuando el ejercicio tiene varios archivos de verdad:
concatenar dos `.c` duplica símbolos, y un `#include "propio.h"` no existe porque el header nunca se
escribió al disco. Un solo archivo funciona bien.

Es acotable: **exponer estos lenguajes en modo un-archivo** (que cubre la mayoría de los ejercicios de
un curso introductorio) y dejar el multi-archivo real como trabajo aparte. La alternativa limpia es
dejar de pre-concatenar y mandar los `files[]` tal cual a Judge0, que soporta proyectos multi-archivo
(`additional_files`) — **confirmar contra la versión que corre la VM** antes de diseñar sobre eso.

### 3. Haskell no tiene resaltado de sintaxis

`MONACO_LANGUAGE.haskell` es `"plaintext"` porque Monaco no trae la gramática. Ofrecer Haskell sin
colores en un editor es una experiencia visiblemente peor. Es cosmético y se resuelve con
`monaco.languages.register` + una gramática, o se acepta, o se deja Haskell afuera.

**Veredicto parte 1: SÍ, viable, y es lo más barato que se puede hacer.** El orden es verificar la VM
→ ampliar `AWS_LAMBDA_LANGUAGES` → exponer en UI. Sugerido para el primer lote: **C, C++, Go, Rust,
C#, TypeScript** (los que un plan de estudios pide de verdad), dejando PHP/Ruby/F#/Haskell para
cuando haya demanda.

---

## Parte 2 — Frameworks: por qué la infraestructura actual no puede

Vale la pena ser preciso sobre qué es CodeSandbox, porque de eso sale todo lo demás. No es "más
lenguajes": es **instalar dependencias de npm, empaquetar, levantar un servidor de desarrollo y
mostrar el resultado en vivo con recarga en caliente**. Cuatro capacidades que el runner actual no
tiene y no puede tener:

| Necesita | Runner actual (Judge0) |
|---|---|
| `npm install` | **Sin red** en el sandbox, a propósito (es la garantía de seguridad) |
| Proceso que queda vivo | Ejecuta y **muere**; devuelve stdout/stderr y termina |
| Servir HTTP a un iframe | No expone puertos |
| Segundos-minutos de trabajo | Tope de **~29 s** (API Gateway) y 18 s de compilación |

Y la consola v86 tampoco es la respuesta, aunque parezca: es Linux real, pero **sin red** y con
**128 MB de RAM** emulando un x86 de 32 bits. Un `npm install` ahí no es lento, es imposible.

Así que frameworks obliga a **infraestructura nueva**. Evalué cuatro caminos.

### Opción A — WebContainers de StackBlitz: **descartada**

Corre Node.js entero en el navegador vía WASM. Es la tecnología correcta y la experiencia es
excelente, pero exige **aislamiento cross-origin** (headers `COOP`/`COEP` para habilitar
`SharedArrayBuffer`).

Dos problemas, y el segundo es el que decide:

1. **No hay dónde poner los headers.** El repo no tiene `netlify.toml`, `vercel.json` ni `_headers` —
   el hosting es Lovable y los headers no se controlan desde el código.
2. **Aunque se pudieran poner, romperían media app.** El aislamiento cross-origin bloquea todo
   recurso de otro origen que no manda `CORP`. Y hoy hay cuatro orígenes de terceros en el camino
   crítico, verificados en el código: **CheerpJ** (`cjrtnc.leaningtech.com/4.3/loader.js` — Java en el
   navegador), **v86** y **xterm** (`cdn.jsdelivr.net` — la consola Linux), y los **embeds de
   YouTube/Vimeo** ([`video-embed.ts`](../src/shared/lib/video-embed.ts)) que usan la biblioteca de
   videos y las sesiones. Se cambiaría "no tenemos React en vivo" por "se rompió el módulo de videos y
   el de Java gráfico".

Sumado a que el uso comercial de la API de WebContainer requiere licencia (**a verificar**), no es el
camino.

### Opción B — Sandpack (el componente open source de CodeSandbox): **viable, con reservas**

Es literalmente el motor de CodeSandbox publicado como componente de React, con plantillas para
React, Vue, Svelte, Angular, Node y vanilla. No necesita COOP/COEP.

A favor: es la opción que más se parece a lo pedido, y con menos código propio.

En contra, tres cosas que hay que decidir a conciencia:

- **El empaquetado ocurre en un servidor de CodeSandbox** (por defecto). O sea: **el código del
  alumno sale de nuestra infraestructura** hacia un tercero. Para una institución educativa eso es
  una conversación de privacidad, no un detalle técnico. Se puede auto-hospedar el bundler, y ahí
  vuelve el costo de infraestructura.
- **Dependencia npm nueva y grande**, y `bun.lock` tiene que regenerarse y commitearse (el CI valida
  sincronía). No es gratis en peso del bundle.
- **Licencia a verificar** antes de adoptarla.

### Opción C — Preview web sin dependencias: **la mejor relación costo/beneficio**

Un `<iframe sandbox srcdoc={...}>` con el HTML/CSS/JS del alumno. Cero dependencias nuevas, cero
infraestructura, y **el patrón ya existe en el repo** ([`report-download.ts`](../src/modules/reports/report-download.ts)
usa `iframe.srcdoc` para los informes).

Cubre **HTML + CSS + JavaScript del DOM**, que es donde arranca cualquier curso de web y hoy la
plataforma no tiene nada. Y con `<script type="importmap">` apuntando a un CDN de ESM, más Babel
en el iframe para JSX, **corre React y Vue sin bundler** — al costo de que el alumno necesita red.

Lo que NO da: `npm install` de paquetes arbitrarios, backend en Node, herramientas de build reales.
Es un playground de frontend, no un CodeSandbox.

Encaja bien con lo que ya hay: el multi-archivo del runner, `CodeFileRunnerDialog`, las hojas de
código de la pizarra y los snippets de sesión ya tienen la forma correcta para colgarle un preview.

### Opción D — Runner propio en contenedor: **el camino honesto, y el más caro**

Un servicio que hace `npm install`, `build` y sirve el resultado. Es lo único que evalúa de verdad un
proyecto con framework. Es también un servicio nuevo con red, cuotas, imágenes cacheadas, límites de
recursos y una superficie de seguridad que hoy no existe.

Antes de pagarlo hay que responder una pregunta de producto: **¿hace falta EJECUTAR el proyecto para
calificarlo?** Porque `codigo_zip` + calificación con IA ya lee el código completo y lo evalúa. Si la
respuesta es "quiero que el alumno practique con feedback inmediato", la opción C alcanza para
frontend. Si es "quiero que el pipeline de build sea parte de la nota", entonces sí, hace falta D.

---

## Recomendación

**Fase 1 — Lenguajes (esta semana, riesgo bajo).**
Verificar la VM, ampliar `AWS_LAMBDA_LANGUAGES` con lo confirmado, exponer C, C++, Go, Rust, C# y
TypeScript en modo un-archivo. Es la única parte que da valor inmediato sin decisiones nuevas.

**Fase 2 — Preview web sin dependencias (opción C).**
Un tipo de pregunta `web` con `srcdoc` + `sandbox`. Abre los cursos de frontend, no toca
infraestructura, no manda código a terceros.

**Fase 3 — Recién ahí decidir Sandpack o runner propio**, con la fase 2 en producción y datos reales
de cuánto se usa.

### Dos restricciones de diseño que valen para las fases 2 y 3

**El preview no puede estar en un examen con proctoring.** Un iframe que carga desde un CDN es un
canal de red abierto: el alumno pide lo que quiera. El preview vive en talleres, práctica y snippets
de sesión; en examen, el runner actual (sin red) sigue siendo el correcto. Esto no es un obstáculo, es
dónde poner el límite.

**La IA tiene que saber calificar lo nuevo.** El grader tiene directivas por tipo (`codigo`,
`java_gui`, `python_gui`, `so_consola`). Un tipo `web` sin su directiva se califica con el prompt
genérico y da notas pobres. Y ojo: en frontend lo que importa es el resultado renderizado, que un
modelo de texto no ve — habría que mandarle una captura, como ya se hace con las GUI de escritorio.

## Pendiente de verificar (no lo pude hacer desde acá)

- **Qué lenguajes tiene realmente la VM de Judge0** — es el dato que decide el costo de la fase 1.
  Corre `node scripts/judge0-verify-languages.mjs`; necesita `JUDGE0_URL`.
- **Licencia exacta** de Sandpack y de la API de WebContainer, si se consideran.
- **Si Lovable permite headers HTTP propios.** No cambia la recomendación (COOP/COEP rompería los
  embeds de todos modos), pero conviene saberlo.
