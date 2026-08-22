# Un subdominio por institución con Cloudflare (plan Free)

Objetivo: que cada institución tenga su propia dirección —`uniaj.tudominio.co`,
`fesna.tudominio.co`— y que al entrar **no haya que elegir la institución en un
selector**. El enlace ya dice a cuál se entra.

> **Se puede hacer a costo cero**, con todo administrado en Cloudflare: DNS, Workers,
> Universal SSL y el proxy son plan **Free**. Lo único que Cloudflare NO da gratis es
> el dominio en sí — su Registrar vende **a precio de costo**, sin recargo, pero no
> regala nombres. La sección [Conseguir el dominio](#0--conseguir-el-dominio) resuelve
> justamente eso.

---

## Por qué Cloudflare y no otra cosa (verificado en su documentación)

| Lo que hace falta | Resultado |
|---|---|
| Wildcard en **Cloudflare Pages** | ❌ Su doc solo contempla apex y subdominios exactos |
| **Custom Domains** de Workers | ❌ *"Custom Domains do not support wildcard DNS records. An incoming request must exactly match the domain or subdomain"* |
| **Routes** de Workers | ✅ Admiten patrones — es la vía correcta |
| **Universal SSL** gratis | ✅ Cubre el dominio raíz **y los subdominios de primer nivel**, en plan Free |

De ahí sale la receta: **un Worker con un Route wildcard**, no un Custom Domain, y no
Pages.

**Límite real, para no llevarse una sorpresa:** Universal SSL cubre **un solo nivel**.
`uniaj.tudominio.co` ✅ · `sede.uniaj.tudominio.co` ❌ (eso necesitaría Total TLS o un
certificado avanzado, que sí son de pago).

---

## Antes de empezar

- Un dominio propio — si no tenés, el paso 0 lo consigue **gratis**.
- La app compilada: `bun run build:cf` deja el sitio estático en `dist/client/`.
- **No hace falta apagar Lovable.** Los dos servidores pueden convivir porque la base
  de datos es la misma: Lovable sigue sirviendo `examlab.lovable.app` con el selector,
  y Cloudflare sirve los subdominios sin selector. Se puede migrar de a poco.

---

## 0 · Conseguir el dominio

**Cloudflare no regala dominios.** Verificado en su propia documentación: su Registrar
vende *"at cost… you only pay what is charged by registries and ICANN"* — sin recargo,
pero con precio. Y **tampoco sirve `workers.dev`** para esto: su hostname es
exactamente `<worker>.<cuenta>.workers.dev` y no admite comodines ni un nivel más, así
que no hay forma de meter ahí un `uniaj.`.

Entonces hay dos caminos. Los dos terminan con **todo administrado en Cloudflare**;
solo cambia de dónde sale el nombre.

### Camino A — gratis, con un dominio `.eu.org`

[eu.org](https://nic.eu.org/) registra subdominios **gratis**: *"provide free subdomain
registration to users or non-profit organizations who cannot afford the fees demanded by
some NICs"*. Pedís `tuinstituto.eu.org` y lo delegás a los nameservers de Cloudflare —
desde ahí el manual sigue igual, paso por paso.

**Por qué funciona en plan Free y no exige plan de pago:** Cloudflare decide qué es un
"dominio raíz" con la Public Suffix List, y **`eu.org` está en esa lista** (verificado en
el archivo oficial: `eu.org` aparece como entrada propia, junto a `al.eu.org`,
`asso.eu.org`, …). Es decir: `tuinstituto.eu.org` cuenta como **apex de zona**, no como
zona-subdominio — las zonas-subdominio sí requieren plan de pago. Y como es apex,
`uniaj.tuinstituto.eu.org` es un **subdominio de primer nivel**, justo lo que cubre
Universal SSL gratis.

**El costo real de esta vía no es dinero, es tiempo y respaldo:**

- La aprobación es **manual y lenta** (se resuelve por correo, puede tardar días o
  semanas). No hay pago que la acelere.
- Su sitio dice textualmente **"No support is provided"**. Si algo se rompe, no hay
  mesa de ayuda: solo una lista de correo comunitaria.
- El nombre queda como `uniaj.tuinstituto.eu.org`. Para uso interno o piloto está
  bien; para presentarlo a una institución, se ve menos formal que un dominio propio.
- **Un detalle a confirmar en el tablero, no antes:** que el certificado Universal
  liste `*.tuinstituto.eu.org`. La documentación de Cloudflare describe la cobertura
  para zonas normales, pero **no dice nada explícito sobre zonas que son subdominio de
  un sufijo público**. Por el razonamiento de arriba debería quedar cubierto; se ve en
  un minuto en **SSL/TLS → Edge Certificates** (paso 3) y ahí se sabe con certeza.

> Aviso para no perder tiempo: **Freenom** —el clásico de los `.tk` gratis— dejó de
> registrar dominios. No es una opción vigente.

### Camino B — a precio de costo, con Cloudflare Registrar

Si querés el nombre andando hoy y que se vea formal, comprá el dominio en
**Cloudflare Registrar** (mismo panel, sin intermediarios): pagás lo que cobra el
registro, sin recargo. Salta el paso 1 —el dominio ya nace en Cloudflare— y seguí
desde el paso 2.

Suele ser el orden de ~10 USD/año según la extensión. **No lo tomes de acá como
cotización**: los precios los fija cada registro y cambian; se ven en el buscador del
propio panel al momento de comprar.

### Cuál elegir

| | Camino A (`.eu.org`) | Camino B (Registrar) |
|---|---|---|
| Costo | **0** | Precio de costo del registro |
| Disponible | Días/semanas (aprobación manual) | Inmediato |
| Respaldo | Ninguno, declarado | Soporte de Cloudflare |
| Nombre | `uniaj.tuinstituto.eu.org` | `uniaj.tuinstituto.co` |

Para probar la idea sin gastar, **A**. Si esto va a quedar frente a instituciones, **B**
ahorra fricción por poco dinero. Los pasos siguientes son idénticos en ambos.

---

## 1 · Meter el dominio en Cloudflare

> **Camino B (Registrar) se saltea este paso**: el dominio ya nace dentro de Cloudflare
> con sus nameservers puestos. Seguí desde el paso 2.

1. Entrá a [dash.cloudflare.com](https://dash.cloudflare.com) y creá la cuenta.
2. **Add a site** → escribí tu dominio → elegí el plan **Free**.
3. Cloudflare escanea tus registros DNS actuales y te da **dos nameservers**
   (`algo.ns.cloudflare.com`).
4. **Delegá el dominio a esos dos nameservers.**
   - *Camino A (`.eu.org`)*: se hace desde el panel de eu.org, en los datos del
     dominio. Es el mismo trámite de delegación, solo que el "registrador" es eu.org.
   - *Dominio comprado en otro registrador*: en su panel, reemplazá los nameservers.
5. Esperá la propagación (suele ser menos de una hora; Cloudflare te avisa por correo).
   El sitio queda "Active".

## 2 · El registro DNS wildcard

En **DNS → Records**, creá:

| Type | Name | Target | Proxy |
|---|---|---|---|
| `A` | `*` | `192.0.2.1` | **Proxied** (nube naranja) |

Dos cosas que importan:

- **La nube tiene que estar naranja (Proxied).** Si está gris, el tráfico no pasa por
  Cloudflare, el Worker nunca se ejecuta y el certificado no aplica.
- **La IP es de relleno a propósito.** `192.0.2.1` es una dirección reservada para
  documentación: nunca recibe tráfico. El registro existe solo para que el hostname
  resuelva y el Worker lo intercepte. Es el patrón normal cuando un Worker responde
  por sí mismo.

Agregá también el apex si querés que `tudominio.co` responda:

| Type | Name | Target | Proxy |
|---|---|---|---|
| `A` | `@` | `192.0.2.1` | **Proxied** |

## 3 · Confirmar el certificado

**SSL/TLS → Edge Certificates**. El certificado Universal debe listar
`tudominio.co` **y** `*.tudominio.co`. Si todavía no aparece, esperá unos minutos —
se emite solo.

**Acá se confirma el único supuesto del camino A.** Si tu zona es `tuinstituto.eu.org`,
lo que tiene que aparecer es `*.tuinstituto.eu.org`. Debería estar, porque `eu.org` es
un sufijo público y entonces tu dominio es apex (ver paso 0), pero eso lo deduje del
comportamiento documentado: no lo dice una línea explícita de la documentación. Si el
comodín **no** aparece, el camino A no da los subdominios y hay que pasarse al B — mejor
enterarse en este paso, que toma un minuto, que después de configurar el Worker.

En la misma pantalla, poné **SSL/TLS encryption mode** en **Full**.

## 4 · Publicar la app

> **Esto ya está hecho y funcionando**: está en `main` y lo publica GitHub Actions
> (`deploy-cloudflare.yml`) en cada push. El despliegue general vive en
> <https://app.examlab.workers.dev> y cada institución en `<slug>.examlab.workers.dev`
> (verificado el 2026-08-22: los dos responden 200). Esta sección explica CÓMO quedó y
> por qué; para publicar a mano es `bun run deploy:cf`.

### Se publica como sitio ESTÁTICO, no como Worker con SSR

Este es el punto donde la versión anterior de este manual estaba equivocada: decía
que `bun run build` dejaba un sitio estático en `dist/`. **No lo dejaba.** El
proyecto es TanStack Start con **SSR sobre Workers**, y el build emitía un Worker
que ejecuta React en el servidor.

Ese camino **no entra en el plan Free**, medido el 2026-08-21:

| | Medido | Límite Free | Límite Paid |
|---|---|---|---|
| Tamaño del Worker SSR | **5,34 MB** gzip | 3 MB ❌ | 10 MB ✅ |
| CPU por request | SSR de este árbol de React | 10 ms ⚠️ | 30 s |

El deploy rebota con `error 10027`. Y aunque se lograra bajar el tamaño, quedaría el
segundo techo: 10 ms de CPU casi seguro no alcanzan para renderizar esta app en el
servidor (daría error 1102). **Los dos límites son del SSR.**

Por eso la rama va en **modo SPA**: el servidor deja de ejecutar React, el modo SPA
prerenderiza un cascarón, y ese cascarón se sirve como archivo estático. Sin código
de servidor, ninguno de los dos límites aplica y sigue siendo gratis.

**Es seguro en esta app** porque no tiene lógica de servidor: cero `createServerFn`,
cero rutas de servidor, cero `loader:` en las 84 rutas y un solo `beforeLoad`. Todos
los datos ya viajan del navegador a Supabase, con la RLS haciendo el aislamiento.

### La configuración

En `vite.config.ts`, dos opciones (ambas comentadas en el archivo):

```ts
tanstackStart: { spa: { enabled: true } },   // prerenderiza el cascarón
cloudflare: false,                            // no generes Worker
```

`cloudflare: false` además destraba un choque entre plugins: el prerender de SPA
importa `dist/server/server.js`, pero el plugin de Cloudflare nombra esa entrada
`index.js` y el build moría con `ERR_MODULE_NOT_FOUND`.

En `wrangler.jsonc`, **sin `main`** — eso es lo que lo vuelve un despliegue solo de
assets:

```jsonc
"assets": {
  "directory": "./dist/client",
  "not_found_handling": "single-page-application",
}
```

`single-page-application` es imprescindible: sin eso, entrar directo a
`uniaj.tudominio.co/app/teacher/exams` daría 404, porque en el disco no existe ese
archivo — es una ruta del router de la app.

### Publicar

```bash
bun run deploy:cf     # build + cascarón + wrangler deploy
```

El paso intermedio ([`scripts/build-cloudflare.mjs`](../scripts/build-cloudflare.mjs))
copia `_shell.html` a `index.html`: TanStack Start le pone el primer nombre, y
Cloudflare sirve el segundo —y solo ese— como fallback de SPA.

**Si `.wrangler/deploy/config.json` quedó de un build viejo con el plugin de
Cloudflare**, el deploy falla diciendo que no encuentra `dist/server/wrangler.json`.
Se borra esa carpeta y listo.

### Para los subdominios, agregar el Route

Cuando exista el dominio (pasos 1-3), descomentar en `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "*.tudominio.co/*", "zone_name": "tudominio.co" },
  { "pattern": "tudominio.co/*", "zone_name": "tudominio.co" },
],
```

Tiene que ser `routes` con comodín, **no** un Custom Domain — esos no admiten
wildcards. Y no hay que recompilar la app: se vuelve a publicar y ya.

## 5 · Probar

1. Abrí `uniaj.tudominio.co` → debe cargar la app **sin el selector de institución**,
   ya con la marca de UNIAJ.
2. Abrí `fesna.tudominio.co` → la misma app, con la otra institución.
3. Abrí `tudominio.co` (sin subdominio) → carga **con** el selector, como hoy.
4. `examlab.lovable.app` sigue funcionando igual: la app detecta que es un host de
   plataforma y no lo interpreta como institución.

Si un subdominio muestra el selector en vez de la institución, casi siempre es una de
tres: la nube del DNS está gris, el slug del subdominio no coincide con
`tenants.slug`, o el Route no incluye `/*` al final.

---

## Los slugs ya están listos

No hay que crear ningún campo ni migrar datos: la app usa el `slug` que cada
institución ya tiene.

Las instituciones activas salen del RPC público `list_active_tenants_public()` — el
mismo que llena el selector del login. Consultado el 2026-08-21 devuelve **cuatro**
(una versión anterior de esta tabla listaba `linkvide`, que ya no está activa; si vas
a desplegar por institución, confirmá la lista contra el RPC y no contra este doc):

| Institución | Con dominio propio | Publicado hoy en workers.dev |
|---|---|---|
| Universidad Antonio José Camacho | `uniaj.tudominio.co` | <https://uniaj.examlab.workers.dev> |
| FESNA | `fesna.tudominio.co` | <https://fesna.examlab.workers.dev> |
| ExamLab Demo | `examlab-demo.tudominio.co` | <https://examlab-demo.examlab.workers.dev> |
| Demo Global Corp | `demo-global-corp.tudominio.co` | <https://demo-global-corp.examlab.workers.dev> |
| *(selector, sin institución)* | `tudominio.co` | <https://app.examlab.workers.dev> |

**Y acá está la diferencia que justifica pagar el dominio.** Con dominio propio, al
crear una institución nueva su subdominio **funciona solo**: el DNS comodín y el Route
ya cubren cualquier nombre. En la variante de workers.dev hay que **desplegarle su
Worker a mano** (`wrangler deploy --name <slug>`), o su dirección no existe. Es el
costo estructural del atajo.

## La variante sin dominio: un Worker por institución

Sirve para pilotos y demostraciones: da subdominios por institución hoy y sin costo.
Funciona porque en `<worker>.<cuenta>.workers.dev` la primera etiqueta la elegimos al
desplegar — el subdominio de la cuenta es `examlab` y cada Worker se nombra con el
slug de su institución.

```bash
bun run build:cf                      # una sola vez
wrangler deploy                       # el general → app.examlab.workers.dev
wrangler deploy --name uniaj          # → uniaj.examlab.workers.dev
wrangler deploy --name fesna          # → fesna.examlab.workers.dev
```

Es el MISMO build en todos; solo cambia el nombre del Worker. El despliegue general se
llama `app` a propósito: esa etiqueta está reservada en `subdomain.ts`, así que muestra
el selector en vez de buscar una institución llamada "app".

Un usuario de otra institución **no puede entrar** por el subdominio ajeno: el login
valida que la institución del host coincida con su perfil y rechaza con *"No perteneces
a la institución seleccionada"*. Cada subdominio es además un origen distinto, así que
no hay sesión que se arrastre entre uno y otro. El SuperAdmin sí pasa, a propósito.

---

## Qué hace la app con el subdominio

La lógica vive en [`src/modules/tenants/subdomain.ts`](../src/modules/tenants/subdomain.ts)
(con tests). Lee la primera etiqueta del hostname y la trata como slug de institución,
**salvo** que sea:

- un host de plataforma (`*.lovable.app`, `*.pages.dev`, `*.vercel.app`…) — si no, en
  `examlab.lovable.app` interpretaría `examlab` como institución;
- un dominio desnudo o `www`;
- una etiqueta reservada (`app`, `api`, `admin`, `auth`, `cdn`, `staging`…);
- `localhost` o una IP.

En cualquiera de esos casos devuelve `null` y **el selector se comporta como hoy**. Es
aditivo: nada del flujo actual cambia si no hay subdominio.

**El subdominio es una pista de interfaz, no un control de seguridad.** El aislamiento
entre instituciones lo sigue dando la RLS en la base: escribir el subdominio de otra
institución en la barra de direcciones no da acceso a sus datos.

En desarrollo funciona `uniaj.localhost:5173` — Chrome y Firefox resuelven `*.localhost`
sin tocar el archivo `hosts`.

---

## Por qué no se usó la ruta `/t/<slug>/`

Fue el plan original y **ya se intentó**: no funcionó en Lovable porque el `rewrite` de
TanStack Router queda asimétrico entre servidor y cliente y el SSR emitía redirects 307
(está documentado en el encabezado de `use-tenant.ts` y en `TenantUrlGuard.tsx`). El
subdominio no toca el router ni el SSR: se lee del hostname en tiempo de ejecución.

## Lo que se descartó, y por qué

- **`workers.dev` / `pages.dev` como dominio.** La documentación fija el hostname en
  `<worker>.<cuenta>.workers.dev` y no menciona comodines ni niveles extra; el
  certificado no cubriría un cuarto nivel. No hay dónde poner el `uniaj.`.
- **Cloudflare Pages** en lugar de Workers: su documentación no contempla wildcards.
- **Custom Domains** de Workers: *"do not support wildcard DNS records"*, textual.
- **`Freenom`** (los `.tk` gratis de siempre): dejó de registrar dominios.
- **La ruta `/t/<slug>/`**: ver la sección anterior — ya se intentó y falló en Lovable.

Y si no se quiere ni gastar ni esperar la aprobación de `.eu.org`: **el selector actual
funciona**. Los subdominios son comodidad y presentación, no un requisito para operar.
