# Investigación — Preguntas tipo "Red" (Red GUI tipo Cisco + Red consola)

> Resultado del workflow de investigación `wf_19ed13ad-e20` (6 agentes, 44 opciones evaluadas, 2026-07-06).
> Objetivo: integraciones GRATUITAS/open-source y embebibles para dos tipos nuevos de pregunta de redes.

## Resumen ejecutivo

- **No existe atajo legal** para embeber Packet Tracer, GNS3, CML, EVE-NG ni NetSim: todos chocan con licencia (NetAcad/AGPL/comercial) o exigen infra server pesada incompatible con el modelo Lambda-efímero actual.
- **Ruta recomendada: CONSTRUIR componentes propios livianos** reusando el stack: **React Flow** (`@xyflow/react`, MIT) para la topología, **xterm.js** (MIT) para la consola, y un **intérprete IOS en TypeScript** — todo client-side, más el pipeline de `ai-grade-submission` que ya existe para calificación tolerante.

## Red GUI (topología tipo Cisco)

| Opción | Licencia | Embed | Esfuerzo |
|---|---|---|---|
| **React Flow + modelo propio** ✅ recomendada | MIT | Componente React, client-side | Medio |
| draw.io / diagrams.net (variante "dibuja topología") | Apache-2.0 | iframe + postMessage | Bajo |
| netsim-labs / PackeTTrino (solo referencia) | AGPL+comercial / GPL-3.0 | — | Alto |

Descartar: Packet Tracer (propietario, no embebible), PT Anywhere (abandonado + binario Cisco), netsim-labs (AGPL comercial), GNS3/EVE-NG/Kathará (server-heavy, imágenes IOS no redistribuibles).

## Red consola (terminal IOS/Linux)

| Opción | Licencia | Client vs backend | Esfuerzo |
|---|---|---|---|
| **xterm.js + intérprete IOS propio en TS** ✅ recomendada | MIT + código propio | client-side puro | Medio |
| Networkers Home sim (forkear parser IOS) | auditar LICENSE | client-side | Bajo-medio |
| Lambda + network namespaces / v86 | GPL/BSD | backend privilegiado / WASM pesado | Alto |

- **NO Lambda**: comandos de red reales exigen `CAP_NET_RAW`/`CAP_NET_ADMIN` que Lambda no da. El parser client-side simula ping/traceroute con un BFS determinista → más barato y auto-calificable.
- Descartar por licencia: **CheerpX/WebVM** (comercial para organizaciones, incluida academia).

## Auto-calificación (patrón híbrido barato→caro)

- **Red GUI**: export `toJSON()` (nodos + enlaces + configs) → diff tolerante contra respuesta esperada (por rol, ignora IDs/posiciones). Cada aserción = ítem de rúbrica.
- **Red consola**: (1) estado final de config comparado contra aserciones; (2) secuencia de comandos normalizada; (3) conectividad semántica vía BFS. Fallback a IA-juez (reusar `ai-grade-submission` con un directive "redes" en paralelo a `python_gui`).

## MVP recomendado (orden)

1. **Red consola primero** (~2-4 sem): xterm.js + intérprete IOS en `src/modules/network/ios-interpreter.ts` (módulo puro, testeable con vitest sin DOM). Grading determinista + fallback IA. Cero backend nuevo.
2. **Red GUI después** (~3-5 sem): React Flow + custom nodes, **reusa el intérprete del MVP 1** (doble-click nodo → terminal). Diff JSON tolerante. Cero backend.
   - Atajo si urge: draw.io por iframe para "dibuja la topología" calificado por IA.

## Riesgos

- Licencias limpias: React Flow, xterm.js, draw.io, v86, `netmask`/`ip-address` (todas MIT/Apache/BSD).
- Verificar antes de shippear: LICENSE real de Networkers Home.
- El intérprete propio no es IOS real (solo comandos implementados) — aceptable/deseable para exámenes de competencias acotadas.
- El MVP client-side funciona offline (encaja con offline-sync); la calificación IA no es offline (igual que todo el grading actual).

_Recomendación final: construir liviano (xterm.js + intérprete TS + React Flow + IA-grading) es la decisión correcta; no existe el "iframe de Packet Tracer" legal._
