# Pruebas de UI en el navegador (`e2e/`)

Pruebas de **diseño y uso** —no de lógica de negocio— sobre la app real, en escritorio, tableta y
teléfono. Detectan lo que solo aparece con la pantalla ya dibujada: una tabla que empuja la página
de costado, un botón tapado por el botón flotante, un área de toque chica, un foco de teclado que
no se ve. Complementan a `scripts/audit-ui.mjs`, que revisa el código fuente.

## Cómo corren

- Sobre el **build de producción** servido en local (`servidor-estatico.mjs`, con el mismo
  comportamiento de SPA que Cloudflare), contra el **backend real**, con la cuenta multi-rol de la
  institución de demostración (Demo Global Corp). Una sola sesión por corrida, con el rol de cada
  pantalla inyectado.
- **Nada escribe.** Las escrituras a la base, a Storage y a las funciones del servidor se
  interceptan (`soporte/red.ts`). De las RPC —todas van por POST, así que el método no dice si
  leen— sale solo una lista blanca de lecturas verificadas contra su SQL (`RPC_QUE_LEEN`); el resto
  se bloquea. Si una pantalla llama una RPC que no está en la lista, la prueba lo anota como «rpc sin
  clasificar»: si solo lee, se agrega. Lo bloqueado y lo que pasó queda en el `red.json` de cada
  prueba.
- **No se mide una pantalla a medio cargar**: antes de revisar se espera a que esté dibujado el
  título y no queden indicadores de carga. Si la app no llega a dibujar su estructura, la prueba
  falla diciéndolo (con los errores de la página en `consola.json`) en vez de registrar hallazgos de
  una página vacía; si una espera se vence, queda anotada como «espera vencida».
- En el CI **no se graban trazas**: guardan los encabezados de cada petición, y los artefactos de
  un repo público los puede bajar cualquiera. Sí quedan la captura y el video del fallo.

## Las capas

| Proyecto | Qué revisa |
|---|---|
| `anchos` | 14 anchos de 320 a 1920 px, con los dos lados de cada corte de Tailwind (639/640, 767/768, 1023/1024, 1279/1280): sin desplazamiento horizontal, nada interactivo fuera de la pantalla, ningún texto saliéndose de su caja, nada tapado, y el menú correcto (lateral desde 768, botón de menú por debajo). |
| `escritorio-chrome` (1280) · `escritorio-safari` (1440) | Áreas de clic (bloquea bajo 24×24 salvo que tenga espacio libre alrededor —la excepción de WCAG 2.5.8—, avisa bajo 32), superposiciones arriba y al final de la página, señal al pasar el mouse (aviso), recorrido con Tab (cada parada visible y con marca de foco) y el primer menú desplegable con teclado. |
| `ipad` · `iphone-se` (320) · `iphone` · `android` | Áreas de toque de 44×44, letra (bloquea bajo 10 px; avisa si más de la mitad del texto queda bajo 12 px), superposiciones, botón de menú del teléfono, el primer menú desplegable tocándolo y una aproximación del teclado virtual (aviso). |

Las pantallas están en `soporte/pantallas.ts`: públicas, Estudiante, Docente y Admin.

## El trinquete (`linea-base.json`)

Lo que ya existía al instalar las pruebas está registrado en `linea-base.json` y **no** frena el
despliegue; un problema **nuevo** sí. La clave es capa + pantalla + regla + firma del componente
(etiqueta, rol, clases y zona de la página, nunca el texto, que sale de los datos). Los **avisos**
nunca bloquean: quedan anotados en el reporte.

Si un cambio introduce un problema que se acepta a propósito, se registra con:

```bash
bun run e2e:linea-base                       # todas las pantallas
bun run e2e:linea-base -- --project=anchos   # solo una capa
```

(`bun run e2e:linea-base` corre lo mismo en la máquina, pero la línea base que se commitea sale de
Linux: ver abajo.) No lances dos corridas a la vez sobre el mismo checkout: comparten
`test-results/`.

Registrar una parte reemplaza solo lo que corrió —cada pantalla en cada perfil—; lo de los demás
perfiles queda como estaba. Si alguna prueba falla por otra causa, el archivo no se toca. Al
arreglar algo conocido, su entrada se puede borrar del archivo (o regenerarlo).

**La línea base se genera en Linux**, igual que el CI: Windows dibuja las fuentes distinto y daría
diferencias falsas. Con Docker:

```bash
bun run build:cf
docker run --rm --ipc=host -e CI=1 -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.60.0-noble \
  node e2e/registrar-linea-base.mjs
```

## Correr en local

1. `bun run build:cf` (las pruebas sirven `dist/client`).
2. `bunx playwright install chromium webkit` (una vez).
3. `.env.e2e` en la raíz (ignorado por git) con la cuenta de prueba:
   ```
   E2E_EMAIL=...
   E2E_PASSWORD=...
   ```
   La URL y la clave pública de Supabase salen del `.env` de siempre.
4. `bun run e2e` (o `bun run e2e -- --project=iphone-se`). El reporte queda en
   `playwright-report/` (`bunx playwright show-report`).

## En el CI

El job `ui-rapida` de `deploy-cloudflare.yml` corre estas pruebas antes de publicar, en tres grupos
paralelos (Chromium · Safari e iPad · iPhone) sobre Ubuntu 24.04, la misma base de la imagen con
que se genera la línea base. Si encuentran un problema nuevo, **el despliegue no sale**, y cada grupo
que falla deja su reporte (`reporte-ui-<grupo>`). La cuenta llega por los secretos `E2E_EMAIL` y
`E2E_PASSWORD`. Para publicar con las pruebas rotas (por ejemplo, Supabase caído), se lanza el
workflow a mano con «Saltar las pruebas de UI».

## Lo que NO cubren

- **Teclado virtual de iOS, barra de direcciones y zonas seguras**: la emulación no los reproduce.
  La prueba del teclado es una aproximación (achica la ventana como Android) y por eso solo avisa.
- **Datos que cambian**: el backend es el real. Si alguien graba una demo con un título larguísimo y
  rompe una tabla, la prueba lo marca: es un problema real, no un falso positivo.
- Accesibilidad con axe y comparación visual de capturas: son las fases 3 y 2.
