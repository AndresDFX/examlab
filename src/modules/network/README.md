# Módulo `network` — motor de preguntas tipo "Red"

Motor **puro y testeable sin DOM** para las preguntas de redes (MVP #1 "Red consola" del
[research doc](../../../docs/research/network-question-integrations.md)). Sin backend nuevo: la
topología, el intérprete IOS y la calificación corren client-side.

## Piezas

| Archivo | Rol |
|---|---|
| [topology.ts](topology.ts) | Modelo (`Device`/`NetInterface`/`Link`/`Topology`) + helpers de IP puros (`parseIp`, `maskToPrefix`, `sameSubnet`, …) + **conectividad BFS** (`canReach`) + `canonicalIface`. |
| [ios-interpreter.ts](ios-interpreter.ts) | `IosInterpreter` — máquina de modos IOS (user/priv/config/if) sobre UN dispositivo. Comandos: `enable`, `configure terminal`, `hostname`, `interface`, `ip address`, `[no] shutdown`, `show running-config`, `show ip interface brief`, `ping`. Acepta abreviaturas (`conf t`, `int g0/0`, `no shut`). Guarda `history` para calificar por secuencia. |
| [grading.ts](grading.ts) | `gradeNetwork(state, assertions)` — calificación **determinista y tolerante** por aserciones: `hostname`, `interface_ip`, `interface_up`, `connectivity`, `command_used`. Cada aserción = ítem de rúbrica con puntos. |
| `*.test.ts` | 36 tests vitest (sin DOM) — IP helpers, BFS de conectividad, transiciones de modo, comandos, y las 5 aserciones + puntaje agregado. |

## Semántica de conectividad (MVP, deliberadamente simplificada)

`canReach(topo, srcId, dstIp)` = BFS sobre enlaces con **ambos** extremos `up`; **reenvían** routers y
switches, los endpoints (pc/server) solo originan; el origen necesita una interfaz activa con IP y el
destino debe existir en una interfaz activa. **No hay** tablas de rutas estáticas/dinámicas ni gateway
por defecto — es "directamente conectado". Suficiente para exámenes de competencias acotadas; NO es un
simulador IOS real (por diseño — ver research doc).

## Ejemplo

```ts
import { IosInterpreter } from "@/modules/network/ios-interpreter";
import { gradeNetwork } from "@/modules/network/grading";

// topo: Device[] + Link[] definidos por el escenario del docente.
const ios = new IosInterpreter({ device: r1, topology: topo });
ios.execute("enable");
ios.execute("configure terminal");
ios.execute("interface g0/0");
ios.execute("ip address 192.168.1.1 255.255.255.0");
ios.execute("no shutdown");

const result = gradeNetwork(
  { topology: topo, histories: { r1: ios.history } },
  [
    { kind: "interface_ip", device: "R1", iface: "g0/0", ip: "192.168.1.1", mask: "/24", points: 2 },
    { kind: "interface_up", device: "R1", iface: "g0/0", points: 1 },
    { kind: "connectivity", from: "PC1", toIp: "192.168.1.1", points: 3 },
  ],
);
// result.ratio ∈ [0,1] → nota; result.items → desglose por rúbrica.
```

## Estado de integración

- ✅ **Motor + grading + tests** — núcleo reutilizable (`tsc` limpio, 45 tests).
- ✅ **UI de consola** — [NetworkConsole.tsx](NetworkConsole.tsx): terminal React sobre `IosInterpreter`
  (input controlado + salida monoespaciada, sin `xterm.js`), con resumen de topología, historial
  (flechas ↑/↓), reanudación desde la respuesta guardada y serialización en `onChange`.
- ✅ **Tipo `red_consola` en el flujo de TALLER (end-to-end)** — migración
  [20261080000000](../../../supabase/migrations/20261080000000_red_consola_support.sql) (CHECK en las
  4 tablas, aplicada+verificada en prod) + [scenario.ts](scenario.ts) (escenario en `options.network`
  + generador templado determinista) + editor manual del docente (escenario JSON con plantilla) +
  "Generar con IA" (generación LOCAL sin modelo) + taker del alumno (consola) + **calificación
  DETERMINISTA** (fase 1, sin IA) en [WorkshopQuestions.tsx](../workshops/WorkshopQuestions.tsx).
- ⏳ **Exámenes / proyectos** — la migración ya habilita el tipo en sus tablas; falta replicar el
  editor + taker + grading (mismo patrón que el taller) en `app.student.take.$examId.tsx` /
  `ProjectFiles.tsx`. El banco de preguntas también.
- ⏳ **Fallback IA** — directive "redes" en `ai-grade-submission` para escenarios con aspectos abiertos,
  en paralelo a la calificación determinista (patrón del research doc).
- ⏳ **Red GUI** (MVP #2) — React Flow + custom nodes, reusando este mismo intérprete al doble-click.
