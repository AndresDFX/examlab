// Paridad de la COPIA Deno del motor de red (usada por el edge ai-grade-submission
// para calificar red_consola en exámenes/proyectos). No usa el intérprete (client-side):
// construye el estado final directamente y verifica gradeNetwork + parse helpers.
import { describe, expect, it } from "vitest";
import { type Topology } from "./topology.ts";
import { gradeNetwork } from "./grading.ts";
import { defaultScenario, parseNetworkAnswer, parseScenario, serializeNetworkAnswer } from "./scenario.ts";

// Topología "resuelta": R1 con Gi0/0 direccionada+activa hacia PC1 (192.168.1.10/24).
function solvedTopology(): Topology {
  return {
    devices: [
      {
        id: "R1",
        name: "R1",
        kind: "router",
        interfaces: [{ name: "GigabitEthernet0/0", ip: "192.168.1.1", mask: "255.255.255.0", up: true }],
      },
      {
        id: "PC1",
        name: "PC1",
        kind: "pc",
        interfaces: [{ name: "GigabitEthernet0/0", ip: "192.168.1.10", mask: "255.255.255.0", up: true }],
      },
    ],
    links: [
      { a: { device: "R1", iface: "GigabitEthernet0/0" }, b: { device: "PC1", iface: "GigabitEthernet0/0" } },
    ],
  };
}

describe("Deno network engine parity", () => {
  it("califica una solución correcta del escenario por defecto al 100%", () => {
    const scenario = defaultScenario();
    const raw = serializeNetworkAnswer(solvedTopology(), {
      R1: ["enable", "configure terminal", "hostname R1", "interface g0/0", "ip address 192.168.1.1 255.255.255.0", "no shutdown"],
    });
    const answer = parseNetworkAnswer(raw)!;
    const result = gradeNetwork({ topology: answer.topology, histories: answer.histories }, scenario.assertions);
    expect(result.ratio).toBe(1);
  });

  it("parseScenario lee options.network y una solución vacía da 0", () => {
    const scenario = parseScenario({ network: defaultScenario() })!;
    expect(scenario.targetDeviceId).toBe("R1");
    // Estado inicial (R1 sin configurar) → 0 aserciones cumplidas de las que dependen de config.
    const initial: Topology = {
      devices: [
        { id: "R1", name: "Router", kind: "router", interfaces: [{ name: "GigabitEthernet0/0", ip: null, mask: null, up: false }] },
        { id: "PC1", name: "PC1", kind: "pc", interfaces: [{ name: "GigabitEthernet0/0", ip: "192.168.1.10", mask: "255.255.255.0", up: true }] },
      ],
      links: [{ a: { device: "R1", iface: "GigabitEthernet0/0" }, b: { device: "PC1", iface: "GigabitEthernet0/0" } }],
    };
    const result = gradeNetwork({ topology: initial, histories: {} }, scenario.assertions);
    expect(result.ratio).toBe(0);
  });
});
