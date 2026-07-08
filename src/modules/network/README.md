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

- ✅ **Motor + grading + tests** (esta entrega) — núcleo reutilizable, verificado (`tsc` limpio, 36 tests).
- ⏳ **UI de consola** — componente React que renderice una terminal sobre `IosInterpreter` (un
  `<textarea>`/línea de comandos liviano basta; `xterm.js` es opcional y agregaría dependencia). El
  motor ya expone `prompt()` + `execute()` para conectarlo directo.
- ⏳ **Tipo de pregunta `red_consola`** — migración que agregue el tipo al CHECK de `questions` /
  `workshop_questions` / `project_files` / `question_bank` (patrón de `python_gui`, mig
  `20260813000000`), + editor del docente (escenario: devices/links/aserciones) + taker del alumno.
- ⏳ **Fallback IA** — directive "redes" en `ai-grade-submission` para aspectos abiertos, en paralelo a
  la calificación determinista (patrón del research doc).
- ⏳ **Red GUI** (MVP #2) — React Flow + custom nodes, reusando este mismo intérprete al doble-click.
