# Convertir ExamLab en una app de Android (TWA)

Revisión transversal pedida el 2026-09-25, a raíz de que la insignia con el
número de avisos sin leer **no se puede lograr desde la web en Android**: Chrome
para Android no implementa la Badging API, y el número que muestra el lanzador
sale de cuántas notificaciones hay sin descartar. Sobrescribirlo con un número
propio (`setNumber()`) es exclusivo de una app nativa.

Una TWA (*Trusted Web Activity*) es una app de Android que abre el mismo sitio a
pantalla completa, sin barra de navegador, verificada como propia mediante
Digital Asset Links. No es un WebView ni una reescritura: **es el mismo código
que ya está en producción**, dentro de un envoltorio nativo.

---

## 1. Lo que se gana

| | Hoy (PWA) | Con TWA |
|---|---|---|
| Insignia numérica en el ícono | no en Android | **sí**, vía delegación de notificaciones |
| Instalación | «Agregar a pantalla de inicio», escondido | Play Store, buscable |
| Confianza para el estudiante | «es una página web» | aparece como app |
| Actualizaciones | inmediatas, sin tienda | inmediatas (el contenido es web) |

**La insignia es el motivo por el que esto está sobre la mesa, y conviene ser
preciso sobre cómo se consigue**: la TWA sola no la da. Hace falta *delegación de
notificaciones* — el envoltorio Android recibe el push y publica la notificación
con código nativo, y ahí sí puede llamar `setNumber(n)`. Está soportado
oficialmente (`android-browser-helper`, demo `twa-notification-delegation`), pero
es **código Android, no configuración**. Es la parte más cara de todo el plan y
es justamente la que entrega lo que se busca.

## 2. Lo que cuesta en dinero

| Concepto | Costo | Nota |
|---|---|---|
| Cuenta de desarrollador de Play | **US$25, una sola vez** | verificado en la documentación de Google |
| Dominio propio | ~US$10–20 / año | ver §3, es lo que lo destraba |
| Cloudflare Workers Paid | US$5 / mes | **ya hacía falta igual**: el plan Free corta en 100.000 peticiones/día por cuenta y cada institución es un origen distinto |

En plata es casi nada. **El costo real es de ingeniería y de calendario.**

## 3. El obstáculo estructural: siete orígenes

Hoy cada institución vive en su propio origen (`uniaj.examlab.workers.dev`,
`fesna.…`, y cinco más) porque `subdomain.ts` resuelve la institución **desde el
hostname**. Una TWA se verifica contra **un origen**: navegar fuera de él sale de
la app y abre una pestaña del navegador.

Eso deja dos caminos, y conviene elegirlo antes de escribir una línea:

**A. Siete apps.** Una por institución, cada una apuntando a su subdominio. Cada
una necesita su ficha en Play, sus capturas, su revisión y su mantenimiento.
Siete veces el trabajo de publicación, para siempre. No lo recomiendo.

**B. Una app, un origen, institución elegida adentro.** La app apunta a
`app.examlab.<dominio>` y la institución se resuelve después del login. **Esto ya
existe en el código**: `examlab_tenant_override` en `localStorage` y
`readTenantOverride()` hacen exactamente eso para el SuperAdmin. Los subdominios
seguirían funcionando en la web; la app usaría el camino de override.

El dominio propio no es un capricho de imagen: `wrangler.jsonc` ya tiene
preparada la configuración de subdominios «para cuando exista el dominio», y sin
él la app quedaría atada a `workers.dev`, que es una dirección que no controlamos
y que no se puede mover.

## 4. Lo que hay que re-probar, no asumir

- **Proctoring.** `blur`, `visibilitychange` y `fullscreenchange` son la base de
  las advertencias del examen. En una TWA no hay barra de navegador y la app ya
  ocupa la pantalla: hay que medir **en un teléfono** qué eventos siguen
  llegando y si `MAX_WARNINGS` empieza a dispararse por gestos normales del
  sistema. Un falso positivo acá le cuesta el parcial a un estudiante.
- **La consola Linux (v86) y CheerpJ.** Se descargan de CDN y pesan decenas de
  MB. Dentro de la TWA es el mismo Chrome, así que deberían funcionar igual,
  pero hay que verificarlo con datos móviles.
- **La política «Minimum Functionality» de Play.** Google rechaza apps que son
  «solo un sitio web envuelto». Las TWA son un formato que Google mismo promueve,
  y ExamLab es una aplicación real, no un folleto — pero **esto hay que
  confirmarlo antes de invertir**, no después del rechazo.

## 5. El calendario, que es el costo escondido

Una cuenta personal creada después del 13-nov-2023 necesita, antes de poder
publicar en producción: **12 personas probando la app de forma continua durante
14 días**. No es negociable ni se acelera con dinero.

Con 158 estudiantes activos conseguir 12 probadores es trivial — pero son **dos
semanas de calendario** que empiezan recién cuando la app ya está construida y
subida. Planificar como si se publicara el mismo día es el error más probable
de este proyecto.

## 6. Plan de trabajo

**Fase 0 — Decidir (antes de escribir código)**
1. Confirmar la política de Play para este caso concreto.
2. Elegir camino A o B del §3. Recomendado: **B**.
3. Comprar el dominio y apuntar Cloudflare.

**Fase 1 — La app mínima (≈2 días)**
4. Generar el envoltorio con Bubblewrap desde el manifiesto que ya existe.
5. Publicar `/.well-known/assetlinks.json` en el origen (es un archivo estático
   más; `not_found_handling: single-page-application` no lo tapa porque existe
   en disco). Verificar que la barra del navegador **desaparece** — si sigue
   visible, la verificación falló y la app es una pestaña con otro ícono.

**Fase 2 — La insignia, que es el objetivo (≈3 días)**
6. Delegación de notificaciones en el envoltorio.
7. Publicar la notificación con `setNumber(sinLeer)`. **El dato ya viaja**: el
   edge `send-push` manda `unread` en el payload desde el 2026-09-24.
8. Limpiar el número al abrir la app.

**Fase 3 — Verificación en teléfono real (≈2 días)**
9. Rendir un examen completo y revisar el conteo de advertencias.
10. Probar la consola Linux y el compilador con datos móviles.

**Fase 4 — Publicación (≈2 días de trabajo + 14 de espera)**
11. Ficha de Play: capturas, descripción, política de privacidad y formulario de
    seguridad de datos (declara que se recogen correo, nombre y uso — hay que
    responderlo con cuidado, es la parte que más rechazos genera).
12. Firmar el AAB desde CI y reusar la huella SHA-256 en `assetlinks.json`.
13. Prueba cerrada con 12 estudiantes, 14 días corridos.
14. Producción.

**Total: unos 9 días de trabajo, repartidos en 4–5 semanas de calendario.**

## 7. La alternativa honesta

Si lo único que se busca es la insignia, hay un camino de **medio día**: que la
notificación diga el número en su texto («Tenés 6 avisos sin leer»). No aparece
en el ícono, pero se lee al llegar y funciona en todos los teléfonos, sin tienda,
sin dominio y sin espera.

La TWA se justifica si además se quiere presencia en Play y que la plataforma
deje de parecer una página web. Si eso no está en los planes, es mucho trabajo
para un número.
